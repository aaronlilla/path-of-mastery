//! Port of `Modules/CalcActiveSkill.lua`'s `calcs.createActiveSkill` (lines 83-164) and
//! `Modules/CalcTools.lua`'s `calcLib.canGrantedEffectSupportActiveSkill`/
//! `calcLib.doesTypeExpressionMatch` (lines 60-161), the support-gem compatibility/application
//! pass. `imbuedSupport`/`appliesToGrantedSkills` (Forbidden Shako/Hungry Loop/Pearl of Tsoatha
//! special cases) are always `false`/`None` here - this crate's socket-group input never
//! synthesizes those (see `xmlskills.rs`'s doc comment).
use crate::data::{self, weapon_type_info};
use crate::skill_type;
use pom_engine::data::gems::GrantedEffect;
use pom_engine::fxhash::{HashMap, HashSet};

/// The two equipped-weapon inputs `getWeaponFlags`/`canGrantedEffectSupportActiveSkill` read:
/// `activeSkill.actor.weaponData1`/`weaponData2`. `ty` is `None` when the weapon has no `type` at
/// all (`weaponData2`'s "nothing real equipped" case is `{}`, not `{type = "None"}` - see
/// `data::BuildItemTypes::weapon2_type`'s doc comment); `weaponData1` always has `Some` (its own
/// empty-slot fallback is the real `"None"`/unarmed entry). `counts_as_all_1h` (Varunastra) is
/// always `false` - not modeled.
#[derive(Clone, Default)]
pub struct WeaponData {
    pub ty: Option<String>,
    pub counts_as_all_1h: bool,
}

pub struct SupportEffect<'a> {
    pub granted_effect: &'a GrantedEffect,
    pub level_idx: usize,
}

pub struct ActiveSkill<'a> {
    pub active_granted_effect: &'a GrantedEffect,
    pub skill_types: HashSet<i64>,
    pub minion_skill_types: Option<HashSet<i64>>,
    pub skill_flags: HashMap<String, bool>,
    /// The supports that passed compatibility (Pass 2 order), used later by
    /// `buildActiveSkillModList`.
    pub effect_list: Vec<usize>,
    pub weapon1: WeaponData,
    pub weapon2: WeaponData,
    /// `activeSkill.summonSkill`'s `skillTypes`/`minionSkillTypes` (set for a minion's own skill).
    pub summon: Option<(HashSet<i64>, Option<HashSet<i64>>)>,
    /// `activeSkill.activeEffect.gemData ~= nil` (nil for item- and tree-granted skills).
    pub has_gem_data: bool,
}

thread_local! {
    /// Set by `assemble::build_minion_skill` around its `build_one` call: the summoning skill's
    /// (final) skill types and its granted effect's minion skill types.
    pub static SUMMON: std::cell::RefCell<Option<(HashSet<i64>, Option<HashSet<i64>>)>> = const { std::cell::RefCell::new(None) };
}

fn flag(m: &HashMap<String, bool>, k: &str) -> bool {
    m.get(k).copied().unwrap_or(false)
}

/// `calcLib.doesTypeExpressionMatch` (CalcTools.lua:60-82): evaluates a flat postfix expression
/// of `SkillType` ids interspersed with `SkillType.OR`/`.AND`/`.NOT`.
pub fn does_type_expression_match(check_types: &[i64], skill_types: &HashSet<i64>, minion_types: Option<&HashSet<i64>>) -> bool {
    let mut stack: Vec<bool> = Vec::new();
    let pop = |s: &mut Vec<bool>| s.pop().unwrap_or(false);
    for &ty in check_types {
        if ty == skill_type::OR {
            let other = pop(&mut stack);
            let a = pop(&mut stack);
            stack.push(a || other);
        } else if ty == skill_type::AND {
            let other = pop(&mut stack);
            let a = pop(&mut stack);
            stack.push(a && other);
        } else if ty == skill_type::NOT {
            let a = pop(&mut stack);
            stack.push(!a);
        } else {
            let v = skill_types.contains(&ty) || minion_types.map(|m| m.contains(&ty)).unwrap_or(false);
            stack.push(v);
        }
    }
    stack.into_iter().any(|v| v)
}

