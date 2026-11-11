// Shared plumbing for specialModList (ModParser.lua lines 2130-5955): the entry value shape, the
// createMod/flag call-argument helpers, and the raw-capture accessor both halves (special_a.rs,
// special_b.rs) use. Tags are built directly as PVal (a `{"type": ..., ...}` map) rather than via
// the shared `crate::modifier::Tag`/`Value` contract types: specialModList's output only ever
// needs to be serialized for the golden comparison, never consumed as a real `Tag` elsewhere.
use crate::luapat::tonumber;
use crate::modparser::types::{mod_to_pval, PMod, PVal};

/// Raw regex captures (cap1..cap5) from the specialModList pattern match, same calling
/// convention as modTagList's TagArgs: `.n(k)` parses capture k (1-based) as a number, `.s(k)`
/// returns it as text.
pub struct SpecialArgs<'a> {
    pub c: [Option<&'a str>; 5],
}
impl<'a> SpecialArgs<'a> {
    pub fn n(&self, k: usize) -> f64 {
        self.c[k - 1].and_then(tonumber).unwrap_or(f64::NAN)
    }
    pub fn s(&self, k: usize) -> &'a str {
        self.c[k - 1].unwrap_or("")
    }
    pub fn has(&self, k: usize) -> bool {
        self.c[k - 1].is_some()
    }
}

pub type SpecialFn = fn(&SpecialArgs) -> Option<Vec<PMod>>;
/// A function bound to a fixed skill name (see `SpecialVal::SkillFunc`): the skill name plus the
/// match's captures.
pub type SkillSpecialFn = fn(&str, &SpecialArgs) -> Option<Vec<PMod>>;

pub enum SpecialVal {
    /// A literal, precomputed mod list (Lua: `["..."] = { mod(...), ... }`).
    Mods(Vec<PMod>),
    /// A function of the match's captures (Lua: `["..."] = function(...) return {...} end`).
    Func(SpecialFn),
    /// A function closed over one specific skill name, for the per-gem dynamic specialModList
    /// entries ModParser.lua injects at lines 6124-6146 (e.g. `specialModList["^"..skillName:
    /// lower().." fires (%d+) additional projectiles"] = function(num) return { ... skillName ...
    /// } end`, built once per skill gem inside a `for gemId, gemData in pairs(data.gems)` loop).
    /// `SpecialFn` is a plain, non-capturing function pointer so it can't close over a per-entry
    /// skill name the way the Lua closure does; this variant carries that name alongside instead.
    SkillFunc(String, SkillSpecialFn),
}

/// A tag literal: `{ type = "Condition", var = "Foo", ... }`.
pub fn stag(kind: &str, fields: Vec<(&str, PVal)>) -> PVal {
    let mut out = vec![("type".to_string(), PVal::Str(kind.to_string()))];
    out.extend(fields.into_iter().map(|(k, v)| (k.to_string(), v)));
    PVal::Map(out)
}
pub fn s(v: impl Into<String>) -> PVal {
    PVal::Str(v.into())
}
pub fn n(v: f64) -> PVal {
    PVal::Num(v)
}
pub fn b(v: bool) -> PVal {
    PVal::Bool(v)
}
pub fn list(v: Vec<PVal>) -> PVal {
    PVal::List(v)
}

/// One positional argument to `mod(name, type, value, ...)` / `flag(name, ...)`, matching
/// Modules/ModTools.lua's `modLib.createMod` vararg scan: an optional leading source string, an
/// optional flags number, an optional keywordFlags number, then any number of tags.
pub enum Arg {
    Source(String),
    Flags(u64),
    KwFlags(u64),
    Tag(PVal),
    /// A tag stranded past a table-constructor hole (see `PMod::unreachable_tags`): present in
    /// the golden JSON export at this raw 1-based index, but never reached by `ipairs(mod)`, so
    /// `pmod_to_mod` must not put it in the real `tags` list. Use when a Lua `mod(...)` call
    /// splices an explicit `nil` before a tag argument instead of omitting it outright.
    Hole(usize, PVal),
}
pub fn src(v: impl Into<String>) -> Arg {
    Arg::Source(v.into())
}
pub fn flags(f: u64) -> Arg {
    Arg::Flags(f)
}
pub fn kw(f: u64) -> Arg {
    Arg::KwFlags(f)
}
pub fn tg(tag: PVal) -> Arg {
    Arg::Tag(tag)
}
pub fn hole(index: usize, tag: PVal) -> Arg {
    Arg::Hole(index, tag)
}

