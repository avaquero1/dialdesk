//! Property tests for every op: probabilities stay in 0..=1, price, probability and odds
//! round-trip, EV's sign is right, the Kalshi–Polymarket gap is symmetric, base rates
//! from history match a plain count, and receipts are deterministic and hash what ran.

use std::collections::BTreeMap;

use engine::{
    EngineInput, EngineResult, OpCall, OpName, Origin, Plan, Point, Provenance, Receipt, Resolved,
    Unit, Value, hash_json, run,
};
use proptest::prelude::*;

const TOL: f64 = 2e-9;

fn op_name(s: &str) -> OpName {
    serde_json::from_value(serde_json::Value::String(s.into())).expect("op name")
}

fn call(id: &str, op: &str, args: &[(&str, &str)]) -> OpCall {
    OpCall {
        id: id.into(),
        op: op_name(op),
        args: args
            .iter()
            .map(|(a, r)| (a.to_string(), r.to_string()))
            .collect(),
    }
}

fn input(ops: Vec<OpCall>, numbers: Vec<(&str, Value)>, origins: &[(&str, Origin)]) -> EngineInput {
    EngineInput {
        plan: Plan {
            plan_version: 1,
            ops,
        },
        numbers: numbers.into_iter().map(|(k, v)| (k.into(), v)).collect(),
        origins: origins.iter().map(|(k, o)| (k.to_string(), *o)).collect(),
        provenance: Default::default(),
    }
}

/// The last op's value and receipt, or the first error code.
fn last(res: &EngineResult) -> Result<(f64, Receipt), String> {
    match (res.errors.first(), res.numbers.last(), res.receipts.last()) {
        (Some(e), _, _) => Err(e.code.clone()),
        (None, Some(n), Some(r)) => Ok((n.value, r.clone())),
        _ => panic!("no number and no error"),
    }
}

fn one(op: &str, args: &[(&str, &str)], numbers: Vec<(&str, Value)>) -> Result<f64, String> {
    last(&run(&input(vec![call("n1", op, args)], numbers, &[]))).map(|(v, _)| v)
}

fn num(x: f64) -> Value {
    Value::Number(x)
}

/// A price in cents: whole cents, the edges, or any real in 0..=100.
fn price() -> impl Strategy<Value = f64> {
    prop_oneof![
        (0u32..=100).prop_map(f64::from),
        Just(0.0),
        Just(100.0),
        0.0f64..=100.0,
    ]
}

fn prob() -> impl Strategy<Value = f64> {
    prop_oneof![Just(0.0), Just(1.0), 0.0f64..=1.0]
}

/// A price series sorted by t (ties allowed), 1..40 points.
fn series(min: usize) -> impl Strategy<Value = Vec<Point>> {
    prop::collection::vec((0i64..10_000, price()), min..40).prop_map(|mut v| {
        v.sort_by_key(|(t, _)| *t);
        v.into_iter().map(|(t, v)| Point { t, v }).collect()
    })
}

fn history(min: usize) -> impl Strategy<Value = Vec<Resolved>> {
    prop::collection::vec(
        (0i64..1_000_000, (0u32..=100).prop_map(f64::from), 0u8..=1),
        min..80,
    )
    .prop_map(|v| {
        v.into_iter()
            .map(|(t, p, o)| Resolved {
                t,
                price_cents: p,
                outcome: f64::from(o),
            })
            .collect()
    })
}

