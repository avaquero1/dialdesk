use super::*;
use serde_json::json;

fn input(ops: serde_json::Value, numbers: serde_json::Value) -> EngineInput {
    serde_json::from_value(json!({"plan": {"plan_version": 1, "ops": ops}, "numbers": numbers}))
        .expect("test input parses")
}

/// Runs one op and returns its value, or its error code.
fn one(op: &str, args: serde_json::Value, numbers: serde_json::Value) -> Result<f64, String> {
    let res = run(&input(
        json!([{"id": "n1", "op": op, "args": args}]),
        numbers,
    ));
    match (res.numbers.first(), res.errors.first()) {
        (Some(n), None) => Ok(n.value),
        (_, Some(e)) => Err(e.code.clone()),
        _ => panic!("no number and no error"),
    }
}

fn series(points: &[(i64, f64)]) -> serde_json::Value {
    json!(
        points
            .iter()
            .map(|(t, v)| json!({"t": t, "v": v}))
            .collect::<Vec<_>>()
    )
}

#[test]
fn implied_probability() {
    assert_eq!(
        one(
            "implied_probability",
            json!({"price_cents": "p"}),
            json!({"p": 57})
        ),
        Ok(0.57)
    );
    assert_eq!(
        one(
            "implied_probability",
            json!({"price_cents": "p"}),
            json!({"p": 101})
        ),
        Err("out_of_range".into())
    );
}

#[test]
fn price_to_odds() {
    assert_eq!(
        one(
            "price_to_odds",
            json!({"probability": "p"}),
            json!({"p": 0.25})
        ),
        Ok(4.0)
    );
    assert_eq!(
        one(
            "price_to_odds",
            json!({"probability": "p"}),
            json!({"p": 0})
        ),
        Err("out_of_range".into())
    );
}

#[test]
fn odds_to_probability() {
    assert_eq!(
        one(
            "odds_to_probability",
            json!({"decimal_odds": "o"}),
            json!({"o": 2.5})
        ),
        Ok(0.4)
    );
    assert_eq!(
        one(
            "odds_to_probability",
            json!({"decimal_odds": "o"}),
            json!({"o": 0.5})
        ),
        Err("out_of_range".into())
    );
}

#[test]
fn expected_value() {
    let args = json!({"price_cents": "c", "probability": "p"});
    assert_eq!(
        one("expected_value", args.clone(), json!({"c": 57, "p": 0.62})),
        Ok(5.0)
    );
    assert_eq!(
        one("expected_value", args, json!({"c": 57, "p": 1.2})),
        Err("out_of_range".into())
    );
}

#[test]
fn movement() {
    let s = series(&[(0, 40.0), (100, 45.0), (200, 50.0), (300, 48.0)]);
    let args = json!({"series": "s", "window_s": "w"});
    // Window 150 from t=300 starts at the first point with t >= 150, i.e. t=200 (v=50).
    assert_eq!(
        one("movement", args.clone(), json!({"s": s, "w": 150})),
        Ok(-2.0)
    );
    assert_eq!(
        one("movement", args.clone(), json!({"s": s, "w": 1000})),
        Ok(8.0)
    );
    assert_eq!(
        one("movement", args.clone(), json!({"s": s, "w": 0})),
        Err("out_of_range".into())
    );
    assert_eq!(
        one("movement", args, json!({"s": [], "w": 10})),
        Err("out_of_range".into())
    );
}

#[test]
fn volatility() {
    // Changes: +2, -2, +2, -2 -> mean 0, stddev 2.
    let s = series(&[(0, 50.0), (1, 52.0), (2, 50.0), (3, 52.0), (4, 50.0)]);
    assert_eq!(
        one("volatility", json!({"series": "s"}), json!({"s": s})),
        Ok(2.0)
    );
    let short = series(&[(0, 50.0)]);
    assert_eq!(
        one("volatility", json!({"series": "s"}), json!({"s": short})),
        Err("out_of_range".into())
    );
    let unsorted = series(&[(5, 50.0), (1, 52.0)]);
    assert_eq!(
        one("volatility", json!({"series": "s"}), json!({"s": unsorted})),
        Err("bad_arg".into())
    );
}

#[test]
fn gap() {
    let args = json!({"a_cents": "a", "b_cents": "b"});
    assert_eq!(one("gap", args.clone(), json!({"a": 41, "b": 47})), Ok(6.0));
    assert_eq!(
        one("gap", args, json!({"a": -1, "b": 47})),
        Err("out_of_range".into())
    );
}

#[test]
fn base_rate() {
    let args = json!({"hits": "h", "total": "t"});
    assert_eq!(
        one("base_rate", args.clone(), json!({"h": 3, "t": 12})),
        Ok(0.25)
    );
    assert_eq!(
        one("base_rate", args.clone(), json!({"h": 3, "t": 0})),
        Err("out_of_range".into())
    );
    assert_eq!(
        one("base_rate", args, json!({"h": 13, "t": 12})),
        Err("out_of_range".into())
    );
}

#[test]
fn position_value() {
    let args = json!({"count": "n", "price_cents": "c"});
    assert_eq!(
        one("position_value", args.clone(), json!({"n": 10, "c": 57})),
        Ok(5.7)
    );
    assert_eq!(
        one("position_value", args, json!({"n": -1, "c": 57})),
        Err("out_of_range".into())
    );
}

