//! The HTTP API: auth, the job table and the job lifecycle.
//!
//! queued -> running -> held -> released | killed      (browse, hold=true)
//! queued -> running -> done | failed                   (browse hold=false, compute)
//! Any active state -> killed (POST kill, or hold_timeout).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};

use crate::backend::{Backend, SandboxHandle};
use crate::now;
use crate::types::*;

const BUSY_RETRY_MS: u32 = 2000;
const MAX_URLS: usize = 10;

#[derive(Debug, Clone)]
pub struct Caller {
    pub name: String,
    pub token_sha256: [u8; 32],
}

/// Parses SANDBOX_MANAGER_CALLERS: `runner:<sha256hex>[,other:<hex>]`.
pub fn parse_callers(s: &str) -> Result<Vec<Caller>, String> {
    s.split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(|e| {
            let (name, h) = e
                .split_once(':')
                .ok_or(format!("caller {e:?} is not name:sha256hex"))?;
            let bytes = hex::decode(h).map_err(|_| format!("caller {name:?}: hash is not hex"))?;
            let token_sha256 = bytes
                .try_into()
                .map_err(|_| format!("caller {name:?}: hash is not 32 bytes"))?;
            Ok(Caller {
                name: name.to_string(),
                token_sha256,
            })
        })
        .collect()
}

pub struct Config {
    pub callers: Vec<Caller>,
    /// Live sandboxes at most (queued, running, held); past it POST /jobs answers busy.
    pub slots: usize,
    /// Sandboxes starting at once at most (Chromium's cold start is the CPU peak); the
    /// rest wait queued.
    pub starting: usize,
    /// Allows http:// URLs.
    pub dev: bool,
}

struct Job {
    req: JobRequest,
    status: JobStatus,
    handle: Option<SandboxHandle>,
    held_at: Option<Instant>,
}

pub struct AppState {
    starting: Arc<tokio::sync::Semaphore>,
    cfg: Config,
    backend: Arc<dyn Backend>,
    jobs: Mutex<HashMap<String, Job>>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn new(cfg: Config, backend: Arc<dyn Backend>) -> Shared {
        Arc::new(AppState {
            starting: Arc::new(tokio::sync::Semaphore::new(cfg.starting.max(1))),
            cfg,
            backend,
            jobs: Mutex::new(HashMap::new()),
        })
    }

    fn jobs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Job>> {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn caller_for(&self, token: &str) -> Option<String> {
        let h: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        // Compare every caller in full so timing doesn't say which one nearly matched.
        let mut found = None;
        for c in &self.cfg.callers {
            let diff = c
                .token_sha256
                .iter()
                .zip(h.iter())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b));
            if diff == 0 {
                found = Some(c.name.clone());
            }
        }
        found
    }
}

/// A refused request: an ApiError with its status, or 503 Busy.
pub enum Fail {
    Api(StatusCode, ApiError),
    Busy(Busy),
}

impl IntoResponse for Fail {
    fn into_response(self) -> Response {
        match self {
            Fail::Api(status, e) => (status, Json(e)).into_response(),
            Fail::Busy(b) => {
                let secs = HeaderValue::from(b.retry_after_ms.div_ceil(1000));
                let mut res = (StatusCode::SERVICE_UNAVAILABLE, Json(b)).into_response();
                res.headers_mut().insert(header::RETRY_AFTER, secs);
                res
            }
        }
    }
}

type ApiResult = Result<Response, Fail>;

fn api_error(status: StatusCode, error: &str, message: impl Into<String>) -> Fail {
    Fail::Api(
        status,
        ApiError {
            error: error.into(),
            message: message.into(),
        },
    )
}

fn parse<T: DeserializeOwned>(body: &Bytes) -> Result<T, Fail> {
    serde_json::from_slice(body)
        .map_err(|e| api_error(StatusCode::BAD_REQUEST, "bad_request", e.to_string()))
}

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/jobs", post(create_job))
        .route("/jobs/{id}", get(get_job))
        .route("/jobs/{id}/release", post(release_job))
        .route("/jobs/{id}/kill", post(kill_job_route))
        .route("/sandboxes", get(list_sandboxes))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth))
        .route("/health", get(health))
        .layer(middleware::from_fn(log_request))
        .with_state(state)
}

