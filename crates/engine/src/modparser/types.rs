// Internal parse-tree types used only inside the parser and its answer-key serializer. These
// mirror generic Lua table shapes directly (see the answer keys' own
// serialization rules) rather than the fixed-shape `crate::modifier::Mod` contract, because a
// mod's `value` field can itself be an arbitrary nested table (JewelFunc, ExtraAuraEffect, ...).
use crate::modifier::{Mod, ModType, Tag};
use crate::sym::Sym;
use crate::value::Value;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq)]
pub enum PVal {
    Num(f64),
    Bool(bool),
    Str(String),
    List(Vec<PVal>),
    /// Generic Lua table with string keys (tags use this too: `{"type": ..., ...}`).
    Map(Vec<(String, PVal)>),
    /// One `func` field inside a `JewelFunc` or `ExtraJewelFunc` mod's value map (ModParser.lua:
    /// 6646,6651,6582,6591 and the Militant Faith wrapping in special_a.rs). See
    /// `crate::modparser::jewelfunc::JewelFuncHandle`: this renders as the literal string
    /// `"<function>"` in the golden JSON comparison, matching Lua's own serializer for a function
    /// value, and correctness of the callable itself is judged separately by the jewel function
    /// behavioral test.
    JewelFunc(crate::modparser::jewelfunc::JewelFuncHandle),
}

#[derive(Clone, Debug, PartialEq)]
pub struct PMod {
    pub name: String,
    pub ty: String,
    pub value: PVal,
    pub flags: u64,
    pub keyword_flags: u64,
    pub source: Option<String>,
    pub tags: Vec<PVal>,
    /// Tags that exist in the exported Lua table but are never reached by `ipairs(mod)` --
    /// ModParser.lua's own `mod()`/`createMod` occasionally splices a table-constructor tail that
    /// starts with a literal `nil` (see e.g. `mod("ChanceToIgnoreEnemyPhysicalDamageReduction",
    /// "BASE", num, nil, {type="Condition",...})`, ModParser.lua:5692), which leaves array key 1
    /// unset and puts the tag at key 2 instead. `ipairs` stops at the first missing key, so
    /// `EvalMod`/ModStore's `for _, tag in ipairs(mod)` never iterates past that hole: the mod
    /// behaves as if it had no tags at all (unconditional), even though the golden JSON export
    /// still shows the tag under its raw numeric key. Each entry is `(lua_index, tag)`, 1-based,
    /// matching the key it must serialize under. `pmod_to_mod` deliberately does not read this
    /// field, so the real `Mod` this parser hands to ModStore has zero tags here, same as Lua.
    pub unreachable_tags: Vec<(usize, PVal)>,
}

pub fn value_to_pval(v: &Value) -> PVal {
    match v {
        Value::Nil => PVal::Bool(false),
        Value::Bool(b) => PVal::Bool(*b),
        Value::Num(n) => PVal::Num(*n),
        Value::Str(s) => PVal::Str(s.to_string()),
        Value::List(l) => PVal::List(l.iter().map(value_to_pval).collect()),
        Value::Map(m) => PVal::Map(m.iter().map(|(k, v)| (k.as_str().to_string(), value_to_pval(v))).collect()),
    }
}

pub fn tag_to_pval(t: &Tag) -> PVal {
    let mut fields = vec![("type".to_string(), PVal::Str(t.kind.as_str().to_string()))];
    for (k, v) in &t.fields {
        fields.push((k.as_str().to_string(), value_to_pval(v)));
    }
    PVal::Map(fields)
}

pub fn mod_to_pval(m: &PMod) -> PVal {
    let mut fields = vec![
        ("name".to_string(), PVal::Str(m.name.clone())),
        ("type".to_string(), PVal::Str(m.ty.clone())),
        ("value".to_string(), m.value.clone()),
        ("flags".to_string(), PVal::Num(m.flags as f64)),
        ("keywordFlags".to_string(), PVal::Num(m.keyword_flags as f64)),
    ];
    if let Some(s) = &m.source {
        fields.push(("source".to_string(), PVal::Str(s.clone())));
    }
    for (i, t) in m.tags.iter().enumerate() {
        fields.push(((i + 1).to_string(), t.clone()));
    }
    for (i, t) in &m.unreachable_tags {
        fields.push((i.to_string(), t.clone()));
    }
    PVal::Map(fields)
}

pub fn tag(kind: &str, fields: Vec<(&str, Value)>) -> Tag {
    Tag { kind: Sym::new(kind), fields: fields.into_iter().map(|(k, v)| (Sym::new(k), v)).collect() }
}

