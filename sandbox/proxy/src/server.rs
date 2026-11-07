//! The proxy. Sandboxes reach it on `listen` and nothing else; it is their only way out.
//!
//! - A connection belongs to the sandbox whose address the manager registered (by source
//!   address, so no token ever enters a sandbox). An unknown source gets nothing.
//! - Only `CONNECT host:443` to a name on that sandbox's allowlist goes through. Plain-HTTP
//!   proxy requests are always refused (and logged), whatever their host.
//! - Names are resolved here, after the allowlist check, and every resolved address must be
//!   public (`decide`). The tunnel goes to an address that was checked, never re-resolved.
//! - Every request, allowed or refused, is logged for its sandbox. The manager takes the log
//!   over the control socket; the proxy never calls anything.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream};
use tokio::sync::{Notify, Semaphore};

use crate::control::{LogEntry, Request, Response};
use crate::{Decision, Reason, decide, on_allowlist, precheck};

const MAX_HEAD: usize = 8 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// A tunnel lives at most this long (a browse job plus its hold fit well inside).
const TUNNEL_MAX: Duration = Duration::from_secs(300);
const MAX_CONNECTIONS: usize = 1024;
const MAX_PER_SANDBOX: usize = 64;
/// Log entries kept per sandbox; the rest are counted in `dropped`.
pub const MAX_LOG: usize = 500;
const MAX_CONTROL_REQUEST: usize = 64 * 1024;

#[derive(Debug, Clone, Default)]
pub struct Config {
    pub listen: Vec<SocketAddr>,
    pub control: PathBuf,
    /// DEV ONLY: names under a domain go to a fixed upstream, exempt from the range check
    /// (the fixture site on a private address). Never set on the sandbox machine.
    pub dev_map: Vec<(String, String)>,
    /// DEV ONLY: a name resolves to these addresses. Still range-checked (the rebinding test).
    pub dev_resolve: HashMap<String, Vec<IpAddr>>,
    /// The group that may also open the control socket (mode 0660 instead of 0600): on the sandbox machine the
    /// manager runs as its own user, in this group.
    pub control_gid: Option<u32>,
}

struct Sandbox {
    sandbox_id: String,
    allowlist: Vec<String>,
    log: Mutex<Vec<LogEntry>>,
    dropped: AtomicU64,
    open: AtomicUsize,
    closed: AtomicBool,
    close: Notify,
}

