use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

use crate::app::{self, AppState, Config, Shared};
use crate::backend::DockerBackend;

const TOKEN: &str = "test-token-runner";

fn state(slots: usize) -> Shared {
    let callers =
        app::parse_callers(&format!("runner:{}", hex::encode(Sha256::digest(TOKEN)))).unwrap();
    AppState::new(
        Config {
            callers,
            slots,
            dev: false,
        },
        std::sync::Arc::new(DockerBackend),
    )
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let body = body.map_or(Body::empty(), |b| Body::from(b.to_string()));
    let res = app
        .clone()
        .oneshot(
            req.header("content-type", "application/json")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn wait_for(app: &Router, id: &str, want: &str) -> Value {
    for _ in 0..200 {
        let (_, v) = call(app, "GET", &format!("/jobs/{id}"), Some(TOKEN), None).await;
        if v["state"] == want {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("job {id} never reached {want}");
}

fn browse_job(id: &str) -> Value {
    json!({
        "job_id": id, "run_id": "run1", "widget_id": "w1", "kind": "browse",
        "browse": {"urls": ["https://kalshi.com/markets", "https://evil.example/x"], "allowlist": ["kalshi.com"]}
    })
}

#[tokio::test]
async fn auth_is_required_except_health() {
    let app = app::router(state(6));
    let (s, v) = call(&app, "GET", "/sandboxes", None, None).await;
    assert_eq!(
        (s, v["error"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("unauthorized"))
    );
    let (s, _) = call(&app, "GET", "/sandboxes", Some("wrong"), None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = call(&app, "POST", "/jobs", None, Some(browse_job("j1"))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = call(&app, "GET", "/sandboxes", Some(TOKEN), None).await;
    assert_eq!(s, StatusCode::OK);
    let (s, v) = call(&app, "GET", "/health", None, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        v,
        json!({"ok": true, "service": "sandbox-manager", "backend": "docker"})
    );
}

#[tokio::test]
async fn browse_lifecycle_held_then_killed() {
    let app = app::router(state(6));
    let (s, v) = call(&app, "POST", "/jobs", Some(TOKEN), Some(browse_job("j1"))).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert!(v["sandbox_id"].as_str().unwrap().starts_with("sbx-"));
    assert_eq!(v["limits"]["memory_mb"], 1024);

    let held = wait_for(&app, "j1", "held").await;
    let log: Vec<_> = held["proxy_log"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["host"].clone(), e["reason"].clone()))
        .collect();
    assert_eq!(
        log,
        [
            (json!("kalshi.com"), json!("allowlisted")),
            (json!("evil.example"), json!("not_on_allowlist"))
        ]
    );
    assert_eq!(held["proxy_log"][0]["port"], 443);

    let (_, list) = call(&app, "GET", "/sandboxes", Some(TOKEN), None).await;
    assert_eq!(list["slots_used"], 1);
    assert_eq!(list["sandboxes"][0]["state"], "held");

    // Posting the same job_id again is idempotent.
    let (s, again) = call(&app, "POST", "/jobs", Some(TOKEN), Some(browse_job("j1"))).await;
    assert_eq!(
        (s, &again["sandbox_id"]),
        (StatusCode::ACCEPTED, &held["sandbox_id"])
    );

    let kill = json!({"reason": "user_stop", "audit_row_id": "a1"});
    let (s, v) = call(
        &app,
        "POST",
        "/jobs/j1/kill",
        Some(TOKEN),
        Some(kill.clone()),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        (v["state"].as_str(), v["kill_reason"].as_str()),
        (Some("killed"), Some("user_stop"))
    );
    let (s, _) = call(&app, "POST", "/jobs/j1/kill", Some(TOKEN), Some(kill)).await;
    assert_eq!(s, StatusCode::OK, "killing twice is fine");
    let (s, v) = call(&app, "POST", "/jobs/j1/release", Some(TOKEN), None).await;
    assert_eq!(
        (s, v["error"].as_str()),
        (StatusCode::CONFLICT, Some("conflict"))
    );

    let (_, list) = call(&app, "GET", "/sandboxes", Some(TOKEN), None).await;
    assert_eq!(list["slots_used"], 0);
    let (s, _) = call(&app, "GET", "/jobs/nope", Some(TOKEN), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn release_and_hold_timeout() {
    let st = state(6);
    let app = app::router(st.clone());
    call(&app, "POST", "/jobs", Some(TOKEN), Some(browse_job("r1"))).await;
    call(&app, "POST", "/jobs", Some(TOKEN), Some(browse_job("t1"))).await;
    wait_for(&app, "r1", "held").await;
    wait_for(&app, "t1", "held").await;

    let (s, v) = call(&app, "POST", "/jobs/r1/release", Some(TOKEN), None).await;
    assert_eq!((s, v["state"].as_str()), (StatusCode::OK, Some("released")));

    app::sweep_holds(&st, Instant::now()).await;
    wait_for(&app, "t1", "held").await;
    app::sweep_holds(&st, Instant::now() + Duration::from_secs(61)).await;
    let v = wait_for(&app, "t1", "killed").await;
    assert_eq!(v["kill_reason"], "hold_timeout");
}

#[tokio::test]
async fn busy_when_slots_are_full() {
    let app = app::router(state(2));
    for id in ["b1", "b2"] {
        let (s, _) = call(&app, "POST", "/jobs", Some(TOKEN), Some(browse_job(id))).await;
        assert_eq!(s, StatusCode::ACCEPTED);
    }
    let (s, v) = call(&app, "POST", "/jobs", Some(TOKEN), Some(browse_job("b3"))).await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(v["error"], "busy");
    assert!(v["retry_after_ms"].as_u64().unwrap() > 0);

    // A freed slot takes the next job.
    wait_for(&app, "b1", "held").await;
    call(
        &app,
        "POST",
        "/jobs/b1/kill",
        Some(TOKEN),
        Some(json!({"reason": "test"})),
    )
    .await;
    let (s, _) = call(&app, "POST", "/jobs", Some(TOKEN), Some(browse_job("b3"))).await;
    assert_eq!(s, StatusCode::ACCEPTED);
}

#[tokio::test]
async fn compute_returns_numbers() {
    let app = app::router(state(6));
    let job = json!({
        "job_id": "c1", "run_id": "run1", "widget_id": "w1", "kind": "compute",
        "compute": {"engine_input": {
            "plan": {"plan_version": 1, "ops": [{"id": "n1", "op": "implied_probability", "args": {"price_cents": "c"}}]},
            "numbers": {"c": 57}
        }}
    });
    let (s, v) = call(&app, "POST", "/jobs", Some(TOKEN), Some(job)).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert_eq!(v["limits"]["memory_mb"], 128);
    let done = wait_for(&app, "c1", "done").await;
    let r = &done["compute_result"];
    assert_eq!(r["ok"], true);
    assert_eq!(r["numbers"][0]["value"], 0.57);
    assert_eq!(r["receipts"][0]["formula"], "p = price_cents / 100");
    let (_, list) = call(&app, "GET", "/sandboxes", Some(TOKEN), None).await;
    assert_eq!(list["slots_used"], 0, "a done job frees its slot");
}

#[tokio::test]
async fn bad_requests_are_400() {
    let app = app::router(state(6));
    let mut http = browse_job("h1");
    http["browse"]["urls"] = json!(["http://kalshi.com/"]);
    let mut extra = browse_job("h2");
    extra["surprise"] = json!(1);
    let mut mismatch = browse_job("h3");
    mismatch["kind"] = json!("compute");
    for body in [http, extra, mismatch] {
        let (s, v) = call(&app, "POST", "/jobs", Some(TOKEN), Some(body)).await;
        assert_eq!(
            (s, v["error"].as_str()),
            (StatusCode::BAD_REQUEST, Some("bad_request"))
        );
    }
    let (s, _) = call(&app, "POST", "/jobs/h1/kill", Some(TOKEN), Some(json!({}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[test]
fn schema_lists_all_paths() {
    let doc = app::schema_doc();
    let paths: Vec<String> = doc["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            format!(
                "{} {}",
                p["method"].as_str().unwrap(),
                p["path"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(
        paths,
        [
            "GET /health",
            "POST /jobs",
            "GET /jobs/{id}",
            "POST /jobs/{id}/release",
            "POST /jobs/{id}/kill",
            "GET /sandboxes"
        ]
    );
    // Every type a path names has a schema.
    for p in doc["paths"].as_array().unwrap() {
        let names = p["responses"]
            .as_object()
            .unwrap()
            .values()
            .chain(p["request"].as_str().map(|_| &p["request"]));
        for n in names {
            assert!(
                doc["schemas"][n.as_str().unwrap()].is_object(),
                "no schema for {n}"
            );
        }
    }
}

#[test]
fn callers_parse() {
    let h = "a".repeat(64);
    let c = app::parse_callers(&format!("runner:{h}, other:{h}")).unwrap();
    assert_eq!(
        c.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["runner", "other"]
    );
    assert!(app::parse_callers("runner:xyz").is_err());
    assert!(app::parse_callers("runner").is_err());
    assert!(app::parse_callers("").unwrap().is_empty());
}
