//! `engine`: reads an EngineInput on stdin, writes an EngineResult on stdout.
//! `engine --schema` prints the contract; `engine --version` prints version and git hash.

use std::io::{Read, Write};
use std::process::ExitCode;

/// Inputs larger than this are refused.
const MAX_INPUT: u64 = 16 * 1024 * 1024;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => run_stdin(),
        ["--schema"] => {
            let s = serde_json::to_string_pretty(&engine::schemas()).expect("schemas serialize");
            println!("{s}");
            ExitCode::SUCCESS
        }
        ["--version"] => {
            println!("engine {} ({})", engine::ENGINE_VERSION, engine::GIT_HASH);
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: engine [--schema | --version]  (no args: EngineInput JSON on stdin)");
            ExitCode::from(2)
        }
    }
}

fn run_stdin() -> ExitCode {
    let mut buf = String::new();
    let read = std::io::stdin()
        .take(MAX_INPUT + 1)
        .read_to_string(&mut buf);
    let parsed = match read {
        Err(e) => Err(format!("could not read stdin: {e}")),
        Ok(n) if n as u64 > MAX_INPUT => Err(format!("input is larger than {MAX_INPUT} bytes")),
        Ok(_) => serde_json::from_str::<engine::EngineInput>(&buf).map_err(|e| e.to_string()),
    };
    let (out, code) = match parsed {
        Ok(input) => (
            serde_json::to_string(&engine::run(&input)),
            ExitCode::SUCCESS,
        ),
        Err(message) => (
            serde_json::to_string(&serde_json::json!({"error": "bad_input", "message": message})),
            ExitCode::from(2),
        ),
    };
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}", out.expect("results serialize"));
    code
}