/// `modLib.createMod(name, type, value, ...)`.
pub fn mk_mod(name: impl Into<String>, ty: &str, value: PVal, args: Vec<Arg>) -> PMod {
    let mut source = None;
    let mut fl = 0u64;
    let mut kwfl = 0u64;
    let mut tags = Vec::new();
    let mut unreachable_tags = Vec::new();
    for a in args {
        match a {
            Arg::Source(s) => source = Some(s),
            Arg::Flags(f) => fl |= f,
            Arg::KwFlags(f) => kwfl |= f,
            Arg::Tag(tv) => tags.push(tv),
            Arg::Hole(i, tv) => unreachable_tags.push((i, tv)),
        }
    }
    PMod { name: name.into(), ty: ty.to_string(), value, flags: fl, keyword_flags: kwfl, source, tags, unreachable_tags }
}

/// `local function flag(name, ...) return mod(name, "FLAG", true, ...) end`.
pub fn flag_mod(name: impl Into<String>, args: Vec<Arg>) -> PMod {
    mk_mod(name, "FLAG", PVal::Bool(true), args)
}

pub fn num(v: f64) -> PVal {
    PVal::Num(v)
}

/// `{ skillId = gemIdLookup[skill], level = ..., ... }`: Lua never creates the `skillId` key at
/// all when the lookup misses (assigning nil to a table field is the same as not assigning it),
/// so this omits the field entirely rather than falling back to an empty string.
pub fn ext_skill_map(skill_id: Option<&str>, mut fields: Vec<(&str, PVal)>) -> PVal {
    let mut out = Vec::with_capacity(fields.len() + 1);
    if let Some(id) = skill_id {
        out.push(("skillId".to_string(), PVal::Str(id.to_string())));
    }
    for (k, v) in fields.drain(..) {
        out.push((k.to_string(), v));
    }
    PVal::Map(out)
}

/// `mod(name, "LIST", { mod = inner }, ...tags)`: the common EnemyModifier/MinionModifier wrap.
pub fn wrap(name: &str, inner: PMod, args: Vec<Arg>) -> PMod {
    mk_mod(name, "LIST", PVal::Map(vec![("mod".to_string(), mod_to_pval(&inner))]), args)
}

/// `string.gsub(" "..str, "%W%l", string.upper):sub(2)`: capitalizes the first letter of every
/// whitespace-separated word (used to turn a lowercased skill name back into its display form).
pub fn title_case(s: &str) -> String {
    s.split(' ').map(first_upper).collect::<Vec<_>>().join(" ")
}

pub fn first_upper(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// `local explodeFunc = function(chance, amount, type, ...)` (line 2108-2119): shared by the many
/// "chance to explode dealing X% of life as Y damage" mods in special_a.rs's range.
pub fn explode_func(chance: f64, amount: &str, dmg_type: &str, extra_tags: Vec<PVal>) -> Option<Vec<PMod>> {
    let amount_number = tonumber(amount).or_else(|| match amount {
        "tenth" => Some(10.0),
        "quarter" => Some(25.0),
        _ => None,
    })?;
    let value = PVal::Map(vec![
        ("type".to_string(), PVal::Str(first_upper(dmg_type))),
        ("chance".to_string(), PVal::Num(chance / 100.0)),
        ("amount".to_string(), PVal::Num(amount_number)),
        ("keyOfScaledMod".to_string(), PVal::Str("chance".to_string())),
    ]);
    let args: Vec<Arg> = extra_tags.into_iter().map(Arg::Tag).collect();
    Some(vec![mk_mod("ExplodeMod", "LIST", value, args), flag_mod("CanExplode", vec![])])
}
