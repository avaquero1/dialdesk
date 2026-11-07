//! The egress decision. Every connection a sandbox asks for goes through `decide`:
//! a named host on the allowlist, port 443, and only public addresses after DNS.
//! Checking the resolved addresses (not just the name) stops DNS rebinding.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::Serialize;

/// Why a connection was allowed or refused. Shared with the manager's proxy log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Allowlisted,
    NotOnAllowlist,
    IpLiteral,
    BadPort,
    BlockedRange,
    DnsFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Decision {
    pub allowed: bool,
    pub reason: Reason,
}

fn refuse(reason: Reason) -> Decision {
    Decision {
        allowed: false,
        reason,
    }
}

/// Lowercase, no trailing dot, no IPv6 brackets.
pub fn normalize(host: &str) -> String {
    host.trim()
        .trim_end_matches('.')
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

/// An address, or a name that URL parsers and resolvers would read as one
/// (e.g. "2130706433", "0x7f.1", "127.1"): a numeric or 0x-hex last label.
pub fn is_ip_literal(host: &str) -> bool {
    let h = normalize(host);
    if h.parse::<IpAddr>().is_ok() {
        return true;
    }
    let last = h.rsplit('.').next().unwrap_or("");
    let hex = last
        .strip_prefix("0x")
        .is_some_and(|d| d.chars().all(|c| c.is_ascii_hexdigit()));
    hex || (!last.is_empty() && last.chars().all(|c| c.is_ascii_digit()))
}

/// Exact match, or a subdomain of an allowlisted domain.
pub fn on_allowlist<S: AsRef<str>>(host: &str, allowlist: &[S]) -> bool {
    let h = normalize(host);
    allowlist
        .iter()
        .map(|d| normalize(d.as_ref()))
        .filter(|d| !d.is_empty())
        .any(|d| {
            h == d
                || h.strip_suffix(d.as_str())
                    .is_some_and(|rest| rest.ends_with('.'))
        })
}

fn blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 0                                // 0/8 "this network"
        || a == 10                        // 10/8
        || a == 127                       // 127/8 loopback
        || (a == 100 && (b & 0xc0) == 64) // 100.64/10 carrier NAT
        || (a == 169 && b == 254)         // 169.254/16 link-local, cloud metadata
        || (a == 172 && (b & 0xf0) == 16) // 172.16/12
        || (a == 192 && b == 168)         // 192.168/16
        || a >= 224 // multicast, reserved, broadcast
}

fn blocked_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    if let Some(v4) = ip.to_ipv4_mapped() {
        return blocked_v4(v4); // ::ffff:a.b.c.d
    }
    let low32 = Ipv4Addr::from(((s[6] as u32) << 16) | s[7] as u32);
    if s[..6] == [0; 6] {
        return blocked_v4(low32); // ::, ::1 and IPv4-compatible ::a.b.c.d
    }
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] && blocked_v4(low32) {
        return true; // NAT64 64:ff9b::/96 to a private v4
    }
    (s[0] & 0xff80) == 0xfe80     // fe80::/10 link-local and old fec0::/10 site-local
        || (s[0] & 0xfe00) == 0xfc00 // fc00::/7 unique local
        || (s[0] & 0xff00) == 0xff00 // ff00::/8 multicast
}

pub fn is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => blocked_v4(v4),
        IpAddr::V6(v6) => blocked_v6(v6),
    }
}

