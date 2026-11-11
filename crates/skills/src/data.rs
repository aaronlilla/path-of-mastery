//! `GameData` access plus the flat JSON helpers this crate needs on top of it:
//! `GrantedEffect.extra`/`GemLevel.values` are untyped `serde_json::Map`s (their shape varies
//! per skill), so every read here goes through a small set of typed-accessor helpers instead of
//! adding one-off fields to `pom-engine`'s shared `GrantedEffect`/`GemLevel` structs.
use pom_engine::data::gems::{GemData, GrantedEffect};
use pom_engine::data::GameData;
use pom_engine::fxhash::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;

/// `game_data().gems`, sorted by its own key string. `pom_engine::data::GameData.gems` is a plain
/// `pom_engine::fxhash::HashMap` (randomized-hasher, iteration order differs *between processes*,
/// confirmed the hard way: this crate's own answer-key "matched" count visibly flickered
/// between two values run to run before every gem-tie-break-sensitive derived index here switched
/// to iterating this sorted view instead of `&game_data().gems` directly). Every derived index
/// that can have a genuine ambiguity to resolve (`xmlskills::gems_by_game_id`, `gem_for_skill`,
/// `find_gem_by_exact_name`, `gem_id_for_base_name`) must build from this, not the raw map, so
/// this crate's *own* output is at least reproducible - this does not claim to match LuaJIT's real
/// `pairs()` order, only to stop depending on a hasher seed.
pub fn sorted_gems() -> &'static Vec<(&'static str, &'static GemData)> {
    static SORTED: OnceLock<Vec<(&'static str, &'static GemData)>> = OnceLock::new();
    SORTED.get_or_init(|| {
        let mut v: Vec<(&'static str, &'static GemData)> = game_data().gems.iter().map(|(k, g)| (k.as_str(), g)).collect();
        v.sort_by_key(|(k, _)| *k);
        v
    })
}

pub fn game_data() -> &'static GameData {
    pom_engine::data::shared()
}

/// `data_skills.json` as the process's one shared compact document (`pom_engine::cjson`): the skills, calc and
/// pipeline crates all read skill levels from it.
pub fn skills_doc() -> pom_engine::cjson::J {
    static DOC: OnceLock<pom_engine::cjson::J> = OnceLock::new();
    *DOC.get_or_init(|| pom_engine::cjson::doc(&engine_data_dir().join("data_skills.json")).unwrap_or(pom_engine::cjson::J::NULL))
}

/// `grantedEffect.levels[level]` by the real level number: a dense `1..N` table exports as an array (index
/// `level - 1`, clamped at 0), a sparse one (a skill fixed at one level) as an object keyed by the number.
pub fn skill_level_obj(ge_id: &str, level_num: f64) -> Option<pom_engine::cjson::J> {
    let levels = skills_doc().get(ge_id)?.get("levels")?;
    let n = level_num.round() as i64;
    match (levels.as_array(), levels.as_object()) {
        (Some(a), _) => a.get((n - 1).max(0) as usize),
        (_, Some(o)) => o.get(&n.to_string()),
        _ => None,
    }
}

/// Resolved once per process (it checks the file system).
pub(crate) fn engine_data_dir() -> std::path::PathBuf {
    static DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(engine_data_dir_live).clone()
}

fn engine_data_dir_live() -> std::path::PathBuf {
    // The data folder the host or tool named. The working-directory copies below are for running from a checkout
    // (cargo tests, the golden binaries); the app always sets the variable, so it never reaches them.
    for var in ["POM_ENGINE_DATA"] {
        if let Some(d) = std::env::var_os(var).filter(|d| !d.is_empty()) {
            return std::path::PathBuf::from(d);
        }
    }
    for dir in ["../../engine-data", "engine-data"] {
        let p = Path::new(dir);
        if p.exists() {
            return p.to_path_buf();
        }
    }
    panic!("could not locate engine-data directory");
}

/// `data.gems[gemId].grantedEffect` / `.secondaryGrantedEffect` - looked up straight by the raw
/// game id (`<Gem gemId="Metadata/Items/Gems/SkillGemArc">`), matching `Modules/Data.lua`'s
/// `setupGem` (`gem.grantedEffect = data.skills[gem.grantedEffectId]`).
pub fn gem_granted_effect(gem_id: &str, secondary: bool) -> Option<&'static GrantedEffect> {
    let gem = game_data().gems.get(gem_id)?;
    if secondary {
        gem_secondary_effect(gem)
    } else {
        gem_primary_effect(gem)
    }
}