impl Sandbox {
    fn record(&self, host: &str, port: u16, d: Decision) {
        let host: String = host.chars().take(255).collect();
        tracing::info!(sandbox_id = %self.sandbox_id, host, port, allowed = d.allowed,
            reason = ?d.reason, "egress");
        let mut log = self.log.lock().unwrap_or_else(|e| e.into_inner());
        if log.len() >= MAX_LOG {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        log.push(LogEntry {
            at: now(),
            sandbox_id: self.sandbox_id.clone(),
            host,
            port,
            allowed: d.allowed,
            reason: d.reason,
        });
    }

    fn take_log(&self) -> (Vec<LogEntry>, u64) {
        let log = std::mem::take(&mut *self.log.lock().unwrap_or_else(|e| e.into_inner()));
        (log, self.dropped.swap(0, Ordering::Relaxed))
    }
}

#[derive(Default)]
struct Registry {
    by_source: HashMap<IpAddr, Arc<Sandbox>>,
    by_id: HashMap<String, IpAddr>,
}

pub struct State {
    cfg: Config,
    reg: Mutex<Registry>,
    conns: Arc<Semaphore>,
}

impl State {
    fn reg(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.reg.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn sandbox_for(&self, ip: IpAddr) -> Option<Arc<Sandbox>> {
        self.reg().by_source.get(&ip).cloned()
    }

    fn control(&self, req: Request) -> Response {
        let err = |m: String| Response {
            ok: false,
            error: Some(m),
            ..Response::default()
        };
        match req {
            Request::Health => Response {
                ok: true,
                ..Response::default()
            },
            Request::Register {
                source,
                sandbox_id,
                allowlist,
            } => {
                let source = source.to_canonical();
                let mut reg = self.reg();
                if reg.by_source.contains_key(&source) {
                    return err(format!("source {source} is already registered"));
                }
                if reg.by_id.contains_key(&sandbox_id) {
                    return err(format!("sandbox {sandbox_id} is already registered"));
                }
                tracing::info!(%source, sandbox_id, allowlist = ?allowlist, "registered");
                reg.by_id.insert(sandbox_id.clone(), source);
                reg.by_source.insert(
                    source,
                    Arc::new(Sandbox {
                        sandbox_id,
                        allowlist,
                        log: Mutex::new(Vec::new()),
                        dropped: AtomicU64::new(0),
                        open: AtomicUsize::new(0),
                        closed: AtomicBool::new(false),
                        close: Notify::new(),
                    }),
                );
                Response {
                    ok: true,
                    ..Response::default()
                }
            }
            Request::Drain { sandbox_id } => {
                let reg = self.reg();
                let Some(sb) = reg
                    .by_id
                    .get(&sandbox_id)
                    .and_then(|ip| reg.by_source.get(ip))
                else {
                    return err(format!("no sandbox {sandbox_id}"));
                };
                let (log, dropped) = sb.take_log();
                Response {
                    ok: true,
                    log,
                    dropped,
                    ..Response::default()
                }
            }
            Request::Unregister { sandbox_id } => {
                let sb = {
                    let mut reg = self.reg();
                    let Some(ip) = reg.by_id.remove(&sandbox_id) else {
                        return err(format!("no sandbox {sandbox_id}"));
                    };
                    reg.by_source.remove(&ip)
                };
                let Some(sb) = sb else {
                    return err(format!("no sandbox {sandbox_id}"));
                };
                // Ends its open tunnels too.
                sb.closed.store(true, Ordering::SeqCst);
                sb.close.notify_waiters();
                tracing::info!(sandbox_id, "unregistered");
                let (log, dropped) = sb.take_log();
                Response {
                    ok: true,
                    log,
                    dropped,
                    ..Response::default()
                }
            }
        }
    }
}

pub struct Running {
    pub addrs: Vec<SocketAddr>,
    pub state: Arc<State>,
}

/// Binds every listener and the control socket, then serves them in the background.
pub async fn start(cfg: Config) -> io::Result<Running> {
    if cfg.listen.is_empty() {
        return Err(io::Error::other("need at least one --listen address"));
    }
    for (domain, target) in &cfg.dev_map {
        tracing::warn!(
            domain,
            target,
            "DEV MAP: names under this domain skip the range check"
        );
    }
    for (name, ips) in &cfg.dev_resolve {
        tracing::warn!(name, ips = ?ips, "DEV RESOLVE: this name resolves to fixed addresses");
    }
    let mut listeners = Vec::new();
    for a in &cfg.listen {
        listeners.push(TcpListener::bind(a).await?);
    }
    let _ = std::fs::remove_file(&cfg.control);
    let control = UnixListener::bind(&cfg.control)?;
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = match cfg.control_gid {
            Some(gid) => {
                std::os::unix::fs::chown(&cfg.control, None, Some(gid))?;
                0o660
            }
            None => 0o600,
        };
        std::fs::set_permissions(&cfg.control, std::fs::Permissions::from_mode(mode))?;
    }
    let addrs = listeners
        .iter()
        .map(|l| l.local_addr())
        .collect::<io::Result<Vec<_>>>()?;
    let state = Arc::new(State {
        cfg,
        reg: Mutex::new(Registry::default()),
        conns: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
    });
    for l in listeners {
        tokio::spawn(accept_loop(state.clone(), l));
    }
    tokio::spawn(control_loop(state.clone(), control));
    tracing::info!(listen = ?addrs, control = %state.cfg.control.display(), "listening");
    Ok(Running { addrs, state })
}

async fn accept_loop(st: Arc<State>, l: TcpListener) {
    loop {
        let (sock, peer) = match l.accept().await {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!(error = %e, "accept");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let Ok(permit) = st.conns.clone().try_acquire_owned() else {
            tracing::warn!(%peer, "too many connections; dropped");
            continue;
        };
        let st = st.clone();
        tokio::spawn(async move {
            handle(st, sock, peer).await;
            drop(permit);
        });
    }
}

async fn control_loop(st: Arc<State>, l: UnixListener) {
    loop {
        match l.accept().await {
            Ok((s, _)) => {
                tokio::spawn(control_conn(st.clone(), s));
            }
            Err(e) => {
                tracing::warn!(error = %e, "control accept");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

async fn control_conn(st: Arc<State>, s: UnixStream) {
    let (r, mut w) = s.into_split();
    let mut line = String::new();
    let read = BufReader::new(r.take(MAX_CONTROL_REQUEST as u64))
        .read_line(&mut line)
        .await;
    let res = match read {
        Ok(_) => match serde_json::from_str::<Request>(&line) {
            Ok(req) => st.control(req),
            Err(e) => Response {
                ok: false,
                error: Some(format!("bad request: {e}")),
                ..Response::default()
            },
        },
        Err(e) => Response {
            ok: false,
            error: Some(e.to_string()),
            ..Response::default()
        },
    };
    let mut out = serde_json::to_vec(&res).unwrap_or_default();
    out.push(b'\n');
    let _ = w.write_all(&out).await;
}

/// What a sandbox asked for.
#[derive(Debug, PartialEq, Eq)]
enum Ask {
    Connect {
        host: String,
        port: u16,
    },
    /// An absolute-form plain proxy request (GET http://...): always refused.
    Plain {
        host: String,
        port: u16,
    },
    Malformed,
}

fn split_host_port(s: &str, default_port: Option<u16>) -> Option<(String, u16)> {
    let (host, port) = if let Some(rest) = s.strip_prefix('[') {
        let (h, after) = rest.split_once(']')?;
        match after.strip_prefix(':') {
            Some(p) => (h, Some(p)),
            None if after.is_empty() => (h, None),
            None => return None,
        }
    } else {
        match s.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (s, None),
        }
    };
    let port = match port {
        Some(p) => p.parse().ok()?,
        None => default_port?,
    };
    if host.is_empty() {
        return None;
    }
    Some((crate::normalize(host), port))
}

fn parse_ask(head: &[u8]) -> Ask {
    let Ok(text) = std::str::from_utf8(head) else {
        return Ask::Malformed;
    };
    let line = text.lines().next().unwrap_or("");
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Ask::Malformed;
    };
    if !version.starts_with("HTTP/1.") || parts.next().is_some() {
        return Ask::Malformed;
    }
    if method.eq_ignore_ascii_case("CONNECT") {
        return match split_host_port(target, None) {
            Some((host, port)) => Ask::Connect { host, port },
            None => Ask::Malformed,
        };
    }
    let lower = target.to_ascii_lowercase();
    let (rest, default_port) = if let Some(r) = lower.strip_prefix("http://") {
        (r, 80)
    } else if let Some(r) = lower.strip_prefix("https://") {
        (r, 443)
    } else if let Some(r) = lower.strip_prefix("ws://") {
        (r, 80)
    } else {
        return Ask::Malformed;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    match split_host_port(authority, Some(default_port)) {
        Some((host, port)) => Ask::Plain { host, port },
        None => Ask::Malformed,
    }
}

/// Reads up to the end of the request head. Returns the head and any bytes after it.
async fn read_head(sock: &mut TcpStream) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        let n = sock.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(i + 4);
            return Ok((buf, rest));
        }
        if buf.len() > MAX_HEAD {
            return Err(io::ErrorKind::InvalidData.into());
        }
    }
}

async fn reply(sock: &mut TcpStream, status: &str, why: &str) {
    let msg = format!(
        "HTTP/1.1 {status}\r\nX-Egress: {why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    let _ = sock.write_all(msg.as_bytes()).await;
    let _ = sock.shutdown().await;
}

fn reason_str(r: Reason) -> &'static str {
    match r {
        Reason::Allowlisted => "allowlisted",
        Reason::NotOnAllowlist => "not_on_allowlist",
        Reason::IpLiteral => "ip_literal",
        Reason::BadPort => "bad_port",
        Reason::BlockedRange => "blocked_range",
        Reason::DnsFailed => "dns_failed",
    }
}

fn plain_name(host: &str) -> bool {
    !host.is_empty()
        && host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
}

/// Where an allowed name goes: the checked addresses, or a dev-map upstream.
async fn route(st: &State, sb: &Sandbox, host: &str, port: u16) -> (Decision, Vec<SocketAddr>) {
    let refused = |reason| {
        (
            Decision {
                allowed: false,
                reason,
            },
            vec![],
        )
    };
    if let Some(d) = precheck(host, port, &sb.allowlist) {
        return (d, vec![]);
    }
    if !plain_name(host) {
        return refused(Reason::NotOnAllowlist);
    }
    if !st.cfg.dev_resolve.contains_key(host)
        && let Some((_, target)) = st
            .cfg
            .dev_map
            .iter()
            .find(|(domain, _)| on_allowlist(host, std::slice::from_ref(domain)))
    {
        let addrs = match tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host(target)).await {
            Ok(Ok(a)) => a.collect::<Vec<_>>(),
            _ => vec![],
        };
        if addrs.is_empty() {
            return refused(Reason::DnsFailed);
        }
        let ok = Decision {
            allowed: true,
            reason: Reason::Allowlisted,
        };
        return (ok, addrs);
    }
    let ips: Vec<IpAddr> = match st.cfg.dev_resolve.get(host) {
        Some(ips) => ips.clone(),
        None => {
            match tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((host, port))).await {
                Ok(Ok(a)) => a.map(|s| s.ip().to_canonical()).collect(),
                _ => vec![],
            }
        }
    };
    let d = decide(host, port, &ips, &sb.allowlist);
    let addrs = if d.allowed {
        ips.into_iter()
            .map(|ip| SocketAddr::new(ip, port))
            .collect()
    } else {
        vec![]
    };
    (d, addrs)
}

