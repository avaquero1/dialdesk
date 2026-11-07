//! Sets GIT_HASH for the binary. Never fails: no git or no commit gives "unknown".
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
    let hash = git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=GIT_HASH={hash}");

    // Rerun when HEAD moves. Only watch paths that exist, or cargo reruns on every build.
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        let dir = Path::new(&dir);
        let mut watch = vec![
            dir.join("HEAD"),
            dir.join("packed-refs"),
            dir.join("refs/heads"),
        ];
        if let Some(r) = git(&["symbolic-ref", "-q", "HEAD"]) {
            watch.push(dir.join(r));
        }
        for p in watch.iter().filter(|p| p.exists()) {
            println!("cargo:rerun-if-changed={}", p.display());
        }
    }
    println!("cargo:rerun-if-changed=build.rs");
}
