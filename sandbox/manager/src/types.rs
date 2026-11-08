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
    /// The trust page's log rows for this job, in the order they happened. The caller adds account_id and
    /// appends each one to the log as service "sandbox-manager".
    #[serde(default)]
    pub trust_log: Vec<TrustLogEntry>,
}

/// One log row in the shape of the trust page's actions (TRUST_ACTIONS in packages/contracts/src/api/audit.ts):
/// `sandbox.created`, `sandbox.killed` and `sandbox.destroyed` with subject_id = the sandbox id, and one
/// `proxy.refused` per job with `sizes.requests` = how many requests the proxy refused. Ids and sizes only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TrustLogEntry {
    /// e.g. "sandbox.killed".
    pub action: String,
    /// RFC 3339.
    pub at: String,
    pub subject_id: Option<String>,
    /// "ok", "refused" or "killed".
    pub outcome: Option<String>,
    #[serde(default)]
    pub ids: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub sizes: std::collections::BTreeMap<String, u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageOut {
    pub url: String,
    pub status: u16,
    /// All of the page's text, cut to the output limit: visible and hidden text and HTML comments, not scripts or styles.
    pub text: String,
    /// What a person sees on the page (`document.body.innerText`), cut to the output limit. Absent from a backend that has no browser.
    pub visible_text: Option<String>,
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
    // From the VX1 spike (Nov 7, gVisor 16/16): 1 CPU, 1 GB with no swap, 256 processes,
    // a 512 MB /tmp. The hold's hard cap stays open in the architecture.
    pub const BROWSE: Limits = Limits {
        cpu_millis: 1000,
        memory_mb: 1024,
        pids: 256,
        wall_s: 30,
        hold_s: 60,
        disk_mb: 512,
        output_kb: 2048,
    };
    // The engine's own checked flags (engine/README.md): 64 MB, 8 processes.
    // 15 s: a board's first numbers box took more than 5 s on a loaded machine (RUN_RULES.timeoutsMs.compute waits longer).
    pub const COMPUTE: Limits = Limits {
        cpu_millis: 1000,
        memory_mb: 64,
        pids: 8,
        wall_s: 15,
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