/// PVal -> crate::value::Value, the inverse of `value_to_pval` (round-trips exactly for every
/// shape this parser produces except `JewelFunc`: Nil never appears in parser output, so there's
/// no PVal case for it to lose, other than the one below). `crate::value::Value` has no case for a
/// callable, so a `JewelFunc` mod's value becomes `Value::Nil` here -- the same documented gap as
/// `PMod::unreachable_tags` (see its doc comment): `matched_via_mod` in the answer-key grader is lower than
/// `matched` by exactly the number of jewel-func lines for this reason, and that's expected, not a
/// bug. The callable itself is only ever read back off the `PMod` directly (`PVal::JewelFunc`),
/// never through this conversion.
pub fn pval_to_value(v: &PVal) -> Value {
    match v {
        PVal::Num(n) => Value::Num(*n),
        PVal::Bool(b) => Value::Bool(*b),
        PVal::Str(s) => Value::Str(Arc::from(s.as_str())),
        PVal::List(l) => Value::List(Arc::new(l.iter().map(pval_to_value).collect())),
        PVal::Map(m) => Value::Map(Arc::new(m.iter().map(|(k, v)| (Sym::new(k), pval_to_value(v))).collect())),
        PVal::JewelFunc(_) => Value::Nil,
    }
}

/// A tag-shaped PVal (`{"type": "...", field: val, ...}`) -> crate::modifier::Tag.
pub fn pval_to_tag(v: &PVal) -> Tag {
    match v {
        PVal::Map(m) => {
            let mut kind = crate::sym!("");
            let mut fields = Vec::new();
            for (k, val) in m {
                if k == "type" {
                    if let PVal::Str(s) = val {
                        kind = Sym::new(s);
                    }
                } else {
                    fields.push((Sym::new(k), pval_to_value(val)));
                }
            }
            Tag { kind, fields }
        }
        _ => panic!("tag PVal must be a Map, got {:?}", v),
    }
}

/// The contract type the ModStore port (`crate::modstore`) actually consumes. Every mod this
/// parser produces (including specialModList's PVal-based tags) round-trips through this.
pub fn pmod_to_mod(m: &PMod) -> Mod {
    Mod {
        name: Sym::new(&m.name),
        ty: ModType::parse(&m.ty).unwrap_or_else(|| panic!("unknown ModType {:?} for mod {:?}", m.ty, m.name)),
        value: pval_to_value(&m.value),
        flags: m.flags,
        keyword_flags: m.keyword_flags,
        source: m.source.as_deref().map(Arc::from),
        tags: m.tags.iter().map(pval_to_tag).collect(),
    }
}

/// The inverse projection used only by the golden test, to check that a mod still serializes
/// correctly after the `pmod_to_mod` round-trip (i.e. the shape ModStore will actually receive).
pub fn mod_to_pmod(m: &Mod) -> PMod {
    PMod {
        name: m.name.as_str().to_string(),
        ty: m.ty.as_str().to_string(),
        value: value_to_pval(&m.value),
        flags: m.flags,
        keyword_flags: m.keyword_flags,
        source: m.source.as_ref().map(|s| s.to_string()),
        tags: m.tags.iter().map(tag_to_pval).collect(),
        // A real `Mod` has no hole concept (ipairs already collapsed it away before this parser
        // ever handed the mod off) -- so a round-trip through Mod legitimately can't reconstruct
        // one, and the golden test's via-Mod path is expected to diverge from the direct path on
        // exactly the lines that have one. See PMod::unreachable_tags.
        unreachable_tags: vec![],
    }
}

#[cfg(test)]
mod hole_tests {
    use super::*;

    /// Replay check for PMod::unreachable_tags: a mod with a tag stranded past a
    /// table-constructor hole must come out of `pmod_to_mod` with zero tags -- exactly as
    /// `ipairs(mod)` sees it in real Lua (it stops at the missing index-1 key and never reaches
    /// index 2), so ModStore evaluates the mod unconditionally rather than gating it on the
    /// condition that the answer-key export still prints. This was manually verified to
    /// fail (tags.len() == 1) against a version of pmod_to_mod that chained unreachable_tags into
    /// the reachable tags list, before landing on the current implementation, which ignores the
    /// field entirely.
    #[test]
    fn hole_tag_is_invisible_to_pmod_to_mod() {
        let condition_tag = tag_to_pval(&tag("Condition", vec![("var", crate::value::Value::Str("SacrificialZeal".into()))]));
        let pmod = PMod {
            name: "ChanceToIgnoreEnemyPhysicalDamageReduction".to_string(),
            ty: "BASE".to_string(),
            value: PVal::Num(15.0),
            flags: 0,
            keyword_flags: 0,
            source: None,
            tags: vec![],
            unreachable_tags: vec![(2, condition_tag)],
        };
        let real_mod = pmod_to_mod(&pmod);
        assert!(real_mod.tags.is_empty(), "a mod with only a hole tag must reach ModStore as fully untagged (unconditional), got {:?}", real_mod.tags);
    }
}
