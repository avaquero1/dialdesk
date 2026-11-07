//! The `docker` backend: one container per job, through the docker CLI. The runtime is a
//! setting, so `gvisor` is this backend with `--runtime runsc`.
//!
//! Every sandbox gets the same hardening: not root (uid 10001), every capability dropped,
//! no-new-privileges, a read-only root with small tmpfs mounts, memory (no swap), CPU,
//! process and open-file caps, no env from the manager, no host folders (only an empty,
//! read-only resolv.conf, so nothing inside can resolve a name), no Docker socket, and no
//! log on disk (`--log-driver none`: page text never lands in Docker's logs).
//!
//! - browse: on the sandbox network at an address the manager picks, registered with the
//!   egress proxy (with the job's allowlist) before the container starts. Its only route
//!   out is the proxy. The driver prints one JSON event per line; after `ready` the
//!   container keeps running (the hold) until release or kill destroys it.
//! - compute: `--network none`. The engine image (engine/Dockerfile, `make engine-image`)
//!   reads an EngineInput on stdin and writes an EngineResult on stdout. The engine has no
//!   time limit of its own: the manager's wall cap kills the sandbox.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::backend::{Backend, BackendError, BoxFut, SandboxHandle, from_proxy, new_sandbox_id};
use crate::types::{BrowseSpec, ComputeSpec, JobKind, JobRequest, Limits, PageOut, ProxyLogEntry};

/// The uid and gid every sandbox runs as (the `sbx` user in the images).
pub const SANDBOX_USER: &str = "10001:10001";
/// Slack on top of output_kb for the event framing.
const OUTPUT_SLACK: usize = 16 * 1024;

/// Under gVisor, the least `--pids-limit` (host tasks: the Sentry's threads plus the sandbox's).
const RUNSC_PIDS_BACKSTOP: u32 = 1024;

#[derive(Debug, Clone)]
pub struct DockerConfig {
    /// The docker CLI (DOCKER_HOST and friends come from the manager's env).
    pub docker: String,
    /// runc, runsc, runsc-kvm.
    pub runtime: String,
    pub browse_image: String,
    pub compute_image: String,
    /// The Docker network browse sandboxes join. Its only way out is the proxy.
    pub network: String,
    /// The proxy as a sandbox sees it, e.g. http://172.30.79.2:8201.
    pub proxy_url: String,
    pub proxy_control: PathBuf,
    /// Chromium's own sandbox: off, on, or auto (try on, fall back to off).
    pub chromium_sandbox: String,
    /// DEV ONLY: the fixture certificate's SPKI pin, passed to Chromium.
    pub dev_spki: Option<String>,
    /// Prefix of container names and the `vha.instance` label.
    pub instance: String,
    pub state_dir: PathBuf,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

impl DockerConfig {
    pub fn from_env(runtime: String, dev: bool) -> Result<DockerConfig, String> {
        let need = |n: &str| env(n).ok_or(format!("{n} is required for the docker backend"));
        let dev_spki = env("SANDBOX_DEV_SPKI");
        if dev_spki.is_some() && !dev {
            return Err("SANDBOX_DEV_SPKI needs SANDBOX_MANAGER_DEV=1".into());
        }
        let instance = env("SANDBOX_INSTANCE").unwrap_or_else(|| "vha".into());
        if !instance
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("SANDBOX_INSTANCE must be [A-Za-z0-9-]".into());
        }
        // The VX1 spike: Chromium's own sandbox works under gVisor. Docker's seccomp blocks it on runc.
        let default_cs = if runtime.starts_with("runsc") {
            "on"
        } else {
            "off"
        };
        let chromium_sandbox = env("SANDBOX_CHROMIUM_SANDBOX").unwrap_or_else(|| default_cs.into());
        if !["off", "on", "auto"].contains(&chromium_sandbox.as_str()) {
            return Err("SANDBOX_CHROMIUM_SANDBOX must be off, on or auto".into());
        }
        let state_dir = env("SANDBOX_STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::temp_dir()
                    .join(format!("{instance}-sandbox-manager-{}", std::process::id()))
            });
        Ok(DockerConfig {
            docker: env("SANDBOX_DOCKER").unwrap_or_else(|| "docker".into()),
            runtime,
            browse_image: env("SANDBOX_BROWSE_IMAGE").unwrap_or_else(|| "vha-browse:dev".into()),
            compute_image: env("SANDBOX_COMPUTE_IMAGE")
                .unwrap_or_else(|| "vha-engine-compute:dev".into()),
            network: need("SANDBOX_NETWORK")?,
            proxy_url: need("SANDBOX_PROXY_URL")?,
            proxy_control: need("SANDBOX_PROXY_CONTROL")?.into(),
            chromium_sandbox,
            dev_spki,
            instance,
            state_dir,
        })
    }
}

