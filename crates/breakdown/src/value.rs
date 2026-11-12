//! Dynamic value used only where the Lua original stores arbitrary tables: LIST mod values and
//! tag fields. Everything numeric on the hot path stays a plain f64.
use crate::sym::Sym;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Nil,
    Bool(bool),
    Num(f64),
    Str(Arc<str>),
    /// Lua sequence part (1..n)
    List(Arc<Vec<Value>>),
    /// Lua hash part, keys in insertion order
    Map(Arc<Vec<(Sym, Value)>>),
}

impl Value {
    /// Lua's arithmetic operators (`+`, `*`, ...) implicitly coerce a numeric-looking string
    /// operand to a number (`"15" + 0` is `15`), and `SumInternal`/`MoreInternal` never
    /// explicitly `tonumber()` a mod's value before adding it in -- they just do `result = result
    /// + (EvalMod(...) or 0)`. A mod whose value Lua itself stored as a string (confirmed on a
    /// real corpus mod, Tree:61834's `Speed` INC 15 -- an odd upstream parseMod artifact, not a
    /// bug in this crate) still contributes its number in upstream, so `num()` mirrors that
    /// coercion rather than only accepting `Value::Num`.
    pub fn num(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            Value::Str(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        }
    }
    pub fn truthy(&self) -> bool { !matches!(self, Value::Nil | Value::Bool(false)) }
    pub fn get(&self, key: Sym) -> &Value {
        static NIL: Value = Value::Nil;
        if let Value::Map(m) = self { for (k, v) in m.iter() { if *k == key { return v; } } }
        &NIL
    }
}