async fn log_request(req: Request, next: Next) -> Response {
    let (method, path) = (req.method().clone(), req.uri().path().to_string());
    let started = Instant::now();
    let res = next.run(req).await;
    tracing::info!(
        method = %method, path, status = res.status().as_u16(),
        ms = started.elapsed().as_millis() as u64, "request"
    );
    res
}

async fn auth(State(st): State<Shared>, req: Request, next: Next) -> Response {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    match token
        .and_then(|t| t.strip_prefix("Bearer "))
        .and_then(|t| st.caller_for(t.trim()))
    {
        Some(caller) => {
            tracing::debug!(caller, "authorized");
            next.run(req).await
        }
        None => {
            tracing::warn!(path = req.uri().path(), "unauthorized");
            api_error(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "missing or unknown bearer token",
            )
            .into_response()
        }
    }
}

async fn health(State(st): State<Shared>) -> Json<Health> {
    Json(Health {
        ok: true,
        service: "sandbox-manager".into(),
        backend: st.backend.name().into(),
    })
}

fn valid_ref(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
}

fn validate(req: &JobRequest, dev: bool) -> Result<(), String> {
    for (name, v) in [
        ("job_id", &req.job_id),
        ("run_id", &req.run_id),
        ("widget_id", &req.widget_id),
    ] {
        if !valid_ref(v) {
            return Err(format!("{name} must be 1-128 chars of [A-Za-z0-9-_.:]"));
        }
    }
    match (req.kind, &req.browse, &req.compute) {
        (JobKind::Browse, Some(b), None) => {
            if b.urls.is_empty() || b.urls.len() > MAX_URLS {
                return Err(format!("browse.urls needs 1 to {MAX_URLS} URLs"));
            }
            for u in &b.urls {
                let uri: axum::http::Uri = u.parse().map_err(|_| format!("bad URL {u:?}"))?;
                let scheme_ok = match uri.scheme_str() {
                    Some("https") => true,
                    Some("http") => dev,
                    _ => false,
                };
                if !scheme_ok || uri.host().is_none() {
                    let allowed = if dev { "http(s)" } else { "https" };
                    return Err(format!("URL {u:?} must be an absolute {allowed} URL"));
                }
            }
            if b.allowlist.iter().any(|d| {
                d.is_empty()
                    || !d
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
            }) {
                return Err("browse.allowlist entries must be domain names".into());
            }
            Ok(())
        }
        (JobKind::Compute, None, Some(_)) => Ok(()),
        (JobKind::Browse, ..) => Err("kind browse needs browse and no compute".into()),
        (JobKind::Compute, ..) => Err("kind compute needs compute and no browse".into()),
    }
}

async fn create_job(State(st): State<Shared>, body: Bytes) -> ApiResult {
    let req: JobRequest = parse(&body)?;
    validate(&req, st.cfg.dev).map_err(|m| api_error(StatusCode::BAD_REQUEST, "bad_request", m))?;

    // Reserve the slot before creating the sandbox, so concurrent posts can't overfill.
    {
        let mut jobs = st.jobs();
        if let Some(job) = jobs.get(&req.job_id) {
            return Ok((StatusCode::ACCEPTED, Json(job.status.clone())).into_response());
        }
        if jobs.values().filter(|j| j.status.state.active()).count() >= st.cfg.slots {
            let busy = Busy {
                error: "busy".into(),
                retry_after_ms: BUSY_RETRY_MS,
            };
            return Err(Fail::Busy(busy));
        }
        let t = now();
        let status = JobStatus {
            job_id: req.job_id.clone(),
            sandbox_id: String::new(),
            kind: req.kind,
            state: JobState::Queued,
            backend: st.backend.name().into(),
            created_at: t.clone(),
            updated_at: t,
            limits: Limits::for_kind(req.kind),
            pages: vec![],
            compute_result: None,
            proxy_log: vec![],
            kill_reason: None,
            error: None,
            trust_log: vec![],
        };
        jobs.insert(
            req.job_id.clone(),
            Job {
                req: req.clone(),
                status,
                handle: None,
                held_at: None,
            },
        );
    }

    let created = st.backend.create(&req, &Limits::for_kind(req.kind)).await;
    let status = {
        let mut jobs = st.jobs();
        let job = jobs.get_mut(&req.job_id).expect("reserved above");
        match &created {
            Ok(h) => {
                job.status.sandbox_id = h.sandbox_id.clone();
                job.handle = Some(h.clone());
                let ids = [
                    ("job_id", req.job_id.as_str()),
                    ("run_id", req.run_id.as_str()),
                    ("widget_id", req.widget_id.as_str()),
                    ("kind", kind_name(req.kind)),
                ];
                let row = trust_row("sandbox.created", &h.sandbox_id, "ok", &ids, &[]);
                job.status.trust_log.push(row);
            }
            Err(e) => {
                job.status.state = JobState::Failed;
                job.status.error = Some(format!("create failed: {e}"));
                job.status.updated_at = now();
            }
        }
        job.status.clone()
    };
    tracing::info!(job_id = %req.job_id, run_id = %req.run_id, widget_id = %req.widget_id,
        kind = ?req.kind, sandbox_id = %status.sandbox_id, state = ?status.state, "job created");

    if let Ok(h) = created {
        if status.state == JobState::Queued {
            tokio::spawn(run_job(st.clone(), req.job_id.clone()));
        } else {
            // Killed while the sandbox was being created.
            teardown(&st, &req.job_id, &h, false).await;
        }
    }
    Ok((StatusCode::ACCEPTED, Json(status)).into_response())
}