/// Free addresses on the sandbox network.
struct IpPool {
    first: u32,
    last: u32,
    taken: HashSet<Ipv4Addr>,
}

impl IpPool {
    fn take(&mut self, skip: &HashSet<Ipv4Addr>) -> Option<Ipv4Addr> {
        let ip = (self.first..=self.last)
            .map(Ipv4Addr::from)
            .find(|ip| !self.taken.contains(ip) && !skip.contains(ip))?;
        self.taken.insert(ip);
        Some(ip)
    }
    fn free(&mut self, ip: Ipv4Addr) {
        self.taken.remove(&ip);
    }
}

struct Live {
    name: String,
    kind: JobKind,
    limits: Limits,
    /// The `docker start -a` client of a held browse sandbox.
    attach: Option<Child>,
}

pub struct DockerBackend {
    cfg: DockerConfig,
    pool: Mutex<IpPool>,
    live: Mutex<HashMap<String, Live>>,
}

fn err(m: impl Into<String>) -> BackendError {
    BackendError(m.into())
}

/// Runs one docker CLI command; its stdout, or its stderr as the error.
async fn run(docker: &str, args: &[&str]) -> Result<String, BackendError> {
    let out = Command::new(docker)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| err(format!("{docker}: {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        Err(err(format!(
            "docker {}: {}",
            args.first().unwrap_or(&""),
            stderr.trim().chars().take(400).collect::<String>()
        )))
    }
}

#[derive(Deserialize)]
struct IpamConfig {
    #[serde(rename = "Subnet")]
    subnet: String,
    #[serde(rename = "Gateway", default)]
    gateway: String,
}

#[derive(Deserialize)]
struct NetContainer {
    #[serde(rename = "IPv4Address", default)]
    ipv4: String,
}

#[derive(Deserialize)]
struct NetInspect {
    #[serde(rename = "IPAM")]
    ipam: Ipam,
    #[serde(rename = "Containers", default)]
    containers: HashMap<String, NetContainer>,
}

#[derive(Deserialize)]
struct Ipam {
    #[serde(rename = "Config", default)]
    config: Vec<IpamConfig>,
}

fn parse_cidr(s: &str) -> Option<(u32, u32)> {
    let (ip, len) = s.split_once('/')?;
    let ip: Ipv4Addr = ip.parse().ok()?;
    let len: u32 = len.parse().ok()?;
    if !(8..=30).contains(&len) {
        return None;
    }
    let mask = u32::MAX << (32 - len);
    let net = u32::from(ip) & mask;
    Some((net, net | !mask))
}

/// One event from the browse driver.
#[derive(Deserialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
enum Event {
    Launched {
        chromium: String,
        sandbox: String,
        fallback: bool,
    },
    Page {
        url: String,
        status: u16,
        text: String,
        screenshot_png_b64: Option<String>,
        error: Option<String>,
    },
    Ready,
    Error {
        stage: String,
        message: String,
    },
}

/// What one probe run in a fresh sandbox did (`sandbox-manager probe`).
#[derive(Debug, Serialize)]
pub struct ProbeReport {
    pub sandbox_id: String,
    pub runtime: String,
    pub exit_code: Option<i64>,
    pub oom_killed: bool,
    /// The wall cap ended it.
    pub timed_out: bool,
    pub ms: u64,
    /// The probe's JSON lines (the last 50).
    pub lines: Vec<serde_json::Value>,
    pub proxy_log: Vec<ProxyLogEntry>,
    pub gone_after: bool,
}

