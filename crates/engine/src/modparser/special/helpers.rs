// Port of ModParser.lua's specialModList prelude (lines 2036-2106): `gemIdLookup` (built once
// from `data.skills`) and the three helper closures built on top of it -- `grantedExtraSkill`,
// `triggerExtraSkill`, `extraSupport` -- that turn a skill/support gem name capture into
// ExtraSkill/ExtraSupport/SkillData mods. Shared by special_a.rs and special_b.rs.
//
// Lua table-constructor semantics matter here: `{ key = someNilValue }` never puts `key` in the
// resulting table at all (assigning nil is the same as not assigning), so every field derived
// from an optional Lua argument (noSupports, source, triggerChance, appliesToGrantedSkills, ...)
// is only pushed onto the PVal::Map when the corresponding Rust value is "present" (true / Some),
// exactly mirroring which keys the Lua table would actually have.
use super::support::{mk_mod, stag, tg};
use crate::data::GameData;
use crate::modparser::types::{mod_to_pval, PMod, PVal};
use serde::Deserialize;
use crate::fxhash::HashMap;
use std::path::Path;
use std::sync::OnceLock;

fn game_data() -> &'static GameData {
    crate::data::shared()
}

/// The subset of a `data.skills[id]` entry (a `GrantedEffect`) that the prelude helpers need.
#[derive(Debug, Clone, Deserialize, Default)]
struct SkillMeta {
    #[serde(default)]
    name: String,
    #[serde(default)]
    hidden: bool,
    #[serde(rename = "fromItem", default)]
    from_item: bool,
    #[serde(rename = "fromTree", default)]
    from_tree: bool,
    /// Whether this granted effect is itself a support gem's effect (Lua:
    /// `grantedEffect.support`); used by `extraSupport` to inspect a gem's secondary effect
    /// without resolving the `$ref` the JSON export leaves for `secondaryGrantedEffect`.
    #[serde(default)]
    support: bool,
}

fn skills_map() -> &'static HashMap<String, SkillMeta> {
    static S: OnceLock<HashMap<String, SkillMeta>> = OnceLock::new();
    S.get_or_init(|| {
        let v = game_data().extra.get("skills").ok().flatten().map(|j| j.to_value()).unwrap_or(serde_json::Value::Null);
        serde_json::from_value(v).unwrap_or_default()
    })
}

fn gem_for_base_name() -> &'static HashMap<String, String> {
    static G: OnceLock<HashMap<String, String>> = OnceLock::new();
    G.get_or_init(|| {
        let v = game_data().extra.get("gemForBaseName").ok().flatten().map(|j| j.to_value()).unwrap_or(serde_json::Value::Null);
        serde_json::from_value(v).unwrap_or_default()
    })
}

/// `data.keystones` (line 5943 in the original: `for _, name in ipairs(data.keystones) do ...`):
/// every keystone's display name (e.g. "Acrobatics", "Elemental Overload").
pub fn keystone_names() -> &'static Vec<String> {
    static K: OnceLock<Vec<String>> = OnceLock::new();
    K.get_or_init(|| {
        let v = game_data().extra.get("keystones").ok().flatten().map(|j| j.to_value()).unwrap_or(serde_json::Value::Null);
        serde_json::from_value(v).unwrap_or_default()
    })
}

/// `data.clusterJewels.keystones` (line 5946 in the original).
pub fn cluster_jewel_keystone_names() -> &'static Vec<String> {
    static K: OnceLock<Vec<String>> = OnceLock::new();
    K.get_or_init(|| {
        game_data()
            .extra
            .get("clusterJewels")
            .ok()
            .flatten()
            .and_then(|v| v.get("keystones").map(|j| j.to_value()))
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    })
}

/// Lua (lines 2036-2046):
/// ```lua
/// local skillIds = {}
/// for id in pairs(data.skills) do table.insert(skillIds, id) end
/// table.sort(skillIds)
/// for _, id in ipairs(skillIds) do
///     local grantedEffect = data.skills[id]
///     if not grantedEffect.hidden or grantedEffect.fromItem or grantedEffect.fromTree then
///         gemIdLookup[grantedEffect.name:lower()] = grantedEffect.id
///     end
/// end
/// ```
/// Built from ids in sorted order so that, on a lower-cased name collision, the same id wins as
/// in the original (last write in sorted-id order).
pub fn gem_id_lookup() -> &'static HashMap<String, String> {
    static L: OnceLock<HashMap<String, String>> = OnceLock::new();
    L.get_or_init(|| {
        let skills = skills_map();
        let mut ids: Vec<&String> = skills.keys().collect();
        ids.sort();
        // Lua seeds the table with this one hardcoded entry before the loop below fills in the
        // rest from data.skills (line 2033-2035).
        let mut map = HashMap::default();
        map.insert("power charge on critical strike".to_string(), "SupportPowerChargeOnCritical".to_string());
        for id in ids {
            let s = &skills[id];
            if !s.hidden || s.from_item || s.from_tree {
                map.insert(s.name.to_lowercase(), id.clone());
            }
        }
        map
    })
}

