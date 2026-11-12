//! The shared modifier contract (Modules/ModTools.lua modLib.createMod). Every ported module
//! (ModParser, ModStore/ModList/ModDB, Calc*) builds and reads mods through these types.
use crate::sym::Sym;
use crate::value::Value;
use std::sync::Arc;

/// mod.type: "INC" "MORE" "BASE" "OVERRIDE" "MAX" "MIN" "CHANCE" "DUMMY" "FLAG" "Flag" "LIST"
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum ModType { Inc, More, Base, Override, Max, Min, Chance, Dummy, Flag, FlagLower, List }

impl ModType {
    pub fn parse(s: &str) -> Option<ModType> {
        Some(match s {
            "INC" => ModType::Inc, "MORE" => ModType::More, "BASE" => ModType::Base,
            "OVERRIDE" => ModType::Override, "MAX" => ModType::Max, "MIN" => ModType::Min,
            "CHANCE" => ModType::Chance, "DUMMY" => ModType::Dummy, "FLAG" => ModType::Flag,
            "Flag" => ModType::FlagLower, "LIST" => ModType::List, _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            ModType::Inc => "INC", ModType::More => "MORE", ModType::Base => "BASE",
            ModType::Override => "OVERRIDE", ModType::Max => "MAX", ModType::Min => "MIN",
            ModType::Chance => "CHANCE", ModType::Dummy => "DUMMY", ModType::Flag => "FLAG",
            ModType::FlagLower => "Flag", ModType::List => "LIST",
        }
    }
}

/// One ModTag: `{ type = "Condition", var = "FullLife", neg = true }`. `kind` is the `type`
/// field; the remaining fields keep Lua insertion order.
#[derive(Clone, Debug, PartialEq)]
pub struct Tag { pub kind: Sym, pub fields: Vec<(Sym, Value)> }

impl Tag {
    pub fn get(&self, key: Sym) -> &Value {
        static NIL: Value = Value::Nil;
        for (k, v) in &self.fields { if *k == key { return v; } }
        &NIL
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mod {
    pub name: Sym,
    pub ty: ModType,
    pub value: Value,
    pub flags: u64,
    pub keyword_flags: u64,
    pub source: Option<Arc<str>>,
    pub tags: Vec<Tag>,
}
