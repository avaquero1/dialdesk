//! base_rate_history on real history: this season's settled NFL and NBA game winners on Kalshi, priced before each
//! start (fixtures/markets/live/weekend/resolved/engine-history.json, from services/markets/scripts/record-resolved.ts).
//! Any band, any order and any part of the recording: the rate is the plain count, its receipt's sample size is the
//! count, and the home teams' rate is their wins over their games.

use std::collections::BTreeMap;
use std::path::Path;

use engine::{EngineInput, OpCall, OpName, Origin, Plan, Resolved, Value, run};
use proptest::prelude::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct League {
    all: Vec<Resolved>,
    home: Vec<Resolved>,
}

fn recorded() -> BTreeMap<String, League> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/markets/live/weekend/resolved/engine-history.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("engine-history.json"))
        .expect("history shape")
}

/// base_rate_history over `h` in lo..=hi: (rate, sample size), or the error code.
fn rate(h: Vec<Resolved>, band: Option<(f64, f64)>) -> Result<(f64, u32), String> {
    let mut args = BTreeMap::from([("history".to_string(), "h".to_string())]);
    let mut numbers = BTreeMap::from([("h".to_string(), Value::History(h))]);
    if let Some((lo, hi)) = band {
        args.insert("lo_cents".into(), "lo".into());
        args.insert("hi_cents".into(), "hi".into());
        numbers.insert("lo".into(), Value::Number(lo));
        numbers.insert("hi".into(), Value::Number(hi));
    }
    let input = EngineInput {
        plan: Plan {
            plan_version: 1,
            ops: vec![OpCall {
                id: "n1".into(),
                op: OpName::BaseRateHistory,
                args,
            }],
        },
        numbers,
        origins: BTreeMap::from([("h".to_string(), Origin::History)]),
        provenance: Default::default(),
    };
    let res = run(&input);
    if let Some(e) = res.errors.first() {
        return Err(e.code.clone());
    }
    Ok((
        res.numbers[0].value,
        res.receipts[0].sample_size.expect("sample_size"),
    ))
}

fn plain(h: &[Resolved], lo: f64, hi: f64) -> (u32, u32) {
    let inb: Vec<_> = h
        .iter()
        .filter(|r| r.price_cents >= lo && r.price_cents <= hi)
        .collect();
    (
        inb.iter().filter(|r| r.outcome == 1.0).count() as u32,
        inb.len() as u32,
    )
}

#[test]
fn the_recording_is_this_seasons_games() {
    let rec = recorded();
    for (name, l) in &rec {
        assert!(l.all.len() > 200, "{name}: {} records", l.all.len());
        assert_eq!(
            l.home.len() * 2,
            l.all.len(),
            "{name}: every game is one home and one away market"
        );
        // Home teams' rate: their wins over their games, as the engine counts it.
        let (yes, n) = plain(&l.home, 0.0, 100.0);
        let (v, size) = rate(l.home.clone(), None).unwrap();
        assert_eq!(size, n);
        assert!((v - f64::from(yes) / f64::from(n)).abs() < 2e-9, "{name}");
        // Every game has one winner, so over both markets of every game the rate is exactly a half.
        assert_eq!(
            rate(l.all.clone(), None).unwrap(),
            (0.5, l.all.len() as u32),
            "{name}"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn any_band_of_real_history_is_the_plain_count(nba in any::<bool>(), lo in 0u32..=95, width in 0u32..=40) {
        let rec = recorded();
        let h = &rec[if nba { "nba" } else { "nfl" }].all;
        let (lo, hi) = (f64::from(lo), f64::from((lo + width).min(100)));
        let (yes, n) = plain(h, lo, hi);
        match rate(h.clone(), Some((lo, hi))) {
            Ok((v, size)) => {
                prop_assert_eq!(size, n);
                prop_assert!((v - f64::from(yes) / f64::from(n)).abs() < 2e-9);
                prop_assert!((0.0..=1.0).contains(&v));
            }
            Err(code) => {
                prop_assert_eq!(n, 0, "refused ({}) with {} records in the band", code, n);
                prop_assert_eq!(code, "out_of_range");
            }
        }
    }

    #[test]
    fn order_and_any_part_of_real_history_dont_change_the_count(nba in any::<bool>(), seed in any::<u64>(), keep in 1usize..=300) {
        let rec = recorded();
        let mut h = rec[if nba { "nba" } else { "nfl" }].home.clone();
        // A seeded shuffle, then a part of it.
        let mut s = seed | 1;
        for i in (1..h.len()).rev() {
            s ^= s << 13; s ^= s >> 7; s ^= s << 17;
            h.swap(i, (s % (i as u64 + 1)) as usize);
        }
        h.truncate(keep.min(h.len()));
        let (yes, n) = plain(&h, 0.0, 100.0);
        let (v, size) = rate(h, None).unwrap();
        prop_assert_eq!(size, n);
        prop_assert!((v - f64::from(yes) / f64::from(n)).abs() < 2e-9);
    }
}
