//! Port of the base-case (no supports) part of Modules/CalcActiveSkill.lua's
//! `calcs.createActiveSkill` (lines 83-108): `skillTypes`/`skillFlags` straight off the gem's own
//! `GrantedEffect`, plus the one derived flag (`hit`) that doesn't come from a support. The
//! support-processing loop (lines 109-161: `calcLib.canGrantedEffectSupportActiveSkill`,
//! `addSkillTypes`/`addFlags`) is not ported. Everything past `skillTypes`/
//! `skillFlags` (`skillCfg`, `skillModList`, `buildActiveSkillModList`) is also not ported.
use crate::data::{game_data, weapon_is_melee};
use pom_engine::data::gems::GrantedEffect;
use pom_engine::fxhash::{HashMap, HashSet};
use std::sync::OnceLock;

/// `SkillType.Attack`/`.Projectile`/`.Damage` (Data/Global.lua): the three types `hit` derives
/// from.
const SKILL_TYPE_ATTACK: i64 = 1;
const SKILL_TYPE_PROJECTILE: i64 = 3;
const SKILL_TYPE_DAMAGE: i64 = 7;

/// `grantedEffect.id` -> `&'static GrantedEffect`, built once from every gem's primary and
/// secondary granted effect (`data_gems.json`). A skill's `activeEffect.grantedEffect` is looked
/// up by this id, not by the owning gem's id (a gem's own id and its granted effect's id differ,
/// e.g. gem `Metadata/Items/Gems/SkillGemAbsolution` grants effect id `"Absolution"`).
fn granted_effect_index() -> &'static HashMap<String, &'static GrantedEffect> {
    static IDX: OnceLock<HashMap<String, &'static GrantedEffect>> = OnceLock::new();
    IDX.get_or_init(|| {
        let mut m = HashMap::default();
        for gem in game_data().gems.values() {
            if let Some(ge) = &gem.granted_effect {
                if let Some(id) = &ge.id {
                    m.insert(id.clone(), ge);
                }
            }
            if let Some(ge) = &gem.secondary_granted_effect {
                if let Some(id) = &ge.id {
                    m.insert(id.clone(), ge);
                }
            }
        }
        m
    })
}

/// `data.skills` (`data_skills.json`): every granted effect by id, including item-only ones no gem
/// grants (Envy from Aul's Uprising etc.), which `granted_effect_index` (gems only) never sees.
fn all_skills() -> &'static HashMap<String, GrantedEffect> {
    static SKILLS: OnceLock<HashMap<String, GrantedEffect>> = OnceLock::new();
    SKILLS.get_or_init(|| pom_engine::cjson::from_j(raw_skills()).unwrap_or_default())
}

pub fn granted_effect_by_id(id: &str) -> Option<&'static GrantedEffect> {
    granted_effect_index().get(id).copied().or_else(|| all_skills().get(id))
}

fn json_set_i64(v: Option<&pom_engine::cjson::J>) -> HashSet<i64> {
    v.and_then(|v| v.as_object()).map(|o| o.keys().filter_map(|k| k.parse::<i64>().ok()).collect()).unwrap_or_default()
}
fn json_set_str(v: Option<&pom_engine::cjson::J>) -> HashMap<String, bool> {
    v.and_then(|v| v.as_object())
        .map(|o| o.iter().filter_map(|(k, v)| v.as_bool().map(|b| (k.to_string(), b))).collect())
        .unwrap_or_default()
}

/// `activeSkill.skillTypes = copyTable(activeGrantedEffect.skillTypes)`.
pub fn base_skill_types(ge: &GrantedEffect) -> HashSet<i64> {
    json_set_i64(ge.extra.get("skillTypes"))
}

/// `skillFlags = copyTable(activeGrantedEffect.baseFlags); skillFlags.hit = skillFlags.hit or
/// skillTypes[Attack] or skillTypes[Damage] or skillTypes[Projectile]`.
pub fn base_skill_flags(ge: &GrantedEffect, skill_types: &HashSet<i64>) -> HashMap<String, bool> {
    let mut flags = json_set_str(ge.extra.get("baseFlags"));
    let hit = flags.get("hit").copied().unwrap_or(false)
        || skill_types.contains(&SKILL_TYPE_ATTACK)
        || skill_types.contains(&SKILL_TYPE_DAMAGE)
        || skill_types.contains(&SKILL_TYPE_PROJECTILE);
    if hit {
        flags.insert("hit".to_string(), true);
    }
    flags
}