impl DockerBackend {
    /// Checks Docker, the network, the proxy and the images; removes this instance's
    /// leftover sandboxes (from a crash: no sandbox outlives its job).
    pub async fn start(cfg: DockerConfig) -> Result<DockerBackend, String> {
        let d = cfg.docker.as_str();
        run(d, &["version", "--format", "{{.Server.Version}}"])
            .await
            .map_err(|e| format!("docker is not reachable: {e}"))?;
        let runtimes = run(d, &["info", "--format", "{{json .Runtimes}}"])
            .await
            .map_err(|e| e.to_string())?;
        if !runtimes.contains(&format!("\"{}\"", cfg.runtime)) {
            return Err(format!(
                "Docker runtime {:?} is not registered",
                cfg.runtime
            ));
        }
        for img in [&cfg.browse_image, &cfg.compute_image] {
            run(d, &["image", "inspect", "--format", "{{.Id}}", img])
                .await
                .map_err(|_| {
                    format!("image {img} is missing (make images and make engine-image build them)")
                })?;
        }
        let net = run(
            d,
            &["network", "inspect", "--format", "{{json .}}", &cfg.network],
        )
        .await
        .map_err(|e| format!("network {}: {e}", cfg.network))?;
        let net: NetInspect =
            serde_json::from_str(&net).map_err(|e| format!("network inspect: {e}"))?;
        let ipam = net
            .ipam
            .config
            .iter()
            .find(|c| parse_cidr(&c.subnet).is_some())
            .ok_or(format!("network {} has no IPv4 subnet", cfg.network))?;
        let (lo, hi) = parse_cidr(&ipam.subnet).expect("checked");
        let mut taken: HashSet<Ipv4Addr> = net
            .containers
            .values()
            .filter_map(|c| c.ipv4.split('/').next()?.parse().ok())
            .collect();
        if let Ok(gw) = ipam.gateway.parse() {
            taken.insert(gw);
        }
        if let Some(Ok(IpAddr::V4(p))) = cfg
            .proxy_url
            .split("://")
            .nth(1)
            .and_then(|r| r.rsplit_once(':'))
            .map(|(h, _)| h.parse::<IpAddr>())
        {
            taken.insert(p);
        }
        // Skip .0-.9: the gateway and the proxy usually live there.
        let first = lo + 10;
        let last = (hi - 1).min(first + 4096);
        if first > last {
            return Err(format!("network {} is too small", cfg.network));
        }
        egress_proxy::control::call(&cfg.proxy_control, &egress_proxy::control::Request::Health)
            .await
            .map_err(|e| format!("egress proxy: {e}"))?;
        std::fs::create_dir_all(&cfg.state_dir).map_err(|e| format!("state dir: {e}"))?;
        // Mounted read-only over /etc/resolv.conf: no resolver inside a sandbox.
        std::fs::write(cfg.state_dir.join("resolv.conf"), b"")
            .map_err(|e| format!("state dir: {e}"))?;
        let b = DockerBackend {
            cfg,
            pool: Mutex::new(IpPool { first, last, taken }),
            live: Mutex::new(HashMap::new()),
        };
        let removed = b.remove_leftovers().await;
        tracing::info!(runtime = %b.cfg.runtime, network = %b.cfg.network, subnet = %ipam.subnet,
            browse_image = %b.cfg.browse_image, compute_image = %b.cfg.compute_image,
            chromium_sandbox = %b.cfg.chromium_sandbox, removed, "docker backend ready");
        Ok(b)
    }

    async fn remove_leftovers(&self) -> usize {
        let filter = format!("label=vha.instance={}", self.cfg.instance);
        let ids = run(&self.cfg.docker, &["ps", "-aq", "--filter", &filter])
            .await
            .unwrap_or_default();
        let ids: Vec<&str> = ids.split_whitespace().collect();
        if !ids.is_empty() {
            let mut args = vec!["rm", "-f"];
            args.extend(&ids);
            let _ = run(&self.cfg.docker, &args).await;
        }
        ids.len()
    }

