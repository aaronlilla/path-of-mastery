//! The `skillModFlags`/`skillKeywordFlags` bit sets and `skillCfg` construction from
//! `buildActiveSkillModList` (CalcActiveSkill.lua:357-478), everything past the weapon-flag
//! resolution (`active_skill::apply_weapon_flags`) up to (not including) the skill-mod-list build
//! (line 492 onward - not ported).
use crate::active_skill::ActiveSkill;
use crate::skill_type;
use pom_engine::modparser::flags::{keyword_flag as kf, mod_flag as mf};
use pom_engine::fxhash::HashMap;

fn flag(m: &HashMap<String, bool>, k: &str) -> bool {
    m.get(k).copied().unwrap_or(false)
}

/// Lines 357-379: `skillModFlags`, plus the `melee`/`projectile` -> `chaining` side effect.
pub fn skill_mod_flags(skill_flags: &mut HashMap<String, bool>) -> u64 {
    let mut f = 0u64;
    if flag(skill_flags, "hit") {
        f |= mf::Hit;
    }
    if flag(skill_flags, "attack") {
        f |= mf::Attack;
    } else {
        f |= mf::Cast;
        if flag(skill_flags, "spell") {
            f |= mf::Spell;
        }
    }
    if flag(skill_flags, "melee") {
        f |= mf::Melee;
    } else if flag(skill_flags, "projectile") {
        f |= mf::Projectile;
        skill_flags.insert("chaining".to_string(), true);
    }
    if flag(skill_flags, "area") {
        f |= mf::Area;
    }
    f
}

/// Lines 381-438: `skillKeywordFlags`, plus the `selfCast` side effect.
pub fn skill_keyword_flags(active: &ActiveSkill, weapon1_flags: Option<u64>) -> u64 {
    let mut f = 0u64;
    let sf = &active.skill_flags;
    let st = &active.skill_types;
    if flag(sf, "hit") {
        f |= kf::Hit;
    }
    if st.contains(&skill_type::AURA) {
        f |= kf::Aura;
    }
    if st.contains(&skill_type::APPLIES_CURSE) {
        f |= kf::Curse;
    }
    if st.contains(&skill_type::WARCRY) {
        f |= kf::Warcry;
    }
    if st.contains(&skill_type::MOVEMENT) {
        f |= kf::Movement;
    }
    if st.contains(&skill_type::VAAL) {
        f |= kf::Vaal;
    }
    if st.contains(&skill_type::LIGHTNING) {
        f |= kf::Lightning;
    }
    if st.contains(&skill_type::COLD) {
        f |= kf::Cold;
    }
    if st.contains(&skill_type::FIRE) {
        f |= kf::Fire;
    }
    if st.contains(&skill_type::CHAOS) {
        f |= kf::Chaos;
    }
    if st.contains(&skill_type::PHYSICAL) {
        f |= kf::Physical;
    }
    if flag(sf, "weapon1Attack") && weapon1_flags.map(|w| w & mf::Bow != 0).unwrap_or(false) {
        f |= kf::Bow;
    }
    if flag(sf, "brand") {
        f |= kf::Brand;
    }
    if flag(sf, "arrow") {
        f |= kf::Arrow;
    }
    f
}

/// The `totem`/`trap`/`mine`/`selfCast` branch (lines 424-432) - mutates `skill_flags` (its
/// `selfCast` side effect) and returns the extra keyword bits.
pub fn skill_keyword_flags_totem_branch(active: &mut ActiveSkill) -> u64 {
    let mut f = 0u64;
    if flag(&active.skill_flags, "totem") {
        f |= kf::Totem;
    } else if flag(&active.skill_flags, "trap") {
        f |= kf::Trap;
    } else if flag(&active.skill_flags, "mine") {
        f |= kf::Mine;
    } else if !active.skill_types.contains(&skill_type::TRIGGERED) {
        active.skill_flags.insert("selfCast".to_string(), true);
    }
    if active.skill_types.contains(&skill_type::ATTACK) {
        f |= kf::Attack;
    }
    if active.skill_types.contains(&skill_type::SPELL) && !flag(&active.skill_flags, "cast") {
        f |= kf::Spell;
    }
    f
}