/// The main-hand-weapon part of `buildActiveSkillModList`'s weapon flag resolution
/// (CalcActiveSkill.lua:283-291, via `getWeaponFlags` at lines 194-226): a skill whose base flags
/// carry both `melee` and `projectile` (Frenzy, Cyclone, Wild Strike, Elemental Hit, ...) gets
/// pruned to whichever one the actual equipped Weapon 1 resolves to, but only for an `attack`
/// (`skillFlags.attack` or `.dotFromAttack`) skill. Not ported: `weaponTypes` compatibility
/// filtering (a skill/support restricted to specific weapon types, which can leave `weapon1Flags`
/// nil and skip this branch entirely), `shieldAttack`/`forceOffHand`/`forceMainHand` special
/// cases, Weapon 2 (off hand only ever sets `weapon2Attack`, never touches `melee`/`projectile`),
/// and the minion "ignore weapon types" fallback. Those are all `skillFlags.disable`/off-path
/// cases for the ordinary one-or-two-melee-or-ranged-weapon skills this covers.
pub fn apply_weapon1_flags(flags: &mut HashMap<String, bool>, weapon1_type: Option<&str>) {
    let is_attack = flags.get("attack").copied().unwrap_or(false) || flags.get("dotFromAttack").copied().unwrap_or(false);
    if !is_attack {
        return;
    }
    let melee = weapon_is_melee(weapon1_type);
    let has_melee = flags.get("melee").copied().unwrap_or(false);
    let has_projectile = flags.get("projectile").copied().unwrap_or(false);
    if melee && has_melee {
        flags.remove("projectile");
    } else if !melee && has_projectile {
        flags.remove("melee");
    }
}

/// `data_skills.json` as the process's shared compact document (`pom_engine::cjson`).
fn raw_skills() -> pom_engine::cjson::J {
    static DOC: OnceLock<pom_engine::cjson::J> = OnceLock::new();
    *DOC.get_or_init(|| {
        for var in ["POM_ENGINE_DATA"] {
            if let Some(d) = std::env::var_os(var).filter(|d| !d.is_empty()) {
                if let Ok(j) = pom_engine::cjson::doc(&std::path::Path::new(&d).join("data_skills.json")) {
                    return j;
                }
            }
        }
        for dir in ["../../engine-data", "engine-data"] {
            let p = std::path::Path::new(dir).join("data_skills.json");
            if p.exists() {
                if let Ok(j) = pom_engine::cjson::doc(&p) {
                    return j;
                }
            }
        }
        pom_engine::cjson::J::NULL
    })
}

/// `grantedEffect.levels[level]` straight from `data_skills.json`: a dense `1..N` table exports as
/// an array (0-indexed), a sparse one (item-granted skills fixed at one level, e.g. Envy) as an
/// object keyed by the level number.
pub fn raw_level(ge_id: &str, level: f64) -> Option<pom_engine::cjson::JObj> {
    let levels = raw_skills().get(ge_id)?.get("levels")?;
    let n = level.round() as i64;
    match (levels.as_array(), levels.as_object()) {
        (Some(a), _) => a.get((n.max(1).min(a.len() as i64) - 1) as usize).and_then(|v| v.as_object()),
        (_, Some(o)) => {
            if let Some(l) = o.get(&n.to_string()) {
                return l.as_object();
            }
            // calcLib.validateGemLevel (CalcTools.lua:42-58): clamp into 1..#levels, where `#` of a sparse
            // table is its consecutive border from 1; failing that, "any level" (`next`) - the lowest here.
            let mut border = 0i64;
            while o.contains_key(&(border + 1).to_string()) {
                border += 1;
            }
            let mut lvl = n.max(1);
            if border > 0 {
                lvl = lvl.min(border);
            }
            if let Some(l) = o.get(&lvl.to_string()) {
                return l.as_object();
            }
            o.iter().filter_map(|(k, v)| k.parse::<i64>().ok().map(|k| (k, v))).min_by_key(|(k, _)| *k).and_then(|(_, v)| v.as_object())
        }
        _ => None,
    }
}