/// `data.skills`: the flat `{ [grantedEffectId] = GrantedEffect }` table (`data_skills.json`),
/// keyed by every granted effect's own id - including ones with no owning gem at all (item-only
/// granted skills, e.g. Replica Dragonfang's Flight's "Death Walk"). `data.gems`'s own
/// `.grantedEffect fields are a subset of this same data, looked up by the owning gem instead.
pub fn all_skills() -> &'static HashMap<String, GrantedEffect> {
    static SKILLS: OnceLock<HashMap<String, GrantedEffect>> = OnceLock::new();
    SKILLS.get_or_init(|| {
        // Each skill straight from the compact document. `data_skills.json` exports a field that is the same Lua table
        // as another skill's as `{"$ref": "data.skills.<id>.<field>"}` (only `ExplosiveTrapAltX`'s `parts` and
        // `baseMods`, which upstream defines as `skills.ExplosiveTrap.parts` / `.baseMods`); such a skill is
        // patched with a copy of each target as a `Value` first.
        let doc = skills_doc();
        let Some(obj) = doc.as_object() else { return HashMap::default() };
        let mut out = pom_engine::fxhash::map_with_capacity(obj.len());
        for (id, entry) in obj.iter() {
            let fixes: Vec<(&str, pom_engine::cjson::J)> = entry
                .as_object()
                .map(|e| {
                    e.iter()
                        .filter_map(|(field, v)| {
                            let r = v.as_object()?.get("$ref")?.as_str()?;
                            let parts: Vec<&str> = r.split('.').collect();
                            if parts.len() != 4 || parts[0] != "data" || parts[1] != "skills" {
                                return None;
                            }
                            let target = obj.get(parts[2])?.get(parts[3])?;
                            (!target.as_object().is_some_and(|o| o.contains_key("$ref"))).then_some((field, target))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let ge: GrantedEffect = if fixes.is_empty() {
                pom_engine::cjson::from_j(entry).unwrap_or_else(|e| panic!("data_skills.json {id}: {e}"))
            } else {
                let mut v = entry.to_value();
                if let Some(o) = v.as_object_mut() {
                    for (field, target) in fixes {
                        o.insert(field.to_string(), target.to_value());
                    }
                }
                serde_json::from_value(v).unwrap_or_else(|e| panic!("data_skills.json {id}: {e}"))
            };
            out.insert(id.to_string(), ge);
        }
        out
    })
}

pub fn granted_effect_by_skill_id(skill_id: &str) -> Option<&'static GrantedEffect> {
    all_skills().get(skill_id)
}

/// `data_gems.json`'s `grantedEffect`/`secondaryGrantedEffect` are frequently a `{"$ref":
/// "data.gems.<other gem>.grantedEffect"}` placeholder instead of the real object - the exporter's
/// way of not duplicating a `GrantedEffect` that's the *same Lua table* as another gem's (every
/// `secondaryGrantedEffect` is one, 147/147 checked; 52/871 primaries too, mostly Vaal-skill
/// `AltX` gems whose primary is a shared reference to their base gem's). Deserializing that
/// placeholder into `GrantedEffect` doesn't error (every field is `Option`/`extra`-flattened) but
/// produces a near-empty object - `support`/`addSkillTypes`/`addFlags`/etc. all silently read as
/// absent. Always re-resolve through `data.skills` (`all_skills`) by the gem's own
/// `grantedEffectId`/`secondaryGrantedEffectId` string field instead of trusting the embedded
/// object; that flat table is exported straight from `data.skills` and never carries a `$ref`.
pub fn gem_primary_effect(gem: &'static GemData) -> Option<&'static GrantedEffect> {
    if let Some(id) = &gem.granted_effect_id {
        if let Some(ge) = all_skills().get(id) {
            return Some(ge);
        }
    }
    gem.granted_effect.as_ref()
}

/// See `gem_primary_effect`'s doc comment - the same `$ref`-placeholder issue, but for
/// `secondaryGrantedEffect` (every sample checked, 147/147, is a placeholder).
pub fn gem_secondary_effect(gem: &'static GemData) -> Option<&'static GrantedEffect> {
    if let Some(id) = &gem.secondary_granted_effect_id {
        if let Some(ge) = all_skills().get(id) {
            return Some(ge);
        }
    }
    gem.secondary_granted_effect.as_ref()
}

/// `data.gemForSkill[grantedEffect]`: reverse index from a granted effect's id to the gem key
/// that grants it (`Modules/Data.lua`'s `setupGem`: `data.gemForSkill[gem.grantedEffect] =
/// gemId`), built from both primary and secondary granted effects. `None` for a granted effect no
/// gem actually grants (item-only skills).
pub fn gem_for_skill(skill_id: &str) -> Option<&'static str> {
    static IDX: OnceLock<HashMap<String, &'static str>> = OnceLock::new();
    let idx = IDX.get_or_init(|| {
        let mut m = HashMap::default();
        // Primary-id matches first, secondary-id matches only filling gaps: a Vaal skill's
        // *secondary* granted effect is its plain (non-Vaal) counterpart's id (e.g. "Vaal
        // Immortal Call"'s secondary is plain "ImmortalCall"), which collides with "Immortal
        // Call"'s own gem, where it's the *primary*. `data.gemForSkill[gem.grantedEffect] =
        // gemId` / `...secondaryGrantedEffect...` in upstream has the exact same ambiguity,
        // resolved by whichever gem `pairs(data.gems)` visits last (not reproduced here - see
        // the `resolve_gem` variant-tie-break doc comment for the same class of gap); this
        // two-pass order is close to the effect: prefer the gem that natively owns a skill as its
        // primary over one that merely carries it as a secondary alias.
        for (gem_key, gem) in sorted_gems() {
            if let Some(id) = &gem.granted_effect_id {
                m.insert(id.clone(), *gem_key);
            }
        }
        for (gem_key, gem) in sorted_gems() {
            if let Some(id) = &gem.secondary_granted_effect_id {
                m.entry(id.clone()).or_insert(*gem_key);
            }
        }
        m
    });
    idx.get(skill_id).copied()
}

/// `SkillsTabClass:FindSkillGem`'s exact-match pattern only (`"^ "..nameSpec:gsub(...).."$"`,
/// case-insensitive): the fallback used when a `<Gem>`'s `gemId`/`skillId` attributes don't
/// resolve to any known variant (a legacy/renamed gem - old saves can carry a `variantId`/
/// `skillId` from before a skill was renamed, e.g. `"Riposte"` -> `"Glacial Shield Swipe"`,
/// `"FlameWhip"` -> `"Flame Surge"`). Upstream also tries four increasingly fuzzy
/// abbreviation patterns after this one; not ported (no sample build has needed them so far - an
/// unresolved gem after the exact-name fallback is left unresolved here too, same as a build
/// where every `FindSkillGem` pattern misses).
pub fn find_gem_by_exact_name(name_spec: &str) -> Option<&'static pom_engine::data::gems::GemData> {
    // SkillsTab.lua:1103 `FindSkillGem`: five increasingly broad Lua patterns over " "..gem.name;
    // an ambiguous match at one level returns an error (gemData nil).
    let alpha = |c: char| c.is_ascii_alphabetic();
    let stripped: String = name_spec.chars().filter(|c| *c != ' ').collect();
    let mut p1 = String::from("^ ");
    for c in name_spec.chars() {
        if alpha(c) {
            p1.push_str(&format!("[{}{}]", c.to_ascii_uppercase(), c.to_ascii_lowercase()));
        } else {
            p1.push(c);
        }
    }
    p1.push('$');
    let mut p2 = String::from("^");
    for c in name_spec.chars() {
        if alpha(c) {
            p2.push(' ');
            p2.push(c);
            p2.push_str("%l+");
        } else {
            p2.push(c);
        }
    }
    p2.push('$');
    let mut p3 = String::from("^ ");
    for c in stripped.chars() {
        if c.is_ascii_lowercase() {
            p3.push_str("%l*");
        }
        p3.push(c);
    }
    p3.push_str("%l+$");
    let mut p4 = String::from("^");
    let mut p5 = String::from("^");
    for c in stripped.chars() {
        if alpha(c) {
            p4.push_str(".*");
            p5.push_str(&format!(".*[{}{}]", c.to_ascii_uppercase(), c.to_ascii_lowercase()));
        } else {
            p5.push(c);
        }
        p4.push(c);
    }
    for pat in [p1, p2, p3, p4, p5] {
        let mut found: Option<&'static pom_engine::data::gems::GemData> = None;
        for (_, g) in sorted_gems() {
            let Some(n) = g.name.as_ref() else { continue };
            let subject = format!(" {n}");
            if let Ok(Some(_)) = pom_engine::luapat::lmatch(subject.as_bytes(), pat.as_bytes(), None) {
                if found.is_some() {
                    return None;
                }
                found = Some(g);
            }
        }
        if found.is_some() {
            return found;
        }
    }
    None
}


/// `SkillsTabClass:FindSkillGem` (SkillsTab.lua:1103-1127): the name-spec fallback for a gem instance whose
/// `gemId`/`skillId` resolved to nothing. Five increasingly broad Lua patterns against `" "..gemData.name`; the
/// first pass with any match wins, and two matches in the same pass is an "Ambiguous gem name" error (no gem).
pub fn find_skill_gem(name_spec: &str) -> Option<&'static pom_engine::data::gems::GemData> {
    // Pure function of the static gem table: the pattern scan over every gem is slow, so memoize by name.
    type Memo = std::sync::Mutex<HashMap<String, Option<&'static pom_engine::data::gems::GemData>>>;
    static MEMO: OnceLock<Memo> = OnceLock::new();
    let memo = MEMO.get_or_init(Default::default);
    if let Some(r) = memo.lock().unwrap().get(name_spec) {
        return *r;
    }
    let r = find_skill_gem_uncached(name_spec);
    memo.lock().unwrap().insert(name_spec.to_string(), r);
    r
}

fn find_skill_gem_uncached(name_spec: &str) -> Option<&'static pom_engine::data::gems::GemData> {
    use pom_engine::luapat::pattern::lmatch;
    let nospace: String = name_spec.chars().filter(|c| *c != ' ').collect();
    let mut p1 = String::from("^ ");
    let mut p2 = String::from("^");
    let mut p3 = String::from("^ ");
    let mut p4 = String::from("^");
    let mut p5 = String::from("^");
    for c in name_spec.chars() {
        if c.is_ascii_alphabetic() {
            p1.push_str(&format!("[{}{}]", c.to_ascii_uppercase(), c.to_ascii_lowercase()));
            p2.push_str(&format!(" {c}%l+"));
        } else {
            p1.push(c);
            p2.push(c);
        }
    }
    p1.push('$');
    p2.push('$');
    for c in nospace.chars() {
        if c.is_ascii_lowercase() {
            p3.push_str(&format!("%l*{c}"));
        } else {
            p3.push(c);
        }
        if c.is_ascii_alphabetic() {
            p4.push_str(&format!(".*{c}"));
            p5.push_str(&format!(".*[{}{}]", c.to_ascii_uppercase(), c.to_ascii_lowercase()));
        } else {
            p4.push(c);
            p5.push(c);
        }
    }
    p3.push_str("%l+$");
    for pat in [p1, p2, p3, p4, p5] {
        let mut found: Option<&'static pom_engine::data::gems::GemData> = None;
        for (_, g) in sorted_gems() {
            let Some(n) = &g.name else { continue };
            let hay = format!(" {n}");
            if matches!(lmatch(hay.as_bytes(), pat.as_bytes(), None), Ok(Some(_))) {
                if found.is_some() {
                    return None;
                }
                found = Some(*g);
            }
        }
        if found.is_some() {
            return found;
        }
    }
    None
}

