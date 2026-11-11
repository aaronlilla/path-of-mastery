//! Calcs-mode breakdown tables (`actor.breakdown[Stat]` of upstream, filled only by `calcs.buildOutput(build, "CALCS")`).
//!
//! The tables live in a thread-local so the code that computes a stat can write its table at the same line upstream
//! does, without threading a handle through every function: `if bd::on() { bd::cur(|b| ...) }`. Normal calcs never turn
//! the mode on (`bd::on()` is one `Cell` read), so a click pays nothing.
//!
//! A Lua table is a `serde_json::Value`: an array for a pure list, an object for anything with string keys; a table that
//! has both (upstream's `{ "line", "line", rowList = {...} }`) is an object whose list part sits under "1", "2", ...,
//! exactly how the answer-key recorder serialises it. `ins`/`set`/`t` below keep that shape.
//!
//! `sprintf` / `sf!` run upstream's `string.format` strings verbatim (`%d %i %f %g %s %%`, flags/width/precision), so a
//! port copies the Lua format string instead of re-deriving it.
use serde_json::{Map, Value};
use std::cell::{Cell, RefCell};

// ---------------------------------------------------------------------------------------------------------------------
// number formatting (C printf semantics, as upstream's `string.format` / `tostring`)
// ---------------------------------------------------------------------------------------------------------------------

/// C's `%.{prec}g`.
pub fn format_g(v: f64, precision: usize, alt: bool) -> String {
    if v.is_nan() {
        return if v.is_sign_negative() { "-nan".into() } else { "nan".into() };
    }
    if v.is_infinite() {
        return if v < 0.0 { "-inf".into() } else { "inf".into() };
    }
    let precision = if precision == 0 { 1 } else { precision };
    if v == 0.0 {
        let mut s = String::from(if v.is_sign_negative() { "-0" } else { "0" });
        if alt && precision > 1 {
            s.push('.');
            s.push_str(&"0".repeat(precision - 1));
        }
        return s;
    }
    let neg = v < 0.0;
    let av = v.abs();
    let sci = format!("{:.*e}", precision - 1, av);
    let (mantissa_str, exp_str) = sci.split_once('e').unwrap();
    let exp: i32 = exp_str.parse().unwrap();
    let digits: String = mantissa_str.chars().filter(|c| *c != '.').collect();
    let use_exp = exp < -4 || exp >= precision as i32;
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    if use_exp {
        out.push(digits.as_bytes()[0] as char);
        let frac = if alt { digits[1..].to_string() } else { digits[1..].trim_end_matches('0').to_string() };
        if !frac.is_empty() {
            out.push('.');
            out.push_str(&frac);
        }
        out.push('e');
        out.push(if exp >= 0 { '+' } else { '-' });
        out.push_str(&format!("{:02}", exp.abs()));
    } else if exp >= 0 {
        let int_len = (exp + 1) as usize;
        if int_len >= digits.len() {
            out.push_str(&digits);
            out.push_str(&"0".repeat(int_len - digits.len()));
        } else {
            out.push_str(&digits[..int_len]);
            let frac = if alt { digits[int_len..].to_string() } else { digits[int_len..].trim_end_matches('0').to_string() };
            if !frac.is_empty() {
                out.push('.');
                out.push_str(&frac);
            }
        }
    } else {
        out.push_str("0.");
        out.push_str(&"0".repeat((-exp - 1) as usize));
        let frac = if alt { digits.clone() } else { digits.trim_end_matches('0').to_string() };
        out.push_str(if frac.is_empty() { "0" } else { &frac });
    }
    out
}

/// Lua's `tostring(number)` (`%.14g`), what `..` uses on a number.
pub fn tostr(v: f64) -> String {
    format_g(v, 14, false)
}

/// Common.lua `round(val, dec)`: `m_floor(val * 10^dec + 0.5) / 10^dec` (no `dec`: nearest integer).
pub fn round(val: f64, dec: i32) -> f64 {
    if dec == 0 {
        (val + 0.5).floor()
    } else {
        let p = 10f64.powi(dec);
        (val * p + 0.5).floor() / p
    }
}

