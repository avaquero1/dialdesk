//! `sandbox-manager serve` runs the API; `sandbox-manager --schema` prints its contract.
//! `sandbox-manager probe [--allow a,b] [--wall S] [--image IMG] -- <probe args>` runs one
//! attack probe in a fresh sandbox made exactly like a browse job's, and prints a report
//! (the containment tests use it).
//!
//! Env: SANDBOX_MANAGER_ADDR (default 127.0.0.1:8200), SANDBOX_MANAGER_CALLERS
//! (`runner:<sha256hex>[,other:<hex>]`, required), SANDBOX_SLOTS (live sandboxes, default
//! 6), SANDBOX_STARTING (sandboxes starting at once, default 2),
//! SANDBOX_BACKEND (docker, gvisor or stub; default docker, stub when dev), SANDBOX_MANAGER_DEV=1 (allows
//! http:// URLs and the dev-only settings). The docker backend: see `docker::DockerConfig`.

mod app;
mod backend;
mod docker;
mod types;

#[cfg(test)]
mod tests;

use std::process::ExitCode;
use std::time::{Duration, Instant};

/// Now, as RFC 3339 UTC.
pub fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("UTC time formats")
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--schema"] => {
            println!(
                "{}",
                serde_json::to_string_pretty(&app::schema_doc()).expect("schema serializes")
            );
            ExitCode::SUCCESS
        }
        ["serve"] => match serve() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("sandbox-manager: {e}");
                ExitCode::from(2)
            }
        },
        ["probe", ..] => match probe(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("sandbox-manager probe: {e}");
                ExitCode::from(2)
            }
        },
        _ => {
            eprintln!(
                "usage: sandbox-manager serve | --schema | probe [--allow a,b] [--wall S] [--image IMG] -- <args>"
            );
            ExitCode::from(2)
        }
    }
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn serve() -> Result<(), String> {
    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .init();

    let callers = app::parse_callers(&env_or("SANDBOX_MANAGER_CALLERS", ""))?;
    if callers.is_empty() {
        return Err("SANDBOX_MANAGER_CALLERS is empty; every request would be refused".into());
    }
    let slots: usize = env_or("SANDBOX_SLOTS", "6")
        .parse()
        .map_err(|_| "SANDBOX_SLOTS must be a number".to_string())?;
    let starting: usize = env_or("SANDBOX_STARTING", "2")
        .parse()
        .map_err(|_| "SANDBOX_STARTING must be a number".to_string())?;
    let dev = env_or("SANDBOX_MANAGER_DEV", "") == "1";
    let backend = backend::from_env(dev).await?;
    let addr = env_or("SANDBOX_MANAGER_ADDR", "127.0.0.1:8200");

    let names: Vec<&str> = callers.iter().map(|c| c.name.as_str()).collect();
    tracing::info!(addr, slots, starting, backend = backend.name(), dev, callers = ?names, "starting");
    let state = app::AppState::new(
        app::Config {
            callers,
            slots,
            starting,
            dev,
        },
        backend,
    );

    let sweeper = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            app::sweep_holds(&sweeper, Instant::now()).await;
        }
    });

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    axum::serve(listener, app::router(state))
        .with_graceful_shutdown(shutdown())
        .await
        .map_err(|e| e.to_string())
}

/// Ctrl-C or SIGTERM (systemd stop).
async fn shutdown() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    tracing::info!("shutting down");
}

#[tokio::main]
async fn probe(args: &[String]) -> Result<(), String> {
    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .with_writer(std::io::stderr)
        .init();
    let split = args
        .iter()
        .position(|a| a == "--")
        .ok_or("need -- <probe args>")?;
    let (opts, probe_args) = (&args[..split], &args[split + 1..]);
    let mut limits = types::Limits::BROWSE;
    let mut allow = Vec::new();
    let mut image = env_or("SANDBOX_PROBE_IMAGE", "vha-probe:dev");
    let mut it = opts.iter();
    while let Some(k) = it.next() {
        let v = it.next().ok_or(format!("{k} needs a value"))?;
        match k.as_str() {
            "--allow" => allow = v.split(',').map(String::from).collect(),
            "--wall" => limits.wall_s = v.parse().map_err(|_| "--wall: seconds")?,
            "--image" => image = v.clone(),
            other => return Err(format!("unknown flag {other}")),
        }
    }
    let dev = env_or("SANDBOX_MANAGER_DEV", "") == "1";
    let runtime = match env_or("SANDBOX_BACKEND", "docker").as_str() {
        "gvisor" => env_or("SANDBOX_RUNTIME", "runsc"),
        _ => env_or("SANDBOX_RUNTIME", "runc"),
    };
    let mut cfg = docker::DockerConfig::from_env(runtime, dev)?;
    // Its own instance, so start-up never touches a running manager's sandboxes.
    cfg.instance = format!("{}-probe{}", cfg.instance, std::process::id());
    cfg.state_dir = cfg.state_dir.join("probe");
    let b = docker::DockerBackend::start(cfg).await?;
    let report = b
        .probe(&image, probe_args, &allow, limits)
        .await
        .map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|e| e.to_string())?
    );
    Ok(())
}
