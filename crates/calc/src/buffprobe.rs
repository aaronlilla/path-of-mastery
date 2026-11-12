//! Parses the probe JSONL (`PROBE(name, value)` output) for the two probes this crate's buff/aura port is
//! graded against: `"buffs_in"` (each active, non-disabled skill's `buffList` right before
//! `calcs.perform`'s buff loop starts, CalcPerform.lua:2305) and `"buffs_out"` (the `buffs` table
//! - keyed by buff name, each value its final merged mod list - right before "Apply buff/debuff
//! modifiers" flushes it into `modDB`, CalcPerform.lua:3343). Both probes are guarded by
//! `env.mode == "MAIN"` in the probe code itself, but `calcs.buildOutput`'s own `mode == "MAIN"`
//! branch (Modules/Calcs.lua:399, `calcs.buildActiveSkill` per skill) re-enters `calcs.perform` in
//! "MAIN" mode again for tooltip/breakdown purposes after the real one, so a build can still emit
//! several `("buffs_in"/"buffs_out", build)` pairs - same reason this crate's own `prePerform`
//! recorder hook just unconditionally overwrites on every "MAIN" call rather than
//! taking the first: whichever call is temporally LAST is the one whose post-state
//! `build.calcsTab.mainEnv` actually reflects (confirmed empirically: `load` here keeps the last
//! occurrence per build, the same convention `prePerform` already relies on for the 99.1%-matched
//! attribute-bonus subsystem).
//!
//! Wire shape: this is the probe script's generic `ser()`, not the calc recorder's purpose-built
//! serializer - a Lua array becomes a JSON *object* keyed by `"1".."n"` (matching
//! `pom_calc::rawlua`'s mod/tag shape, which is reused here via `parse_raw_mod` - see that
//! module's doc comment), so this file supplies its own "numeric-keyed object as ordered list"
//! walk for the outer skill/buff-list/buffs-by-name structures.
use crate::rawlua::parse_raw_mod;
use pom_engine::modifier::Mod;
use serde_json::Value as J;
use pom_engine::fxhash::HashMap;

fn jbool(v: &J) -> bool {
    v.as_bool().unwrap_or(false)
}
fn jstr(v: &J) -> &str {
    v.as_str().unwrap_or("")
}
fn jnum(v: &J) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

/// Walks a `probe.lua`-serialized Lua array (`{"1":x,"2":y,...}`) in index order. A real JSON
/// array is accepted too, since a probe value nested inside one already-parsed by `parse_raw_mod`
/// (a mod's own `value`/tags) never reaches this - only the outer wrapper tables this crate's own
/// probe `code` built - but staying tolerant costs nothing.
fn array_like(v: &J) -> Vec<&J> {
    match v {
        J::Array(a) => a.iter().collect(),
        J::Object(o) => {
            let mut keys: Vec<i64> = o.keys().filter_map(|k| k.parse().ok()).collect();
            keys.sort_unstable();
            keys.into_iter().map(|k| &o[&k.to_string()]).collect()
        }
        _ => Vec::new(),
    }
}

/// One `CalcActiveSkill.lua:826-839`-shaped `buff` table entry from a skill's `buffList`, plus
/// this crate's own probe-computed gate booleans
/// for the unported subsystems (general condition
/// evaluation, party/ally aura sharing) those gates depend on - treated as recorded input state
/// the same way `StoreSnapshot.conditions` already is everywhere else in this crate, not as a
/// pre-computed answer for `perform::compute_buffs`'s own branch logic.
pub struct ProbedBuff {
    pub ty: String,
    pub name: String,
    pub mod_list: Vec<Mod>,
    pub apply_not_player: bool,
    pub allow_totem_buff: bool,
    pub active_skill_buff: bool,
    /// `buff.cond`/`buff.enemyCond` gate (CalcPerform.lua:2312-2315), evaluated in Lua at probe
    /// time since this crate doesn't model general skill-condition state.
    pub gate_ok: bool,
    /// Aura-only: `activeSkill.skillData.auraCannotAffectSelf`.
    pub aura_cannot_affect_self: bool,
    /// Aura-only: `modDB:Flag(nil, "AlliesAurasCannotAffectSelf")`.
    pub allies_auras_cannot_affect_self_flag: bool,
    /// Aura-only: whether a party member (`env.partyMembers`) grants the same-named aura - see
    /// `perform::compute_buffs`'s doc comment for how this and `party_aura_effect_mult` combine
    /// with a self-computed `mult` to reproduce CalcPerform.lua:2465's guard.
    pub has_party_aura: bool,
    pub party_aura_effect_mult: f64,
}