    fn live(&self) -> std::sync::MutexGuard<'_, HashMap<String, Live>> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pool(&self) -> std::sync::MutexGuard<'_, IpPool> {
        self.pool.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn container_name(&self, sandbox_id: &str) -> String {
        format!("{}-{}", self.cfg.instance, sandbox_id)
    }

    /// The `docker create` flags every sandbox gets.
    fn hardening(&self, sandbox_id: &str, kind: &str, l: &Limits) -> Vec<String> {
        let mut a: Vec<String> = vec![
            "--name".into(),
            self.container_name(sandbox_id),
            "--label".into(),
            format!("vha.instance={}", self.cfg.instance),
            "--label".into(),
            format!("vha.sandbox={sandbox_id}"),
            "--label".into(),
            format!("vha.kind={kind}"),
            "--runtime".into(),
            self.cfg.runtime.clone(),
            "--user".into(),
            SANDBOX_USER.into(),
            "--cap-drop".into(),
            "ALL".into(),
            "--security-opt".into(),
            "no-new-privileges".into(),
            "--read-only".into(),
            "--tmpfs".into(),
            format!("/tmp:rw,nosuid,nodev,noexec,size={}m", l.disk_mb),
            "--tmpfs".into(),
            "/home/sbx:rw,nosuid,nodev,noexec,size=16m,uid=10001,gid=10001".into(),
            "--shm-size".into(),
            "64m".into(),
            "--memory".into(),
            format!("{}m", l.memory_mb),
            "--memory-swap".into(),
            format!("{}m", l.memory_mb),
            "--cpus".into(),
            format!("{:.3}", l.cpu_millis as f64 / 1000.0),
            "--ulimit".into(),
            "nofile=4096:4096".into(),
            "--ulimit".into(),
            "core=0".into(),
            "--init".into(),
            "--log-driver".into(),
            "none".into(),
            "--no-healthcheck".into(),
            "--hostname".into(),
            "sbx".into(),
            "--stop-timeout".into(),
            "1".into(),
        ];
        // The process cap. Under gVisor the sandbox has its own kernel, so RLIMIT_NPROC counts
        // only its processes; --pids-limit there counts host tasks, and a fork bomb would kill
        // the whole sandbox instead of being held (the VX1 spike). On runc RLIMIT_NPROC counts
        // uid 10001 across every sandbox on the host, so the cgroup's pids limit is the cap.
        // The host backstop is never under RUNSC_PIDS_BACKSTOP: the Sentry's own threads count
        // against it, and compute's 8 x 4 = 32 left the engine unable to start on the VX1
        // (tini: "exec /engine failed: Cannot allocate memory").
        if self.cfg.runtime.starts_with("runsc") {
            a.extend([
                "--ulimit".into(),
                format!("nproc={0}:{0}", l.pids),
                "--pids-limit".into(),
                (l.pids * 4).max(RUNSC_PIDS_BACKSTOP).to_string(),
            ]);
        } else {
            a.extend(["--pids-limit".into(), l.pids.to_string()]);
        }
        a
    }

    fn network_flags(&self, ip: Ipv4Addr) -> Vec<String> {
        vec![
            "--network".into(),
            self.cfg.network.clone(),
            "--ip".into(),
            ip.to_string(),
            "-v".into(),
            format!(
                "{}:/etc/resolv.conf:ro",
                self.cfg.state_dir.join("resolv.conf").display()
            ),
        ]
    }

    fn driver_args(&self, spec: &BrowseSpec, l: &Limits) -> Vec<String> {
        let mut a = vec![
            "--proxy".to_string(),
            self.cfg.proxy_url.clone(),
            "--sandbox".into(),
            self.cfg.chromium_sandbox.clone(),
            "--output-kb".into(),
            l.output_kb.to_string(),
            "--max-life".into(),
            (l.wall_s + l.hold_s + 10).to_string(),
        ];
        if spec.screenshot {
            a.push("--screenshot".into());
        }
        if let Some(spki) = &self.cfg.dev_spki {
            a.push("--spki".into());
            a.push(spki.clone());
        }
        for u in &spec.urls {
            a.push("--url".into());
            a.push(u.clone());
        }
        a
    }

    /// Creates a container on the sandbox network and registers it with the proxy.
    /// Returns its address. Nothing runs until `docker start`.
    async fn create_networked(
        &self,
        sandbox_id: &str,
        kind: &str,
        l: &Limits,
        image: &str,
        cmd: &[String],
        allowlist: &[String],
    ) -> Result<Ipv4Addr, BackendError> {
        let mut skip = HashSet::new();
        let mut last_err = err("no free address on the sandbox network");
        for _ in 0..5 {
            let Some(ip) = self.pool().take(&skip) else {
                break;
            };
            let mut args = vec!["create".to_string()];
            args.extend(self.hardening(sandbox_id, kind, l));
            args.extend(self.network_flags(ip));
            args.push(image.to_string());
            args.extend(cmd.iter().cloned());
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            match run(&self.cfg.docker, &refs).await {
                Ok(_) => {}
                Err(e) if e.0.contains("ddress already in use") => {
                    // Someone else holds it: keep it out of our pool.
                    skip.insert(ip);
                    last_err = e;
                    continue;
                }
                Err(e) => {
                    self.pool().free(ip);
                    return Err(e);
                }
            }
            let reg = egress_proxy::control::call(
                &self.cfg.proxy_control,
                &egress_proxy::control::Request::Register {
                    source: IpAddr::V4(ip),
                    sandbox_id: sandbox_id.to_string(),
                    allowlist: allowlist.to_vec(),
                },
            )
            .await;
            if let Err(e) = reg {
                let name = self.container_name(sandbox_id);
                let _ = run(&self.cfg.docker, &["rm", "-f", &name]).await;
                self.pool().free(ip);
                return Err(err(e));
            }
            return Ok(ip);
        }
        Err(last_err)
    }

    async fn exit_state(&self, name: &str) -> (Option<i64>, bool) {
        let s = run(
            &self.cfg.docker,
            &[
                "inspect",
                "--format",
                "{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.Running}}",
                name,
            ],
        )
        .await
        .unwrap_or_default();
        let mut it = s.split_whitespace();
        let code = it.next().and_then(|c| c.parse().ok());
        let oom = it.next() == Some("true");
        let running = it.next() == Some("true");
        (if running { None } else { code }, oom)
    }

    fn attach(&self, name: &str, stdin: bool) -> Result<Child, BackendError> {
        let mut c = Command::new(&self.cfg.docker);
        c.args(["start", "-a"]);
        if stdin {
            c.arg("-i");
        }
        c.arg(name)
            .stdin(if stdin { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| err(format!("docker start: {e}")))
    }

    async fn teardown(&self, sandbox_id: &str, ip: Option<IpAddr>) -> Vec<ProxyLogEntry> {
        let name = self.container_name(sandbox_id);
        let live = self.live().remove(sandbox_id);
        if let Err(e) = run(&self.cfg.docker, &["rm", "-f", "-v", &name]).await
            && !e.0.contains("No such container")
        {
            tracing::warn!(sandbox_id, error = %e, "remove failed");
        }
        drop(live); // ends a held sandbox's attach client
        let Some(ip) = ip else { return vec![] };
        let log = match egress_proxy::control::call(
            &self.cfg.proxy_control,
            &egress_proxy::control::Request::Unregister {
                sandbox_id: sandbox_id.to_string(),
            },
        )
        .await
        {
            Ok(r) => {
                if r.dropped > 0 {
                    tracing::warn!(sandbox_id, dropped = r.dropped, "proxy log over its cap");
                }
                r.log.into_iter().map(from_proxy).collect()
            }
            Err(e) => {
                tracing::warn!(sandbox_id, error = %e, "proxy unregister failed");
                vec![]
            }
        };
        if let IpAddr::V4(v4) = ip {
            self.pool().free(v4);
        }
        log
    }

    async fn drain(&self, sandbox_id: &str) -> Vec<ProxyLogEntry> {
        egress_proxy::control::call(
            &self.cfg.proxy_control,
            &egress_proxy::control::Request::Drain {
                sandbox_id: sandbox_id.to_string(),
            },
        )
        .await
        .map(|r| r.log.into_iter().map(from_proxy).collect())
        .unwrap_or_default()
    }

    /// Runs `probe_args` in a fresh sandbox built exactly like a browse job's (the probe
    /// image instead of the browse image), to the end or the wall cap; then destroys it.
    pub async fn probe(
        &self,
        image: &str,
        probe_args: &[String],
        allowlist: &[String],
        limits: Limits,
    ) -> Result<ProbeReport, BackendError> {
        let sandbox_id = new_sandbox_id();
        let name = self.container_name(&sandbox_id);
        let ip = self
            .create_networked(&sandbox_id, "probe", &limits, image, probe_args, allowlist)
            .await?;
        let started = Instant::now();
        let mut child = self.attach(&name, false)?;
        let stdout = child.stdout.take().expect("piped");
        let cap = limits.output_kb as usize * 1024 + OUTPUT_SLACK;
        let read = async {
            let mut lines = Vec::new();
            let mut r = BufReader::new(stdout.take(cap as u64)).lines();
            while let Ok(Some(l)) = r.next_line().await {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&l) {
                    lines.push(v);
                    if lines.len() > 50 {
                        lines.remove(0);
                    }
                }
            }
            let _ = child.wait().await;
            lines
        };
        let wall = Duration::from_secs(limits.wall_s as u64);
        let (lines, timed_out) = match tokio::time::timeout(wall, read).await {
            Ok(lines) => (lines, false),
            Err(_) => {
                let _ = run(&self.cfg.docker, &["kill", &name]).await;
                (vec![], true)
            }
        };
        let ms = started.elapsed().as_millis() as u64;
        let (exit_code, oom_killed) = self.exit_state(&name).await;
        let proxy_log = self.teardown(&sandbox_id, Some(IpAddr::V4(ip))).await;
        let gone_after = run(&self.cfg.docker, &["inspect", &name]).await.is_err();
        Ok(ProbeReport {
            sandbox_id,
            runtime: self.cfg.runtime.clone(),
            exit_code,
            oom_killed,
            timed_out,
            ms,
            lines,
            proxy_log,
            gone_after,
        })
    }
}

impl Backend for DockerBackend {
    fn name(&self) -> &'static str {
        if self.cfg.runtime.starts_with("runsc") {
            "gvisor"
        } else {
            "docker"
        }
    }