/// `data.gemForBaseName[name:lower()]`: reverse lookup by a gem's display name (used for
/// `ExtraSupport`/imbued-support resolution, where only a name is known). Not needed by the
/// XML-driven socket-group path (which always has a real `gemId`), kept for completeness.
pub fn gem_id_for_base_name(name: &str) -> Option<&'static str> {
    static IDX: OnceLock<HashMap<String, &'static str>> = OnceLock::new();
    let idx = IDX.get_or_init(|| {
        let mut m = HashMap::default();
        for (gem_id, gem) in sorted_gems() {
            let Some(gname) = &gem.name else { continue };
            let mut base_name = gname.clone();
            if let Some(ge) = gem_primary_effect(gem) {
                if is_support(ge) && gem.granted_effect_id.as_deref() != Some("SupportBarrage") {
                    base_name = format!("{base_name} Support");
                }
            }
            m.insert(base_name.to_lowercase(), *gem_id);
        }
        m
    });
    idx.get(&name.to_lowercase()).copied()
}

/// `calcLib.getGameIdFromGemName` (CalcTools.lua:277-292): the gem's `gameId`, which transfigured
/// variants share with their base gem; `drop_vaal` swaps a Vaal gem for its Vaal skill's own gem.
pub fn game_id_from_gem_name(name: &str, drop_vaal: bool) -> Option<&'static str> {
    let gem = game_data().gems.get(gem_id_for_base_name(name)?)?;
    if drop_vaal && gem.vaal_gem {
        let sec = gem.secondary_granted_effect_id.as_deref()?;
        let other = sorted_gems().iter().find(|(_, g)| g.granted_effect_id.as_deref() == Some(sec))?;
        return other.1.game_id.as_deref();
    }
    gem.game_id.as_deref()
}

/// `calcLib.isGemIdSame(gemName, typeName, true)` (CalcTools.lua:299-303).
pub fn is_gem_id_same(gem_name: &str, type_name: &str) -> bool {
    matches!((game_id_from_gem_name(gem_name, true), game_id_from_gem_name(type_name, true)), (Some(a), Some(b)) if a == b)
}

pub fn extra<'a>(ge: &'a GrantedEffect, key: &str) -> Option<&'a pom_engine::cjson::J> {
    ge.extra.get(key)
}

/// A `{ [key] = true, ... }`-shaped Lua table exported as a flat JSON object of bools.
pub fn json_bool_set(v: Option<&pom_engine::cjson::J>) -> HashSet<String> {
    v.and_then(|v| v.as_object()).map(|o| o.iter().filter(|(_, v)| v.as_bool().unwrap_or(false)).map(|(k, _)| k.to_string()).collect()).unwrap_or_default()
}

/// A `{ [skillTypeId] = true, ... }`-shaped table keyed by numeric `SkillType` id.
pub fn json_int_set(v: Option<&pom_engine::cjson::J>) -> HashSet<i64> {
    v.and_then(|v| v.as_object()).map(|o| o.iter().filter(|(_, v)| v.as_bool().unwrap_or(false)).filter_map(|(k, _)| k.parse::<i64>().ok()).collect()).unwrap_or_default()
}

pub fn is_support(ge: &GrantedEffect) -> bool {
    extra(ge, "support").and_then(|v| v.as_bool()).unwrap_or(false)
}
pub fn is_unsupported(ge: &GrantedEffect) -> bool {
    extra(ge, "unsupported").and_then(|v| v.as_bool()).unwrap_or(false)
}
pub fn cannot_be_supported(ge: &GrantedEffect) -> bool {
    extra(ge, "cannotBeSupported").and_then(|v| v.as_bool()).unwrap_or(false)
}
pub fn support_gems_only(ge: &GrantedEffect) -> bool {
    extra(ge, "supportGemsOnly").and_then(|v| v.as_bool()).unwrap_or(false)
}
pub fn from_item(ge: &GrantedEffect) -> bool {
    extra(ge, "fromItem").and_then(|v| v.as_bool()).unwrap_or(false)
}
pub fn is_trigger(ge: &GrantedEffect) -> bool {
    extra(ge, "isTrigger").and_then(|v| v.as_bool()).unwrap_or(false)
}
pub fn ignore_minion_types(ge: &GrantedEffect) -> bool {
    extra(ge, "ignoreMinionTypes").and_then(|v| v.as_bool()).unwrap_or(false)
}
pub fn has_global_effect(ge: &GrantedEffect) -> bool {
    extra(ge, "hasGlobalEffect").and_then(|v| v.as_bool()).unwrap_or(false)
}
pub fn mod_source(ge: &GrantedEffect) -> Option<&str> {
    extra(ge, "modSource").and_then(|v| v.as_str())
}
pub fn skill_types(ge: &GrantedEffect) -> HashSet<i64> {
    json_int_set(extra(ge, "skillTypes"))
}
pub fn minion_skill_types(ge: &GrantedEffect) -> Option<HashSet<i64>> {
    extra(ge, "minionSkillTypes").map(|_| json_int_set(extra(ge, "minionSkillTypes")))
}
pub fn base_flags(ge: &GrantedEffect) -> HashSet<String> {
    json_bool_set(extra(ge, "baseFlags"))
}
/// `addSkillTypes`: a flat array of `SkillType` ids on a support's `GrantedEffect` - `for _,
/// skillType in pairs(supportEffect.grantedEffect.addSkillTypes) do activeSkill.skillTypes[
/// skillType] = true end` (CalcActiveSkill.lua:117) iterates *values*, unlike `skillTypes` itself
/// (a `{[id]=true}` set) - so this is a different JSON shape (a plain array, not an object).
pub fn add_skill_types(ge: &GrantedEffect) -> HashSet<i64> {
    extra(ge, "addSkillTypes").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_i64()).collect()).unwrap_or_default()
}
/// `addFlags`: `{ [flagName] = true }` on a support's `GrantedEffect` (e.g. Remote Mine's
/// `mine`).
pub fn add_flags(ge: &GrantedEffect) -> HashSet<String> {
    json_bool_set(extra(ge, "addFlags"))
}
/// `excludeSkillTypes`/`requireSkillTypes`: a flat postfix-expression array of `SkillType` ids
/// (or `SkillType.OR`/`.AND`/`.NOT`), evaluated by `calcLib.doesTypeExpressionMatch`.
pub fn skill_type_expr(ge: &GrantedEffect, key: &str) -> Vec<i64> {
    extra(ge, key).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_i64()).collect()).unwrap_or_default()
}
/// `weaponTypes`: `{ [weaponTypeName] = true }`, present on some supports/active skills
/// (Wisps Support, Varunastra-compatible skills, ...).
pub fn weapon_types(ge: &GrantedEffect) -> Option<HashSet<String>> {
    let v = extra(ge, "weaponTypes")?;
    Some(v.as_object().map(|o| o.iter().filter(|(_, v)| v.as_bool().unwrap_or(false)).map(|(k, _)| k.to_string()).collect()).unwrap_or_default())
}
/// `addMinionList`: an array of minion-type strings a support adds (Raise Spectre's supports,
/// etc.) - only used by minion creation, not by this crate's current scope.
pub fn add_minion_list(ge: &GrantedEffect) -> Vec<String> {
    extra(ge, "addMinionList").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()
}
/// `parts`: the multipart-skill definition array (each entry a `{flagName: true/false, ...,
/// name = "..."}` table). Returned as raw JSON since each entry's shape (which flags it flips)
/// varies per skill.
pub fn parts(ge: &GrantedEffect) -> Option<pom_engine::cjson::JArr> {
    extra(ge, "parts").and_then(|v| v.as_array())
}