#[test]
fn pnl() {
    let args = json!({"count": "n", "avg_price_cents": "a", "price_cents": "c"});
    assert_eq!(
        one("pnl", args.clone(), json!({"n": 10, "a": 40, "c": 57})),
        Ok(1.7)
    );
    assert_eq!(
        one("pnl", args.clone(), json!({"n": 10, "a": 60, "c": 57})),
        Ok(-0.3)
    );
    assert_eq!(
        one("pnl", args, json!({"n": 10, "a": 140, "c": 57})),
        Err("out_of_range".into())
    );
}

#[test]
fn bad_arg_kinds() {
    // Unknown arg, missing arg, and a series where a number belongs.
    let n = json!({"p": 50, "s": series(&[(0, 1.0)])});
    assert_eq!(
        one(
            "implied_probability",
            json!({"price_cents": "p", "x": "p"}),
            n.clone()
        ),
        Err("bad_arg".into())
    );
    assert_eq!(
        one("implied_probability", json!({}), n.clone()),
        Err("bad_arg".into())
    );
    assert_eq!(
        one("implied_probability", json!({"price_cents": "s"}), n),
        Err("bad_arg".into())
    );
}

#[test]
fn missing_input() {
    assert_eq!(
        one(
            "implied_probability",
            json!({"price_cents": "nope"}),
            json!({})
        ),
        Err("missing_input".into())
    );
}

#[test]
fn bad_plan() {
    let mut i = input(json!([{"id": "n1", "op": "gap", "args": {}}]), json!({}));
    i.plan.plan_version = 2;
    let res = run(&i);
    assert!(!res.ok);
    assert_eq!(res.errors[0].code, "bad_plan");
    assert!(res.numbers.is_empty());

    let dup = json!([
        {"id": "n1", "op": "implied_probability", "args": {"price_cents": "p"}},
        {"id": "n1", "op": "implied_probability", "args": {"price_cents": "p"}},
    ]);
    assert_eq!(run(&input(dup, json!({"p": 5}))).errors[0].code, "bad_plan");
    let bad_id = json!([{"id": "N-1", "op": "implied_probability", "args": {"price_cents": "p"}}]);
    assert_eq!(
        run(&input(bad_id, json!({"p": 5}))).errors[0].code,
        "bad_plan"
    );
    let clash = json!([{"id": "p", "op": "implied_probability", "args": {"price_cents": "p"}}]);
    assert_eq!(
        run(&input(clash, json!({"p": 5}))).errors[0].code,
        "bad_plan"
    );
}

#[test]
fn unknown_fields_are_refused() {
    let r: Result<EngineInput, _> = serde_json::from_value(json!({
        "plan": {"plan_version": 1, "ops": [], "extra": 1}, "numbers": {}
    }));
    assert!(r.is_err());
}

#[test]
fn chained_ops_and_failed_dependency() {
    let ops = json!([
        {"id": "p1", "op": "implied_probability", "args": {"price_cents": "c"}},
        {"id": "o1", "op": "price_to_odds", "args": {"probability": "p1"}},
        {"id": "bad", "op": "implied_probability", "args": {"price_cents": "big"}},
        {"id": "o2", "op": "price_to_odds", "args": {"probability": "bad"}},
    ]);
    let res = run(&input(ops, json!({"c": 40, "big": 400})));
    assert!(!res.ok);
    let vals: Vec<_> = res
        .numbers
        .iter()
        .map(|n| (n.id.as_str(), n.value, n.unit))
        .collect();
    assert_eq!(
        vals,
        [
            ("p1", 0.4, Unit::Probability),
            ("o1", 2.5, Unit::DecimalOdds)
        ]
    );
    let errs: Vec<_> = res
        .errors
        .iter()
        .map(|e| (e.op_id.as_str(), e.code.as_str()))
        .collect();
    assert_eq!(errs, [("bad", "out_of_range"), ("o2", "missing_input")]);
}

#[test]
fn receipts_are_deterministic() {
    let s = series(&[(10, 40.0), (20, 44.0)]);
    let mk = || {
        input(
            json!([
                {"id": "m1", "op": "movement", "args": {"series": "s", "window_s": "w"}},
                {"id": "p1", "op": "implied_probability", "args": {"price_cents": "c"}},
            ]),
            json!({"s": s, "w": 60, "c": 44}),
        )
    };
    let (a, b) = (run(&mk()), run(&mk()));
    assert!(a.ok);
    assert_eq!(a, b);
    let r = &a.receipts[0];
    assert_eq!(r.id, receipt_id(&a.plan_hash, "m1"));
    assert_eq!(r.id.len(), 10);
    assert!(r.id.starts_with("r-"));
    assert_eq!(a.numbers[0].receipt_id, r.id);
    assert_ne!(a.receipts[0].id, a.receipts[1].id);
    match &r.args["series"] {
        ReceiptArg::Series(s) => assert_eq!((s.points, s.first_t, s.last_t), (2, 10, 20)),
        other => panic!("expected a series summary, got {other:?}"),
    }
    assert_eq!(r.args["window_s"], ReceiptArg::Number(60.0));
    assert_eq!(r.plan_hash.len(), 64);
    assert_eq!(r.input_hash, a.input_hash);

    // A different plan gives different receipt ids.
    let mut other = mk();
    other.plan.ops.swap(0, 1);
    assert_ne!(run(&other).receipts[1].id, a.receipts[0].id);
}

#[test]
fn schema_has_four_keys() {
    let s = schemas();
    for k in ["plan", "input", "result", "receipt"] {
        assert!(s[k].is_object(), "missing {k}");
    }
    let text = serde_json::to_string(&s).unwrap();
    assert!(text.contains("^[a-z][a-z0-9_]{0,31}$"));
}