    fn create<'a>(&'a self, req: &'a JobRequest, limits: &'a Limits) -> BoxFut<'a, SandboxHandle> {
        Box::pin(async move {
            let sandbox_id = new_sandbox_id();
            let ip = match &req.browse {
                Some(b) => {
                    let cmd = self.driver_args(b, limits);
                    let image = self.cfg.browse_image.clone();
                    let ip = self
                        .create_networked(&sandbox_id, "browse", limits, &image, &cmd, &b.allowlist)
                        .await?;
                    Some(IpAddr::V4(ip))
                }
                None => {
                    let mut args = vec!["create".to_string(), "-i".into()];
                    args.extend(self.hardening(&sandbox_id, "compute", limits));
                    let image = self.cfg.compute_image.clone();
                    args.extend(["--network".into(), "none".into(), image]);
                    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
                    run(&self.cfg.docker, &refs).await?;
                    None
                }
            };
            self.live().insert(
                sandbox_id.clone(),
                Live {
                    name: self.container_name(&sandbox_id),
                    kind: req.kind,
                    limits: *limits,
                    attach: None,
                },
            );
            Ok(SandboxHandle {
                sandbox_id,
                job_id: req.job_id.clone(),
                ip,
            })
        })
    }

    fn browse<'a>(
        &'a self,
        sb: &'a SandboxHandle,
        _spec: &'a BrowseSpec,
    ) -> BoxFut<'a, (Vec<PageOut>, Vec<ProxyLogEntry>)> {
        Box::pin(async move {
            let (name, limits) = {
                let live = self.live();
                let l = live
                    .get(&sb.sandbox_id)
                    .filter(|l| l.kind == JobKind::Browse)
                    .ok_or(err("no such browse sandbox"))?;
                (l.name.clone(), l.limits)
            };
            let mut child = self.attach(&name, false)?;
            let stdout = child.stdout.take().expect("piped");
            let stderr = child.stderr.take().expect("piped");
            // Docker's own messages; the driver writes nothing there.
            let errtail = tokio::spawn(async move {
                let mut s = String::new();
                let _ = BufReader::new(stderr.take(4096))
                    .read_to_string(&mut s)
                    .await;
                s
            });
            let cap = limits.output_kb as usize * 1024 + OUTPUT_SLACK;
            let mut r = BufReader::new(stdout);
            let mut total = 0usize;
            let mut pages = Vec::new();
            loop {
                let mut line = Vec::new();
                let n = (&mut r)
                    .take((cap - total + 1) as u64)
                    .read_until(b'\n', &mut line)
                    .await
                    .map_err(|e| err(format!("read: {e}")))?;
                total += n;
                if total > cap {
                    return Err(err("output_limit: the sandbox wrote more than output_kb"));
                }
                if n == 0 {
                    let (code, oom) = self.exit_state(&name).await;
                    let docker_msg = errtail.await.unwrap_or_default();
                    return Err(err(format!(
                        "sandbox exited before the pages were read (exit {}{}){}",
                        code.map_or("?".into(), |c| c.to_string()),
                        if oom { ", out of memory" } else { "" },
                        docker_msg
                            .lines()
                            .next()
                            .map(|l| format!(": {l}"))
                            .unwrap_or_default()
                    )));
                }
                match serde_json::from_slice::<Event>(&line) {
                    Ok(Event::Launched {
                        chromium,
                        sandbox,
                        fallback,
                    }) => {
                        tracing::info!(sandbox_id = %sb.sandbox_id, chromium, chromium_sandbox = sandbox,
                            fallback, "chromium launched");
                    }
                    Ok(Event::Page {
                        url,
                        status,
                        text,
                        screenshot_png_b64,
                        error,
                    }) => {
                        if let Some(e) = error {
                            tracing::info!(sandbox_id = %sb.sandbox_id, status, error = e, "page read with an error");
                        }
                        pages.push(PageOut {
                            url,
                            status,
                            text,
                            screenshot_png_b64,
                        });
                    }
                    Ok(Event::Ready) => break,
                    Ok(Event::Error { stage, message }) => {
                        return Err(err(format!("browse driver failed at {stage}: {message}")));
                    }
                    Err(_) => {
                        return Err(err("the sandbox wrote something that is not an event"));
                    }
                }
            }
            // Held: keep the attach client with the sandbox until it is destroyed.
            if let Some(l) = self.live().get_mut(&sb.sandbox_id) {
                l.attach = Some(child);
            }
            Ok((pages, self.drain(&sb.sandbox_id).await))
        })
    }

    fn compute<'a>(
        &'a self,
        sb: &'a SandboxHandle,
        spec: &'a ComputeSpec,
    ) -> BoxFut<'a, engine::EngineResult> {
        Box::pin(async move {
            let (name, limits) = {
                let live = self.live();
                let l = live
                    .get(&sb.sandbox_id)
                    .ok_or(err("no such compute sandbox"))?;
                (l.name.clone(), l.limits)
            };
            let mut child = self.attach(&name, true)?;
            let input = serde_json::to_vec(&spec.engine_input).map_err(|e| err(e.to_string()))?;
            let mut stdin = child.stdin.take().expect("piped");
            let stdout = child.stdout.take().expect("piped");
            let cap = limits.output_kb as u64 * 1024;
            let write = async move {
                let _ = stdin.write_all(&input).await;
                drop(stdin);
            };
            let read = async move {
                let mut out = Vec::new();
                let _ = stdout.take(cap + 1).read_to_end(&mut out).await;
                out
            };
            let ((), out) = tokio::join!(write, read);
            let _ = child.wait().await;
            if out.len() as u64 > cap {
                return Err(err("output_limit: the engine wrote more than output_kb"));
            }
            let (code, oom) = self.exit_state(&name).await;
            serde_json::from_slice(&out).map_err(|_| {
                err(format!(
                    "the engine gave no result (exit {}{})",
                    code.map_or("?".into(), |c| c.to_string()),
                    if oom { ", out of memory" } else { "" }
                ))
            })
        })
    }

    fn kill<'a>(&'a self, sb: &'a SandboxHandle) -> BoxFut<'a, ()> {
        Box::pin(async move {
            let name = self.container_name(&sb.sandbox_id);
            let _ = run(&self.cfg.docker, &["kill", &name]).await;
            Ok(())
        })
    }

    fn destroy<'a>(&'a self, sb: &'a SandboxHandle) -> BoxFut<'a, Vec<ProxyLogEntry>> {
        Box::pin(async move { Ok(self.teardown(&sb.sandbox_id, sb.ip).await) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DockerConfig {
        DockerConfig {
            docker: "docker".into(),
            runtime: "runc".into(),
            browse_image: "vha-browse:dev".into(),
            compute_image: "vha-engine-compute:dev".into(),
            network: "vha-sbx-test".into(),
            proxy_url: "http://172.30.79.2:8201".into(),
            proxy_control: "/run/egress.sock".into(),
            chromium_sandbox: "off".into(),
            dev_spki: None,
            instance: "vha".into(),
            state_dir: "/run/vha".into(),
        }
    }

    fn backend() -> DockerBackend {
        DockerBackend {
            cfg: cfg(),
            pool: Mutex::new(IpPool {
                first: 10,
                last: 20,
                taken: HashSet::new(),
            }),
            live: Mutex::new(HashMap::new()),
        }
    }

    fn pairs(a: &[String]) -> Vec<(String, String)> {
        a.windows(2).map(|w| (w[0].clone(), w[1].clone())).collect()
    }

    #[test]
    fn every_sandbox_is_hardened() {
        let a = backend().hardening("sbx-1", "browse", &Limits::BROWSE);
        let p = pairs(&a);
        let has = |k: &str, v: &str| p.contains(&(k.to_string(), v.to_string()));
        assert!(has("--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=512m"));
        assert!(has("--user", "10001:10001"));
        assert!(has("--cap-drop", "ALL"));
        assert!(has("--security-opt", "no-new-privileges"));
        assert!(has("--memory", "1024m") && has("--memory-swap", "1024m"));
        assert!(has("--pids-limit", "256"));
        assert!(has("--cpus", "1.000"));
        assert!(has("--runtime", "runc"));
        assert!(has("--log-driver", "none"));
        assert!(a.contains(&"--read-only".to_string()));
        assert!(a.contains(&"--init".to_string()));
        // Nothing from the manager's env, no host folders, no privileges.
        for bad in [
            "-e",
            "--env",
            "--env-file",
            "--privileged",
            "-v",
            "--mount",
            "--volume",
        ] {
            assert!(!a.contains(&bad.to_string()), "{bad}");
        }
        assert!(!a.iter().any(|x| x.contains("docker.sock")));
    }

    #[test]
    fn browse_network_has_one_mount_the_empty_resolver() {
        let a = backend().network_flags("172.30.79.10".parse().unwrap());
        let mounts: Vec<&String> = a
            .windows(2)
            .filter(|w| w[0] == "-v")
            .map(|w| &w[1])
            .collect();
        assert_eq!(mounts, vec!["/run/vha/resolv.conf:/etc/resolv.conf:ro"]);
        assert!(pairs(&a).contains(&("--network".into(), "vha-sbx-test".into())));
    }

    #[test]
    fn gvisor_is_the_same_backend_with_runsc() {
        let mut b = backend();
        assert_eq!(b.name(), "docker");
        b.cfg.runtime = "runsc".into();
        assert_eq!(b.name(), "gvisor");
        let p = pairs(&b.hardening("s", "browse", &Limits::BROWSE));
        assert!(p.contains(&("--runtime".into(), "runsc".into())));
        // The spike's process cap under gVisor: nproc 256, the pids limit well above it.
        assert!(p.contains(&("--ulimit".into(), "nproc=256:256".into())));
        assert!(p.contains(&("--pids-limit".into(), "1024".into())));
        // Compute: nproc 8 inside, and the host backstop still 1024 (the Sentry's threads count there).
        let c = pairs(&b.hardening("s", "compute", &Limits::COMPUTE));
        assert!(c.contains(&("--ulimit".into(), "nproc=8:8".into())));
        assert!(c.contains(&("--pids-limit".into(), "1024".into())));
    }

    #[test]
    fn driver_gets_urls_and_no_secret() {
        let spec = BrowseSpec {
            urls: vec!["https://a.example/x".into()],
            allowlist: vec!["a.example".into()],
            screenshot: true,
            hold: true,
        };
        let a = backend().driver_args(&spec, &Limits::BROWSE);
        let p = pairs(&a);
        assert!(p.contains(&("--url".into(), "https://a.example/x".into())));
        assert!(p.contains(&("--proxy".into(), "http://172.30.79.2:8201".into())));
        assert!(p.contains(&("--max-life".into(), "100".into())));
        assert!(a.contains(&"--screenshot".to_string()));
        assert!(!a.contains(&"--spki".to_string()));
    }

    #[test]
    fn ip_pool_reuses_freed_addresses() {
        let mut pool = IpPool {
            first: u32::from(Ipv4Addr::new(10, 9, 0, 10)),
            last: u32::from(Ipv4Addr::new(10, 9, 0, 11)),
            taken: HashSet::new(),
        };
        let none = HashSet::new();
        let a = pool.take(&none).unwrap();
        let b = pool.take(&none).unwrap();
        assert_ne!(a, b);
        assert_eq!(pool.take(&none), None);
        pool.free(a);
        assert_eq!(pool.take(&none), Some(a));
    }

    #[test]
    fn cidr() {
        let (lo, hi) = parse_cidr("172.30.79.0/24").unwrap();
        assert_eq!(Ipv4Addr::from(lo), Ipv4Addr::new(172, 30, 79, 0));
        assert_eq!(Ipv4Addr::from(hi), Ipv4Addr::new(172, 30, 79, 255));
        assert_eq!(parse_cidr("fd00::/64"), None);
    }
}