/// `calcLib.buildSkillInstanceStats` (CalcTools.lua:192-251), narrowed to a single stat name:
/// only the two `SkillStatMap.lua` entries that set `.skillFlag` (`skill_can_fire_arrows` ->
/// `arrow`, `infinite_minion_duration` -> `permanentMinion`) need a stat *value* rather than a
/// full mod build, so this crate never builds the general stat map (`statInterpolation` types 2
/// "linear"/3 "effectiveness" are not modeled - neither of those two stats uses them in the
/// current game data, checked directly: not a bounded promise for any other stat name).
pub fn stat_value(ge: &GrantedEffect, level_num: f64, quality: f64, stat_name: &str) -> f64 {
    let mut total = 0.0;
    if quality > 0.0 {
        for qs in &ge.quality_stats {
            if let Some(arr) = qs.as_array() {
                if arr.first().and_then(|v| v.as_str()) == Some(stat_name) {
                    let mult = arr.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0);
                    total += (mult * quality).trunc();
                }
            }
        }
    }
    let level_idx = level_num.round() as i64;
    let level_data = if level_idx >= 1 && (level_idx as usize) <= ge.levels.len() { Some(&ge.levels[(level_idx - 1) as usize]) } else { None };
    for (i, name) in ge.stats.iter().enumerate() {
        if name != stat_name {
            continue;
        }
        let idx = i + 1;
        let default = level_data.and_then(|l| l.values.get(&idx.to_string())).and_then(|v| v.as_f64()).unwrap_or(1.0);
        total += default;
    }
    if let Some(cs) = ge.extra.get("constantStats").and_then(|v| v.as_array()) {
        for c in cs {
            if let Some(arr) = c.as_array() {
                if arr.first().and_then(|v| v.as_str()) == Some(stat_name) {
                    total += arr.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0);
                }
            }
        }
    }
    total
}

/// `activeGrantedEffect.minionList[1]` truthy (`CalcActiveSkill.lua`:671-706): a skill with a
/// *fixed* minion list (Raise Zombie's `{"RaisedZombie"}`, Summon Raging Spirit's own, etc.) sets
/// `skillFlags.haveMinion = true` unconditionally (`activeSkill.actor.minionData` - the player
/// actor being itself a minion - is never true for this crate's player-only scope). A skill whose
/// `minionList` is present but *empty* (Raise Spectre's `{}`, a marker meaning "use the build's
/// chosen spectre list", `env.build.spectreList` - build-specific UI state this crate doesn't
/// have) or that instead gains a minion only via a support's `addMinionList` (no minion list of
/// its own) isn't covered - bounded gap.
pub fn has_own_minion_list(ge: &GrantedEffect) -> bool {
    extra(ge, "minionList").and_then(|v| v.as_array()).map(|a| !a.is_empty()).unwrap_or(false)
}

/// `SkillStatMap.lua`'s only two `skillFlag`-mapped stat entries (checked exhaustively - see
/// `stat_value`'s doc comment).
pub const STAT_SKILL_FLAGS: [(&str, &str); 2] = [("skill_can_fire_arrows", "arrow"), ("infinite_minion_duration", "permanentMinion")];

/// A `GemLevel`'s numeric field by name (the flattened `values` map: `manaMultiplier`,
/// `manaReservationPercent`, `damageMultiplier`, `attackTime`, `attackSpeedMultiplier`,
/// `cooldown`, `storedUses`, `vaalStoredUses`, `soulPreventionDuration`, `PvPDamageMultiplier`,
/// `levelRequirement` (also typed directly on `GemLevel`)).
pub fn level_num(level: &pom_engine::data::gems::GemLevel, key: &str) -> Option<f64> {
    level.values.get(key).and_then(|v| v.as_f64())
}

/// `data.weaponTypeInfo[weaponType]`: `.flag` (a `ModFlag` name, e.g. `"Bow"`/`"Claw"`/
/// `"Unarmed"`), `.melee` (bool), `.oneHand` (bool). `weaponType` is `"None"` for unarmed.
pub struct WeaponTypeInfo {
    pub flag: String,
    pub melee: bool,
    pub one_hand: bool,
}

pub fn weapon_type_info(weapon_type: &str) -> Option<WeaponTypeInfo> {
    static IDX: OnceLock<HashMap<String, WeaponTypeInfoRaw>> = OnceLock::new();
    struct WeaponTypeInfoRaw {
        flag: String,
        melee: bool,
        one_hand: bool,
    }
    let idx = IDX.get_or_init(|| {
        let v = game_data().extra.get("weaponTypeInfo").expect("weaponTypeInfo section missing").expect("weaponTypeInfo section failed to parse");
        let mut m = HashMap::default();
        if let Some(obj) = v.as_object() {
            for (k, info) in obj {
                let flag = info.get("flag").and_then(|f| f.as_str()).unwrap_or("").to_string();
                let melee = info.get("melee").and_then(|f| f.as_bool()).unwrap_or(false);
                let one_hand = info.get("oneHand").and_then(|f| f.as_bool()).unwrap_or(false);
                m.insert(k.to_string(), WeaponTypeInfoRaw { flag, melee, one_hand });
            }
        }
        m
    });
    idx.get(weapon_type).map(|r| WeaponTypeInfo { flag: r.flag.clone(), melee: r.melee, one_hand: r.one_hand })
}

/// `data.misc.MatchingSocketQualityBonus`.
pub fn matching_socket_quality_bonus() -> f64 {
    game_data().misc.get("MatchingSocketQualityBonus").unwrap_or(0.0)
}

/// One `ExtraSupport` mod an item carries (`Modules/CalcSetup.lua`'s `addExtraSupports`, lines
/// 1628-1651): a support gem the item grants to whatever's socketed in wherever it's equipped
/// (e.g. a Shield's "Trigger a Socketed Elemental Spell on Block" affix). `skill_id` is the
/// mod value's own `skillId` field (`Support...`-prefixed support ids like
/// `SupportTriggerElementalSpellOnBlock` resolve directly; a bare skill id needing the
/// `"Support"..id` fallback - lines 1633-1635 - isn't hit by any sample build, not implemented).
#[derive(Debug, Clone)]
pub struct ExtraSupport {
    pub skill_id: String,
    /// The mod value's own `level` field (`Modules/CalcSetup.lua`'s `addExtraSupports`: `level =
    /// level or value.level`). Defaults to 20 (a reasonable max-ish gem level) when the recorded
    /// mod value carries none - not observed in the sample corpus, not a faithful port of the
    /// `nil` case (which would leave the support gem's own level lookup `nil` in upstream,
    /// eventually erroring/defaulting inside `calcLib.validateGemLevel`).
    pub level: f64,
}

