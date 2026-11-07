//! The manager's API types. `sandbox-manager --schema` prints them as JSON Schema.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    /// Open pages in a browser behind the egress proxy.
    Browse,
    /// Run the math engine on an EngineInput.
    Compute,
}

/// POST /jobs. Exactly one of `browse` / `compute` is set, matching `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct JobRequest {
    /// Caller-chosen, unique. Posting the same job_id again returns the existing job.
    pub job_id: String,
    pub run_id: String,
    pub widget_id: String,
    pub kind: JobKind,
    pub browse: Option<BrowseSpec>,
    pub compute: Option<ComputeSpec>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrowseSpec {
    /// https only (http too when SANDBOX_MANAGER_DEV=1). 1 to 10 URLs.
    pub urls: Vec<String>,
    /// Domains the sandbox may reach; subdomains included.
    pub allowlist: Vec<String>,
    #[serde(default)]
    pub screenshot: bool,
    /// Keep the sandbox open after the pages load, until release, kill or hold_s.
    #[serde(default = "yes")]
    pub hold: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ComputeSpec {
    pub engine_input: engine::EngineInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Held,
    Released,
    Killed,
    Done,
    Failed,
}

impl JobState {
    /// Queued, running and held jobs occupy a slot.
    pub fn active(self) -> bool {
        matches!(self, JobState::Queued | JobState::Running | JobState::Held)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct JobStatus {
    pub job_id: String,
    /// "sbx-" + random hex.
    pub sandbox_id: String,
    pub kind: JobKind,
    pub state: JobState,
    pub backend: String,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub updated_at: String,
    pub limits: Limits,
    pub pages: Vec<PageOut>,
    pub compute_result: Option<engine::EngineResult>,
    pub proxy_log: Vec<ProxyLogEntry>,
    pub kill_reason: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageOut {
    pub url: String,
    pub status: u16,
    /// Visible text of the page, cut to the output limit.
    pub text: String,
    pub screenshot_png_b64: Option<String>,
}

/// Why the egress proxy allowed or refused a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProxyReason {
    Allowlisted,
    NotOnAllowlist,
    IpLiteral,
    BadPort,
    BlockedRange,
    DnsFailed,
}

/// One connection the sandbox asked the egress proxy for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProxyLogEntry {
    /// RFC 3339.
    pub at: String,
    pub sandbox_id: String,
    pub host: String,
    pub port: u16,
    pub allowed: bool,
    pub reason: ProxyReason,
}

/// POST /jobs/{id}/kill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct KillRequest {
    pub reason: String,
    /// The audit row that records who asked for the kill, if any.
    pub audit_row_id: Option<String>,
}

/// Resource limits for one sandbox. Defaults are placeholders, set from the spike.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Limits {
    pub cpu_millis: u32,
    pub memory_mb: u32,
    pub pids: u32,
    pub wall_s: u32,
    pub hold_s: u32,
    pub disk_mb: u32,
    pub output_kb: u32,
}

impl Limits {
    // Set from the spike.
    pub const BROWSE: Limits = Limits {
        cpu_millis: 1000,
        memory_mb: 1024,
        pids: 256,
        wall_s: 30,
        hold_s: 60,
        disk_mb: 256,
        output_kb: 2048,
    };
    // Set from the spike.
    pub const COMPUTE: Limits = Limits {
        cpu_millis: 1000,
        memory_mb: 128,
        pids: 32,
        wall_s: 5,
        hold_s: 0,
        disk_mb: 16,
        output_kb: 256,
    };

    pub fn for_kind(kind: JobKind) -> Limits {
        match kind {
            JobKind::Browse => Limits::BROWSE,
            JobKind::Compute => Limits::COMPUTE,
        }
    }
}

/// 503 from POST /jobs when every slot is taken.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Busy {
    /// Always "busy".
    pub error: String,
    pub retry_after_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SandboxList {
    pub backend: String,
    pub slots_total: u32,
    pub slots_used: u32,
    /// Active sandboxes (queued, running, held).
    pub sandboxes: Vec<SandboxInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SandboxInfo {
    pub sandbox_id: String,
    pub job_id: String,
    pub kind: JobKind,
    pub state: JobState,
    pub created_at: String,
}

/// Every non-2xx response except 503 Busy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ApiError {
    /// Machine code: unauthorized, bad_request, not_found, conflict, backend.
    pub error: String,
    pub message: String,
}

/// GET /health.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Health {
    pub ok: bool,
    pub service: String,
    pub backend: String,
}
