//! The math engine. A fixed set of ops turns named inputs into numbers, and every
//! number comes with a receipt: the resolved inputs, the formula, and hashes of the
//! plan and inputs, so anyone can check where it came from.
//!
//! The types here are the contract; `engine --schema` prints them as JSON Schema.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod ops;

pub use ops::Unit;

pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GIT_HASH: &str = env!("GIT_HASH");
/// The only plan version this engine runs.
pub const PLAN_VERSION: u32 = 1;
/// Upper bound on ops in one plan.
pub const MAX_OPS: usize = 256;

/// One engine run: a plan and the named numbers it reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EngineInput {
    pub plan: Plan,
    /// Named inputs. Op args refer to them by key.
    pub numbers: BTreeMap<String, Value>,
}

/// A named input: a single number or a time series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Value {
    Number(f64),
    Series(Vec<Point>),
}

/// One point of a price series.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Point {
    /// Unix seconds.
    pub t: i64,
    /// Price in cents (0..=100).
    pub v: f64,
}

/// The ops to run, in order. Later ops may read earlier ops' outputs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    /// Must be 1.
    pub plan_version: u32,
    pub ops: Vec<OpCall>,
}

/// One op call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OpCall {
    /// Slot-safe id, unique in the plan, e.g. "n1". Must not equal a key in `numbers`.
    #[schemars(regex(pattern = r"^[a-z][a-z0-9_]{0,31}$"))]
    pub id: String,
    pub op: OpName,
    /// Arg name -> a key in `numbers`, or the id of an earlier op.
    pub args: BTreeMap<String, String>,
}

/// The fixed op set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OpName {
    /// args: price_cents. Probability 0..1 = price / 100.
    ImpliedProbability,
    /// args: probability. Decimal odds = 1 / p.
    PriceToOdds,
    /// args: decimal_odds. Probability = 1 / odds.
    OddsToProbability,
    /// args: price_cents, probability. Cents per contract = p * 100 - price.
    ExpectedValue,
    /// args: series, window_s. Points moved over the window.
    Movement,
    /// args: series. Stddev of point-to-point changes, in points.
    Volatility,
    /// args: a_cents, b_cents. b - a in points.
    Gap,
    /// args: hits, total. hits / total.
    BaseRate,
    /// args: count, price_cents. Dollars.
    PositionValue,
    /// args: count, avg_price_cents, price_cents. Dollars.
    Pnl,
}

/// Everything one run produced. `ok` is true when there are no errors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EngineResult {
    pub ok: bool,
    pub engine_version: String,
    pub git_hash: String,
    /// sha256 hex of the plan's canonical JSON.
    pub plan_hash: String,
    /// sha256 hex of the `numbers` map's canonical JSON.
    pub input_hash: String,
    pub numbers: Vec<NumberOut>,
    pub receipts: Vec<Receipt>,
    pub errors: Vec<OpError>,
}

/// One computed number. Values are rounded to 9 decimal places.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NumberOut {
    pub id: String,
    pub op: OpName,
    pub value: f64,
    pub unit: Unit,
    pub receipt_id: String,
}

/// How one number was computed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Receipt {
    /// "r-" + first 8 hex of sha256(plan_hash + op id).
    pub id: String,
    pub op_id: String,
    pub op: OpName,
    /// The resolved inputs, by arg name.
    pub args: BTreeMap<String, ReceiptArg>,
    /// Human-readable formula, e.g. "p = price_cents / 100".
    pub formula: String,
    pub value: f64,
    pub unit: Unit,
    pub plan_hash: String,
    pub input_hash: String,
    pub engine_version: String,
    pub git_hash: String,
}

/// A resolved input as recorded on a receipt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ReceiptArg {
    Number(f64),
    Series(SeriesSummary),
}

/// A series on a receipt: its size, span and hash instead of every point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SeriesSummary {
    pub points: u32,
    pub first_t: i64,
    pub last_t: i64,
    /// sha256 hex of the series' canonical JSON.
    pub hash: String,
}

/// Why an op (or the whole plan) did not produce a number.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct OpError {
    /// The op's id, or "plan" for a plan-level error.
    pub op_id: String,
    /// One of: bad_arg, missing_input, out_of_range, bad_plan.
    pub code: String,
    pub message: String,
}

