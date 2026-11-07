//! `egress-proxy --check <host> <port> <resolved-ip[,ip...]> <allowlist,comma,separated>`
//! prints the decision as JSON. With no args it is a stub until Phase 1.

use std::net::IpAddr;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => {
            eprintln!("egress-proxy stub: CONNECT handling comes in Phase 1");
            ExitCode::SUCCESS
        }
        ["--check", host, port, resolved, allowlist] => check(host, port, resolved, allowlist),
        _ => usage(),
    }
}

fn usage() -> ExitCode {
    eprintln!(
        "usage: egress-proxy --check <host> <port> <resolved-ip[,ip...]|-> <allowlist,comma,separated>"
    );
    ExitCode::from(2)
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