fn strip_skill_suffix(name: &str) -> String {
    // Lua: `name:gsub(" skill","")` -- a plain-text gsub (no magic chars), so every occurrence of
    // the literal substring is removed, not just a trailing one.
    name.replace(" skill", "")
}

fn pval_map(fields: Vec<(&str, PVal)>) -> PVal {
    PVal::Map(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// Lua (lines 2047-2054):
/// ```lua
/// local function grantedExtraSkill(name, level, noSupports)
///     name = name:gsub(" skill","")
///     if gemIdLookup[name] then
///         return { mod("ExtraSkill", "LIST", { skillId = gemIdLookup[name], level = tonumber(level), noSupports = noSupports }) }
///     end
/// end
/// ```
pub fn granted_extra_skill(name: &str, level: f64, no_supports: bool) -> Option<Vec<PMod>> {
    let name = strip_skill_suffix(name);
    let skill_id = gem_id_lookup().get(&name)?.clone();
    let mut fields = vec![("skillId", PVal::Str(skill_id)), ("level", PVal::Num(level))];
    if no_supports {
        fields.push(("noSupports", PVal::Bool(true)));
    }
    Some(vec![mk_mod("ExtraSkill", "LIST", pval_map(fields), vec![])])
}

/// Options bag mirroring `triggerExtraSkill`'s Lua `options` table.
#[derive(Default, Clone, Copy)]
pub struct TriggerOptions<'a> {
    pub source_skill: Option<&'a str>,
    pub no_supports: bool,
    pub ignore_hexproof: bool,
    pub on_crit: bool,
    pub trigger_chance: Option<f64>,
}

/// Lua (lines 2055-2072):
/// ```lua
/// local function triggerExtraSkill(name, level, options)
///     local options = options or {}
///     name = name:gsub(" skill","")
///     if options.sourceSkill then options.sourceSkill = options.sourceSkill:gsub(" skill","") end
///     local mods = {}
///     if gemIdLookup[name] then
///         t_insert(mods, mod("ExtraSkill", "LIST", { skillId = gemIdLookup[name], level = tonumber(level), noSupports = options.noSupports, triggered = true, source = options.sourceSkill, triggerChance = tonumber(options.triggerChance) }))
///     end
///     if options.ignoreHexproof then
///         t_insert(mods, mod("SkillData", "LIST", { key = "ignoreHexproof", value = true }, { type = "SkillId", skillId = gemIdLookup[name] }))
///     end
///     if options.onCrit then
///         t_insert(mods, mod("ExtraSkillMod", "LIST", { mod = mod("SkillData", "LIST", { key = "triggerOnCrit", value = true })}, { type = "SkillId", skillId = gemIdLookup[name] }))
///     end
///     return mods
/// end
/// ```
pub fn trigger_extra_skill(name: &str, level: f64, options: TriggerOptions) -> Vec<PMod> {
    let name = strip_skill_suffix(name);
    let source_skill = options.source_skill.map(strip_skill_suffix);
    let skill_id = gem_id_lookup().get(&name).cloned();
    let mut mods = Vec::new();

    if let Some(sid) = &skill_id {
        let mut fields = vec![("skillId", PVal::Str(sid.clone())), ("level", PVal::Num(level))];
        if options.no_supports {
            fields.push(("noSupports", PVal::Bool(true)));
        }
        fields.push(("triggered", PVal::Bool(true)));
        if let Some(src) = &source_skill {
            fields.push(("source", PVal::Str(src.clone())));
        }
        if let Some(tc) = options.trigger_chance {
            fields.push(("triggerChance", PVal::Num(tc)));
        }
        mods.push(mk_mod("ExtraSkill", "LIST", pval_map(fields), vec![]));
    }
    if options.ignore_hexproof {
        let mut tag_fields: Vec<(&str, PVal)> = vec![];
        if let Some(sid) = &skill_id {
            tag_fields.push(("skillId", PVal::Str(sid.clone())));
        }
        let t = stag("SkillId", tag_fields);
        mods.push(mk_mod(
            "SkillData",
            "LIST",
            pval_map(vec![("key", PVal::Str("ignoreHexproof".to_string())), ("value", PVal::Bool(true))]),
            vec![tg(t)],
        ));
    }
    if options.on_crit {
        let mut tag_fields: Vec<(&str, PVal)> = vec![];
        if let Some(sid) = &skill_id {
            tag_fields.push(("skillId", PVal::Str(sid.clone())));
        }
        let t = stag("SkillId", tag_fields);
        let inner = mk_mod(
            "SkillData",
            "LIST",
            pval_map(vec![("key", PVal::Str("triggerOnCrit".to_string())), ("value", PVal::Bool(true))]),
            vec![],
        );
        let inner_pval = mod_to_pval(&inner);
        mods.push(mk_mod("ExtraSkillMod", "LIST", pval_map(vec![("mod", inner_pval)]), vec![tg(t)]));
    }
    mods
}

/// Lua (lines 2081-2084), title-cases each word of a slot name: prefixes the string with a space,
/// then Lua's `string.gsub(" "..slot, "%W%l", string.upper):sub(2)` uppercases the letter
/// following every non-word character (which includes the leading space, and thus the first
/// letter of the whole string) and drops that leading space back off.
pub fn title_case_words(slot: &str) -> String {
    let mut out = String::with_capacity(slot.len());
    let mut prev_is_word = false; // start of string acts like it follows a non-word char
    for c in slot.chars() {
        if !prev_is_word && c.is_lowercase() {
            out.extend(c.to_uppercase());
        } else {
            out.push(c);
        }
        prev_is_word = c.is_alphanumeric() || c == '_';
    }
    out
}

/// Lua (lines 2073-2106).
pub fn extra_support(name: &str, level: f64, slot: Option<&str>, applies_to_granted_skills: bool) -> Option<Vec<PMod>> {
    let lookup = gem_id_lookup();
    let name_no_prefix = name.strip_prefix("increased ").unwrap_or(name);
    let name_no_suffix = name.strip_suffix(" support").unwrap_or(name);
    let skill_id = lookup
        .get(name)
        .or_else(|| lookup.get(name_no_prefix))
        .or_else(|| lookup.get(name_no_suffix))?
        .clone();

    let slot_name = match slot {
        Some("main hand") | Some("main hand weapon") => "Weapon 1".to_string(),
        Some("off hand") | Some("off hand weapon") => "Weapon 2".to_string(),
        Some(s) => title_case_words(s),
        None => "{SlotName}".to_string(),
    };
    let slot_tag = stag("SocketedIn", vec![("slotName", PVal::Str(slot_name))]);

    let skills = skills_map();
    let skill_name = skills.get(&skill_id).map(|s| s.name.clone()).unwrap_or_default();
    let gem_id = gem_for_base_name().get(&format!("{} support", skill_name).to_lowercase()).cloned();

    if let Some(gem) = gem_id.as_deref().and_then(|id| game_data().gems.get(id)) {
        let granted_effect_id = gem.granted_effect_id.clone().unwrap_or_default();
        let mut fields = vec![("skillId", PVal::Str(granted_effect_id)), ("level", PVal::Num(level))];
        if applies_to_granted_skills {
            fields.push(("appliesToGrantedSkills", PVal::Bool(true)));
        }
        let mut mods = vec![mk_mod("ExtraSupport", "LIST", pval_map(fields), vec![tg(slot_tag.clone())])];
        if let Some(sec_id) = gem.secondary_granted_effect_id.clone() {
            let is_support = skills.get(&sec_id).map(|s| s.support).unwrap_or(false);
            if is_support {
                let mut f2 = vec![("skillId", PVal::Str(sec_id)), ("level", PVal::Num(level))];
                if applies_to_granted_skills {
                    f2.push(("appliesToGrantedSkills", PVal::Bool(true)));
                }
                mods.push(mk_mod("ExtraSupport", "LIST", pval_map(f2), vec![tg(slot_tag)]));
            } else {
                let f2 = vec![("skillId", PVal::Str(sec_id)), ("level", PVal::Num(level))];
                mods.push(mk_mod("ExtraSkill", "LIST", pval_map(f2), vec![]));
            }
        }
        Some(mods)
    } else {
        let mut fields = vec![("skillId", PVal::Str(skill_id)), ("level", PVal::Num(level))];
        if applies_to_granted_skills {
            fields.push(("appliesToGrantedSkills", PVal::Bool(true)));
        }
        Some(vec![mk_mod("ExtraSupport", "LIST", pval_map(fields), vec![tg(slot_tag)])])
    }
}
