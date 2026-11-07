//! The op set: arg specs, units, formulas and the math itself.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{OpCall, OpError, OpName, Point, ReceiptArg, SeriesSummary, Value, hash_json};

/// The unit of a computed number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    /// 0..=1.
    Probability,
    /// Decimal odds, >= 1.
    DecimalOdds,
    /// Cents per contract.
    Cents,
    /// Price points (1 point = 1 cent of price).
    Points,
    Dollars,
    Ratio,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Num,
    Series,
}

enum Arg<'a> {
    Num(f64),
    Series(&'a [Point]),
}

type Fail = (&'static str, String);

impl OpName {
    fn spec(self) -> &'static [(&'static str, Kind)] {
        use Kind::*;
        match self {
            OpName::ImpliedProbability => &[("price_cents", Num)],
            OpName::PriceToOdds => &[("probability", Num)],
            OpName::OddsToProbability => &[("decimal_odds", Num)],
            OpName::ExpectedValue => &[("price_cents", Num), ("probability", Num)],
            OpName::Movement => &[("series", Series), ("window_s", Num)],
            OpName::Volatility => &[("series", Series)],
            OpName::Gap => &[("a_cents", Num), ("b_cents", Num)],
            OpName::BaseRate => &[("hits", Num), ("total", Num)],
            OpName::PositionValue => &[("count", Num), ("price_cents", Num)],
            OpName::Pnl => &[
                ("count", Num),
                ("avg_price_cents", Num),
                ("price_cents", Num),
            ],
        }
    }

    pub fn unit(self) -> Unit {
        match self {
            OpName::ImpliedProbability | OpName::OddsToProbability => Unit::Probability,
            OpName::PriceToOdds => Unit::DecimalOdds,
            OpName::ExpectedValue => Unit::Cents,
            OpName::Movement | OpName::Volatility | OpName::Gap => Unit::Points,
            OpName::BaseRate => Unit::Ratio,
            OpName::PositionValue | OpName::Pnl => Unit::Dollars,
        }
    }

    pub fn formula(self) -> &'static str {
        match self {
            OpName::ImpliedProbability => "p = price_cents / 100",
            OpName::PriceToOdds => "odds = 1 / probability",
            OpName::OddsToProbability => "p = 1 / decimal_odds",
            OpName::ExpectedValue => "ev = probability * 100 - price_cents",
            OpName::Movement => "move = last.v - v of first point with t >= last.t - window_s",
            OpName::Volatility => "sd = population stddev of (v[i] - v[i-1])",
            OpName::Gap => "gap = b_cents - a_cents",
            OpName::BaseRate => "rate = hits / total",
            OpName::PositionValue => "value = count * price_cents / 100",
            OpName::Pnl => "pnl = count * (price_cents - avg_price_cents) / 100",
        }
    }
}

/// Resolves one call's args and computes its value.
pub(crate) fn eval(
    call: &OpCall,
    numbers: &BTreeMap<String, Value>,
    done: &BTreeMap<&str, Option<f64>>,
) -> Result<(f64, BTreeMap<String, ReceiptArg>), OpError> {
    let err = |code: &str, msg: String| OpError::new(&call.id, code, msg);
    let spec = call.op.spec();
    if let Some(extra) = call.args.keys().find(|k| !spec.iter().any(|(n, _)| n == k)) {
        return Err(err("bad_arg", format!("unknown arg {extra:?}")));
    }

    let mut args = BTreeMap::new();
    let mut receipt = BTreeMap::new();
    for &(name, kind) in spec {
        let Some(r) = call.args.get(name) else {
            return Err(err("bad_arg", format!("missing arg {name:?}")));
        };
        let arg = match (done.get(r.as_str()), numbers.get(r)) {
            (Some(Some(v)), _) => Arg::Num(*v),
            (Some(None), _) => return Err(err("missing_input", format!("op {r:?} failed"))),
            (None, Some(Value::Number(v))) => Arg::Num(*v),
            (None, Some(Value::Series(s))) => Arg::Series(s),
            (None, None) => {
                return Err(err(
                    "missing_input",
                    format!("no number or earlier op named {r:?}"),
                ));
            }
        };
        let rec = match (&arg, kind) {
            (Arg::Num(v), Kind::Num) => ReceiptArg::Number(*v),
            (Arg::Series(s), Kind::Series) => ReceiptArg::Series(SeriesSummary {
                points: s.len() as u32,
                first_t: s.first().map_or(0, |p| p.t),
                last_t: s.last().map_or(0, |p| p.t),
                hash: hash_json(s),
            }),
            (_, Kind::Num) => return Err(err("bad_arg", format!("{name:?} must be a number"))),
            (_, Kind::Series) => return Err(err("bad_arg", format!("{name:?} must be a series"))),
        };
        args.insert(name, arg);
        receipt.insert(name.to_string(), rec);
    }

    let value = compute(call.op, &args).map_err(|(code, msg)| err(code, msg))?;
    if !value.is_finite() {
        return Err(err("out_of_range", "result is not finite".into()));
    }
    Ok((tidy(value), receipt))
}

