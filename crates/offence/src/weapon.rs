// Port of the weapon-flags/weapon-Cfg setup that CalcOffence.lua's passList loop depends on but
// doesn't itself compute: `getWeaponFlags` (Modules/CalcActiveSkill.lua:194-226) and the
// `weapon1Cfg`/`weapon2Cfg` construction (CalcActiveSkill.lua:480-489). That file runs before
// `calcs.offence` and isn't recorded directly, but everything
// it needs is reconstructible from what IS recorded: `skillCfg` (whose `.flags` already contains
// `skillModFlags | (weapon1Flags or weapon2Flags or 0)`, so masking out the weapon bits recovers
// `skillModFlags`) plus the actor's own `weaponData1`/`weaponData2` (type, `countsAsAll1H`) and the
// already-recorded `skillFlags.weapon1Attack`/`weapon2Attack` (true only when the Lua's
// `weaponTypes` compatibility gate already passed, so this module never needs to re-check it).
use pom_engine::modparser::flags::mod_flag;
use pom_engine::modstore::types::{Cfg, ScalarValue};
use pom_engine::fxhash::HashMap;
use std::sync::Arc;

struct WeaponTypeInfo {
    one_hand: bool,
    melee: bool,
    flag: u64,
}

/// `data.weaponTypeInfo` (Modules/Data.lua:556-572).
fn weapon_type_info(weapon_type: &str) -> Option<WeaponTypeInfo> {
    use mod_flag::*;
    Some(match weapon_type {
        "None" => WeaponTypeInfo { one_hand: true, melee: true, flag: Unarmed },
        "Bow" => WeaponTypeInfo { one_hand: false, melee: false, flag: Bow },
        "Claw" => WeaponTypeInfo { one_hand: true, melee: true, flag: Claw },
        "Dagger" => WeaponTypeInfo { one_hand: true, melee: true, flag: Dagger },
        "Staff" => WeaponTypeInfo { one_hand: false, melee: true, flag: Staff },
        "Wand" => WeaponTypeInfo { one_hand: true, melee: false, flag: Wand },
        "One Handed Axe" => WeaponTypeInfo { one_hand: true, melee: true, flag: Axe },
        "One Handed Mace" => WeaponTypeInfo { one_hand: true, melee: true, flag: Mace },
        "One Handed Sword" => WeaponTypeInfo { one_hand: true, melee: true, flag: Sword },
        "Sceptre" => WeaponTypeInfo { one_hand: true, melee: true, flag: Mace },
        "Thrusting One Handed Sword" => WeaponTypeInfo { one_hand: true, melee: true, flag: Sword },
        "Fishing Rod" => WeaponTypeInfo { one_hand: false, melee: true, flag: Fishing },
        "Two Handed Axe" => WeaponTypeInfo { one_hand: false, melee: true, flag: Axe },
        "Two Handed Mace" => WeaponTypeInfo { one_hand: false, melee: true, flag: Mace },
        "Two Handed Sword" => WeaponTypeInfo { one_hand: false, melee: true, flag: Sword },
        _ => return None,
    })
}

/// `(melee, oneHand)` of `data.weaponTypeInfo[weapon_type]`; `None` when the type is not in the table.
pub fn weapon_type_melee_one_hand(weapon_type: &str) -> Option<(bool, bool)> {
    weapon_type_info(weapon_type).map(|i| (i.melee, i.one_hand))
}

/// `getWeaponFlags(env, weaponData, weaponTypes)` (CalcActiveSkill.lua:194-226), minus the
/// `weaponTypes` compatibility check: the caller only calls this once it already knows (via the
/// recorded `skillFlags.weapon1Attack`/`weapon2Attack`) that the gate passed. Returns `None` only
/// for a `weaponData.type` this crate's static table doesn't recognise.
pub fn weapon_flags(weapon_type: &str, counts_as_all_1h: bool) -> Option<u64> {
    let info = weapon_type_info(weapon_type)?;
    let mut flags = if counts_as_all_1h { mod_flag::Axe | mod_flag::Claw | mod_flag::Dagger | mod_flag::Mace | mod_flag::Sword } else { info.flag };
    if weapon_type != "None" {
        flags |= mod_flag::Weapon;
        flags |= if info.one_hand { mod_flag::Weapon1H } else { mod_flag::Weapon2H };
        flags |= if info.melee { mod_flag::WeaponMelee } else { mod_flag::WeaponRanged };
    }
    Some(flags)
}