/// `calcLib.canGrantedEffectSupportActiveSkill` (CalcTools.lua:86-161).
pub fn can_support(support_ge: &GrantedEffect, active: &ActiveSkill) -> bool {
    if data::is_unsupported(support_ge) || data::cannot_be_supported(active.active_granted_effect) {
        return false;
    }
    if data::support_gems_only(support_ge) && !active.has_gem_data {
        return false;
    }
    // Forbidden Shako / Hungry Loop special case: `imbuedSupport` is always `false` here, and
    // `appliesToGrantedSkills` is always `None`, so this only fires when the support and active
    // skill both trace to an item AND the active skill isn't granted through the special
    // exception path - not reachable from this crate's socket-group-only input (a real socketed
    // active gem is never `fromItem`), so this branch is a no-op in practice but kept faithful.
    if data::from_item(support_ge) && (data::from_item(active.active_granted_effect) || active.active_granted_effect.extra.get("modSource").and_then(|v| v.as_str()).map(|s| s.starts_with("Item")).unwrap_or(false)) {
        return false;
    }

    // CalcTools.lua:105-106: a minion's skill compares against the summoning skill's types.
    let effective_skill_types = active.summon.as_ref().map(|s| &s.0).unwrap_or(&active.skill_types);
    let effective_minion_types = if data::ignore_minion_types(support_ge) {
        None
    } else {
        active.summon.as_ref().and_then(|s| s.1.as_ref()).or(active.minion_skill_types.as_ref())
    };

    let exclude = data::skill_type_expr(support_ge, "excludeSkillTypes");
    if !exclude.is_empty() && does_type_expression_match(&exclude, effective_skill_types, None) {
        return false;
    }
    // `grantedEffect.isTrigger and activeSkill.actor.enemy.player ~= activeSkill.actor`: always
    // the real player actor here (no minion/enemy actors modeled), so this never rejects.
    // A minion's skill (`summon` set) has the minion as actor, whose enemy's player is not itself.
    if data::is_trigger(support_ge) && active.summon.is_some() {
        return false;
    }

    if let Some(support_weapon_types) = data::weapon_types(support_ge) {
        let mut active_type_lookup: HashSet<String> = HashSet::default();
        if let Some(active_weapon_types) = data::weapon_types(active.active_granted_effect) {
            active_type_lookup.extend(active_weapon_types);
        } else if effective_skill_types.contains(&skill_type::SKILL_GRANTED_BY_SUPPORT) {
            // `if activeSkill.actor.weaponData1.type then ... end`: truthy-checked, not compared
            // against `"None"` - a real "None"/unarmed weapon1 still counts here.
            if let Some(t) = &active.weapon1.ty {
                active_type_lookup.insert(t.clone());
            }
            if let Some(t) = &active.weapon2.ty {
                active_type_lookup.insert(t.clone());
            }
        }
        if active_type_lookup.is_empty() {
            return false;
        }
        let actor_has_all_1h = active.weapon1.counts_as_all_1h || active.weapon2.counts_as_all_1h;
        if actor_has_all_1h {
            for t in ["Claw", "Dagger", "One Handed Axe", "One Handed Mace", "One Handed Sword"] {
                active_type_lookup.insert(t.to_string());
            }
        }
        if !support_weapon_types.iter().any(|t| active_type_lookup.contains(t)) {
            return false;
        }
    }

    let require = data::skill_type_expr(support_ge, "requireSkillTypes");
    require.is_empty() || does_type_expression_match(&require, effective_skill_types, effective_minion_types)
}

