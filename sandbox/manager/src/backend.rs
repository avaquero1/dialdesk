//! Sandbox backends. A backend creates one sandbox per job, runs the job inside it,
//! and destroys it after; nothing is reused between jobs.
//!
//! Phase 0 has one backend, `docker`, and it is a STUB: it starts no containers.
//! Browse returns no pages and one proxy log entry per URL host; compute runs the
//! engine in-process. The real `docker` backend (Phase 1) runs plain runc and is
//! for local development only. The `gvisor` and `microvm` backends, which give the
//! production isolation, come in Phase 1 too.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::http::Uri;

use crate::now;
use crate::types::{
    BrowseSpec, ComputeSpec, JobRequest, Limits, PageOut, ProxyLogEntry, ProxyReason,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxHandle {
    pub sandbox_id: String,
    pub job_id: String,
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
    /// Removes the sandbox and its disk.
    fn destroy<'a>(&'a self, sb: &'a SandboxHandle) -> BoxFut<'a, ()>;
}

/// Picks the backend named by SANDBOX_BACKEND (default "docker").
pub fn from_name(name: &str) -> Result<Arc<dyn Backend>, String> {
    match name {
        "docker" => Ok(Arc::new(DockerBackend)),
        other => Err(format!(
            "SANDBOX_BACKEND={other:?} is not supported yet (only \"docker\")"
        )),
    }
}

pub fn new_sandbox_id() -> String {
    format!("sbx-{:016x}", rand::random::<u64>())
}

/// Phase 0 stub: touches no Docker.
pub struct DockerBackend;

impl Backend for DockerBackend {
    fn name(&self) -> &'static str {
        "docker"
    }

    fn create<'a>(&'a self, req: &'a JobRequest, _limits: &'a Limits) -> BoxFut<'a, SandboxHandle> {
        Box::pin(async move {
            Ok(SandboxHandle {
                sandbox_id: new_sandbox_id(),
                job_id: req.job_id.clone(),
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
                    let allowed = on_allowlist(&host, &spec.allowlist);
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

    fn destroy<'a>(&'a self, _sb: &'a SandboxHandle) -> BoxFut<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

/// Exact domain or a subdomain of one (the egress proxy's rule).
fn on_allowlist(host: &str, allowlist: &[String]) -> bool {
    let host = host.trim_end_matches('.');
    allowlist
        .iter()
        .map(|d| d.trim_end_matches('.').to_ascii_lowercase())
        .filter(|d| !d.is_empty())
        .any(|d| {
            host == d
                || host
                    .strip_suffix(d.as_str())
                    .is_some_and(|rest| rest.ends_with('.'))
        })
}