/// One `string.format` argument.
pub enum A {
    N(f64),
    S(String),
}
impl From<f64> for A {
    fn from(v: f64) -> A {
        A::N(v)
    }
}
macro_rules! a_from_num {
    ($($t:ty),*) => { $(impl From<$t> for A { fn from(v: $t) -> A { A::N(v as f64) } })* };
}
a_from_num!(f32, i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);
impl From<&str> for A {
    fn from(v: &str) -> A {
        A::S(v.to_string())
    }
}
impl From<String> for A {
    fn from(v: String) -> A {
        A::S(v)
    }
}
impl From<&String> for A {
    fn from(v: &String) -> A {
        A::S(v.clone())
    }
}

/// `string.format(fmt, ...)`: `%d %i %f %g %e %s %%` with flags `-+ 0#`, width and precision.
pub fn sprintf(fmt: &str, args: &[A]) -> String {
    let b: Vec<char> = fmt.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut ai = 0;
    while i < b.len() {
        let c = b[i];
        if c != '%' {
            out.push(c);
            i += 1;
            continue;
        }
        i += 1;
        if i < b.len() && b[i] == '%' {
            out.push('%');
            i += 1;
            continue;
        }
        let (mut left, mut plus, mut space, mut zero, mut alt) = (false, false, false, false, false);
        while i < b.len() && matches!(b[i], '-' | '+' | ' ' | '0' | '#') {
            match b[i] {
                '-' => left = true,
                '+' => plus = true,
                ' ' => space = true,
                '0' => zero = true,
                _ => alt = true,
            }
            i += 1;
        }
        let mut width = 0usize;
        while i < b.len() && b[i].is_ascii_digit() {
            width = width * 10 + b[i].to_digit(10).unwrap() as usize;
            i += 1;
        }
        let mut prec: Option<usize> = None;
        if i < b.len() && b[i] == '.' {
            i += 1;
            let mut p = 0usize;
            while i < b.len() && b[i].is_ascii_digit() {
                p = p * 10 + b[i].to_digit(10).unwrap() as usize;
                i += 1;
            }
            prec = Some(p);
        }
        let conv = if i < b.len() { b[i] } else { 's' };
        i += 1;
        let arg = args.get(ai);
        ai += 1;
        let num = |a: Option<&A>| -> f64 {
            match a {
                Some(A::N(v)) => *v,
                Some(A::S(s)) => s.trim().parse().unwrap_or(0.0),
                None => 0.0,
            }
        };
        let (body, numeric, neg) = match conv {
            'd' | 'i' => {
                let v = num(arg);
                let t = v.trunc();
                if !t.is_finite() || t.abs() >= 9.223372036854775808e18 {
                    // LuaJIT casts to int64: NaN, infinities and out-of-range numbers all give INT64_MIN
                    ("9223372036854775808".to_string(), true, true)
                } else {
                    let neg = t < 0.0;
                    (format!("{}", t.abs() as i128), true, neg)
                }
            }
            'f' | 'F' => {
                let v = num(arg);
                if v.is_finite() {
                    (format!("{:.*}", prec.unwrap_or(6), v.abs()), true, v.is_sign_negative())
                } else {
                    (format_g(v.abs(), 6, false), false, v < 0.0)
                }
            }
            'g' | 'G' => {
                let v = num(arg);
                (format_g(v.abs(), prec.unwrap_or(6), alt), v.is_finite(), v.is_sign_negative() && !v.is_nan())
            }
            'e' | 'E' => {
                let v = num(arg);
                let s = format!("{:.*e}", prec.unwrap_or(6), v.abs());
                let (m, e) = s.split_once('e').unwrap();
                let ev: i32 = e.parse().unwrap();
                (format!("{m}e{}{:02}", if ev < 0 { '-' } else { '+' }, ev.abs()), v.is_finite(), v.is_sign_negative())
            }
            _ => {
                let s = match arg {
                    Some(A::S(s)) => s.clone(),
                    Some(A::N(v)) => tostr(*v),
                    None => String::new(),
                };
                let s = match prec {
                    Some(p) => s.chars().take(p).collect(),
                    None => s,
                };
                (s, false, false)
            }
        };
        let sign = if numeric || matches!(conv, 'f' | 'g') {
            if neg {
                "-"
            } else if plus {
                "+"
            } else if space {
                " "
            } else {
                ""
            }
        } else {
            ""
        };
        let len = sign.chars().count() + body.chars().count();
        if len >= width {
            out.push_str(sign);
            out.push_str(&body);
        } else if left {
            out.push_str(sign);
            out.push_str(&body);
            out.push_str(&" ".repeat(width - len));
        } else if zero && numeric {
            out.push_str(sign);
            out.push_str(&"0".repeat(width - len));
            out.push_str(&body);
        } else {
            out.push_str(&" ".repeat(width - len));
            out.push_str(sign);
            out.push_str(&body);
        }
    }
    out
}