impl OpError {
    fn new(op_id: &str, code: &str, message: impl Into<String>) -> Self {
        OpError {
            op_id: op_id.into(),
            code: code.into(),
            message: message.into(),
        }
    }
}

/// sha256 hex of a value's JSON. Structs serialize in field order and maps are
/// BTreeMaps, so equal values always hash the same.
pub fn hash_json<T: Serialize>(v: &T) -> String {
    let bytes = serde_json::to_vec(v).expect("engine types always serialize");
    hex::encode(Sha256::digest(&bytes))
}

pub fn receipt_id(plan_hash: &str, op_id: &str) -> String {
    let digest = Sha256::digest(format!("{plan_hash}{op_id}").as_bytes());
    format!("r-{}", &hex::encode(digest)[..8])
}

/// JSON Schemas for the contract types: {plan, input, result, receipt}.
pub fn schemas() -> serde_json::Value {
    serde_json::json!({
        "plan": schemars::schema_for!(Plan),
        "input": schemars::schema_for!(EngineInput),
        "result": schemars::schema_for!(EngineResult),
        "receipt": schemars::schema_for!(Receipt),
    })
}

fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=32).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

fn check_plan(input: &EngineInput) -> Vec<OpError> {
    let plan = &input.plan;
    let mut errs = Vec::new();
    if plan.plan_version != PLAN_VERSION {
        let msg = format!(
            "plan_version {} is not supported (want {PLAN_VERSION})",
            plan.plan_version
        );
        errs.push(OpError::new("plan", "bad_plan", msg));
    }
    if plan.ops.len() > MAX_OPS {
        errs.push(OpError::new(
            "plan",
            "bad_plan",
            format!("more than {MAX_OPS} ops"),
        ));
    }
    let mut seen = BTreeSet::new();
    for call in &plan.ops {
        if !valid_id(&call.id) {
            errs.push(OpError::new(
                &call.id,
                "bad_plan",
                "id must match ^[a-z][a-z0-9_]{0,31}$",
            ));
        } else if !seen.insert(call.id.as_str()) {
            errs.push(OpError::new(&call.id, "bad_plan", "duplicate op id"));
        } else if input.numbers.contains_key(&call.id) {
            errs.push(OpError::new(
                &call.id,
                "bad_plan",
                "op id equals a key in numbers",
            ));
        }
    }
    errs
}

/// Runs a plan. Never panics on bad input: problems become `errors`.
pub fn run(input: &EngineInput) -> EngineResult {
    let plan_hash = hash_json(&input.plan);
    let input_hash = hash_json(&input.numbers);
    let mut res = EngineResult {
        ok: false,
        engine_version: ENGINE_VERSION.into(),
        git_hash: GIT_HASH.into(),
        plan_hash,
        input_hash,
        numbers: vec![],
        receipts: vec![],
        errors: check_plan(input),
    };
    if !res.errors.is_empty() {
        return res;
    }

    // Outputs of ops run so far: Some(value), or None when the op failed.
    let mut done: BTreeMap<&str, Option<f64>> = BTreeMap::new();
    for call in &input.plan.ops {
        match ops::eval(call, &input.numbers, &done) {
            Ok((value, args)) => {
                let rid = receipt_id(&res.plan_hash, &call.id);
                let unit = call.op.unit();
                res.numbers.push(NumberOut {
                    id: call.id.clone(),
                    op: call.op,
                    value,
                    unit,
                    receipt_id: rid.clone(),
                });
                res.receipts.push(Receipt {
                    id: rid,
                    op_id: call.id.clone(),
                    op: call.op,
                    args,
                    formula: call.op.formula().into(),
                    value,
                    unit,
                    plan_hash: res.plan_hash.clone(),
                    input_hash: res.input_hash.clone(),
                    engine_version: ENGINE_VERSION.into(),
                    git_hash: GIT_HASH.into(),
                });
                done.insert(&call.id, Some(value));
            }
            Err(e) => {
                res.errors.push(e);
                done.insert(&call.id, None);
            }
        }
    }
    res.ok = res.errors.is_empty();
    res
}

#[cfg(test)]
mod tests;