/// `calcs.createActiveSkill` (CalcActiveSkill.lua:83-164). `supports` is the group's full applied
/// support list (Pass 1/2 both scan the same list; rejected-support retry loop included).
pub fn create_active_skill<'a>(active_ge: &'a GrantedEffect, supports: &[&'a GrantedEffect], weapon1: WeaponData, weapon2: WeaponData, has_gem_data: bool) -> ActiveSkill<'a> {
    let skill_types = data::skill_types(active_ge);
    let minion_skill_types = data::minion_skill_types(active_ge);
    let mut skill_flags: HashMap<String, bool> = data::base_flags(active_ge).into_iter().map(|k| (k, true)).collect();
    let hit = flag(&skill_flags, "hit") || skill_types.contains(&skill_type::ATTACK) || skill_types.contains(&skill_type::DAMAGE) || skill_types.contains(&skill_type::PROJECTILE);
    if hit {
        skill_flags.insert("hit".to_string(), true);
    }

    let mut active = ActiveSkill { active_granted_effect: active_ge, skill_types, minion_skill_types, skill_flags, effect_list: Vec::new(), weapon1, weapon2, summon: SUMMON.with(|c| c.borrow().clone()), has_gem_data };

    // Pass 1 + rejected-supports retry loop (lines 111-143): grow `skill_types` via compatible
    // supports' `addSkillTypes` until a full pass adds nothing new.
    let mut rejected: Vec<usize> = Vec::new();
    for (i, s) in supports.iter().enumerate() {
        if data::is_support(s) {
            if can_support(s, &active) {
                for t in data::add_skill_types(s) {
                    active.skill_types.insert(t);
                }
            } else {
                rejected.push(i);
            }
        }
    }
    loop {
        let mut added_any = false;
        rejected.retain(|&i| {
            let s = supports[i];
            if can_support(s, &active) {
                for t in data::add_skill_types(s) {
                    active.skill_types.insert(t);
                }
                added_any = true;
                false
            } else {
                true
            }
        });
        if !added_any {
            break;
        }
    }

    // Pass 2 (lines 145-161): the final compatible-support list, plus `addFlags`.
    for (i, s) in supports.iter().enumerate() {
        if data::is_support(s) && can_support(s, &active) {
            active.effect_list.push(i);
            for f in data::add_flags(s) {
                active.skill_flags.insert(f, true);
            }
        }
    }

    active
}

/// The main-hand/off-hand weapon-flag resolution from `buildActiveSkillModList`
/// (CalcActiveSkill.lua:284-348), restricted to what feeds `skillFlags`/`skillCfg` (the mod-list
/// tail past this point isn't ported). Returns `(weapon1_mod_flags, weapon2_mod_flags,
/// disable_reason)`.
pub struct WeaponFlagResult {
    pub weapon1_flags: Option<u64>,
    pub weapon2_flags: Option<u64>,
    pub disabled: bool,
    /// `activeSkill.disableReason` as the weapon/shield/staff checks leave it (None when not disabled).
    pub disable_reason: Option<String>,
}

fn get_weapon_flags(weapon: &WeaponData, weapon_types: &[HashSet<String>]) -> (Option<u64>, Option<data::WeaponTypeInfo>) {
    use pom_engine::modparser::flags::mod_flag as mf;
    // `local info = env.data.weaponTypeInfo[weaponData.type]; if not info then return end`: a
    // `None` type (weaponData2's "nothing real equipped" case) never even reaches a lookup.
    let Some(ty) = weapon.ty.as_deref() else { return (None, None) };
    let Some(info) = weapon_type_info(ty) else { return (None, None) };
    for types in weapon_types {
        let has = types.contains(ty);
        let counts_all_1h = weapon.counts_as_all_1h && (types.contains("Claw") || types.contains("Dagger") || types.contains("One Handed Axe") || types.contains("One Handed Mace") || types.contains("One Handed Sword"));
        if !has && !counts_all_1h {
            let flag = info.flag.clone();
            let melee = info.melee;
            let one_hand = info.one_hand;
            return (None, Some(data::WeaponTypeInfo { flag, melee, one_hand }));
        }
    }
    let mut flags = if weapon.counts_as_all_1h { mf::Axe | mf::Claw | mf::Dagger | mf::Mace | mf::Sword } else { flag_for_name(&info.flag) };
    if ty != "None" {
        flags |= mf::Weapon;
        flags |= if info.one_hand { mf::Weapon1H } else { mf::Weapon2H };
        flags |= if info.melee { mf::WeaponMelee } else { mf::WeaponRanged };
    }
    (Some(flags), Some(info))
}

fn flag_for_name(name: &str) -> u64 {
    use pom_engine::modparser::flags::mod_flag as mf;
    match name {
        "Axe" => mf::Axe,
        "Bow" => mf::Bow,
        "Claw" => mf::Claw,
        "Dagger" => mf::Dagger,
        "Mace" => mf::Mace,
        "Staff" => mf::Staff,
        "Sword" => mf::Sword,
        "Wand" => mf::Wand,
        "Unarmed" => mf::Unarmed,
        "Fishing" => mf::Fishing,
        _ => 0,
    }
}

/// `weaponTypes` gathered from the active gem's own granted effect plus every applied support's
/// (CalcActiveSkill.lua:296-301).
pub fn gather_weapon_types(active: &ActiveSkill, supports: &[&GrantedEffect]) -> Vec<HashSet<String>> {
    let mut out = Vec::new();
    if let Some(wt) = data::weapon_types(active.active_granted_effect) {
        out.push(wt);
    }
    for &i in &active.effect_list {
        if let Some(wt) = data::weapon_types(supports[i]) {
            out.push(wt);
        }
    }
    out
}

/// The weapon-flag/disable portion of `buildActiveSkillModList` (lines 272-348), applied to
/// `skill_flags` in place. `has_shield`/`has_staff_main_hand` are the two `RequiresShield`/
/// `RequiresStaff` equip checks (`activeSkill.actor.itemList["Weapon 2"].type == "Shield"` /
/// `["Weapon 1"].type == "Staff"`).
pub fn apply_weapon_flags(active: &mut ActiveSkill, supports: &[&GrantedEffect], has_shield_offhand: bool, has_staff_mainhand: bool) -> WeaponFlagResult {
    let mut disabled = false;
    let mut reason: Option<String> = None;
    if (active.skill_types.contains(&skill_type::REQUIRES_SHIELD) || flag(&active.skill_flags, "shieldAttack")) && !has_shield_offhand {
        active.skill_flags.insert("disable".to_string(), true);
        disabled = true;
        reason = Some("This skill requires a Shield".to_string());
    }
    if active.skill_types.contains(&skill_type::REQUIRES_STAFF) && !has_staff_mainhand {
        active.skill_flags.insert("disable".to_string(), true);
        disabled = true;
        reason = Some("This skill requires a Staff".to_string());
    }

    if flag(&active.skill_flags, "shieldAttack") {
        active.skill_flags.insert("weapon2Attack".to_string(), true);
        return WeaponFlagResult { weapon1_flags: None, weapon2_flags: Some(0), disabled, disable_reason: reason };
    }

    let weapon_types = gather_weapon_types(active, supports);
    let mut weapon1_flags_out = None;
    let mut weapon2_flags_out = None;

    let force_off_hand = flag(&active.skill_flags, "forceOffHand");
    let (mut weapon1_flags, mut weapon1_info) = if !force_off_hand { get_weapon_flags(&active.weapon1, &weapon_types) } else { (None, None) };
    let is_summon = active.summon.is_some();
    if weapon1_flags.is_none() && is_summon {
        // "Minion skills seem to ignore weapon types" (CalcActiveSkill.lua:307-310).
        if let Some(info) = weapon_type_info("None") {
            weapon1_flags = Some(flag_for_name(&info.flag));
            weapon1_info = Some(info);
        }
    }

    if let Some(w1) = weapon1_flags {
        if flag(&active.skill_flags, "attack") || flag(&active.skill_flags, "dotFromAttack") {
            weapon1_flags_out = Some(w1);
            active.skill_flags.insert("weapon1Attack".to_string(), true);
            if let Some(info) = &weapon1_info {
                if info.melee && flag(&active.skill_flags, "melee") {
                    active.skill_flags.remove("projectile");
                } else if !info.melee && flag(&active.skill_flags, "projectile") {
                    active.skill_flags.remove("melee");
                }
            }
        }
    } else if (active.skill_types.contains(&skill_type::DUAL_WIELD_ONLY) || flag(&active.skill_flags, "forceMainHand") || weapon1_info.is_some()) && !is_summon {
        active.skill_flags.insert("disable".to_string(), true);
        disabled = true;
        reason = Some("Main Hand weapon is not usable with this skill".to_string());
    }

    if !flag(&active.skill_flags, "forceMainHand") {
        let (weapon2_flags, weapon2_info) = get_weapon_flags(&active.weapon2, &weapon_types);
        if let Some(w2) = weapon2_flags {
            if active.skill_types.contains(&skill_type::DUAL_WIELD_REQUIRES_DIFFERENT_TYPES) && active.weapon1.ty == active.weapon2.ty && !(active.weapon2.counts_as_all_1h || active.weapon1.counts_as_all_1h) {
                active.skill_flags.insert("disable".to_string(), true);
                disabled = true;
                reason.get_or_insert_with(|| "Weapon Types Need to be Different".to_string());
            } else if flag(&active.skill_flags, "attack") || flag(&active.skill_flags, "dotFromAttack") {
                weapon2_flags_out = Some(w2);
                active.skill_flags.insert("weapon2Attack".to_string(), true);
            }
        } else if (active.skill_types.contains(&skill_type::DUAL_WIELD_ONLY) || weapon2_info.is_some()) && !is_summon {
            active.skill_flags.insert("disable".to_string(), true);
            disabled = true;
            reason.get_or_insert_with(|| "Off Hand weapon is not usable with this skill".to_string());
        } else if flag(&active.skill_flags, "disable") {
            // Neither weapon is compatible (CalcActiveSkill.lua:340-343).
            reason = Some("No usable weapon equipped".to_string());
        }
    }

    if flag(&active.skill_flags, "attack") {
        let both = flag(&active.skill_flags, "weapon1Attack") && flag(&active.skill_flags, "weapon2Attack");
        active.skill_flags.insert("bothWeaponAttack".to_string(), both);
    }

    WeaponFlagResult { weapon1_flags: weapon1_flags_out, weapon2_flags: weapon2_flags_out, disabled, disable_reason: reason }
}