/// Destroys a job's sandbox (killing it first if asked) and adds the rest of its proxy
/// log to the job, then the trust rows: `proxy.refused` (if any) and `sandbox.destroyed`.
/// Returns the job as it stands after.
async fn teardown(st: &Shared, id: &str, h: &SandboxHandle, kill: bool) -> Option<JobStatus> {
    if kill {
        let _ = st.backend.kill(h).await;
    }
    let destroyed = match st.backend.destroy(h).await {
        Ok(log) => Some(log),
        Err(e) => {
            tracing::warn!(job_id = id, sandbox_id = %h.sandbox_id, error = %e, "destroy failed");
            None
        }
    };
    let mut jobs = st.jobs();
    let s = &mut jobs.get_mut(id)?.status;
    if let Some(log) = destroyed {
        s.proxy_log.extend(log);
        let refused = s.proxy_log.iter().filter(|e| !e.allowed).count() as u64;
        let ids = [("job_id", id)];
        if refused > 0 {
            let sizes = [("requests", refused)];
            s.trust_log.push(trust_row(
                "proxy.refused",
                &h.sandbox_id,
                "refused",
                &ids,
                &sizes,
            ));
        }
        let sizes = [("proxy_requests", s.proxy_log.len() as u64)];
        s.trust_log.push(trust_row(
            "sandbox.destroyed",
            &h.sandbox_id,
            "ok",
            &ids,
            &sizes,
        ));
    }
    Some(s.clone())
}

fn kind_name(k: JobKind) -> &'static str {
    match k {
        JobKind::Browse => "browse",
        JobKind::Compute => "compute",
    }
}

/// A row for the trust page (TRUST_ACTIONS): ids and sizes only, each id cut to the log's 120 characters.
fn trust_row(
    action: &str,
    sandbox_id: &str,
    outcome: &str,
    ids: &[(&str, &str)],
    sizes: &[(&str, u64)],
) -> TrustLogEntry {
    TrustLogEntry {
        action: action.into(),
        at: now(),
        subject_id: Some(sandbox_id.chars().take(120).collect()),
        outcome: Some(outcome.into()),
        ids: ids
            .iter()
            .map(|(k, v)| (k.to_string(), v.chars().take(120).collect()))
            .collect(),
        sizes: sizes.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
    }
}

/// The `sandbox.killed` row, written the moment the job is marked killed.
fn killed_row(s: &JobStatus, reason: &str, audit_row_id: Option<&str>) -> TrustLogEntry {
    let mut ids = vec![("job_id", s.job_id.as_str()), ("reason", reason)];
    if let Some(a) = audit_row_id {
        ids.push(("audit_row_id", a));
    }
    trust_row("sandbox.killed", &s.sandbox_id, "killed", &ids, &[])
}

enum Outcome {
    Pages((Vec<PageOut>, Vec<ProxyLogEntry>)),
    Numbers(engine::EngineResult),
}