/// `string.format` with upstream's format string: `sf!("%.2f ^8(base)", x)`.
#[macro_export]
macro_rules! sf {
    ($f:expr $(, $a:expr)* $(,)?) => { $crate::bd::sprintf($f, &[$($crate::bd::A::from($a)),*]) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Lua tables as JSON values
// ---------------------------------------------------------------------------------------------------------------------

/// A number as the recorder writes it.
pub fn num(v: f64) -> Value {
    if v.is_nan() {
        Value::String("NaN".into())
    } else if v == f64::INFINITY {
        Value::String("Inf".into())
    } else if v == f64::NEG_INFINITY {
        Value::String("-Inf".into())
    } else {
        Value::from(v)
    }
}

pub fn s(v: impl Into<String>) -> Value {
    Value::String(v.into())
}

fn list_len(m: &Map<String, Value>) -> usize {
    m.keys().filter(|k| k.parse::<usize>().is_ok()).count()
}

/// `t_insert(tbl, item)`.
pub fn ins(tbl: &mut Value, item: Value) {
    match tbl {
        Value::Array(a) => a.push(item),
        Value::Object(m) => {
            let n = list_len(m);
            m.insert((n + 1).to_string(), item);
        }
        _ => *tbl = Value::Array(vec![item]),
    }
}

/// `t_insert(tbl, "string")`.
pub fn ins_s(tbl: &mut Value, item: impl Into<String>) {
    ins(tbl, Value::String(item.into()));
}

fn as_object(tbl: &mut Value) -> &mut Map<String, Value> {
    if !tbl.is_object() {
        let mut m = Map::new();
        if let Value::Array(a) = std::mem::take(tbl) {
            for (i, x) in a.into_iter().enumerate() {
                m.insert((i + 1).to_string(), x);
            }
        }
        *tbl = Value::Object(m);
    }
    tbl.as_object_mut().unwrap()
}

/// `tbl.key = item` (or `tbl[key] = item`).
pub fn set(tbl: &mut Value, key: &str, item: Value) {
    as_object(tbl).insert(key.to_string(), item);
}

/// `tbl.key = { }`.
pub fn reset<'a>(tbl: &'a mut Value, key: &str) -> &'a mut Value {
    set(tbl, key, Value::Array(vec![]));
    get(tbl, key).unwrap()
}

pub fn get<'a>(tbl: &'a mut Value, key: &str) -> Option<&'a mut Value> {
    match tbl {
        Value::Object(m) => m.get_mut(key),
        _ => None,
    }
}

/// `tbl.key` as a table, creating `{ }` when absent (upstream's `tbl.key = tbl.key or { }`).
pub fn t<'a>(tbl: &'a mut Value, key: &str) -> &'a mut Value {
    let m = as_object(tbl);
    m.entry(key.to_string()).or_insert_with(|| Value::Array(vec![]))
}

/// The `idx`-th (1-based) list item of `tbl`.
pub fn nth(tbl: &mut Value, idx: usize) -> Option<&mut Value> {
    match tbl {
        Value::Array(a) => a.get_mut(idx - 1),
        Value::Object(m) => m.get_mut(&idx.to_string()),
        _ => None,
    }
}

