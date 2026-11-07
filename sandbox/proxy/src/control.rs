//! The control socket between sandbox-manager and the proxy: a Unix socket, one JSON
//! request line and one JSON response line per connection. Only the manager's user can
//! open it (mode 0600), and no sandbox can reach it: it is not on any network.
//!
//! The manager registers each sandbox's source address with its job's allowlist before
//! the sandbox starts, drains the request log when the pages are read, and unregisters
//! (taking the rest of the log) when the sandbox is destroyed. The proxy never calls out.

use std::net::IpAddr;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::Reason;

/// Longest request or response line, in bytes.
pub const MAX_LINE: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    /// Connections from `source` belong to `sandbox_id` and may reach `allowlist` only.
    Register {
        source: IpAddr,
        sandbox_id: String,
        allowlist: Vec<String>,
    },
    /// Returns the log so far and clears it; the mapping stays.
    Drain {
        sandbox_id: String,
    },
    /// Returns the rest of the log and forgets the sandbox.
    Unregister {
        sandbox_id: String,
    },
    Health,
}

/// One connection a sandbox asked for. Same JSON as the manager's ProxyLogEntry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    /// RFC 3339.
    pub at: String,
    pub sandbox_id: String,
    pub host: String,
    pub port: u16,
    pub allowed: bool,
    pub reason: Reason,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub log: Vec<LogEntry>,
    /// Entries not kept because the sandbox passed the log cap.
    #[serde(default)]
    pub dropped: u64,
}

/// Sends one request to the proxy's control socket.
pub async fn call(socket: &Path, req: &Request) -> Result<Response, String> {
    let fut = async {
        let mut s = UnixStream::connect(socket)
            .await
            .map_err(|e| format!("proxy control {}: {e}", socket.display()))?;
        let mut line = serde_json::to_vec(req).map_err(|e| e.to_string())?;
        line.push(b'\n');
        s.write_all(&line).await.map_err(|e| e.to_string())?;
        let mut r = BufReader::new(s);
        let mut out = String::new();
        r.read_line(&mut out).await.map_err(|e| e.to_string())?;
        let res: Response =
            serde_json::from_str(&out).map_err(|e| format!("proxy control: bad response: {e}"))?;
        if res.ok {
            Ok(res)
        } else {
            Err(format!(
                "proxy control: {}",
                res.error.unwrap_or_else(|| "refused".into())
            ))
        }
    };
    tokio::time::timeout(Duration::from_secs(5), fut)
        .await
        .map_err(|_| "proxy control: timed out".to_string())?
}
