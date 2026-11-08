//! The op set: arg specs, units, formulas and the math itself.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    EngineInput, OpCall, OpError, OpName, Origin, Point, ReceiptArg, Resolved, SeriesSummary,
    Value, hash_json,
};

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
    History,
}

/// One arg of an op: its name, kind, and whether the plan must give it.
type ArgSpec = (&'static str, Kind, bool);

enum Arg<'a> {
    Num(f64),
    Series(&'a [Point]),
    History(&'a [Resolved]),
}

type Fail = (&'static str, String);

/// Where a value's inputs came from, followed through earlier ops.
#[derive(Debug, Clone, Default)]
pub(crate) struct Trace {
    pub origins: BTreeSet<Origin>,
    /// True when some input (or an input of an earlier op) had no origin.
    pub untagged: bool,
}

impl Trace {
    fn add(&mut self, other: &Trace) {
        self.origins.extend(other.origins.iter().copied());
        self.untagged |= other.untagged;
    }
}

/// The output of an op that ran, as later ops see it.
pub(crate) struct Done {
    pub value: f64,
    pub unit: Unit,
    pub trace: Trace,
}

/// What `eval` hands back for one op.
pub(crate) struct Out {
    pub value: f64,
    pub receipt_args: BTreeMap<String, ReceiptArg>,
    pub trace: Trace,
    pub sample_size: Option<u32>,
}

impl OpName {
    fn spec(self) -> &'static [ArgSpec] {
        use Kind::*;
        match self {
            OpName::ImpliedProbability => &[("price_cents", Num, true)],
            OpName::PriceToOdds => &[("probability", Num, true)],
            OpName::OddsToProbability => &[("decimal_odds", Num, true)],
            OpName::ExpectedValue => &[("price_cents", Num, true), ("probability", Num, true)],
            OpName::Movement => &[("series", Series, true), ("window_s", Num, true)],
            OpName::Volatility => &[("series", Series, true)],
            OpName::PriceAt => &[("series", Series, true), ("ago_s", Num, true)],
            OpName::Gap => &[("a_cents", Num, true), ("b_cents", Num, true)],
            OpName::BaseRate => &[("hits", Num, true), ("total", Num, true)],
            OpName::BaseRateHistory => &[
                ("history", History, true),
                ("lo_cents", Num, false),
                ("hi_cents", Num, false),
            ],
            OpName::PositionValue => &[("count", Num, true), ("price_cents", Num, true)],
            OpName::Pnl => &[
                ("count", Num, true),
                ("avg_price_cents", Num, true),
                ("price_cents", Num, true),
            ],
        }
    }

    pub fn unit(self) -> Unit {
        match self {
            OpName::ImpliedProbability | OpName::OddsToProbability => Unit::Probability,
            OpName::PriceToOdds => Unit::DecimalOdds,
            OpName::ExpectedValue | OpName::PriceAt => Unit::Cents,
            OpName::Movement | OpName::Volatility | OpName::Gap => Unit::Points,
            OpName::BaseRate | OpName::BaseRateHistory => Unit::Ratio,
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
            OpName::PriceAt => {
                "price = v of first point with t >= last.t - ago_s (the last point at ago_s 0)"
            }
            OpName::Gap => "gap = b_cents - a_cents",
            OpName::BaseRate => "rate = hits / total",
            OpName::BaseRateHistory => {
                "rate = resolved YES / n, over resolved markets with lo_cents <= price_cents <= hi_cents (default 0..=100)"
            }
            OpName::PositionValue => "value = count * price_cents / 100",
            OpName::Pnl => "pnl = count * (price_cents - avg_price_cents) / 100",
        }
    }
}

/// Resolves one call's args and computes its value.
pub(crate) fn eval(
    call: &OpCall,
    input: &EngineInput,
    done: &BTreeMap<&str, Option<Done>>,
) -> Result<Out, OpError> {
    let err = |code: &str, msg: String| OpError::new(&call.id, code, msg);
    let spec = call.op.spec();
    if let Some(extra) = call
        .args
        .keys()
        .find(|k| !spec.iter().any(|(n, _, _)| n == k))
    {
        return Err(err("bad_arg", format!("unknown arg {extra:?}")));
    }

    let mut args = BTreeMap::new();
    let mut receipt = BTreeMap::new();
    let mut trace = Trace::default();
    let mut traces: BTreeMap<&str, (Trace, Option<Unit>)> = BTreeMap::new();
    for &(name, kind, required) in spec {
        let Some(r) = call.args.get(name) else {
            if required {
                return Err(err("bad_arg", format!("missing arg {name:?}")));
            }
            continue;
        };
        let (arg, arg_trace, from_unit) = match (done.get(r.as_str()), input.numbers.get(r)) {
            (Some(Some(d)), _) => (Arg::Num(d.value), d.trace.clone(), Some(d.unit)),
            (Some(None), _) => return Err(err("missing_input", format!("op {r:?} failed"))),
            (None, Some(v)) => {
                let t = match input.origins.get(r) {
                    Some(o) => Trace {
                        origins: BTreeSet::from([*o]),
                        untagged: false,
                    },
                    None => Trace {
                        origins: BTreeSet::new(),
                        untagged: true,
                    },
                };
                let a = match v {
                    Value::Number(x) => Arg::Num(*x),
                    // `[]` parses as an empty series; a history arg reads it as an empty history.
                    Value::Series(s) if kind == Kind::History && s.is_empty() => Arg::History(&[]),
                    Value::Series(s) => Arg::Series(s),
                    Value::History(h) => Arg::History(h),
                };
                (a, t, None)
            }
            (None, None) => {
                return Err(err(
                    "missing_input",
                    format!("no number or earlier op named {r:?}"),
                ));
            }
        };
        let rec = match (&arg, kind) {
            (Arg::Num(v), Kind::Num) => {
                if !v.is_finite() {
                    return Err(err("out_of_range", format!("{name:?} must be finite")));
                }
                ReceiptArg::Number(*v)
            }
            (Arg::Series(s), Kind::Series) => ReceiptArg::Series(SeriesSummary {
                points: s.len() as u32,
                first_t: s.first().map_or(0, |p| p.t),
                last_t: s.last().map_or(0, |p| p.t),
                hash: hash_json(s),
            }),
            (Arg::History(h), Kind::History) => ReceiptArg::Series(SeriesSummary {
                points: h.len() as u32,
                first_t: h.iter().map(|x| x.t).min().unwrap_or(0),
                last_t: h.iter().map(|x| x.t).max().unwrap_or(0),
                hash: hash_json(h),
            }),
            (_, Kind::Num) => return Err(err("bad_arg", format!("{name:?} must be a number"))),
            (_, Kind::Series) => return Err(err("bad_arg", format!("{name:?} must be a series"))),
            (_, Kind::History) => {
                return Err(err(
                    "bad_arg",
                    format!("{name:?} must be a history of resolved markets"),
                ));
            }
        };
        trace.add(&arg_trace);
        traces.insert(name, (arg_trace, from_unit));
        args.insert(name, arg);
        receipt.insert(name.to_string(), rec);
    }

    if call.op == OpName::ExpectedValue {
        let (t, unit) = &traces["probability"];
        sourced_probability(t, *unit).map_err(|m| err("unsourced_probability", m))?;
    }

    let (value, sample_size) = compute(call.op, &args).map_err(|(code, msg)| err(code, msg))?;
    let value = tidy(value);
    if !value.is_finite() {
        return Err(err("out_of_range", "result is not finite".into()));
    }
    Ok(Out {
        value,
        receipt_args: receipt,
        trace,
        sample_size,
    })
}

/// EV's probability is the user's or a sourced number (an exchange's price, a base
/// rate), never a model's: every input it traces back to must carry such an origin.
fn sourced_probability(t: &Trace, from_unit: Option<Unit>) -> Result<(), String> {
    if let Some(u) = from_unit
        && !matches!(u, Unit::Probability | Unit::Ratio)
    {
        return Err(format!("probability comes from an op whose unit is {u:?}"));
    }
    if t.untagged || t.origins.is_empty() {
        return Err(
            "probability has an input with no origin (need user, market or history)".into(),
        );
    }
    if let Some(o) = t.origins.iter().find(|o| !o.sources_probability()) {
        return Err(format!(
            "probability traces to origin {o:?} (need user, market or history)"
        ));
    }
    Ok(())
}

/// Rounds to 9 decimal places so 0.62 * 100 - 57 reads 5, not 5.000000000000007.
/// Values too large to scale by 1e9 are left as they are.
fn tidy(x: f64) -> f64 {
    let scaled = x * 1e9;
    if !scaled.is_finite() {
        return x;
    }
    let r = scaled.round() / 1e9;
    if r == 0.0 { 0.0 } else { r }
}

fn compute(op: OpName, args: &BTreeMap<&str, Arg>) -> Result<(f64, Option<u32>), Fail> {
    let num = |n: &str| match args.get(n) {
        Some(Arg::Num(v)) => *v,
        _ => unreachable!("eval checked arg kinds"),
    };
    let opt_num = |n: &str| match args.get(n) {
        Some(Arg::Num(v)) => Some(*v),
        None => None,
        _ => unreachable!("eval checked arg kinds"),
    };
    let series = |n: &str| match args.get(n) {
        Some(Arg::Series(s)) => *s,
        _ => unreachable!("eval checked arg kinds"),
    };
    let price = |n: &str| in_range(n, num(n), 0.0, 100.0);
    let prob = |n: &str| in_range(n, num(n), 0.0, 1.0);

    let value = match op {
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
            s[s.len() - 1].v - point_from(s, w).v
        }
        OpName::PriceAt => {
            let s = price_series(series("series"), 1)?;
            let ago = num("ago_s");
            if ago.is_nan() || ago < 0.0 {
                return Err(("out_of_range", format!("ago_s {ago} must be >= 0")));
            }
            point_from(s, ago).v
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
        OpName::BaseRateHistory => {
            let Some(Arg::History(h)) = args.get("history") else {
                unreachable!("eval checked arg kinds")
            };
            let lo = match opt_num("lo_cents") {
                Some(v) => in_range("lo_cents", v, 0.0, 100.0)?,
                None => 0.0,
            };
            let hi = match opt_num("hi_cents") {
                Some(v) => in_range("hi_cents", v, 0.0, 100.0)?,
                None => 100.0,
            };
            if lo > hi {
                return Err((
                    "out_of_range",
                    format!("lo_cents {lo} is above hi_cents {hi}"),
                ));
            }
            let (yes, n) = history_rate(h, lo, hi)?;
            return Ok((yes as f64 / n as f64, Some(n)));
        }
        OpName::PositionValue => count(num("count"))? * price("price_cents")? / 100.0,
        OpName::Pnl => {
            let c = count(num("count"))?;
            c * (price("price_cents")? - price("avg_price_cents")?) / 100.0
        }
    };
    Ok((value, None))
}

/// (resolved YES, n) over the records priced in lo..=hi. Every record must be valid,
/// in the band or not, and the band must hold at least one.
fn history_rate(h: &[Resolved], lo: f64, hi: f64) -> Result<(u32, u32), Fail> {
    if h.is_empty() {
        return Err(("out_of_range", "history needs at least 1 record".into()));
    }
    let (mut yes, mut n) = (0u32, 0u32);
    for r in h {
        in_range("history price_cents", r.price_cents, 0.0, 100.0)?;
        if r.outcome != 0.0 && r.outcome != 1.0 {
            return Err((
                "out_of_range",
                format!("history outcome {} must be 0 or 1", r.outcome),
            ));
        }
        if (lo..=hi).contains(&r.price_cents) {
            n += 1;
            yes += u32::from(r.outcome == 1.0);
        }
    }
    if n == 0 {
        return Err((
            "out_of_range",
            format!("no resolved market priced in {lo}..={hi}"),
        ));
    }
    Ok((yes, n))
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
/// The first point with t >= last.t - ago (the last point at ago 0, or when none is older).
/// movement and price_at both read it, so a move is always the difference of two line points.
fn point_from(s: &[Point], ago: f64) -> Point {
    let last = s[s.len() - 1];
    if ago <= 0.0 {
        return last; // now: the series' last price, even when earlier points share its t
    }
    let from = last.t as f64 - ago;
    *s.iter().find(|p| p.t as f64 >= from).unwrap_or(&last)
}

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