/// Per-build `{itemId: [ExtraSupport, ...]}`, read from the item crate's recording
/// (`engine-data/item_golden/corpus/<build>.jsonl`'s `explicitModLines`/`implicitModLines`/
/// `enchantModLines`/`crucibleModLines`, each entry's own `modList` - matching every mod-line
/// source `items.rs` combines, not just explicit mods). `Modules/CalcSetup.lua` reads these
/// through `env.modDB:List(groupCfg, "ExtraSupport")`, a query across the *whole* modDB filtered
/// by the mod's `SocketedIn` tag matching `groupCfg.slotName`; that tag's `slotName` value is
/// always the literal template string `{SlotName}` in this game data (resolved by upstream at
/// mod-parse time to wherever the item itself ends up equipped), so this crate's simpler
/// direct-lookup ("read the item actually equipped in this group's own slot") reproduces the same
/// result for the common (non-cross-linked, non-imbued) case.
#[derive(Debug)]
pub struct ItemExtraSupports(HashMap<i64, Vec<ExtraSupport>>, HashMap<i64, Vec<String>>, HashMap<String, Vec<ExtraSupport>>);

impl ItemExtraSupports {
    pub fn load(build_name: &str) -> ItemExtraSupports {
        let path = engine_data_dir().join("item_golden").join("corpus").join(format!("{build_name}.jsonl"));
        let mut m: HashMap<i64, Vec<ExtraSupport>> = HashMap::default();
        if let Ok(text) = std::fs::read_to_string(&path) {
            for line in text.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let Some(item_id) = v.get("itemId").and_then(|x| x.as_i64()) else { continue };
                let mut out = Vec::new();
                for key in ["explicitModLines", "implicitModLines", "enchantModLines", "crucibleModLines"] {
                    let lines = match v.get(key) {
                        Some(serde_json::Value::Array(a)) => a.clone(),
                        Some(serde_json::Value::Object(o)) => o.values().cloned().collect(),
                        _ => continue,
                    };
                    for mod_line in &lines {
                        let Some(mod_list) = mod_line.get("modList").and_then(|m| m.as_array()) else { continue };
                        for m in mod_list {
                            if m.get("name").and_then(|n| n.as_str()) != Some("ExtraSupport") {
                                continue;
                            }
                            if let Some(skill_id) = m.get("value").and_then(|v| v.get("skillId")).and_then(|s| s.as_str()) {
                                let level = m.get("value").and_then(|v| v.get("level")).and_then(|l| l.as_f64()).unwrap_or(20.0);
                                out.push(ExtraSupport { skill_id: skill_id.to_string(), level });
                            }
                        }
                    }
                }
                // A real crafted/rolled item carries a handful of these mods at most (this
                // corpus's max legitimate case: 2, an item with both an explicit and an implicit
                // ExtraSupport). An item exposing dozens ("Great Crown", whose corrupted-implicit
                // mod text apparently enumerates *every* support gem in the game rather than the
                // one actually rolled - a genuine oddity in this recording, not a real in-game
                // state) can't be disambiguated to the one real support without more item-crate
                // context than this crate has; skip it entirely rather than feeding
                // `create_active_skill` a flood of mostly-incompatible-but-not-always supports
                // that measurably produces wrong output (confirmed: Great Crown's list wrongly
                // added `mine`/`trap`/`totem` to an unrelated spell).
                if !out.is_empty() && out.len() <= 5 {
                    m.insert(item_id, out);
                }
            }
        }
        ItemExtraSupports(m, HashMap::default(), HashMap::default())
    }

    /// `env.crossLinkedSupportGroups` (CalcSetup.lua:1594-1598): `(source slot, target slot)` for every
    /// equipped item carrying a `LinkedSupport` mod ("Socketed support gems can also support skills from your ...").
    pub fn linked_supports(&self, item_slots: &HashMap<String, i64>) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for (slot, id) in item_slots {
            for t in self.1.get(id).map(|v| v.as_slice()).unwrap_or(&[]) {
                out.push((slot.clone(), t.clone()));
            }
        }
        out.sort();
        out
    }

    /// `env.modDB:List(groupCfg, "ExtraSupport")` for a group in `slot_name`: the `SocketedIn` tag's slot decides
    /// ("Skills Socketed in your Helmet are Supported by ..." on a ring applies to the Helmet's groups); mods
    /// without the tag come from the item equipped in that slot.
    pub fn for_slot(&self, item_slots: &HashMap<String, i64>, slot_name: &str) -> Vec<ExtraSupport> {
        let mut out: Vec<ExtraSupport> = item_slots.get(slot_name).and_then(|id| self.0.get(id)).cloned().unwrap_or_default();
        if let Some(v) = self.2.get(slot_name) {
            out.extend(v.iter().cloned());
        }
        // Untagged `ExtraSupport` mods from allocated passive nodes apply to every group (`env.modDB:List(groupCfg, ...)`).
        if let Some(v) = self.2.get("*") {
            out.extend(v.iter().cloned());
        }
        out
    }

    /// `ExtraSupport` mods carried by allocated passive nodes (e.g. Chieftain's Tukohama, War's Herald: "Skills Socketed in your
    /// Body Armour are Supported by ..."); they sit in `env.modDB` next to the items' and match a group by `SocketedIn` slot.
    pub fn add_tree_mods(&mut self, mods: &[pom_engine::modifier::Mod]) {
        for mo in mods {
            if mo.name.as_str() != "ExtraSupport" {
                continue;
            }
            let pom_engine::value::Value::Str(skill_id) = mo.value.get(pom_engine::sym!("skillId")) else { continue };
            let level = if let pom_engine::value::Value::Num(n) = mo.value.get(pom_engine::sym!("level")) { *n } else { 20.0 };
            let tagged_slot = mo.tags.iter().filter(|t| t.kind.as_str() == "SocketedIn").find_map(|t| if let pom_engine::value::Value::Str(sl) = t.get(pom_engine::sym!("slotName")) { Some(sl.to_string()) } else { None });
            self.2.entry(tagged_slot.unwrap_or_else(|| "*".to_string())).or_default().push(ExtraSupport { skill_id: skill_id.to_string(), level });
        }
    }

    /// The live equivalent of `load` for a caller with a real, already-built item `ModStore`/mod
    /// list per item (`pom-pipeline`'s `build_env`, which already runs `pom_item::buildmod::
    /// build_mod_lists` on every equipped item) - reads `ExtraSupport` mods straight off each
    /// item's own resolved `Mod` list instead of re-parsing the item crate's JSONL recording. Same
    /// field shape as `Modules/CalcSetup.lua`'s `ExtraSupport` mod value (`{skillId=...}`).
    pub fn from_live(items: &HashMap<i64, Vec<pom_engine::modifier::Mod>>, order: &[i64]) -> ItemExtraSupports {
        let mut m: HashMap<i64, Vec<ExtraSupport>> = HashMap::default();
        let mut linked: HashMap<i64, Vec<String>> = HashMap::default();
        let mut by_slot: HashMap<String, Vec<ExtraSupport>> = HashMap::default();
        for (item_id, mods) in order.iter().filter_map(|id| items.get(id).map(|m| (*id, m))) {
            let mut out = Vec::new();
            for mo in mods {
                if mo.name.as_str() == "LinkedSupport" {
                    if let pom_engine::value::Value::Str(t) = mo.value.get(pom_engine::sym!("targetSlotName")) {
                        linked.entry(item_id).or_default().push(t.to_string());
                    }
                }
                if mo.name.as_str() != "ExtraSupport" {
                    continue;
                }
                if let pom_engine::value::Value::Str(skill_id) = mo.value.get(pom_engine::sym!("skillId")) {
                    let level = if let pom_engine::value::Value::Num(n) = mo.value.get(pom_engine::sym!("level")) { *n } else { 20.0 };
                    let tagged_slot = mo.tags.iter().filter(|t| t.kind.as_str() == "SocketedIn").find_map(|t| if let pom_engine::value::Value::Str(sl) = t.get(pom_engine::sym!("slotName")) { Some(sl.to_string()) } else { None });
                    match tagged_slot {
                        Some(sl) if !sl.contains('{') => by_slot.entry(sl).or_default().push(ExtraSupport { skill_id: skill_id.to_string(), level }),
                        _ => out.push(ExtraSupport { skill_id: skill_id.to_string(), level }),
                    }
                }
            }
            if !out.is_empty() {
                m.insert(item_id, out);
            }
        }
        ItemExtraSupports(m, linked, by_slot)
    }
}

