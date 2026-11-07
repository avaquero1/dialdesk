//! Sets GIT_HASH for the binary. ENGINE_GIT_HASH wins when set (the compute image is
//! built without .git and passes it in). Never fails: no git or no commit gives "unknown".
use std::path::Path;
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn main() {
    println!("cargo:rerun-if-env-changed=ENGINE_GIT_HASH");
    let from_env = std::env::var("ENGINE_GIT_HASH")
        .ok()
        .filter(|h| !h.is_empty() && h.len() <= 40 && h.bytes().all(|b| b.is_ascii_hexdigit()));
    let hash = from_env
        .or_else(|| git(&["rev-parse", "--short=12", "HEAD"]))
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=GIT_HASH={hash}");

    // Rerun when HEAD moves. In a worktree HEAD lives in the git dir and the branch refs
    // in the common dir. Only watch paths that exist, or cargo reruns on every build.
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        let dir = Path::new(&dir);
        let common = git(&["rev-parse", "--path-format=absolute", "--git-common-dir"])
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| dir.to_path_buf());
        let mut watch = vec![
            dir.join("HEAD"),
            common.join("packed-refs"),
            common.join("refs/heads"),
        ];
        if let Some(r) = git(&["symbolic-ref", "-q", "HEAD"]) {
            watch.push(common.join(r));
        }
        for p in watch.iter().filter(|p| p.exists()) {
            println!("cargo:rerun-if-changed={}", p.display());
        }
    }
    println!("cargo:rerun-if-changed=build.rs");
}