/// A row/table literal: `row(&[("name", s("r")), ("value", num(1.0))])`. Skips nothing (nil fields are the caller's to leave out).
pub fn row(fields: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in fields {
        m.insert(k.to_string(), v);
    }
    Value::Object(m)
}

/// A Lua `x and y` string field: `Some(string)` when the condition holds, `None` (nil) otherwise; false (`x ~= 1 and ..` yields
/// `false` when the condition is false) is `Value::Bool(false)`.
pub fn opt_s(v: Option<String>) -> Value {
    match v {
        Some(x) => Value::String(x),
        None => Value::Bool(false),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// the thread-local breakdown
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct State {
    /// 0 = player, 1 = minion.
    actor: usize,
    roots: [Value; 2],
    /// The pass table upstream calls `breakdown` inside the pass loop: None = the actor's own table.
    pass: Option<&'static str>,
}

thread_local! {
    static ACTIVE: Cell<bool> = const { Cell::new(false) };
    static STATE: RefCell<State> = RefCell::new(State { actor: 0, roots: [Value::Null, Value::Null], pass: None });
}

/// Turn the Calcs mode on for this thread's next calc (`calcs.buildOutput(build, "CALCS")`).
pub fn set_calcs_mode(on: bool) {
    crate::CALCS_MODE.with(|c| c.set(on));
    ACTIVE.with(|c| c.set(false));
    if on {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            *s = State { actor: 0, roots: [Value::Object(Map::new()), Value::Null], pass: None };
        });
    }
}

pub fn calcs_mode() -> bool {
    crate::CALCS_MODE.with(|c| c.get())
}

/// Breakdown writes are live: the Calcs mode is on and the code running is the real actor's offence (`compute_offence`
/// turns it on; a mirage / FullDPS / trigger-source copy, which upstream runs in CALCULATOR mode with no breakdown,
/// leaves it off).
#[inline]
pub fn on() -> bool {
    crate::CALCS_MODE.with(|c| c.get()) && ACTIVE.with(|c| c.get())
}

thread_local! {
    static RUN_DEPTH: Cell<u32> = const { Cell::new(0) };
}

/// `pipeline::run` entry/exit: a nested run (the FullDPS copies call `run` again) is not the actor's own calculation, so
/// `compute_offence` only turns the writes on at depth 1.
pub fn enter_run() {
    RUN_DEPTH.with(|d| d.set(d.get() + 1));
}

pub fn exit_run() {
    RUN_DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
}

pub fn run_depth() -> u32 {
    RUN_DEPTH.with(|d| d.get())
}

/// Suspend / resume writes (a nested calculation that is not the actor's own).
pub fn set_active(v: bool) -> bool {
    ACTIVE.with(|c| c.replace(v))
}

/// Switch the actor whose table is written (0 player, 1 minion); the minion's table starts empty.
pub fn select_actor(actor: usize) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.actor = actor;
        s.pass = None;
        if actor == 1 && s.roots[1].is_null() {
            s.roots[1] = Value::Object(Map::new());
        }
    });
}

/// The actor whose table is written now (0 player, 1 minion).
pub fn current_actor() -> usize {
    STATE.with(|s| s.borrow().actor)
}

/// A fresh `require(calcs.breakdownModule)(...)` object: the breakdown functions are keys of the table (recorded as "<fn>").
pub fn builder_object() -> Value {
    let mut m = Map::new();
    for k in ["multiChain", "simple", "mod", "slot", "area", "effMult", "dot", "critDot", "leech"] {
        m.insert(k.to_string(), Value::String("<fn>".into()));
    }
    Value::Object(m)
}

/// `breakdown.MainHand = require(calcs.breakdownModule)(skillModList, output.MainHand)` (CalcOffence.lua:2007, 2038): creates
/// the hand's table and makes it the current `breakdown` until `set_pass(None)`. NOTE the functions of that object read the
/// SKILL's mod list (`skillModList`), unlike the actor's own table whose functions read the actor modDB.
pub fn begin_pass(p: &'static str) {
    if !on() {
        return;
    }
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let a = s.actor;
        set(&mut s.roots[a], p, builder_object());
        s.pass = Some(p);
    });
}

