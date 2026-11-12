//! Typed equivalents of a Config-tab option's stored value (`configTab.input[var]` /
//! `configTab.placeholder[var]`) and its declared `type` field (Modules/ConfigOptions.lua).
use std::sync::Arc;

/// One `varData.type`. Only the six values that appear on an `apply`-bearing entry (no
/// apply-bearing entry uses "text"; see `gen::meta::OPTION_META`'s generator for the source scan).
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum OptionType {
    Check,
    Count,
    CountAllowZero,
    Integer,
    Float,
    List,
}

/// `configTab.input[var]` / `configTab.placeholder[var]`: a Lua value that is always a bool,
/// a number, or a string (list `val`s can be either number or string; see e.g. `resistancePenalty`
/// which uses numeric `val`s, versus `enemyIsBoss` which uses string ones).
#[derive(Clone, Debug, PartialEq)]
pub enum OptionValue {
    Bool(bool),
    Num(f64),
    Str(&'static str),
}

impl OptionValue {
    pub fn as_bool(&self) -> bool {
        match self {
            OptionValue::Bool(b) => *b,
            OptionValue::Num(n) => *n != 0.0,
            OptionValue::Str(s) => !s.is_empty(),
        }
    }
    pub fn as_f64(&self) -> f64 {
        match self {
            OptionValue::Num(n) => *n,
            OptionValue::Bool(b) => if *b { 1.0 } else { 0.0 },
            OptionValue::Str(s) => s.parse().unwrap_or(0.0),
        }
    }
    pub fn as_str(&self) -> Arc<str> {
        match self {
            OptionValue::Str(s) => Arc::from(*s),
            OptionValue::Num(n) => Arc::from(crate::helpers::fmt_num(*n).as_str()),
            OptionValue::Bool(b) => Arc::from(if *b { "true" } else { "false" }),
        }
    }
    /// Lua truthiness: only `nil` and `false` are falsy. A `Some(_)` OptionValue is always
    /// truthy under this rule (0 and "" are truthy in Lua); callers that need upstream's numeric
    /// "not zero" gate (used by BuildModList for count/integer/float/countAllowZero) should use
    /// the dedicated gating in `build_mod_list`, not this.
    pub fn is_present(v: &Option<OptionValue>) -> bool {
        v.is_some()
    }
}

/// Runtime (non-generated) counterpart used when reading a build's saved `<Input>`/`<Placeholder>`
/// XML values, which are not `&'static str` like the generated table's literals.
#[derive(Clone, Debug, PartialEq)]
pub enum OwnedOptionValue {
    Bool(bool),
    Num(f64),
    Str(Arc<str>),
}

impl OwnedOptionValue {
    pub fn as_bool(&self) -> bool {
        match self {
            OwnedOptionValue::Bool(b) => *b,
            OwnedOptionValue::Num(n) => *n != 0.0,
            OwnedOptionValue::Str(s) => !s.is_empty(),
        }
    }
    pub fn as_f64(&self) -> f64 {
        match self {
            OwnedOptionValue::Num(n) => *n,
            OwnedOptionValue::Bool(b) => if *b { 1.0 } else { 0.0 },
            OwnedOptionValue::Str(s) => s.parse().unwrap_or(0.0),
        }
    }
    pub fn as_str(&self) -> Arc<str> {
        match self {
            OwnedOptionValue::Str(s) => s.clone(),
            OwnedOptionValue::Num(n) => Arc::from(crate::helpers::fmt_num(*n).as_str()),
            OwnedOptionValue::Bool(b) => Arc::from(if *b { "true" } else { "false" }),
        }
    }
    pub fn from_generated(v: &OptionValue) -> OwnedOptionValue {
        match v {
            OptionValue::Bool(b) => OwnedOptionValue::Bool(*b),
            OptionValue::Num(n) => OwnedOptionValue::Num(*n),
            OptionValue::Str(s) => OwnedOptionValue::Str(Arc::from(*s)),
        }
    }
}
