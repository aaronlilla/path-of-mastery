// The thin input layer this crate is built against, so crates/calc (still assembling its own
// Env/Actor/ActiveSkill) can plug in later without touching area.rs/conversion.rs/cooldown.rs/
// misc_fields.rs: every function in this crate takes a `&pom_engine::modstore::store::ModStore`
// (a skill's mod list, or an actor's/enemy's own modDB - the same type either way) plus a
// `SkillView` for the handful of scalar activeSkill fields CalcOffence.lua reads directly rather
// than through a Sum/More/Flag query. No calc-specific type appears in any function signature in
// this crate.
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::{Cfg, ScalarValue};
use pom_engine::fxhash::{HashMap, HashSet};

/// The activeSkill-level scalar state CalcOffence.lua reads directly (`activeSkill.skillData`,
/// `.skillFlags`, `.skillTypes`, `.skillTotemId`), independent of any particular calc-core
/// representation. `skill_data` uses `pom_engine`'s own `ScalarValue` (Num/Str/Bool) since Lua's
/// `skillData` table mixes all three (e.g. `radius` is a number, `debuff` a bool,
/// `corpseMonsterVariety` a string) - a caller with a richer table just exposes the same view.
pub struct SkillView<'a> {
    pub skill_mod_list: &'a ModStore,
    pub skill_cfg: Option<&'a Cfg>,
    pub skill_data: &'a HashMap<String, ScalarValue>,
    pub skill_flags: &'a HashSet<String>,
    pub skill_types: &'a HashSet<i64>,
    pub skill_totem_id: i64,
}

impl<'a> SkillView<'a> {
    pub fn flag(&self, name: &str) -> bool {
        self.skill_flags.contains(name)
    }
    pub fn has_type(&self, id: i64) -> bool {
        self.skill_types.contains(&id)
    }
    /// `skillData.<key>` read as a number; Lua `nil` (key absent) -> `None`, matching `and`/`or`
    /// chains in the source that treat a missing key as falsy/zero.
    pub fn num(&self, key: &str) -> Option<f64> {
        match self.skill_data.get(key) {
            Some(ScalarValue::Num(n)) => Some(*n),
            _ => None,
        }
    }
    pub fn num_or(&self, key: &str, default: f64) -> f64 {
        self.num(key).unwrap_or(default)
    }
    /// `skillData.<key>` read as a Lua-truthy boolean: present and not `false` -> true; absent ->
    /// false (a Lua flag field is either omitted or `true`, so this also covers `ScalarValue::Bool(true)`).
    pub fn truthy(&self, key: &str) -> bool {
        match self.skill_data.get(key) {
            Some(ScalarValue::Bool(b)) => *b,
            Some(_) => true,
            None => false,
        }
    }
    pub fn str(&self, key: &str) -> Option<&str> {
        match self.skill_data.get(key) {
            Some(ScalarValue::Str(s)) => Some(s.as_ref()),
            _ => None,
        }
    }
}