fn sign(x: f64) -> i8 {
    if x > 0.0 {
        1
    } else if x < 0.0 {
        -1
    } else {
        0
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    // 1. implied_probability
    #[test]
    fn implied_probability_is_a_probability(c in price()) {
        let p = one("implied_probability", &[("price_cents", "c")], vec![("c", num(c))]).unwrap();
        prop_assert!((0.0..=1.0).contains(&p));
        prop_assert!((p - c / 100.0).abs() <= TOL);
    }

    #[test]
    fn implied_probability_refuses_a_price_outside_0_100(c in prop_oneof![-1e9f64..-1e-9, 100.000001f64..1e9]) {
        let r = one("implied_probability", &[("price_cents", "c")], vec![("c", num(c))]);
        prop_assert_eq!(r, Err("out_of_range".into()));
    }

    // 2. price_to_odds
    #[test]
    fn odds_are_at_least_one(p in 1e-6f64..=1.0) {
        let o = one("price_to_odds", &[("probability", "p")], vec![("p", num(p))]).unwrap();
        prop_assert!(o >= 1.0 && o.is_finite());
    }

    #[test]
    fn odds_refuse_zero_and_outside_0_1(p in prop_oneof![Just(0.0), -10.0f64..-1e-12, 1.000001f64..10.0]) {
        let r = one("price_to_odds", &[("probability", "p")], vec![("p", num(p))]);
        prop_assert_eq!(r, Err("out_of_range".into()));
    }

    // 3. odds_to_probability
    #[test]
    fn odds_give_a_probability(o in 1.0f64..1e6) {
        let p = one("odds_to_probability", &[("decimal_odds", "o")], vec![("o", num(o))]).unwrap();
        prop_assert!(p > 0.0 && p <= 1.0);
    }

    #[test]
    fn odds_below_one_are_refused(o in -1e6f64..0.999999) {
        let r = one("odds_to_probability", &[("decimal_odds", "o")], vec![("o", num(o))]);
        prop_assert_eq!(r, Err("out_of_range".into()));
    }

    // 1-3 together: price -> probability -> odds -> probability, in one plan.
    #[test]
    fn price_probability_and_odds_round_trip(c in 0.01f64..=100.0) {
        let res = run(&input(
            vec![
                call("p", "implied_probability", &[("price_cents", "c")]),
                call("o", "price_to_odds", &[("probability", "p")]),
                call("q", "odds_to_probability", &[("decimal_odds", "o")]),
            ],
            vec![("c", num(c))],
            &[],
        ));
        prop_assert!(res.ok);
        let (p, q) = (res.numbers[0].value, res.numbers[2].value);
        prop_assert!((q - p).abs() <= TOL, "p {p} q {q}");
        prop_assert!((q * 100.0 - c).abs() <= 100.0 * TOL + 1e-9, "c {c} back {}", q * 100.0);
    }

    #[test]
    fn odds_round_trip(o in 1.0f64..1000.0) {
        let res = run(&input(
            vec![
                call("p", "odds_to_probability", &[("decimal_odds", "o")]),
                call("o2", "price_to_odds", &[("probability", "p")]),
            ],
            vec![("o", num(o))],
            &[],
        ));
        prop_assert!(res.ok);
        let o2 = res.numbers[1].value;
        prop_assert!((o2 - o).abs() / o <= 1e-6, "o {o} o2 {o2}");
    }

    // 4. expected_value
    #[test]
    fn ev_sign_matches_probability_against_price(c in price(), p in prob()) {
        let res = run(&input(
            vec![call("ev", "expected_value", &[("price_cents", "c"), ("probability", "p")])],
            vec![("c", num(c)), ("p", num(p))],
            &[("p", Origin::User)],
        ));
        let (ev, r) = last(&res).unwrap();
        prop_assert!((-100.0..=100.0).contains(&ev));
        let edge = p * 100.0 - c;
        if edge.abs() > 1e-8 {
            prop_assert_eq!(sign(ev), sign(edge), "c {} p {} ev {}", c, p, ev);
        }
        prop_assert_eq!(r.origins, vec![Origin::User]);
    }

    #[test]
    fn ev_grows_with_probability(c in price(), p1 in prob(), p2 in prob()) {
        let ev = |p: f64| {
            let res = run(&input(
                vec![call("ev", "expected_value", &[("price_cents", "c"), ("probability", "p")])],
                vec![("c", num(c)), ("p", num(p))],
                &[("p", Origin::User)],
            ));
            last(&res).unwrap().0
        };
        let (lo, hi) = if p1 <= p2 { (p1, p2) } else { (p2, p1) };
        prop_assert!(ev(lo) <= ev(hi));
    }

    #[test]
    fn ev_at_the_markets_own_price_is_zero(c in price()) {
        let res = run(&input(
            vec![
                call("q", "implied_probability", &[("price_cents", "c")]),
                call("ev", "expected_value", &[("price_cents", "c"), ("probability", "q")]),
            ],
            vec![("c", num(c))],
            &[("c", Origin::Market)],
        ));
        prop_assert!(last(&res).unwrap().0.abs() <= 1e-6);
    }

    #[test]
    fn ev_refuses_a_probability_with_no_source(
        c in price(),
        p in prob(),
        o in prop::option::of(Just(Origin::Connection)),
        via_op in any::<bool>(),
    ) {
        // Untagged (what a model's number would be) or tagged connection, direct or through an op.
        let mut ops = vec![];
        let p_ref = if via_op {
            ops.push(call("q", "base_rate", &[("hits", "p"), ("total", "one")]));
            "q"
        } else {
            "p"
        };
        ops.push(call("ev", "expected_value", &[("price_cents", "c"), ("probability", p_ref)]));
        let origins: Vec<(&str, Origin)> = o.map(|o| vec![("p", o), ("one", Origin::User)]).unwrap_or_default();
        let res = run(&input(ops, vec![("c", num(c)), ("p", num(p)), ("one", num(1.0))], &origins));
        prop_assert_eq!(last(&res).unwrap_err(), "unsourced_probability");
    }

    // 5. movement
    #[test]
    fn movement_is_bounded_and_full_window_is_last_minus_first(s in series(1), w in 1.0f64..20_000.0) {
        let first = s[0].v;
        let lastv = s[s.len() - 1].v;
        let span = (s[s.len() - 1].t - s[0].t) as f64;
        let m = one("movement", &[("series", "s"), ("window_s", "w")], vec![("s", Value::Series(s)), ("w", num(w))]).unwrap();
        prop_assert!((-100.0..=100.0).contains(&m));
        if w >= span {
            prop_assert!((m - (lastv - first)).abs() <= TOL);
        }
    }

    #[test]
    fn movement_of_a_flat_series_is_zero(v in price(), n in 1usize..30, w in 1.0f64..1e5) {
        let s: Vec<Point> = (0..n as i64).map(|t| Point { t: t * 60, v }).collect();
        let m = one("movement", &[("series", "s"), ("window_s", "w")], vec![("s", Value::Series(s)), ("w", num(w))]).unwrap();
        prop_assert_eq!(m, 0.0);
    }

    // 5b. price_at: a point of a line. It is always one of the series' own prices, the last at ago 0, the first once
    // ago covers the span; and a move over a window is the line's last point minus its point that far back.
    #[test]
    fn price_at_is_a_point_of_the_series_and_movement_is_a_difference_of_two(s in series(1), ago in 0.0f64..20_000.0, w in 1.0f64..20_000.0) {
        let at = |a: f64| one("price_at", &[("series", "s"), ("ago_s", "a")], vec![("s", Value::Series(s.clone())), ("a", num(a))]).unwrap();
        let v = at(ago);
        prop_assert!(s.iter().any(|p| (p.v - v).abs() <= TOL), "price_at {v} is not a point of the series");
        prop_assert!((at(0.0) - s[s.len() - 1].v).abs() <= TOL);
        let span = (s[s.len() - 1].t - s[0].t) as f64;
        if ago >= span && ago > 0.0 {
            prop_assert!((v - s[0].v).abs() <= TOL);
        }
        let m = one("movement", &[("series", "s"), ("window_s", "w")], vec![("s", Value::Series(s.clone())), ("w", num(w))]).unwrap();
        prop_assert!((m - (at(0.0) - at(w))).abs() <= TOL);
    }

    #[test]
    fn price_at_moves_back_in_time_with_ago(s in series(1), a in 0.0f64..10_000.0, b in 0.0f64..10_000.0) {
        // A larger ago never reads a later point.
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        let last_t = s[s.len() - 1].t as f64;
        let t_of = |ago: f64| s.iter().find(|p| p.t as f64 >= last_t - ago).map(|p| p.t).unwrap_or(s[s.len() - 1].t);
        prop_assert!(t_of(hi) <= t_of(lo));
        let refused = one("price_at", &[("series", "s"), ("ago_s", "a")], vec![("s", Value::Series(s)), ("a", num(-1.0 - lo))]);
        prop_assert_eq!(refused.unwrap_err(), "out_of_range");
    }

    // 5c. Moves with a receipt: every series and price carries where and when it was read, and the receipt shows it.
    #[test]
    fn move_and_line_receipts_carry_the_series_provenance(s in series(2), secs in 0u32..86_400) {
        let ops = vec![
            call("n1", "movement", &[("series", "series_1"), ("window_s", "day_s")]),
            call("n2", "price_at", &[("series", "series_1"), ("ago_s", "ago_1")]),
        ];
        let mut inp = input(ops, vec![("series_1", Value::Series(s.clone())), ("day_s", num(86_400.0)), ("ago_1", num(0.0))], &[("series_1", Origin::History)]);
        let prov = Provenance { source: "kalshi:KXNBAGAME-26NOV07LALBOS-LAL".into(), as_of: format!("2026-11-07T{:02}:{:02}:{:02}Z", secs / 3600, secs / 60 % 60, secs % 60) };
        inp.provenance.insert("series_1".into(), prov.clone());
        let res = run(&inp);
        prop_assert!(res.ok);
        for r in &res.receipts {
            prop_assert_eq!(&r.provenance["series"], &prov);
            prop_assert_eq!(&r.refs["series"], "series_1");
            prop_assert_eq!(&r.origins, &vec![Origin::History]);
            prop_assert_eq!(&r.input_hash, &res.input_hash);
        }
        prop_assert!((res.numbers[1].value - s[s.len() - 1].v).abs() <= TOL);
    }

    // 6. volatility
    #[test]
    fn volatility_is_bounded_and_ignores_level(s in series(2), shift in -50.0f64..50.0) {
        let sd = one("volatility", &[("series", "s")], vec![("s", Value::Series(s.clone()))]).unwrap();
        prop_assert!((0.0..=100.0).contains(&sd));
        let shifted: Vec<Point> = s.iter().map(|p| Point { t: p.t, v: p.v + shift }).collect();
        if shifted.iter().all(|p| (0.0..=100.0).contains(&p.v)) {
            let sd2 = one("volatility", &[("series", "s")], vec![("s", Value::Series(shifted))]).unwrap();
            prop_assert!((sd - sd2).abs() <= 1e-6, "sd {sd} shifted {sd2}");
        }
        // Mirrored prices (100 - v) move the same amount the other way.
        let mirrored: Vec<Point> = s.iter().map(|p| Point { t: p.t, v: 100.0 - p.v }).collect();
        let sd3 = one("volatility", &[("series", "s")], vec![("s", Value::Series(mirrored))]).unwrap();
        prop_assert!((sd - sd3).abs() <= 1e-6);
    }

    #[test]
    fn volatility_of_a_steady_trend_is_zero(start in 0.0f64..50.0, step in 0.0f64..1.0, n in 2usize..40) {
        let s: Vec<Point> = (0..n).map(|i| Point { t: i as i64, v: start + step * i as f64 }).collect();
        let sd = one("volatility", &[("series", "s")], vec![("s", Value::Series(s))]).unwrap();
        prop_assert!(sd <= 1e-6, "sd {sd}");
    }

    // 7. gap: Kalshi–Polymarket
    #[test]
    fn gap_is_symmetric(k in price(), p in price()) {
        let gap = |a: &str, b: &str| one("gap", &[("a_cents", a), ("b_cents", b)], vec![("k", num(k)), ("p", num(p))]).unwrap();
        let (kp, pk) = (gap("k", "p"), gap("p", "k"));
        prop_assert_eq!(kp, -pk);
        prop_assert!((-100.0..=100.0).contains(&kp));
        prop_assert!((kp - (p - k)).abs() <= TOL);
        prop_assert_eq!(gap("k", "k"), 0.0);
    }

    // 7b. Two prices: the gap's receipt carries both prices, where and when each was read, and the plan's hash;
    // provenance changes the input hash, and an input without it hashes as before.
    #[test]
    fn gap_receipt_has_both_prices_and_their_provenance(k in price(), p in price(), ks in 0u32..1_000_000, ps in 0u32..1_000_000) {
        let ops = vec![call("n1", "gap", &[("a_cents", "kalshi_price"), ("b_cents", "polymarket_price")])];
        let origins = [("kalshi_price", Origin::Market), ("polymarket_price", Origin::Market)];
        let bare = input(ops, vec![("kalshi_price", num(k)), ("polymarket_price", num(p))], &origins);
        let mut with = bare.clone();
        let prov = |source: String, s: u32| Provenance { source, as_of: format!("2026-11-07T22:{:02}:{:02}.{:03}Z", s / 60_000 % 60, s / 1000 % 60, s % 1000) };
        with.provenance.insert("kalshi_price".into(), prov(format!("kalshi:KXNFLGAME-26NOV08CINATL-CIN{ks}"), ks));
        with.provenance.insert("polymarket_price".into(), prov(format!("polymarket:nfl-cin-atl-2026-11-08-{ps}"), ps));
        let (a, b) = (run(&bare), run(&with));
        prop_assert!(a.ok && b.ok);
        prop_assert_eq!(a.numbers[0].value, b.numbers[0].value);
        prop_assert!((b.numbers[0].value - (p - k)).abs() <= TOL);
        let r = &b.receipts[0];
        prop_assert_eq!(&r.provenance["a_cents"], &with.provenance["kalshi_price"]);
        prop_assert_eq!(&r.provenance["b_cents"], &with.provenance["polymarket_price"]);
        prop_assert_eq!(r.args.len(), 2);
        prop_assert_eq!(&r.refs["a_cents"], "kalshi_price");
        prop_assert_eq!(&r.plan_hash, &hash_json(&with.plan));
        prop_assert_eq!(&r.origins, &vec![Origin::Market]);
        prop_assert!(a.receipts[0].provenance.is_empty());
        prop_assert_eq!(&a.input_hash, &hash_json(&serde_json::json!({"numbers": &bare.numbers, "origins": &bare.origins})));
        prop_assert_ne!(&a.input_hash, &b.input_hash);
        prop_assert_eq!(&a.plan_hash, &b.plan_hash);
    }

    // 8. base_rate
    #[test]
    fn base_rate_is_a_ratio(total in 1u32..10_000, frac in 0.0f64..=1.0) {
        let hits = (f64::from(total) * frac).floor();
        let r = one("base_rate", &[("hits", "h"), ("total", "t")], vec![("h", num(hits)), ("t", num(f64::from(total)))]).unwrap();
        prop_assert!((0.0..=1.0).contains(&r));
        prop_assert!((r - hits / f64::from(total)).abs() <= TOL);
    }

    #[test]
    fn base_rate_refuses_more_hits_than_total(total in 1u32..1000, extra in 1u32..100) {
        let r = one("base_rate", &[("hits", "h"), ("total", "t")], vec![("h", num(f64::from(total + extra))), ("t", num(f64::from(total)))]);
        prop_assert_eq!(r, Err("out_of_range".into()));
    }

    // 9. base_rate_history
    #[test]
    fn base_rate_history_matches_a_plain_count(h in history(1), lo in 0u32..=100, width in 0u32..=100) {
        let (lo, hi) = (f64::from(lo), f64::from((lo + width).min(100)));
        let in_band: Vec<&Resolved> = h.iter().filter(|r| r.price_cents >= lo && r.price_cents <= hi).collect();
        let res = run(&input(
            vec![call("b", "base_rate_history", &[("history", "h"), ("lo_cents", "lo"), ("hi_cents", "hi")])],
            vec![("h", Value::History(h.clone())), ("lo", num(lo)), ("hi", num(hi))],
            &[("h", Origin::History)],
        ));
        if in_band.is_empty() {
            prop_assert_eq!(last(&res).unwrap_err(), "out_of_range");
        } else {
            let (rate, r) = last(&res).unwrap();
            let yes = in_band.iter().filter(|r| r.outcome == 1.0).count() as f64;
            prop_assert!((0.0..=1.0).contains(&rate));
            prop_assert!((rate - yes / in_band.len() as f64).abs() <= 1e-9);
            prop_assert_eq!(r.sample_size, Some(in_band.len() as u32));
            prop_assert_eq!(r.origins, vec![Origin::History]);
        }
    }

    #[test]
    fn base_rate_history_ignores_order_and_splits_into_bands(h in history(1)) {
        let rate = |h: Vec<Resolved>, band: Option<(f64, f64)>| {
            let mut args = vec![("history", "h")];
            let mut nums = vec![("h", Value::History(h))];
            if let Some((lo, hi)) = band {
                args.extend([("lo_cents", "lo"), ("hi_cents", "hi")]);
                nums.extend([("lo", num(lo)), ("hi", num(hi))]);
            }
            last(&run(&input(vec![call("b", "base_rate_history", &args)], nums, &[])))
                .ok()
                .map(|(v, r)| (v, r.sample_size.unwrap()))
        };
        let (all, n) = rate(h.clone(), None).unwrap();
        let mut rev = h.clone();
        rev.reverse();
        prop_assert_eq!(rate(rev, None), Some((all, n)));
        prop_assert_eq!(rate(h.clone(), Some((0.0, 100.0))), Some((all, n)));
        // Whole-cent prices: 0..=49 and 50..=100 split the history; the rates average back.
        let parts = [rate(h.clone(), Some((0.0, 49.0))), rate(h, Some((50.0, 100.0)))];
        let (sum, count) = parts.iter().flatten().fold((0.0, 0u32), |(s, c), (v, k)| (s + v * f64::from(*k), c + k));
        prop_assert_eq!(count, n);
        prop_assert!((sum / f64::from(count) - all).abs() <= 1e-6);
    }

    // 10. position_value
    #[test]
    fn position_value_is_bounded_and_linear(count in 0.0f64..1e6, c in price()) {
        let v = |n: f64| one("position_value", &[("count", "n"), ("price_cents", "c")], vec![("n", num(n)), ("c", num(c))]).unwrap();
        let x = v(count);
        prop_assert!(x >= 0.0 && x <= count + TOL);
        prop_assert!((v(count * 2.0) - 2.0 * x).abs() <= 1e-6);
    }

    // 11. pnl
    #[test]
    fn pnl_sign_and_symmetry(count in 0.0f64..1e5, avg in price(), c in price()) {
        let pnl = |a: f64, b: f64| one("pnl", &[("count", "n"), ("avg_price_cents", "a"), ("price_cents", "b")], vec![("n", num(count)), ("a", num(a)), ("b", num(b))]).unwrap();
        let x = pnl(avg, c);
        if count > 0.0 && (c - avg).abs() > 1e-6 {
            prop_assert_eq!(sign(x), sign(c - avg));
        }
        prop_assert!((x + pnl(c, avg)).abs() <= 1e-6);
        let value = |p: f64| one("position_value", &[("count", "n"), ("price_cents", "c")], vec![("n", num(count)), ("c", num(p))]).unwrap();
        prop_assert!((x - (value(c) - value(avg))).abs() <= 1e-6);
    }
}

// ---- Whole plans: arbitrary ops, refs and numbers ----

const OPS: &[(&str, &[&str])] = &[
    ("implied_probability", &["price_cents"]),
    ("price_to_odds", &["probability"]),
    ("odds_to_probability", &["decimal_odds"]),
    ("expected_value", &["price_cents", "probability"]),
    ("movement", &["series", "window_s"]),
    ("volatility", &["series"]),
    ("gap", &["a_cents", "b_cents"]),
    ("base_rate", &["hits", "total"]),
    ("base_rate_history", &["history", "lo_cents", "hi_cents"]),
    ("position_value", &["count", "price_cents"]),
    ("pnl", &["count", "avg_price_cents", "price_cents"]),
];

const KEYS: &[&str] = &["a", "b", "c", "d", "e", "f"];

/// Any f64, the awkward ones included.
fn any_number() -> impl Strategy<Value = f64> {
    prop_oneof![
        price(),
        prob(),
        any::<f64>(),
        Just(f64::NAN),
        Just(f64::INFINITY),
        Just(f64::NEG_INFINITY),
        Just(-0.0),
        Just(f64::MAX),
        Just(f64::MIN_POSITIVE),
    ]
}

fn any_value() -> impl Strategy<Value = Value> {
    prop_oneof![
        3 => any_number().prop_map(Value::Number),
        1 => series(0).prop_map(Value::Series),
        1 => prop::collection::vec((any::<i64>(), any_number()), 0..6)
            .prop_map(|v| Value::Series(v.into_iter().map(|(t, v)| Point { t, v }).collect())),
        1 => history(0).prop_map(Value::History),
        1 => prop::collection::vec((any::<i64>(), any_number(), any_number()), 0..6)
            .prop_map(|v| Value::History(v.into_iter().map(|(t, p, o)| Resolved { t, price_cents: p, outcome: o }).collect())),
    ]
}

fn any_origin() -> impl Strategy<Value = Origin> {
    prop_oneof![
        Just(Origin::User),
        Just(Origin::Market),
        Just(Origin::History),
        Just(Origin::Connection)
    ]
}

/// A plan of up to 12 ops whose args point at inputs, earlier ops, later ops or nothing.
fn any_input() -> impl Strategy<Value = EngineInput> {
    let numbers =
        prop::collection::btree_map(prop::sample::select(KEYS), any_value(), 0..=KEYS.len());
    let origins =
        prop::collection::btree_map(prop::sample::select(KEYS), any_origin(), 0..=KEYS.len());
    let ops = prop::collection::vec(
        (
            0..OPS.len(),
            prop::collection::vec((any::<bool>(), 0usize..20), 3),
        ),
        0..12,
    );
    (numbers, origins, ops).prop_map(|(numbers, origins, ops)| {
        let ops = ops
            .into_iter()
            .enumerate()
            .map(|(i, (op, picks))| {
                let (name, args) = OPS[op];
                let args = args
                    .iter()
                    .zip(&picks)
                    // Optional args may be left out; a ref is an input key, an op id, or neither.
                    .filter(|(a, (skip, _))| {
                        !(*skip && a.ends_with("_cents") && name == "base_rate_history")
                    })
                    .map(|(a, (_, r))| {
                        let r = if *r < KEYS.len() {
                            KEYS[*r].to_string()
                        } else {
                            format!("n{}", r - KEYS.len())
                        };
                        (a.to_string(), r)
                    })
                    .collect();
                OpCall {
                    id: format!("n{i}"),
                    op: op_name(name),
                    args,
                }
            })
            .collect();
        let numbers: BTreeMap<String, Value> = numbers
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        // Keep origins to keys that exist, so the plan is valid and ops run.
        let origins = origins
            .into_iter()
            .filter(|(k, _)| numbers.contains_key(*k))
            .map(|(k, o)| (k.to_string(), o))
            .collect();
        EngineInput {
            plan: Plan {
                plan_version: 1,
                ops,
            },
            numbers,
            origins,
            provenance: Default::default(),
        }
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Whatever comes in, the engine doesn't panic, and every number it gives is finite
    /// and in its unit's range, with one receipt each.
    #[test]
    fn any_plan_gives_numbers_in_range(inp in any_input()) {
        let res = run(&inp);
        prop_assert_eq!(res.ok, res.errors.is_empty());
        prop_assert_eq!(res.numbers.len(), res.receipts.len());
        prop_assert_eq!(res.numbers.len() + res.errors.len(), inp.plan.ops.len());
        for (n, r) in res.numbers.iter().zip(&res.receipts) {
            prop_assert!(n.value.is_finite());
            prop_assert_eq!(&n.receipt_id, &r.id);
            prop_assert_eq!(n.value, r.value);
            match n.unit {
                Unit::Probability | Unit::Ratio => prop_assert!((0.0..=1.0).contains(&n.value), "{:?} {}", n.op, n.value),
                Unit::DecimalOdds => prop_assert!(n.value >= 1.0),
                Unit::Points | Unit::Cents => prop_assert!((-100.0..=100.0).contains(&n.value)),
                Unit::Dollars => {}
            }
            // EV only ever rests on user, market or history inputs.
            if n.op == OpName::ExpectedValue {
                prop_assert!(!r.origins.is_empty());
            }
        }
    }

    /// Same input, same result. The hashes cover exactly the plan and the inputs.
    #[test]
    fn receipts_are_deterministic_and_hash_what_ran(inp in any_input(), bump in 1.0f64..10.0) {
        let res = run(&inp);
        prop_assert_eq!(&res, &run(&inp.clone()));
        prop_assert_eq!(&res.plan, &inp.plan);
        prop_assert_eq!(&res.plan_hash, &hash_json(&inp.plan));
        prop_assert_eq!(res.engine_version.as_str(), engine::ENGINE_VERSION);
        prop_assert_eq!(res.git_hash.as_str(), engine::GIT_HASH);
        let mut ids: Vec<&str> = res.receipts.iter().map(|r| r.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        prop_assert_eq!(ids.len(), res.receipts.len());
        for r in &res.receipts {
            prop_assert_eq!(&r.plan_hash, &res.plan_hash);
            prop_assert_eq!(&r.input_hash, &res.input_hash);
            let planned = &inp.plan.ops.iter().find(|c| c.id == r.op_id).unwrap().args;
            prop_assert_eq!(&r.refs, planned);
        }

        // A changed number changes the input hash, not the plan hash.
        let mut changed = inp.clone();
        changed.numbers.insert("zz".into(), Value::Number(bump));
        let res2 = run(&changed);
        prop_assert_ne!(&res2.input_hash, &res.input_hash);
        prop_assert_eq!(&res2.plan_hash, &res.plan_hash);
        // So does a changed origin.
        let mut tagged = changed.clone();
        tagged.origins.insert("zz".into(), Origin::User);
        prop_assert_ne!(run(&tagged).input_hash, res2.input_hash);
    }

    /// The CLI reads JSON: a JSON round trip of the input gives the same result, hashes included.
    #[test]
    fn json_round_trip_keeps_the_result(inp in any_input()) {
        // JSON has no NaN or infinity (serde_json writes null, which won't parse back), so swap them for 0.
        let fin = |x: f64| if x.is_finite() { x } else { 0.0 };
        let mut inp = inp;
        for v in inp.numbers.values_mut() {
            match v {
                Value::Number(x) => *x = fin(*x),
                Value::Series(s) => s.iter_mut().for_each(|p| p.v = fin(p.v)),
                Value::History(h) => h.iter_mut().for_each(|r| {
                    r.price_cents = fin(r.price_cents);
                    r.outcome = fin(r.outcome);
                }),
            }
        }
        let text = serde_json::to_string(&inp).unwrap();
        let back: EngineInput = serde_json::from_str(&text).unwrap();
        // An empty series and an empty history both read back as an empty series.
        let res = run(&inp);
        let res_back = run(&back);
        prop_assert_eq!(&res_back.plan_hash, &res.plan_hash);
        prop_assert_eq!(&res_back.input_hash, &res.input_hash);
        prop_assert_eq!(res_back.numbers, res.numbers);
        prop_assert_eq!(res_back.errors.len(), res.errors.len());
    }
}