/// `probe.lua`'s `ser()` cycle guard (`seen[v] = path`) is keyed across the *entire* probed
/// value, not reset per skill/buff - so the exact same underlying Lua mod table showing up twice
/// in `env.player.activeSkillList` (seen directly: a curse skill's buff data duplicated across two
/// `activeSkillList` entries) serializes its second occurrence as `{"$ref": "<first path>"}`
/// instead of the real mod fields. `parse_raw_mod` doesn't know this shape (no `name`/`type`/
/// `value` keys to find), so it silently produced a garbage all-defaults `Mod` before this filter
/// existed. Safe to just drop it: the real mod already came through at its first occurrence,
/// wherever that was, so dropping the duplicate reference costs nothing (this buff-name's `want`
/// list already has the real data from its other instance, and `merge_buff` dedups across
/// instances of the same buff name the same way upstream does).
fn is_ref(v: &J) -> bool {
    v.as_object().map(|o| o.contains_key("$ref")).unwrap_or(false)
}

fn parse_buff(v: &J) -> ProbedBuff {
    let o = v.as_object().unwrap_or_else(|| panic!("buff is not an object: {v}"));
    ProbedBuff {
        ty: jstr(o.get("type").unwrap_or(&J::Null)).to_string(),
        name: jstr(o.get("name").unwrap_or(&J::Null)).to_string(),
        mod_list: array_like(o.get("modList").unwrap_or(&J::Null)).into_iter().filter(|m| !is_ref(m)).map(parse_raw_mod).collect(),
        apply_not_player: o.get("applyNotPlayer").map(jbool).unwrap_or(false),
        allow_totem_buff: o.get("allowTotemBuff").map(jbool).unwrap_or(false),
        active_skill_buff: o.get("activeSkillBuff").map(jbool).unwrap_or(false),
        gate_ok: o.get("gateOk").map(jbool).unwrap_or(false),
        aura_cannot_affect_self: o.get("auraCannotAffectSelf").map(jbool).unwrap_or(false),
        allies_auras_cannot_affect_self_flag: o.get("alliesAurasCannotAffectSelfFlag").map(jbool).unwrap_or(false),
        has_party_aura: o.get("hasPartyAura").map(jbool).unwrap_or(false),
        party_aura_effect_mult: o.get("partyAuraEffectMult").map(jnum).unwrap_or(0.0),
    }
}

/// One `env.player.activeSkillList` entry's worth of probed buff data. `skill_index` is the
/// probe's own 1-based `ipairs(env.player.activeSkillList)` index (the recorded `pre.skills`'
/// matching entry is `skills[skill_index - 1]`) - the probe *skips* disabled skills when building
/// this list (`activeSkill.skillFlags.disable`, matching CalcPerform.lua's own gate at the top of
/// the buff loop), so this can't just be the position within the resulting Rust `Vec`; `pre.skills`
/// itself has no such gap (the recorder's `prePerformSnapshotFn` records every skill).
pub struct ProbedSkill {
    pub skill_index: usize,
    pub is_totem: bool,
    pub buff_list: Vec<ProbedBuff>,
}

fn parse_skill(v: &J) -> ProbedSkill {
    let o = v.as_object().unwrap_or_else(|| panic!("skill is not an object: {v}"));
    ProbedSkill {
        skill_index: o.get("skillIndex").map(jnum).unwrap_or(0.0) as usize,
        is_totem: o.get("isTotem").map(jbool).unwrap_or(false),
        buff_list: array_like(o.get("buffList").unwrap_or(&J::Null)).into_iter().map(parse_buff).collect(),
    }
}

/// The two probes, keyed by build name, each holding the *last* occurrence recorded for that
/// build (see this module's doc comment for why last, not first).
#[derive(Default)]
pub struct BuffProbeCorpus {
    pub buffs_in: HashMap<String, Vec<ProbedSkill>>,
    pub buffs_out: HashMap<String, HashMap<String, Vec<Mod>>>,
}

pub fn load(path: &std::path::Path) -> BuffProbeCorpus {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {}", path.display(), e));
    let mut corpus = BuffProbeCorpus::default();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let entry: J = serde_json::from_str(line).unwrap_or_else(|e| panic!("bad probe line: {e}: {line}"));
        let build = jstr(&entry["build"]).to_string();
        if build == "nil" {
            continue;
        }
        let probe = jstr(&entry["probe"]);
        let v = &entry["v"];
        match probe {
            "buffs_in" => {
                let skills = array_like(v).into_iter().map(parse_skill).collect();
                corpus.buffs_in.insert(build, skills);
            }
            "buffs_out" => {
                let mut m = HashMap::default();
                if let Some(o) = v.as_object() {
                    for (k, arr) in o {
                        m.insert(k.clone(), array_like(arr).into_iter().filter(|x| !is_ref(x)).map(parse_raw_mod).collect());
                    }
                }
                corpus.buffs_out.insert(build, m);
            }
            _ => {}
        }
    }
    corpus
}