/// Runs a queued job to held / done / failed, unless it is killed meanwhile.
async fn run_job(st: Shared, job_id: String) {
    let Ok(_starting) = st.starting.clone().acquire_owned().await else {
        return;
    };
    let (req, handle) = {
        let mut jobs = st.jobs();
        let Some(job) = jobs.get_mut(&job_id) else {
            return;
        };
        let Some(h) = job.handle.clone() else { return };
        if job.status.state != JobState::Queued {
            return;
        }
        job.status.state = JobState::Running;
        job.status.updated_at = now();
        (job.req.clone(), h)
    };

    let wall = Duration::from_secs(Limits::for_kind(req.kind).wall_s as u64);
    let outcome = match (&req.browse, &req.compute) {
        (Some(b), _) => tokio::time::timeout(wall, st.backend.browse(&handle, b))
            .await
            .map(|r| r.map(Outcome::Pages)),
        (_, Some(c)) => tokio::time::timeout(wall, st.backend.compute(&handle, c))
            .await
            .map(|r| r.map(Outcome::Numbers)),
        _ => return,
    };

    let terminal = {
        let mut jobs = st.jobs();
        let Some(job) = jobs.get_mut(&job_id) else {
            return;
        };
        if job.status.state != JobState::Running {
            return; // killed while running; kill already destroyed it
        }
        let s = &mut job.status;
        match outcome {
            Ok(Ok(Outcome::Pages((pages, log)))) => {
                s.pages = pages;
                s.proxy_log.extend(log);
                if req.browse.as_ref().is_some_and(|b| b.hold) {
                    s.state = JobState::Held;
                    job.held_at = Some(Instant::now());
                } else {
                    s.state = JobState::Done;
                }
            }
            Ok(Ok(Outcome::Numbers(result))) => {
                s.compute_result = Some(result);
                s.state = JobState::Done;
            }
            Ok(Err(e)) => {
                s.state = JobState::Failed;
                s.error = Some(e.to_string());
            }
            Err(_) => {
                s.state = JobState::Killed;
                s.kill_reason = Some("wall_timeout".into());
                let row = killed_row(s, "wall_timeout", None);
                s.trust_log.push(row);
            }
        }
        s.updated_at = now();
        tracing::info!(job_id, sandbox_id = %s.sandbox_id, state = ?s.state, "job finished");
        !s.state.active()
    };
    if terminal {
        teardown(&st, &job_id, &handle, true).await;
    }
}

async fn get_job(State(st): State<Shared>, Path(id): Path<String>) -> ApiResult {
    match st.jobs().get(&id) {
        Some(job) => Ok(Json(job.status.clone()).into_response()),
        None => Err(api_error(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("no job {id:?}"),
        )),
    }
}

async fn release_job(State(st): State<Shared>, Path(id): Path<String>) -> ApiResult {
    let (status, handle) = {
        let mut jobs = st.jobs();
        let job = jobs.get_mut(&id).ok_or_else(|| {
            api_error(StatusCode::NOT_FOUND, "not_found", format!("no job {id:?}"))
        })?;
        if job.status.state != JobState::Held {
            let msg = format!(
                "job is {:?}; only a held job can be released",
                job.status.state
            );
            return Err(api_error(StatusCode::CONFLICT, "conflict", msg));
        }
        job.status.state = JobState::Released;
        job.status.updated_at = now();
        job.held_at = None;
        (job.status.clone(), job.handle.clone())
    };
    tracing::info!(job_id = %id, sandbox_id = %status.sandbox_id, "job released");
    let status = match handle {
        Some(h) => teardown(&st, &id, &h, false).await.unwrap_or(status),
        None => status,
    };
    Ok(Json(status).into_response())
}

