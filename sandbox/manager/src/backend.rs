//! Sandbox backends. A backend creates one sandbox per job, runs the job inside it,
//! and destroys it after; nothing is reused between jobs.
//!
//! - `docker` (`docker::DockerBackend` on runc): local development and tests.
//! - `gvisor`: the same backend with `--runtime runsc` (the production default).
//! - `stub`: touches no Docker. Browse returns no pages and one proxy log entry per URL
//!   host; compute runs the engine in process. For unit tests and quick runs.
//! - `microvm` (Microsandbox): waits for the spike's answer.

use std::fmt;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;

use axum::http::Uri;

use crate::docker::{DockerBackend, DockerConfig};
use crate::now;
use crate::types::{
    BrowseSpec, ComputeSpec, JobRequest, Limits, PageOut, ProxyLogEntry, ProxyReason,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxHandle {
    pub sandbox_id: String,
    pub job_id: String,
    /// The sandbox's address on the sandbox network (browse on docker only).
    pub ip: Option<IpAddr>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendError(pub String);

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = Result<T, BackendError>> + Send + 'a>>;

/// Object-safe so the manager can hold an `Arc<dyn Backend>` chosen at startup.
pub trait Backend: Send + Sync {
    fn name(&self) -> &'static str;
    fn create<'a>(&'a self, req: &'a JobRequest, limits: &'a Limits) -> BoxFut<'a, SandboxHandle>;
    /// Reads the pages. The sandbox stays up after (the hold); the log is the proxy's so far.
    fn browse<'a>(
        &'a self,
        sb: &'a SandboxHandle,
        spec: &'a BrowseSpec,
    ) -> BoxFut<'a, (Vec<PageOut>, Vec<ProxyLogEntry>)>;
    fn compute<'a>(
        &'a self,
        sb: &'a SandboxHandle,
        spec: &'a ComputeSpec,
    ) -> BoxFut<'a, engine::EngineResult>;
    /// Stops everything in the sandbox now.
    fn kill<'a>(&'a self, sb: &'a SandboxHandle) -> BoxFut<'a, ()>;
    /// Removes the sandbox and its disk. Returns the rest of its proxy log.
    fn destroy<'a>(&'a self, sb: &'a SandboxHandle) -> BoxFut<'a, Vec<ProxyLogEntry>>;
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// The backend named by SANDBOX_BACKEND (default "docker"), configured from the env.
/// `dev` (SANDBOX_MANAGER_DEV=1) is required for the dev-only settings.
pub async fn from_env(dev: bool) -> Result<Arc<dyn Backend>, String> {
    let name = env("SANDBOX_BACKEND").unwrap_or_else(|| "docker".into());
    let runtime = match name.as_str() {
        "stub" => return Ok(Arc::new(StubBackend)),
        "docker" => env("SANDBOX_RUNTIME").unwrap_or_else(|| "runc".into()),
        "gvisor" => env("SANDBOX_RUNTIME").unwrap_or_else(|| "runsc".into()),
        other => {
            return Err(format!(
                "SANDBOX_BACKEND={other:?} is not supported (docker, gvisor or stub)"
            ));
        }
    };
    let cfg = DockerConfig::from_env(runtime, dev)?;
    Ok(Arc::new(DockerBackend::start(cfg).await?))
}

pub fn new_sandbox_id() -> String {
    format!("sbx-{:016x}", rand::random::<u64>())
}

/// Touches no Docker.
pub struct StubBackend;

impl Backend for StubBackend {
    fn name(&self) -> &'static str {
        "stub"
    }

    fn create<'a>(&'a self, req: &'a JobRequest, _limits: &'a Limits) -> BoxFut<'a, SandboxHandle> {
        Box::pin(async move {
            Ok(SandboxHandle {
                sandbox_id: new_sandbox_id(),
                job_id: req.job_id.clone(),
                ip: None,
            })
        })
    }

    fn browse<'a>(
        &'a self,
        sb: &'a SandboxHandle,
        spec: &'a BrowseSpec,
    ) -> BoxFut<'a, (Vec<PageOut>, Vec<ProxyLogEntry>)> {
        Box::pin(async move {
            let log = spec
                .urls
                .iter()
                .filter_map(|u| u.parse::<Uri>().ok())
                .filter_map(|u| {
                    let port = u.port_u16().unwrap_or(if u.scheme_str() == Some("http") {
                        80
                    } else {
                        443
                    });
                    Some((u.host()?.to_ascii_lowercase(), port))
                })
                .map(|(host, port)| {
                    let allowed = egress_proxy::on_allowlist(&host, &spec.allowlist);
                    ProxyLogEntry {
                        at: now(),
                        sandbox_id: sb.sandbox_id.clone(),
                        host,
                        port,
                        allowed,
                        reason: if allowed {
                            ProxyReason::Allowlisted
                        } else {
                            ProxyReason::NotOnAllowlist
                        },
                    }
                })
                .collect();
            Ok((Vec::new(), log))
        })
    }

    fn compute<'a>(
        &'a self,
        _sb: &'a SandboxHandle,
        spec: &'a ComputeSpec,
    ) -> BoxFut<'a, engine::EngineResult> {
        Box::pin(async move { Ok(engine::run(&spec.engine_input)) })
    }

    fn kill<'a>(&'a self, _sb: &'a SandboxHandle) -> BoxFut<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn destroy<'a>(&'a self, _sb: &'a SandboxHandle) -> BoxFut<'a, Vec<ProxyLogEntry>> {
        Box::pin(async { Ok(vec![]) })
    }
}

/// The proxy's log entry as the manager's API type.
pub fn from_proxy(e: egress_proxy::control::LogEntry) -> ProxyLogEntry {
    use egress_proxy::Reason as R;
    ProxyLogEntry {
        at: e.at,
        sandbox_id: e.sandbox_id,
        host: e.host,
        port: e.port,
        allowed: e.allowed,
        reason: match e.reason {
            R::Allowlisted => ProxyReason::Allowlisted,
            R::NotOnAllowlist => ProxyReason::NotOnAllowlist,
            R::IpLiteral => ProxyReason::IpLiteral,
            R::BadPort => ProxyReason::BadPort,
            R::BlockedRange => ProxyReason::BlockedRange,
            R::DnsFailed => ProxyReason::DnsFailed,
        },
    }
}
