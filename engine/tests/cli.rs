//! Runs the built `engine` binary.
use std::io::Write;
use std::process::{Command, Stdio};

fn engine(args: &[&str], stdin: &str) -> (i32, serde_json::Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_engine"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap(),
        serde_json::from_slice(&out.stdout).unwrap(),
    )
}

#[test]
fn schema_prints_four_keys() {
    let (code, v) = engine(&["--schema"], "");
    assert_eq!(code, 0);
    let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys.len(), 4);
    for k in ["plan", "input", "result", "receipt"] {
        assert!(v[k].is_object(), "missing {k}");
    }
}

#[test]
fn stdin_run_and_bad_input() {
    let input = r#"{"plan":{"plan_version":1,"ops":[
        {"id":"n1","op":"implied_probability","args":{"price_cents":"c"}},
        {"id":"n2","op":"implied_probability","args":{"price_cents":"x"}}]},
        "numbers":{"c":57}}"#;
    let (code, v) = engine(&[], input);
    assert_eq!(code, 0, "per-op errors still exit 0");
    assert_eq!(v["ok"], false);
    assert_eq!(v["numbers"][0]["value"], 0.57);
    assert_eq!(v["errors"][0]["code"], "missing_input");

    let (code, v) = engine(&[], "{not json");
    assert_eq!(code, 2);
    assert_eq!(v["error"], "bad_input");
}