/// One `ExtraSkill` mod an item carries (`Modules/CalcSetup.lua`'s dynamic synthetic-socket-group
/// creation, lines 1464-1505; the mod itself is read from `item.grantedSkills`,
/// `Classes/Item.lua`:2627-2639's `for _, skill in ipairs(baseList:List(nil, "ExtraSkill")) do`).
/// `source` is the mod's own `source` string (`item.modSource`, e.g. `"Item:4:Maligaro's
/// Virtuosity, Deerskin Gloves"`), used as the synthetic group's `source`/join key exactly like a
/// real gem-socketed group's `source` attribute (see `xmlskills.rs`'s `load_gem` doc comment for
/// why a `source`-carrying group's gem always resolves bare, never through a real `GemData`).
#[derive(Debug)]
pub struct GrantedSkillMod {
    pub skill_id: String,
    pub level: f64,
    pub no_supports: bool,
    pub triggered: bool,
    pub source: String,
    /// `triggerChance` of the `ExtraSkill` value ("10% chance to Trigger ..."): the gem instance's `triggerChance`.
    pub trigger_chance: Option<f64>,
}

/// Per-build `{itemId: [GrantedSkillMod, ...]}`, read from the item crate's recording the same way
/// `ItemExtraSupports` reads `ExtraSupport` mods (see its doc comment for the mod-line-source
/// list). Unlike `ExtraSupport` (queried by the *group's own slot*), an `ExtraSkill` mod's synthetic
/// group is keyed by *both* the granting item's equip slot and the mod's own `source` string
/// (`Modules/CalcSetup.lua`:1470's `socketGroup.source == grantedSkill.source and socketGroup.slot
/// == grantedSkill.slotName`) - `for_slot_item` returns every `ExtraSkill` mod the item equipped
/// at a given slot carries, so the caller can build one synthetic group per mod.
#[derive(Debug)]
pub struct ItemGrantedSkills(HashMap<i64, Vec<GrantedSkillMod>>, Vec<GrantedSkillMod>, HashMap<String, i64>);

impl ItemGrantedSkills {
    pub fn load(build_name: &str) -> ItemGrantedSkills {
        let path = engine_data_dir().join("item_golden").join("corpus").join(format!("{build_name}.jsonl"));
        let mut m: HashMap<i64, Vec<GrantedSkillMod>> = HashMap::default();
        if let Ok(text) = std::fs::read_to_string(&path) {
            for line in text.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let Some(item_id) = v.get("itemId").and_then(|x| x.as_i64()) else { continue };
                let mut out = Vec::new();
                for key in ["explicitModLines", "implicitModLines", "enchantModLines", "crucibleModLines"] {
                    let lines = match v.get(key) {
                        Some(serde_json::Value::Array(a)) => a.clone(),
                        Some(serde_json::Value::Object(o)) => o.values().cloned().collect(),
                        _ => continue,
                    };
                    for mod_line in &lines {
                        let Some(mod_list) = mod_line.get("modList").and_then(|m| m.as_array()) else { continue };
                        for m in mod_list {
                            if m.get("name").and_then(|n| n.as_str()) != Some("ExtraSkill") {
                                continue;
                            }
                            let Some(value) = m.get("value") else { continue };
                            let Some(skill_id) = value.get("skillId").and_then(|s| s.as_str()) else { continue };
                            let Some(source) = m.get("source").and_then(|s| s.as_str()) else { continue };
                            let level = value.get("level").and_then(|v| v.as_f64()).unwrap_or(1.0);
                            let no_supports = value.get("noSupports").and_then(|v| v.as_bool()).unwrap_or(false);
                            let triggered = value.get("triggered").and_then(|v| v.as_bool()).unwrap_or(false);
                            let trigger_chance = value.get("triggerChance").and_then(|v| v.as_f64());
                            out.push(GrantedSkillMod { skill_id: skill_id.to_string(), level, no_supports, triggered, source: source.to_string(), trigger_chance });
                        }
                    }
                }
                if !out.is_empty() {
                    m.insert(item_id, out);
                }
            }
        }
        ItemGrantedSkills(m, Vec::new(), HashMap::default())
    }

    /// `(skillId, level)` of every triggered `ExtraSkill` mod: `SkillsTab:ProcessSocketGroup`
    /// (SkillsTab.lua:1188-1192) empties `grantedEffect.levels[level].cost` on the shared skill data for these.
    pub fn triggered_levels(&self) -> Vec<(String, i64)> {
        self.0.values().flatten().filter(|g| g.triggered).map(|g| (g.skill_id.clone(), g.level.round() as i64)).collect()
    }

    /// `(source, skillId)` of every triggered `ExtraSkill` grant (items and tree): the granted gem instance's
    /// `triggered` flag (CalcSetup.lua:1500), read by `isTriggered` through `srcInstance.triggered`.
    pub fn triggered_pairs(&self) -> Vec<(String, String)> {
        self.0.values().flatten().chain(self.1.iter()).filter(|g| g.triggered).map(|g| (g.source.clone(), g.skill_id.clone())).collect()
    }

    /// `(source, skillId, triggerChance)` of every `ExtraSkill` grant that carries a trigger chance: the gem instance's `triggerChance`
    /// (CalcSetup.lua:1501), read by `calcs.triggers` as `srcInstance.triggerChance`.
    pub fn trigger_chances(&self) -> Vec<(String, String, f64)> {
        self.0.values().flatten().chain(self.1.iter()).filter_map(|g| g.trigger_chance.map(|c| (g.source.clone(), g.skill_id.clone(), c))).collect()
    }

    /// Every `ExtraSkill` mod the item equipped at `slot_name` carries, or `&[]` if none/no item
    /// there.
    pub fn for_slot<'a>(&'a self, item_slots: &HashMap<String, i64>, slot_name: &str) -> &'a [GrantedSkillMod] {
        // The slots kept under their own names (`with_inactive_slots`) come first: with weapon set II on, the active set's
        // "Weapon 1 Swap" is renamed "Weapon 1" in `item_slots`, but CalcSetup.lua:826-835 names the grant's slot by the
        // slot's own name and the item in set I's "Weapon 1" still grants its skill there.
        self.2.get(slot_name).or_else(|| item_slots.get(slot_name)).and_then(|id| self.0.get(id)).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Items in the weapon-set slots whose own name differs from the one the active set merges them under (the inactive set's
    /// slots, and the active second set's " Swap" slots) and socketed jewels: CalcSetup.lua:826-835 collects their granted
    /// skills by the slot's own name before the weapon-set check skips their mods and renames the swap slots.
    pub fn with_inactive_slots(mut self, slots: HashMap<String, i64>) -> ItemGrantedSkills {
        self.2 = slots;
        self
    }

    pub fn inactive_slot_names(&self) -> Vec<&String> {
        self.2.keys().collect()
    }

    /// The live equivalent of `load` - see `ItemExtraSupports::from_live`'s doc comment.
    pub fn from_live(items: &HashMap<i64, Vec<pom_engine::modifier::Mod>>, order: &[i64]) -> ItemGrantedSkills {
        let mut m: HashMap<i64, Vec<GrantedSkillMod>> = HashMap::default();
        for (item_id, mods) in order.iter().filter_map(|id| items.get(id).map(|m| (*id, m))) {
            let mut out = Vec::new();
            for mo in mods {
                if mo.name.as_str() != "ExtraSkill" {
                    continue;
                }
                let pom_engine::value::Value::Str(skill_id) = mo.value.get(pom_engine::sym!("skillId")) else { continue };
                let Some(source) = mo.source.as_deref() else { continue };
                let level = if let pom_engine::value::Value::Num(n) = mo.value.get(pom_engine::sym!("level")) { *n } else { 1.0 };
                let no_supports = matches!(mo.value.get(pom_engine::sym!("noSupports")), pom_engine::value::Value::Bool(true));
                let triggered = matches!(mo.value.get(pom_engine::sym!("triggered")), pom_engine::value::Value::Bool(true));
                let trigger_chance = if let pom_engine::value::Value::Num(n) = mo.value.get(pom_engine::sym!("triggerChance")) { Some(*n) } else { None };
                out.push(GrantedSkillMod { skill_id: skill_id.to_string(), level, no_supports, triggered, source: source.to_string(), trigger_chance });
            }
            if !out.is_empty() {
                m.insert(item_id, out);
            }
        }
        ItemGrantedSkills(m, Vec::new(), HashMap::default())
    }

    /// `env.grantedSkillsNodes` (CalcSetup.lua:1437-1445): skills granted by allocated tree nodes, `source` `Tree:<id>`.
    pub fn with_tree(mut self, tree: Vec<GrantedSkillMod>) -> ItemGrantedSkills {
        self.1 = tree;
        self
    }

    pub fn tree(&self) -> &[GrantedSkillMod] {
        &self.1
    }
}

