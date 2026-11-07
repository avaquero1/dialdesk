//! `egress-proxy serve --listen <ip:port> [--listen ...] --control <socket path>`
//!   runs the proxy (see `server`). DEV ONLY flags, never on the sandbox machine:
//!   `--dev-map <domain>=<host:port>` (names under domain go to a fixture server, exempt from
//!   the range check) and `--dev-resolve <name>=<ip>[,ip]` (a fixed answer, still range-checked).
//! `egress-proxy --check <host> <port> <resolved-ip[,ip...]> <allowlist,comma,separated>`
//!   prints one decision as JSON.

use std::net::IpAddr;
use std::process::ExitCode;

use egress_proxy::server;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--check", host, port, resolved, allowlist] => check(host, port, resolved, allowlist),
        ["serve", rest @ ..] => match parse_serve(rest) {
            Ok(cfg) => match serve(cfg) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("egress-proxy: {e}");
                    ExitCode::from(1)
                }
            },
            Err(e) => {
                eprintln!("egress-proxy: {e}");
                usage()
            }
        },
        _ => usage(),
    }
}

fn usage() -> ExitCode {
    eprintln!(
        "usage: egress-proxy serve --listen <ip:port> [--listen ...] --control <socket> \
         [--dev-map <domain>=<host:port>] [--dev-resolve <name>=<ip[,ip]>]\n       \
         egress-proxy --check <host> <port> <resolved-ip[,ip...]|-> <allowlist,comma,separated>"
    );
    ExitCode::from(2)
}

fn parse_serve(args: &[&str]) -> Result<server::Config, String> {
    let mut cfg = server::Config::default();
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let v = it.next().ok_or(format!("{flag} needs a value"))?;
        match *flag {
            "--listen" => cfg.listen.push(
                v.parse()
                    .map_err(|_| format!("--listen {v:?}: not ip:port"))?,
            ),
            "--control" => cfg.control = v.into(),
            "--dev-map" => {
                let (d, t) = v
                    .split_once('=')
                    .ok_or(format!("--dev-map {v:?}: not domain=host:port"))?;
                cfg.dev_map
                    .push((egress_proxy::normalize(d), t.to_string()));
            }
            "--dev-resolve" => {
                let (n, ips) = v
                    .split_once('=')
                    .ok_or(format!("--dev-resolve {v:?}: not name=ip"))?;
                let ips = ips
                    .split(',')
                    .map(|s| s.parse::<IpAddr>())
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| format!("--dev-resolve {v:?}: bad address"))?;
                cfg.dev_resolve.insert(egress_proxy::normalize(n), ips);
            }
            other => return Err(format!("unknown flag {other}")),
        }
    }
    if cfg.control.as_os_str().is_empty() {
        return Err("--control is required".into());
    }
    Ok(cfg)
}

#[tokio::main]
async fn serve(cfg: server::Config) -> Result<(), String> {
    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .init();
    let control = cfg.control.clone();
    server::start(cfg).await.map_err(|e| e.to_string())?;
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|e| e.to_string())?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    let _ = std::fs::remove_file(control);
    tracing::info!("shutting down");
    Ok(())
}

fn check(host: &str, port: &str, resolved: &str, allowlist: &str) -> ExitCode {
    let Ok(port) = port.parse::<u16>() else {
        return usage();
    };
    // "-" or "" means DNS returned nothing.
    let addrs: Result<Vec<IpAddr>, _> = resolved
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "-")
        .map(str::parse)
        .collect();
    let Ok(addrs) = addrs else { return usage() };
    let list: Vec<&str> = allowlist.split(',').collect();
    let d = egress_proxy::decide(host, port, &addrs, &list);
    println!(
        "{}",
        serde_json::to_string(&d).expect("decision serializes")
    );
    ExitCode::SUCCESS
}