async fn kill_job_route(
    State(st): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult {
    let k: KillRequest = parse(&body)?;
    kill_job(&st, &id, &k.reason, k.audit_row_id.as_deref())
        .await
        .map(|s| Json(s).into_response())
}

/// Kills an active job. Killing a killed job returns it unchanged.
pub async fn kill_job(
    st: &Shared,
    id: &str,
    reason: &str,
    audit_row_id: Option<&str>,
) -> Result<JobStatus, Fail> {
    let (status, handle) = {
        let mut jobs = st.jobs();
        let job = jobs.get_mut(id).ok_or_else(|| {
            api_error(StatusCode::NOT_FOUND, "not_found", format!("no job {id:?}"))
        })?;
        match job.status.state {
            JobState::Killed => return Ok(job.status.clone()),
            s if !s.active() => {
                return Err(api_error(
                    StatusCode::CONFLICT,
                    "conflict",
                    format!("job is already {s:?}"),
                ));
            }
            _ => {}
        }
        job.status.state = JobState::Killed;
        job.status.kill_reason = Some(reason.to_string());
        job.status.updated_at = now();
        let row = killed_row(&job.status, reason, audit_row_id);
        job.status.trust_log.push(row);
        job.held_at = None;
        (job.status.clone(), job.handle.clone())
    };
    tracing::warn!(job_id = id, sandbox_id = %status.sandbox_id, reason, audit_row_id, "job killed");
    match handle {
        Some(h) => Ok(teardown(st, id, &h, true).await.unwrap_or(status)),
        None => Ok(status),
    }
}

/// Kills held sandboxes whose hold_s has passed. Run every second by `serve`.
pub async fn sweep_holds(st: &Shared, now: Instant) {
    let expired: Vec<String> = st
        .jobs()
        .values()
        .filter(|j| j.status.state == JobState::Held)
        .filter(|j| {
            j.held_at
                .is_some_and(|t| now >= t + Duration::from_secs(j.status.limits.hold_s as u64))
        })
        .map(|j| j.status.job_id.clone())
        .collect();
    for id in expired {
        let _ = kill_job(st, &id, "hold_timeout", None).await;
    }
}

async fn list_sandboxes(State(st): State<Shared>) -> Json<SandboxList> {
    let jobs = st.jobs();
    let mut sandboxes: Vec<SandboxInfo> = jobs
        .values()
        .filter(|j| j.status.state.active())
        .map(|j| SandboxInfo {
            sandbox_id: j.status.sandbox_id.clone(),
            job_id: j.status.job_id.clone(),
            kind: j.status.kind,
            state: j.status.state,
            created_at: j.status.created_at.clone(),
        })
        .collect();
    sandboxes.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then(a.job_id.cmp(&b.job_id))
    });
    Json(SandboxList {
        backend: st.backend.name().into(),
        slots_total: st.cfg.slots as u32,
        slots_used: sandboxes.len() as u32,
        sandboxes,
    })
}

/// The API contract printed by `--schema`.
pub fn schema_doc() -> serde_json::Value {
    use serde_json::json;
    let p = |method: &str, path: &str, request: Option<&str>, responses: &[(&str, &str)]| {
        let r: serde_json::Map<_, _> = responses
            .iter()
            .map(|(k, v)| (k.to_string(), json!(v)))
            .collect();
        json!({"method": method, "path": path, "request": request, "responses": r})
    };
    let auth = ("401", "ApiError");
    json!({
        "version": "0",
        "paths": [
            p("GET", "/health", None, &[("200", "Health")]),
            p("POST", "/jobs", Some("JobRequest"), &[("202", "JobStatus"), ("400", "ApiError"), auth, ("503", "Busy")]),
            p("GET", "/jobs/{id}", None, &[("200", "JobStatus"), auth, ("404", "ApiError")]),
            p("POST", "/jobs/{id}/release", None, &[("200", "JobStatus"), auth, ("404", "ApiError"), ("409", "ApiError")]),
            p("POST", "/jobs/{id}/kill", Some("KillRequest"),
                &[("200", "JobStatus"), ("400", "ApiError"), auth, ("404", "ApiError"), ("409", "ApiError")]),
            p("GET", "/sandboxes", None, &[("200", "SandboxList"), auth]),
        ],
        "schemas": {
            "Health": schemars::schema_for!(Health),
            "JobRequest": schemars::schema_for!(JobRequest),
            "JobStatus": schemars::schema_for!(JobStatus),
            "KillRequest": schemars::schema_for!(KillRequest),
            "Busy": schemars::schema_for!(Busy),
            "SandboxList": schemars::schema_for!(SandboxList),
            "ApiError": schemars::schema_for!(ApiError),
        }
    })
}
