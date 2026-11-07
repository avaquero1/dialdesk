//! `sandbox-manager serve` runs the API; `sandbox-manager --schema` prints its contract.
//!
//! Env: SANDBOX_MANAGER_ADDR (default 127.0.0.1:8200), SANDBOX_MANAGER_CALLERS
//! (`runner:<sha256hex>[,other:<hex>]`, required), SANDBOX_SLOTS (default 6),
//! SANDBOX_BACKEND (default docker), SANDBOX_MANAGER_DEV=1 (allows http:// URLs).

mod app;
mod backend;
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
        _ => {
            eprintln!("usage: sandbox-manager serve | --schema");
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
    let backend = backend::from_name(&env_or("SANDBOX_BACKEND", "docker"))?;
    let dev = env_or("SANDBOX_MANAGER_DEV", "") == "1";
    let addr = env_or("SANDBOX_MANAGER_ADDR", "127.0.0.1:8200");

    let names: Vec<&str> = callers.iter().map(|c| c.name.as_str()).collect();
    tracing::info!(addr, slots, backend = backend.name(), dev, callers = ?names, "starting");
    let state = app::AppState::new(
        app::Config {
            callers,
            slots,
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