/// Per-build `{itemId}` set of equipped items whose `baseModList` carries a `CanExplode` flag mod
/// (`Modules/CalcSetup.lua`:837-839's `if item and item.baseModList and
/// item.baseModList:Flag(nil, "CanExplode") then t_insert(env.explodeSources, item) end`, read
/// from the item crate's recording the same way `ItemExtraSupports`/`ItemGrantedSkills` read their
/// own mod names). This is the item half only of `env.explodeSources` - the tree half
/// (`calcs.buildModListForNode`'s own `CanExplode` check on allocated-node mods, returning the
/// node itself as a source) needs the passives crate's allocated-node data, out of this crate's
/// scope - see `assemble.rs`'s `build_explode_group`.
/// `build.itemsTab.orderedSlots` rank of a slot name (baseSlots order; anything else after, by name).
fn slot_rank(name: &str) -> (usize, String) {
    const BASE: [&str; 18] = ["Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt", "Graft 1", "Graft 2", "Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5"];
    (BASE.iter().position(|b| *b == name).unwrap_or(BASE.len()), name.to_string())
}

#[derive(Debug)]
pub struct ItemCanExplode(HashSet<i64>, pub usize, HashMap<i64, String>, Vec<String>, HashMap<String, i64>);

impl ItemCanExplode {
    pub fn load(build_name: &str) -> ItemCanExplode {
        let path = engine_data_dir().join("item_golden").join("corpus").join(format!("{build_name}.jsonl"));
        let mut set = HashSet::default();
        if let Ok(text) = std::fs::read_to_string(&path) {
            for line in text.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let Some(item_id) = v.get("itemId").and_then(|x| x.as_i64()) else { continue };
                for key in ["explicitModLines", "implicitModLines", "enchantModLines", "crucibleModLines"] {
                    let lines = match v.get(key) {
                        Some(serde_json::Value::Array(a)) => a.clone(),
                        Some(serde_json::Value::Object(o)) => o.values().cloned().collect(),
                        _ => continue,
                    };
                    for mod_line in &lines {
                        let Some(mod_list) = mod_line.get("modList").and_then(|m| m.as_array()) else { continue };
                        for m in mod_list {
                            if m.get("name").and_then(|n| n.as_str()) == Some("CanExplode") && m.get("value").and_then(|v| v.as_bool()).unwrap_or(false) {
                                set.insert(item_id);
                            }
                        }
                    }
                }
            }
        }
        ItemCanExplode(set, 0, HashMap::default(), Vec::new(), HashMap::default())
    }

    /// Slots `env.explodeSources` still counts although the item is not in the active set (inactive weapon set,
    /// socketed tree jewels): CalcSetup.lua:838 runs before the weapon-set skip.
    pub fn with_inactive_slots(mut self, slots: &HashMap<String, i64>) -> Self {
        self.4 = slots.clone();
        self
    }

    /// Allocated tree nodes whose mods carry `CanExplode` (`calcs.buildModListForNode`'s explode source, which
    /// `env.explodeSources` lists ahead of the items').
    pub fn with_tree_sources(mut self, n: usize) -> Self {
        self.1 = n;
        self
    }

    /// The `modSource` strings of the tree explode sources (`"Tree:<id>"`), in `env.explodeSources` order.
    pub fn with_tree_source_names(mut self, names: Vec<String>) -> Self {
        self.1 = names.len();
        self.3 = names;
        self
    }

    /// `explodeSource.modSource or "Tree:"..explodeSource.id` for each `slot_occurrences` entry (same order).
    pub fn slot_sources(&self, item_slots: &HashMap<String, i64>) -> Vec<Option<String>> {
        let mut items: Vec<(&String, &i64)> = item_slots.iter().chain(self.4.iter()).filter(|(_, id)| self.0.contains(id)).collect();
        items.sort_by_key(|a| slot_rank(a.0));
        let mut all: Vec<Option<String>> = (0..self.1).map(|i| self.3.get(i).cloned()).collect();
        all.extend(items.into_iter().map(|(_, id)| self.2.get(id).cloned()));
        all
    }

    /// Every equipped-slot occurrence of an exploding item, one entry per slot the item is
    /// equipped in (`build.itemsTab.orderedSlots`'s per-*slot* iteration - the same item equipped
    /// in two slots, e.g. matching rings, contributes an explode source twice).
    pub fn slot_occurrences(&self, item_slots: &HashMap<String, i64>) -> Vec<String> {
        let mut out: Vec<String> = item_slots.iter().chain(self.4.iter()).filter(|(_, id)| self.0.contains(id)).map(|(slot, _)| slot.clone()).collect();
        out.sort_by_key(|s| slot_rank(s));
        let mut all: Vec<String> = std::iter::repeat("Tree".to_string()).take(self.1).collect();
        all.extend(out);
        all
    }

    /// The live equivalent of `load` - see `ItemExtraSupports::from_live`'s doc comment.
    pub fn from_live(items: &HashMap<i64, Vec<pom_engine::modifier::Mod>>, order: &[i64]) -> ItemCanExplode {
        let mut set = HashSet::default();
        let mut srcs = HashMap::default();
        for (item_id, mods) in order.iter().filter_map(|id| items.get(id).map(|m| (*id, m))) {
            for mo in mods {
                if mo.name.as_str() == "CanExplode" && matches!(mo.value, pom_engine::value::Value::Bool(true)) {
                    set.insert(item_id);
                    if let Some(src) = &mo.source {
                        srcs.entry(item_id).or_insert_with(|| src.to_string());
                    }
                }
            }
        }
        ItemCanExplode(set, 0, srcs, Vec::new(), HashMap::default())
    }
}