/// Select the table the code calls `breakdown`: `Some("MainHand")` / `Some("OffHand")` (the pass tables made by
/// `begin_pass`), None = the actor's table.
pub fn set_pass(p: Option<&'static str>) {
    STATE.with(|s| s.borrow_mut().pass = p);
}

/// Run `f` with `breakdown` = the actor's own table (what `globalBreakdown` is inside a pass loop), then restore the pass.
pub fn with_root_scope<R>(f: impl FnOnce() -> R) -> R {
    let saved = STATE.with(|s| s.borrow().pass);
    set_pass(None);
    let r = f();
    set_pass(saved);
    r
}

/// The actor's own table (upstream's `globalBreakdown` / `actor.breakdown`).
pub fn root<R>(f: impl FnOnce(&mut Value) -> R) -> Option<R> {
    if !on() {
        return None;
    }
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let a = s.actor;
        Some(f(&mut s.roots[a]))
    })
}

/// The table the code at this point calls `breakdown` (the pass's table inside the pass loop).
pub fn cur<R>(f: impl FnOnce(&mut Value) -> R) -> Option<R> {
    if !on() {
        return None;
    }
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let a = s.actor;
        match s.pass {
            None => Some(f(&mut s.roots[a])),
            Some(p) => {
                if get(&mut s.roots[a], p).is_none() {
                    set(&mut s.roots[a], p, builder_object());
                }
                let r = get(&mut s.roots[a], p).unwrap();
                Some(f(r))
            }
        }
    })
}

/// The pass table for a pass label of the Rust loops ("MainHand" / "OffHand" / "Skill"): what `breakdown = pass.breakdown`
/// is inside upstream's `for _, pass in ipairs(passList)` loops (`Skill` = the actor's own table). Call
/// `bd::set_pass(bd::pass_scope(p.label))` at the top of each pass iteration and `bd::set_pass(None)` after the loop.
pub fn pass_scope(label: &str) -> Option<&'static str> {
    match label {
        "MainHand" => Some("MainHand"),
        "OffHand" => Some("OffHand"),
        _ => None,
    }
}

/// A copy of both actors' tables, for code the port runs twice where upstream runs once (`restore` drops the first run's writes).
pub fn snapshot() -> Option<[Value; 2]> {
    if !on() {
        return None;
    }
    Some(STATE.with(|s| s.borrow().roots.clone()))
}

pub fn restore(snap: Option<[Value; 2]>) {
    if let Some(r) = snap {
        STATE.with(|s| s.borrow_mut().roots = r);
    }
}

/// The finished tables, `[player, minion]` (Null when the actor has none), and the mode off again.
pub fn take() -> [Value; 2] {
    crate::CALCS_MODE.with(|c| c.set(false));
    ACTIVE.with(|c| c.set(false));
    STATE.with(|s| std::mem::take(&mut s.borrow_mut().roots))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn printf() {
        assert_eq!(sf!("%.2f ^8(base)", 2.0), "2.00 ^8(base)");
        assert_eq!(sf!("%g", 0.1 + 0.2), "0.3");
        assert_eq!(sf!("%d%% to %s", 50.7, "Fire"), "50% to Fire");
        assert_eq!(sf!("%.2f", 0.125), "0.12");
        assert_eq!(sf!("%5.1f|%-4d|", 3.14159, 7), "  3.1|7   |");
        assert_eq!(sf!("%g", 1e20), "1e+20");
        assert_eq!(sf!("%d", -0.5), "0");
        assert_eq!(tostr(1234567.0), "1234567");
        assert_eq!(tostr(0.1 + 0.2), "0.3");
    }
    #[test]
    fn tables() {
        let mut t0 = Value::Null;
        ins_s(&mut t0, "a");
        ins_s(&mut t0, "b");
        set(&mut t0, "label", s("L"));
        ins_s(&mut t0, "c");
        assert_eq!(t0, serde_json::json!({"1":"a","2":"b","3":"c","label":"L"}));
    }
}
