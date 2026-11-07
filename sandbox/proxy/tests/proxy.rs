//! The proxy over real sockets on loopback: every connection comes from 127.0.0.1, which
//! each test registers as its one sandbox.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use egress_proxy::Reason;
use egress_proxy::control::{self, Request};
use egress_proxy::server::{self, Config};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const LOOPBACK: &str = "127.0.0.1";

struct Proxy {
    addr: SocketAddr,
    control: PathBuf,
}

/// A TCP echo server standing in for the fixture site.
async fn echo_server() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut b = [0u8; 1024];
                while let Ok(n) = s.read(&mut b).await {
                    if n == 0 || s.write_all(&b[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    addr
}

async fn proxy(dev_map: Vec<(String, String)>, dev_resolve: HashMap<String, Vec<IpAddr>>) -> Proxy {
    let control = std::env::temp_dir().join(format!(
        "egress-test-{}-{:x}.sock",
        std::process::id(),
        rand_u64()
    ));
    let r = server::start(Config {
        listen: vec!["127.0.0.1:0".parse().unwrap()],
        control: control.clone(),
        dev_map,
        dev_resolve,
    })
    .await
    .unwrap();
    Proxy {
        addr: r.addrs[0],
        control,
    }
}

fn rand_u64() -> u64 {
    use std::hash::{BuildHasher, RandomState};
    RandomState::new().hash_one(std::time::SystemTime::now())
}

async fn register(p: &Proxy, sandbox_id: &str, allowlist: &[&str]) {
    control::call(
        &p.control,
        &Request::Register {
            source: LOOPBACK.parse().unwrap(),
            sandbox_id: sandbox_id.into(),
            allowlist: allowlist.iter().map(|s| s.to_string()).collect(),
        },
    )
    .await
    .unwrap();
}

/// Sends a request head; returns the status line and the open stream.
async fn ask(p: &Proxy, head: &str) -> (String, TcpStream) {
    let mut s = TcpStream::connect(p.addr).await.unwrap();
    s.write_all(head.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let mut b = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        if s.read(&mut b).await.unwrap() == 0 {
            break;
        }
        buf.push(b[0]);
    }
    let text = String::from_utf8_lossy(&buf).to_string();
    (text.lines().next().unwrap_or("").to_string(), s)
}

async fn connect(p: &Proxy, target: &str) -> (String, TcpStream) {
    ask(
        p,
        &format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n"),
    )
    .await
}

async fn drain(p: &Proxy, id: &str) -> Vec<(String, u16, bool, Reason)> {
    let r = control::call(
        &p.control,
        &Request::Drain {
            sandbox_id: id.into(),
        },
    )
    .await
    .unwrap();
    r.log
        .into_iter()
        .map(|e| {
            assert_eq!(e.sandbox_id, id);
            (e.host, e.port, e.allowed, e.reason)
        })
        .collect()
}

#[tokio::test]
async fn unknown_source_gets_nothing() {
    let p = proxy(vec![], HashMap::new()).await;
    let (status, _) = connect(&p, "news.fixture.test:443").await;
    assert!(status.starts_with("HTTP/1.1 403"), "{status}");
}

#[tokio::test]
async fn allowed_name_tunnels_to_the_fixture() {
    let echo = echo_server().await;
    let p = proxy(
        vec![("fixture.test".into(), echo.to_string())],
        HashMap::new(),
    )
    .await;
    register(&p, "sbx-a", &["news.fixture.test"]).await;
    let (status, mut s) = connect(&p, "news.fixture.test:443").await;
    assert_eq!(status, "HTTP/1.1 200 Connection Established");
    s.write_all(b"ping").await.unwrap();
    let mut b = [0u8; 4];
    s.read_exact(&mut b).await.unwrap();
    assert_eq!(&b, b"ping");
    assert_eq!(
        drain(&p, "sbx-a").await,
        vec![("news.fixture.test".into(), 443, true, Reason::Allowlisted)]
    );
    // Drained: the next drain is empty.
    assert!(drain(&p, "sbx-a").await.is_empty());
}

#[tokio::test]
async fn off_list_host_is_refused_and_logged() {
    let echo = echo_server().await;
    let p = proxy(
        vec![("fixture.test".into(), echo.to_string())],
        HashMap::new(),
    )
    .await;
    register(&p, "sbx-b", &["fanpost.fixture.test"]).await;
    for target in [
        "collect.exfil.fixture.test:443",
        "tracker.offlist.fixture.test:443",
        "evil.example:443",
    ] {
        let (status, _) = connect(&p, target).await;
        assert!(status.starts_with("HTTP/1.1 403"), "{target}: {status}");
    }
    let log = drain(&p, "sbx-b").await;
    assert_eq!(log.len(), 3);
    assert!(
        log.iter()
            .all(|(_, _, allowed, r)| !allowed && *r == Reason::NotOnAllowlist)
    );
}

#[tokio::test]
async fn metadata_address_is_refused_by_connect_and_by_plain_http() {
    let p = proxy(vec![], HashMap::new()).await;
    register(&p, "sbx-c", &["kalshi.com"]).await;
    let (s1, _) = connect(&p, "169.254.169.254:443").await;
    let (s2, _) = ask(
        &p,
        "GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n",
    )
    .await;
    let (s3, _) = connect(&p, "[fd00:ec2::254]:443").await;
    for s in [&s1, &s2, &s3] {
        assert!(s.starts_with("HTTP/1.1 403"), "{s}");
    }
    let log = drain(&p, "sbx-c").await;
    assert_eq!(
        log,
        vec![
            ("169.254.169.254".into(), 443, false, Reason::IpLiteral),
            ("169.254.169.254".into(), 80, false, Reason::IpLiteral),
            ("fd00:ec2::254".into(), 443, false, Reason::IpLiteral),
        ]
    );
}

#[tokio::test]
async fn a_name_that_resolves_to_metadata_is_refused() {
    let p = proxy(
        vec![],
        HashMap::from([(
            "rebind.fixture.test".to_string(),
            vec!["169.254.169.254".parse().unwrap()],
        )]),
    )
    .await;
    register(&p, "sbx-d", &["rebind.fixture.test"]).await;
    let (status, _) = connect(&p, "rebind.fixture.test:443").await;
    assert!(status.starts_with("HTTP/1.1 403"), "{status}");
    assert_eq!(
        drain(&p, "sbx-d").await,
        vec![(
            "rebind.fixture.test".into(),
            443,
            false,
            Reason::BlockedRange
        )]
    );
}

#[tokio::test]
async fn other_ports_and_plain_http_are_refused() {
    let echo = echo_server().await;
    let p = proxy(
        vec![("fixture.test".into(), echo.to_string())],
        HashMap::new(),
    )
    .await;
    register(&p, "sbx-e", &["news.fixture.test"]).await;
    let (s1, _) = connect(&p, "news.fixture.test:80").await;
    let (s2, _) = connect(&p, "news.fixture.test:22").await;
    // Plain HTTP to an allowed name is never forwarded, even on 443.
    let (s3, _) = ask(
        &p,
        "GET http://news.fixture.test:443/ HTTP/1.1\r\nHost: news.fixture.test\r\n\r\n",
    )
    .await;
    for s in [&s1, &s2, &s3] {
        assert!(s.starts_with("HTTP/1.1 403"), "{s}");
    }
    let reasons: Vec<Reason> = drain(&p, "sbx-e").await.into_iter().map(|e| e.3).collect();
    assert_eq!(reasons, vec![Reason::BadPort; 3]);
}

#[tokio::test]
async fn unregister_returns_the_rest_and_forgets_the_source() {
    let echo = echo_server().await;
    let p = proxy(
        vec![("fixture.test".into(), echo.to_string())],
        HashMap::new(),
    )
    .await;
    register(&p, "sbx-f", &["news.fixture.test"]).await;
    // A second registration of the same source is refused: one sandbox per address.
    let again = control::call(
        &p.control,
        &Request::Register {
            source: LOOPBACK.parse().unwrap(),
            sandbox_id: "sbx-g".into(),
            allowlist: vec![],
        },
    )
    .await;
    assert!(again.is_err());
    let (_, mut tunnel) = connect(&p, "news.fixture.test:443").await;
    let (status, _) = connect(&p, "evil.example:443").await;
    assert!(status.starts_with("HTTP/1.1 403"));
    let r = control::call(
        &p.control,
        &Request::Unregister {
            sandbox_id: "sbx-f".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(r.log.len(), 2);
    // The open tunnel is closed, and the address is unknown again.
    let mut b = [0u8; 1];
    let n = tokio::time::timeout(std::time::Duration::from_secs(2), tunnel.read(&mut b))
        .await
        .expect("tunnel closed on unregister")
        .unwrap_or(0);
    assert_eq!(n, 0);
    let (status, _) = connect(&p, "news.fixture.test:443").await;
    assert!(status.starts_with("HTTP/1.1 403"), "{status}");
}

#[tokio::test]
async fn the_control_socket_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let p = proxy(vec![], HashMap::new()).await;
    let mode = std::fs::metadata(&p.control).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
}