/// Per-build equipped-item `type` strings (`"Bow"`, `"One Handed Sword"`, `"Wand"`, `"Shield"`,
/// ...), read from the item crate's own recording (`engine-data/item_golden/corpus/<build>.jsonl`)
/// rather than re-parsing the build's `<Items>` XML: that recording already carries each item's
/// resolved base `type` per `itemId`, matching `build.itemsTab.items[id].type`
/// (`weaponData.type`'s source for a real equipped weapon).
#[derive(Debug)]
pub struct BuildItemTypes(HashMap<i64, String>, bool, Option<String>, HashMap<String, bool>);

impl BuildItemTypes {
    pub fn load(build_name: &str) -> BuildItemTypes {
        let path = engine_data_dir().join("item_golden").join("corpus").join(format!("{build_name}.jsonl"));
        let mut m = HashMap::default();
        if let Ok(text) = std::fs::read_to_string(&path) {
            for line in text.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let Some(item_id) = v.get("itemId").and_then(|x| x.as_i64()) else { continue };
                if let Some(ty) = v.get("type").and_then(|t| t.as_str()) {
                    m.insert(item_id, ty.to_string());
                }
            }
        }
        BuildItemTypes(m, false, None, HashMap::default())
    }

    /// The equipped item's own raw `type` string at `slot_name`, with no weapon-type filtering -
    /// `activeSkill.actor.itemList[slotName].type` (`RequiresShield`/`RequiresStaff`'s equip
    /// check, e.g. `itemList["Weapon 2"].type == "Shield"`), which reads the item directly, not
    /// through `weaponData`.
    pub fn item_type_for_slot(&self, item_slots: &HashMap<String, i64>, slot_name: &str) -> Option<&str> {
        item_slots.get(slot_name).and_then(|id| self.0.get(id)).map(|s| s.as_str())
    }

    /// `weaponData1.type`: the equipped Weapon 1 item's own `type` when it's a real weapon type
    /// (a key `weaponTypeInfo` recognizes), or `"None"` (unarmed) otherwise - `CalcSetup.lua`
    /// line 1566's `... or copyTable(env.data.unarmedWeaponData[env.classId])` fallback, whose
    /// own `type` field is `"None"`.
    pub fn weapon1_type(&self, item_slots: &HashMap<String, i64>, weapon_type_info: impl Fn(&str) -> bool) -> String {
        item_slots.get("Weapon 1").and_then(|id| self.0.get(id)).filter(|ty| weapon_type_info(ty)).cloned().unwrap_or_else(|| "None".to_string())
    }

    /// `weaponData2.type`: **not** the same fallback as `weaponData1` - `CalcSetup.lua` lines
    /// 1567-1580 only ever populates `weaponData2` from a real weapon item's own `weaponData[2]`
    /// entry (dual-wielding-capable Weapon 1, or a genuine weapon socketed in "Weapon 2"); with
    /// nothing there (including a *non-weapon* item like a Shield or Quiver, which has no
    /// `weaponData` at all) it's `env.player.weaponData2 = {}` - a table with **no** `type` key,
    /// not `"None"`. `getWeaponFlags`'s `env.data.weaponTypeInfo[weaponData.type]` lookup on `nil`
    /// then returns `nil` outright (`weaponTypeInfo[nil]` isn't `weaponTypeInfo["None"]`), so a
    /// skill's weapon-2 compatibility check never rejects on an empty off hand - unlike passing
    /// `"None"` through, which `weaponTypeInfo` *does* have a real (`Unarmed`) entry for and would
    /// wrongly participate in a `weaponTypes` restriction check. `None` here reproduces the "no
    /// type at all" case; `countsAsDualWielding` weapons (a 1H weapon usable two-handed, e.g. some
    /// dual-purpose staves) aren't modeled.
    pub fn weapon2_type(&self, item_slots: &HashMap<String, i64>, weapon_type_info: impl Fn(&str) -> bool) -> Option<String> {
        // CalcSetup.lua:1567-1568: a `countsAsDualWielding` Weapon 1 supplies `weaponData[2]` as the off hand.
        if let Some(t) = &self.2 {
            return Some(t.clone());
        }
        // CalcSetup.lua:1570-1577: Hollow Palm Technique with no Weapon 1, Weapon 2 or Gloves gives an unarmed off hand.
        if self.1 && !item_slots.contains_key("Weapon 1") && !item_slots.contains_key("Weapon 2") && !item_slots.contains_key("Gloves") {
            return Some("None".to_string());
        }
        item_slots.get("Weapon 2").and_then(|id| self.0.get(id)).filter(|ty| weapon_type_info(ty)).cloned()
    }

    /// The off-hand `type` supplied by a `countsAsDualWielding` Weapon 1 (`weaponData[2].type`), if any.
    pub fn with_dual_wield_offhand(mut self, ty: Option<String>) -> Self {
        self.2 = ty;
        self
    }

    /// Marks the build as having the Hollow Palm Technique keystone (see `weapon2_type`).
    pub fn with_hollow_palm(mut self, on: bool) -> Self {
        self.1 = on;
        self
    }

    /// The live equivalent of `load` - see `ItemExtraSupports::from_live`'s doc comment. `types` is
    /// `itemId -> pom_item::Item::item_type` for every equipped item (`build_env` already parses
    /// this).
    pub fn from_live(types: &HashMap<i64, String>) -> BuildItemTypes {
        BuildItemTypes(types.clone(), false, None, HashMap::default())
    }

    /// `weaponData.countsAsAll1H` per weapon slot (Varunastra): set from the equipped items' `weaponData`.
    pub fn with_counts_as_all_1h(mut self, flags: HashMap<String, bool>) -> BuildItemTypes {
        self.3 = flags;
        self
    }

    pub fn counts_as_all_1h(&self, slot_name: &str) -> bool {
        self.3.get(slot_name).copied().unwrap_or(false)
    }
}


/// `data.gemForBaseName` (lowercase gem name -> gem id).
fn gem_for_base_name_map() -> &'static HashMap<String, String> {
    static G: OnceLock<HashMap<String, String>> = OnceLock::new();
    G.get_or_init(|| {
        let v = game_data().extra.get("gemForBaseName").ok().flatten().map(|j| j.to_value()).unwrap_or(serde_json::Value::Null);
        serde_json::from_value(v).unwrap_or_default()
    })
}

/// `data.gems[data.gemForBaseName[<imbued name>:lower() .. " support"]]` (SkillsTab.lua:1468).
pub fn imbued_support_gem(name: &str) -> Option<&'static GemData> {
    let id = gem_for_base_name_map().get(&format!("{} support", name).to_lowercase())?;
    game_data().gems.get(id)
}