/// Decides one connection. `resolved` is every address DNS returned for `host`;
/// all of them must be public, because the client may connect to any.
pub fn decide<S: AsRef<str>>(
    host: &str,
    port: u16,
    resolved: &[IpAddr],
    allowlist: &[S],
) -> Decision {
    if is_ip_literal(host) {
        return refuse(Reason::IpLiteral);
    }
    if port != 443 {
        return refuse(Reason::BadPort);
    }
    if !on_allowlist(host, allowlist) {
        return refuse(Reason::NotOnAllowlist);
    }
    if resolved.is_empty() {
        return refuse(Reason::DnsFailed);
    }
    if resolved.iter().any(|ip| is_blocked(*ip)) {
        return refuse(Reason::BlockedRange);
    }
    Decision {
        allowed: true,
        reason: Reason::Allowlisted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &[&str] = &["kalshi.com", "espn.com."];

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn reason(host: &str, port: u16, addrs: &[&str]) -> Reason {
        let addrs: Vec<IpAddr> = addrs.iter().map(|a| ip(a)).collect();
        decide(host, port, &addrs, LIST).reason
    }

    #[test]
    fn allows_listed_host_and_subdomain() {
        assert_eq!(
            reason("kalshi.com", 443, &["104.18.1.1"]),
            Reason::Allowlisted
        );
        assert_eq!(
            reason("api.Kalshi.COM.", 443, &["104.18.1.1"]),
            Reason::Allowlisted
        );
        assert_eq!(
            reason("www.espn.com", 443, &["2606:4700::1"]),
            Reason::Allowlisted
        );
        assert!(decide("kalshi.com", 443, &[ip("1.1.1.1")], LIST).allowed);
    }

    #[test]
    fn refuses_hosts_off_the_list() {
        assert_eq!(
            reason("evilkalshi.com", 443, &["1.1.1.1"]),
            Reason::NotOnAllowlist
        );
        assert_eq!(
            reason("kalshi.com.evil.io", 443, &["1.1.1.1"]),
            Reason::NotOnAllowlist
        );
        assert_eq!(
            reason("example.org", 443, &["1.1.1.1"]),
            Reason::NotOnAllowlist
        );
        assert_eq!(
            decide("kalshi.com", 443, &[ip("1.1.1.1")], &[] as &[&str]).reason,
            Reason::NotOnAllowlist
        );
        assert_eq!(
            decide("kalshi.com", 443, &[ip("1.1.1.1")], &[""]).reason,
            Reason::NotOnAllowlist
        );
    }

    #[test]
    fn refuses_ip_literals() {
        for h in [
            "169.254.169.254",
            "127.0.0.1",
            "8.8.8.8",
            "::1",
            "[::1]",
            "[fe80::1]",
            "2130706433",
            "0x7f000001",
            "127.1",
        ] {
            assert_eq!(reason(h, 443, &["8.8.8.8"]), Reason::IpLiteral, "{h}");
        }
        // Even if the literal is on the allowlist.
        assert_eq!(
            decide("1.1.1.1", 443, &[ip("1.1.1.1")], &["1.1.1.1"]).reason,
            Reason::IpLiteral
        );
    }

    #[test]
    fn refuses_other_ports() {
        for p in [80, 22, 8080, 0, 444] {
            assert_eq!(
                reason("kalshi.com", p, &["1.1.1.1"]),
                Reason::BadPort,
                "{p}"
            );
        }
    }

    #[test]
    fn dns_failure() {
        assert_eq!(reason("kalshi.com", 443, &[]), Reason::DnsFailed);
    }

    #[test]
    fn metadata_endpoint_is_blocked() {
        // An allowlisted name that resolves to the cloud metadata address.
        assert_eq!(
            reason("kalshi.com", 443, &["169.254.169.254"]),
            Reason::BlockedRange
        );
        assert_eq!(
            reason("kalshi.com", 443, &["::ffff:169.254.169.254"]),
            Reason::BlockedRange
        );
    }

    #[test]
    fn dns_rebinding_to_private_is_blocked() {
        assert_eq!(
            reason("kalshi.com", 443, &["10.0.0.5"]),
            Reason::BlockedRange
        );
        // One bad address among good ones is enough.
        assert_eq!(
            reason("api.kalshi.com", 443, &["104.18.1.1", "192.168.1.1"]),
            Reason::BlockedRange
        );
    }

    #[test]
    fn blocked_ranges() {
        let blocked = [
            "10.0.0.0",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.0.1",
            "127.0.0.1",
            "127.255.0.1",
            "169.254.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "0.1.2.3",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fe80::1",
            "febf::1",
            "fec0::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
            "::127.0.0.1",
            "64:ff9b::a00:1",
        ];
        for a in blocked {
            assert!(is_blocked(ip(a)), "{a} should be blocked");
        }
        let public = [
            "1.1.1.1",
            "8.8.8.8",
            "172.15.255.255",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "169.253.1.1",
            "192.169.0.1",
            "11.0.0.1",
            "2606:4700::1111",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
        ];
        for a in public {
            assert!(!is_blocked(ip(a)), "{a} should be public");
        }
    }

    #[test]
    fn decision_json_shape() {
        let d = decide("kalshi.com", 443, &[ip("1.1.1.1")], LIST);
        assert_eq!(
            serde_json::to_string(&d).unwrap(),
            r#"{"allowed":true,"reason":"allowlisted"}"#
        );
    }
}
