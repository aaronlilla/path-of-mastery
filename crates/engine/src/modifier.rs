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

/// A mod's tags. Mods are copied into every store, snapshot and list copy that holds them; the copies share one
/// tag list and a copy that changes its tags gets its own (`DerefMut`). Empty tags allocate nothing.
#[derive(Clone, Default, PartialEq)]
pub struct Tags(Option<Arc<Vec<Tag>>>);

static NO_TAGS: Vec<Tag> = Vec::new();

impl std::ops::Deref for Tags {
    type Target = Vec<Tag>;
    fn deref(&self) -> &Vec<Tag> {
        self.0.as_deref().unwrap_or(&NO_TAGS)
    }
}

impl std::ops::DerefMut for Tags {
    fn deref_mut(&mut self) -> &mut Vec<Tag> {
        Arc::make_mut(self.0.get_or_insert_with(|| Arc::new(Vec::new())))
    }
}

impl std::fmt::Debug for Tags {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        (**self).fmt(f)
    }
}

impl From<Vec<Tag>> for Tags {
    fn from(v: Vec<Tag>) -> Tags {
        if v.is_empty() { Tags(None) } else { Tags(Some(Arc::new(v))) }
    }
}

impl From<Tags> for Vec<Tag> {
    fn from(t: Tags) -> Vec<Tag> {
        match t.0 {
            None => Vec::new(),
            Some(a) => Arc::try_unwrap(a).unwrap_or_else(|a| (*a).clone()),
        }
    }
}

impl FromIterator<Tag> for Tags {
    fn from_iter<I: IntoIterator<Item = Tag>>(it: I) -> Tags {
        Tags::from(it.into_iter().collect::<Vec<Tag>>())
    }
}

impl<'a> IntoIterator for &'a Tags {
    type Item = &'a Tag;
    type IntoIter = std::slice::Iter<'a, Tag>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
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
    pub tags: Tags,
}
