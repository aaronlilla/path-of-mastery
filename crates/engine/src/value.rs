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
    pub fn num(&self) -> Option<f64> { if let Value::Num(n) = self { Some(*n) } else { None } }
    /// Lua number coercion (`math.min(30, "30")`): numeric strings read as numbers.
    pub fn lua_num(&self) -> Option<f64> { match self { Value::Num(n) => Some(*n), Value::Str(s) => s.trim().parse::<f64>().ok(), _ => None } }
    pub fn truthy(&self) -> bool { !matches!(self, Value::Nil | Value::Bool(false)) }
    pub fn get(&self, key: Sym) -> &Value {
        static NIL: Value = Value::Nil;
        if let Value::Map(m) = self { for (k, v) in m.iter() { if *k == key { return v; } } }
        &NIL
    }
}