async fn handle(st: Arc<State>, mut sock: TcpStream, peer: SocketAddr) {
    let ip = peer.ip().to_canonical();
    let Ok(Ok((head, rest))) = tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut sock)).await
    else {
        return;
    };
    let Some(sb) = st.sandbox_for(ip) else {
        tracing::warn!(source = %ip, "refused: unknown source");
        reply(&mut sock, "403 Forbidden", "unknown_source").await;
        return;
    };
    if sb.open.fetch_add(1, Ordering::SeqCst) >= MAX_PER_SANDBOX {
        sb.open.fetch_sub(1, Ordering::SeqCst);
        tracing::warn!(sandbox_id = %sb.sandbox_id, "refused: too many open connections");
        reply(&mut sock, "429 Too Many Requests", "too_many").await;
        return;
    }
    serve_ask(&st, &sb, sock, &head, rest).await;
    sb.open.fetch_sub(1, Ordering::SeqCst);
}

async fn serve_ask(st: &State, sb: &Sandbox, mut sock: TcpStream, head: &[u8], rest: Vec<u8>) {
    let (host, port) = match parse_ask(head) {
        Ask::Connect { host, port } => (host, port),
        Ask::Plain { host, port } => {
            // Never forwarded. Logged with the reason the name would get; plain HTTP
            // to an allowed name on 443 still counts as the wrong port (no TLS).
            let d = precheck(&host, port, &sb.allowlist).unwrap_or(Decision {
                allowed: false,
                reason: Reason::BadPort,
            });
            sb.record(&host, port, d);
            reply(&mut sock, "403 Forbidden", reason_str(d.reason)).await;
            return;
        }
        Ask::Malformed => {
            reply(&mut sock, "400 Bad Request", "malformed").await;
            return;
        }
    };
    let (d, addrs) = route(st, sb, &host, port).await;
    sb.record(&host, port, d);
    if !d.allowed {
        reply(&mut sock, "403 Forbidden", reason_str(d.reason)).await;
        return;
    }
    let mut upstream = None;
    for a in addrs {
        if let Ok(Ok(s)) = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(a)).await {
            upstream = Some(s);
            break;
        }
    }
    let Some(mut up) = upstream else {
        reply(&mut sock, "502 Bad Gateway", "upstream_unreachable").await;
        return;
    };
    if sock
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .is_err()
    {
        return;
    }
    if !rest.is_empty() && up.write_all(&rest).await.is_err() {
        return;
    }
    if sb.closed.load(Ordering::SeqCst) {
        return;
    }
    tokio::select! {
        _ = tokio::time::timeout(TUNNEL_MAX, tokio::io::copy_bidirectional(&mut sock, &mut up)) => {}
        _ = sb.close.notified() => {}
    }
}