/// Rounds to 9 decimal places so 0.62 * 100 - 57 reads 5, not 5.000000000000007.
fn tidy(x: f64) -> f64 {
    let r = (x * 1e9).round() / 1e9;
    if r == 0.0 { 0.0 } else { r }
}

fn compute(op: OpName, args: &BTreeMap<&str, Arg>) -> Result<f64, Fail> {
    let num = |n: &str| match args.get(n) {
        Some(Arg::Num(v)) => *v,
        _ => unreachable!("eval checked arg kinds"),
    };
    let series = |n: &str| match args.get(n) {
        Some(Arg::Series(s)) => *s,
        _ => unreachable!("eval checked arg kinds"),
    };
    let price = |n: &str| in_range(n, num(n), 0.0, 100.0);
    let prob = |n: &str| in_range(n, num(n), 0.0, 1.0);

    Ok(match op {
        OpName::ImpliedProbability => price("price_cents")? / 100.0,
        OpName::PriceToOdds => {
            let p = prob("probability")?;
            if p == 0.0 {
                return Err(("out_of_range", "probability must be > 0 for odds".into()));
            }
            1.0 / p
        }
        OpName::OddsToProbability => {
            let o = num("decimal_odds");
            if o < 1.0 {
                return Err(("out_of_range", format!("decimal_odds {o} must be >= 1")));
            }
            1.0 / o
        }
        OpName::ExpectedValue => prob("probability")? * 100.0 - price("price_cents")?,
        OpName::Movement => {
            let s = price_series(series("series"), 1)?;
            let w = num("window_s");
            if w <= 0.0 {
                return Err(("out_of_range", format!("window_s {w} must be > 0")));
            }
            let last = s[s.len() - 1];
            let from = last.t as f64 - w;
            let start = s.iter().find(|p| p.t as f64 >= from).unwrap_or(&last);
            last.v - start.v
        }
        OpName::Volatility => {
            let s = price_series(series("series"), 2)?;
            let d: Vec<f64> = s.windows(2).map(|w| w[1].v - w[0].v).collect();
            let mean = d.iter().sum::<f64>() / d.len() as f64;
            (d.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / d.len() as f64).sqrt()
        }
        OpName::Gap => price("b_cents")? - price("a_cents")?,
        OpName::BaseRate => {
            let (h, t) = (num("hits"), num("total"));
            if t <= 0.0 {
                return Err(("out_of_range", format!("total {t} must be > 0")));
            }
            in_range("hits", h, 0.0, t)? / t
        }
        OpName::PositionValue => count(num("count"))? * price("price_cents")? / 100.0,
        OpName::Pnl => {
            let c = count(num("count"))?;
            c * (price("price_cents")? - price("avg_price_cents")?) / 100.0
        }
    })
}

fn in_range(name: &str, v: f64, lo: f64, hi: f64) -> Result<f64, Fail> {
    if (lo..=hi).contains(&v) {
        Ok(v)
    } else {
        Err(("out_of_range", format!("{name} {v} must be in {lo}..={hi}")))
    }
}

fn count(c: f64) -> Result<f64, Fail> {
    if c >= 0.0 {
        Ok(c)
    } else {
        Err(("out_of_range", format!("count {c} must be >= 0")))
    }
}

/// A price series: at least `min` points, sorted by t, every v in 0..=100.
fn price_series(s: &[Point], min: usize) -> Result<&[Point], Fail> {
    if s.len() < min {
        return Err((
            "out_of_range",
            format!("series needs at least {min} point(s)"),
        ));
    }
    if s.windows(2).any(|w| w[1].t < w[0].t) {
        return Err(("bad_arg", "series must be sorted by t".into()));
    }
    for p in s {
        in_range("series v", p.v, 0.0, 100.0)?;
    }
    Ok(s)
}