/// Recovers `skillModFlags` (the part of `skillCfg.flags` that isn't a weapon-type bit) by masking
/// out `ModFlag.WeaponMask` - valid because `skillModFlags` (built from skill-type booleans only:
/// Attack/Spell/Hit/Dot/Cast/Melee/Area/Projectile/Ailment/MeleeHit) never sets a weapon-mask bit
/// itself (CalcActiveSkill.lua:370-465).
pub fn skill_mod_flags(skill_cfg_flags: u64) -> u64 {
    skill_cfg_flags & !mod_flag::WeaponMask
}

/// `activeSkill.weapon1Cfg`/`weapon2Cfg` (CalcActiveSkill.lua:481-483 / 486-488): a copy of
/// `skillCfg` with `.flags` replaced by `skillModFlags | weaponFlags` and `.skillCond` gaining
/// `MainHandAttack`/`OffHandAttack` (the Lua uses a metatable fallback to `skillCfg.skillCond` for
/// every other key; cloning `skillCfg.skill_cond` first reproduces that read-through exactly since
/// nothing here ever needs to override one of `skillCfg`'s own keys with a different value).
pub fn weapon_cfg(skill_cfg: &Cfg, weapon_flags: u64, hand_cond: &str) -> Cfg {
    let mut cfg = skill_cfg.clone();
    cfg.flags = skill_mod_flags(skill_cfg.flags) | weapon_flags;
    cfg.skill_cond.insert(Arc::from(hand_cond), true);
    cfg
}

/// `actor.weaponData1`/`weaponData2`, the `source` table `calcDamage`'s base-damage assignment
/// reads (CalcOffence.lua:3355-3356 etc): every scalar field as `f64` (0 when absent/non-numeric,
/// matching Lua's `source[x] or 0`), plus `type`/`subType` kept as strings and `countsAsAll1H` as a
/// bool for `weapon_flags` above.
#[derive(Default, Clone)]
pub struct WeaponSource {
    pub num: HashMap<String, f64>,
    pub weapon_type: Option<String>,
    pub counts_as_all_1h: bool,
}

impl WeaponSource {
    pub fn from_map(m: &HashMap<Arc<str>, ScalarValue>) -> WeaponSource {
        let mut num = HashMap::default();
        let mut weapon_type = None;
        let mut counts_as_all_1h = false;
        for (k, v) in m {
            match v {
                ScalarValue::Num(n) => {
                    num.insert(k.to_string(), *n);
                }
                ScalarValue::Str(s) => {
                    if &**k == "type" {
                        weapon_type = Some(s.to_string());
                    }
                }
                ScalarValue::Bool(b) => {
                    if &**k == "countsAsAll1H" {
                        counts_as_all_1h = *b;
                    }
                }
            }
        }
        WeaponSource { num, weapon_type, counts_as_all_1h }
    }

    /// For a non-attack "Skill" pass, `source = skillData` (CalcOffence.lua:2059): same field
    /// shape, keyed by owned `String` (`SkillView::skill_data`) rather than `Arc<str>`.
    pub fn from_skill_data(m: &HashMap<String, ScalarValue>) -> WeaponSource {
        let mut num = HashMap::default();
        for (k, v) in m {
            if let ScalarValue::Num(n) = v {
                num.insert(k.clone(), *n);
            }
        }
        WeaponSource { num, weapon_type: None, counts_as_all_1h: false }
    }

    pub fn get(&self, key: &str) -> f64 {
        self.num.get(key).copied().unwrap_or(0.0)
    }
    pub fn get_opt(&self, key: &str) -> Option<f64> {
        self.num.get(key).copied()
    }
    pub fn set(&mut self, key: &str, val: f64) {
        self.num.insert(key.to_string(), val);
    }
}