/// Now, as RFC 3339 UTC.
pub fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_what_a_browser_sends() {
        assert_eq!(
            parse_ask(b"CONNECT news.fixture.test:443 HTTP/1.1\r\nHost: x\r\n\r\n"),
            Ask::Connect {
                host: "news.fixture.test".into(),
                port: 443
            }
        );
        assert_eq!(
            parse_ask(b"CONNECT [::1]:443 HTTP/1.1\r\n\r\n"),
            Ask::Connect {
                host: "::1".into(),
                port: 443
            }
        );
        assert_eq!(
            parse_ask(b"GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\n\r\n"),
            Ask::Plain {
                host: "169.254.169.254".into(),
                port: 80
            }
        );
        assert_eq!(
            parse_ask(b"GET http://u:p@Evil.Example:8080/x HTTP/1.1\r\n\r\n"),
            Ask::Plain {
                host: "evil.example".into(),
                port: 8080
            }
        );
        assert_eq!(
            parse_ask(b"CONNECT nohost HTTP/1.1\r\n\r\n"),
            Ask::Malformed
        );
        assert_eq!(parse_ask(b"GET / HTTP/1.1\r\n\r\n"), Ask::Malformed);
        assert_eq!(parse_ask(b"\xff\xfe\r\n\r\n"), Ask::Malformed);
    }
}
