//! The mod-injection chain at the top of `calcs.offence` (`Modules/CalcOffence.lua`:516-1050):
//! every place upstream mutates `skillModList` / `skillData` / `skillCfg` before the per-pass
//! damage loops read them (stat conversions such as "Increases to Spell Damage also apply to
//! Attack Damage", The Scourge's minion damage, Transfiguration, repeat multipliers, random
//! physical gain-as conversions, ...). Each block cites its original line range.
//!
//! Not ported (named, all rare and gated on a specific unique/keystone): `AffectedByEnergyBlade`
//! (564-583, needs `data.itemBases` weapon bases), `ClawCrit*AppliesToMinions` (writes to the
//! minion modDB), Seals (944-967), Momentum (1037-1050; writes to the player modDB).
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modparser::flags::{keyword_flag, mod_flag};
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::{Cfg, ScalarValue};
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_offence::conversion::DMG_TYPES;
use pom_offence::weapon::WeaponSource;
use pom_engine::fxhash::{HashMap, HashSet};
use std::sync::Arc;

pub struct PrepInput<'a> {
    /// `activeSkill.skillFlags`.
    pub skill_flags: &'a HashSet<String>,
    /// `env.modDB`.
    pub player: &'a ModStore,
    /// The player's `output` (`LightningResistTotal`, `Str`, ...).
    pub output: &'a HashMap<String, f64>,
    pub weapon1: &'a WeaponSource,
    pub weapon2: &'a Option<WeaponSource>,
    /// `activeSkill.weapon1Flags` / `weapon2Flags`, when the skill resolved them.
    pub weapon1_flags: Option<u64>,
    pub weapon2_flags: Option<u64>,
    /// `actor.itemList["Weapon 1"].weaponData[1]` exists (a real weapon item in slot 1).
    pub has_weapon1_item: bool,
    pub config_str: &'a HashMap<String, String>,
    pub repeats: f64,
    pub skill_types: &'a HashSet<i64>,
}

thread_local! {
    /// Mods `calcs.offence` writes into `env.minion.modDB` (Law of the Wilds); the pipeline drains them after the
    /// player's main offence pass and adds them to the minion store before its own passes.
    pub static MINION_MODS: std::cell::RefCell<Vec<Mod>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn n(v: f64) -> Value {
    Value::Num(v)
}

fn mk(name: &str, ty: ModType, value: f64, source: &str, flags: u64, kw: u64, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value: n(value), flags, keyword_flags: kw, source: Some(Arc::from(source)), tags: (tags).into() }
}

/// `Tabulate(type, cfg, names)`, with the mods cloned out so the store can be mutated while the
/// result is walked (Lua's `Tabulate` result likewise holds the original mod tables).
fn tab(sml: &ModStore, ty: Option<ModType>, cfg: Option<&Cfg>, names: &[&str]) -> Vec<Mod> {
    let syms: Vec<Sym> = names.iter().map(|s| Sym::new(s)).collect();
    // SAFETY: the pointers refer to mods held by `sml` (or its parents) and are read immediately.
    sml.tabulate(ty, cfg, &syms).into_iter().map(|(_, p)| unsafe { (*p).clone() }).collect()
}

/// As `tab`, also returning each mod's identity (its address), for `processedRandomMods[mod]`.
fn tab_id(sml: &ModStore, ty: Option<ModType>, cfg: Option<&Cfg>, names: &[&str]) -> Vec<(Mod, usize)> {
    let syms: Vec<Sym> = names.iter().map(|s| Sym::new(s)).collect();
    sml.tabulate(ty, cfg, &syms).into_iter().map(|(_, p)| (unsafe { (*p).clone() }, p as usize)).collect()
}

fn mod_num(m: &Mod) -> f64 {
    m.value.num().unwrap_or(0.0)
}

fn mod_source(m: &Mod) -> &str {
    m.source.as_deref().unwrap_or("")
}

/// `calcLib.getConvertedModTags(mod, multiplier, minionMods)` (CalcTools.lua:258-273).
fn converted_tags(m: &Mod, multiplier: f64, minion_mods: bool) -> Vec<Tag> {
    m.tags
        .iter()
        .map(|t| {
            if minion_mods && t.kind.as_str() == "ActorCondition" && t.get(pom_engine::sym!("actor")).as_str_eq("parent") {
                Tag { kind: pom_engine::sym!("Condition"), fields: vec![(pom_engine::sym!("var"), t.get(pom_engine::sym!("var")).clone())] }
            } else if t.get(pom_engine::sym!("limitTotal")).truthy() {
                let mut c = t.clone();
                for (k, v) in c.fields.iter_mut() {
                    if k.as_str() == "limit" {
                        if let Some(l) = v.num() {
                            *v = n(l * multiplier);
                        }
                    }
                }
                c
            } else {
                t.clone()
            }
        })
        .collect()
}

trait ValueExt {
    fn as_str_eq(&self, s: &str) -> bool;
}
impl ValueExt for Value {
    fn as_str_eq(&self, s: &str) -> bool {
        matches!(self, Value::Str(x) if &**x == s)
    }
}

fn floor(x: f64) -> f64 {
    x.floor()
}

fn cfg_flags(flags: u64) -> Cfg {
    Cfg { flags, ..Cfg::default() }
}

/// Applies the chain to `sml` (the skill's mod list), `cfg` (`skillCfg`; its `skillCond` is
/// updated) and `skill_data`.
pub fn prepare_skill_mods(sml: &mut ModStore, cfg: &mut Cfg, skill_data: &mut HashMap<String, ScalarValue>, i: &PrepInput) {
    let flag = |sml: &ModStore, cfg: Option<&Cfg>, name: &str| sml.flag(cfg, &[Sym::new(name)]);
    // 518-525: SkillIsTriggered / SkillIsFocused
    let triggered = skill_data.get("triggered").is_some_and(|v| !matches!(v, ScalarValue::Bool(false)));
    cfg.skill_cond.insert(Arc::from("SkillIsTriggered"), triggered);
    let focused = skill_data.get("chanceToTriggerOnFocus").is_some_and(|v| !matches!(v, ScalarValue::Bool(false)));
    cfg.skill_cond.insert(Arc::from("SkillIsFocused"), focused);
    let cfg: &Cfg = &*cfg;

    // 536-558: additional stat bonuses
    // `actor.strDmgBonus` is only assigned inside the attribute-bonus gate (CalcPerform.lua:517-528); otherwise nil -> 0.
    let str_bonus_on = !i.player.flag(None, &[pom_engine::sym!("NoAttributeBonuses")]) && !i.player.flag(None, &[pom_engine::sym!("NoStrengthAttributeBonuses")]);
    let str_dmg_bonus = if !str_bonus_on { 0.0 } else {
        let str_v = i.output.get("Str").copied().unwrap_or(0.0);
        let dex_int = i.player.sum(ModType::Base, None, &[pom_engine::sym!("DexIntToMeleeBonus")]);
        let ratio = i.player.sum(ModType::Base, None, &[pom_engine::sym!("StrDmgBonusRatioOverride")]);
        if ratio > 0.0 {
            floor((str_v + dex_int) * ratio)
        } else {
            floor((str_v + dex_int) / 5.0)
        }
    };
    if flag(sml, None, "IronGrip") {
        sml.add_mod(mk("PhysicalDamage", ModType::Inc, str_dmg_bonus, "Strength", mod_flag::Attack | mod_flag::Projectile, 0, vec![]));
    }
    if flag(sml, None, "IronWill") {
        sml.add_mod(mk("Damage", ModType::Inc, str_dmg_bonus, "Strength", mod_flag::Spell, 0, vec![]));
    }
    let transfiguration = pom_offence::data::misc("Transfiguration");
    if flag(sml, None, "TransfigurationOfBody") {
        let v = floor(sml.sum(ModType::Inc, None, &[pom_engine::sym!("Life")]) * transfiguration);
        sml.add_mod(mk("Damage", ModType::Inc, v, "Transfiguration of Body", mod_flag::Attack, 0, vec![]));
    }
    if flag(sml, None, "TransfigurationOfMind") {
        let v = floor(sml.sum(ModType::Inc, None, &[pom_engine::sym!("Mana")]) * transfiguration);
        sml.add_mod(mk("Damage", ModType::Inc, v, "Transfiguration of Mind", 0, 0, vec![]));
    }
    if flag(sml, None, "TransfigurationOfSoul") {
        let v = floor(sml.sum(ModType::Inc, None, &[pom_engine::sym!("EnergyShield")]) * transfiguration);
        sml.add_mod(mk("Damage", ModType::Inc, v, "Transfiguration of Soul", mod_flag::Spell, 0, vec![]));
    }
    if i.player.flag(None, &[pom_engine::sym!("Elusive")]) && flag(sml, None, "SupportedByNightblade") {
        let elusive_effect = i.output.get("ElusiveEffectMod").copied().unwrap_or(0.0) / 100.0;
        let multi = sml.sum(ModType::Base, None, &[pom_engine::sym!("NightbladeElusiveCritMultiplier")]);
        sml.add_mod(mk("CritMultiplier", ModType::Base, floor(multi * elusive_effect), "Nightblade", 0, 0, vec![]));
    }

    // 585-612: Battlemage / Spellblade
    let w1 = i.weapon1;
    let w1_num = |k: &str| w1.get(k);
    if flag(sml, None, "Battlemage") && i.has_weapon1_item {
        let multiplier = sml.max(Some(cfg), &[pom_engine::sym!("MainHandWeaponDamageAppliesToSpells")]).unwrap_or(100.0) / 100.0;
        for t in DMG_TYPES {
            sml.add_mod(mk(&format!("{t}Min"), ModType::Base, floor(w1_num(&format!("{t}Min")) * multiplier), "Battlemage", mod_flag::Spell, 0, vec![]));
            sml.add_mod(mk(&format!("{t}Max"), ModType::Base, floor(w1_num(&format!("{t}Max")) * multiplier), "Battlemage", mod_flag::Spell, 0, vec![]));
        }
    }
    let weapon_info = |w: &WeaponSource| -> Option<(bool, bool)> {
        let t = w.weapon_type.as_deref()?;
        // (melee, oneHand) from `data.weaponTypeInfo`
        pom_skills::data::weapon_type_info(t).map(|info| (info.melee, info.one_hand))
    };
    let w1_info = weapon_info(w1);
    let w2_info = i.weapon2.as_ref().and_then(weapon_info);
    if let Some(spellblade) = sml.max(Some(cfg), &[pom_engine::sym!("OneHandWeaponDamageAppliesToSpells")]) {
        if i.has_weapon1_item && w1_info.is_some_and(|(melee, one_hand)| melee && one_hand) {
            let multiplier = spellblade / 100.0 * if w2_info.is_some() { 0.6 } else { 1.0 };
            for t in DMG_TYPES {
                sml.add_mod(mk(&format!("{t}Min"), ModType::Base, floor(w1_num(&format!("{t}Min")) * multiplier), "Spellblade Main Hand", mod_flag::Spell, 0, vec![]));
                sml.add_mod(mk(&format!("{t}Max"), ModType::Base, floor(w1_num(&format!("{t}Max")) * multiplier), "Spellblade Main Hand", mod_flag::Spell, 0, vec![]));
            }
            if w2_info.is_some() {
                let w2 = i.weapon2.as_ref().unwrap();
                for t in DMG_TYPES {
                    sml.add_mod(mk(&format!("{t}Min"), ModType::Base, floor(w2.get(&format!("{t}Min")) * multiplier), "Spellblade Off Hand", mod_flag::Spell, 0, vec![]));
                    sml.add_mod(mk(&format!("{t}Max"), ModType::Base, floor(w2.get(&format!("{t}Max")) * multiplier), "Spellblade Off Hand", mod_flag::Spell, 0, vec![]));
                }
            }
        }
    }

    // 613-643: minion damage / attack speed / cast speed applied to the player
    let minion_mods = |sml: &ModStore, cfg: &Cfg| -> Vec<Mod> {
        // `skillModList:List(skillCfg, "MinionModifier")` values are `{ mod = {...} }` tables, evaluated through the
        // LIST mod's own tags (a `PerStat`/`Multiplier` tag scales `value.mod.value`).
        let syms = [pom_engine::sym!("MinionModifier")];
        let mut out = Vec::new();
        for (v, _) in sml.tabulate(Some(ModType::List), Some(cfg), &syms) {
            if let Value::Map(fields) = &v {
                if let Some((_, Value::Map(inner_map))) = fields.iter().find(|(k, _)| k.as_str() == "mod") {
                    out.push(crate::actor_misc::map_to_mod(inner_map));
                }
            }
        }
        out
    };
    if flag(sml, None, "MinionDamageAppliesToPlayer") || flag(sml, Some(cfg), "MinionDamageAppliesToPlayer") {
        let multiplier = sml.max(Some(cfg), &[pom_engine::sym!("ImprovedMinionDamageAppliesToPlayer")]).unwrap_or(100.0) / 100.0;
        for m in minion_mods(sml, cfg) {
            if m.name.as_str() == "Damage" && m.ty == ModType::Inc {
                let tags = converted_tags(&m, multiplier, true);
                sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: ModType::Inc, value: n(mod_num(&m) * multiplier), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: (tags).into() });
            }
        }
    }
    if flag(sml, None, "MinionAttackSpeedAppliesToPlayer") {
        let multiplier = sml.max(Some(cfg), &[pom_engine::sym!("ImprovedMinionAttackSpeedAppliesToPlayer")]).unwrap_or(100.0) / 100.0;
        for m in minion_mods(sml, cfg) {
            if m.name.as_str() == "Speed" && m.ty == ModType::Inc && (m.flags == 0 || m.flags & mod_flag::Attack != 0) {
                let tags = converted_tags(&m, multiplier, true);
                sml.add_mod(Mod { name: pom_engine::sym!("Speed"), ty: ModType::Inc, value: n(mod_num(&m) * multiplier), flags: mod_flag::Attack, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: (tags).into() });
            }
        }
    }
    if flag(sml, None, "MinionCastSpeedAppliesToPlayer") {
        let multiplier = sml.max(Some(cfg), &[pom_engine::sym!("ImprovedMinionCastSpeedAppliesToPlayer")]).unwrap_or(100.0) / 100.0;
        for m in minion_mods(sml, cfg) {
            if m.name.as_str() == "Speed" && m.ty == ModType::Inc && (m.flags == 0 || m.flags & mod_flag::Cast != 0) {
                let tags = converted_tags(&m, multiplier, true);
                sml.add_mod(Mod { name: pom_engine::sym!("Speed"), ty: ModType::Inc, value: n(mod_num(&m) * multiplier), flags: mod_flag::Cast, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: (tags).into() });
            }
        }
    }

    // 644-650: Evasion applies to spell damage (The Unblinking Eye)
    if flag(sml, None, "EvasionAppliesToSpellDamage") {
        for m in tab(sml, Some(ModType::Inc), Some(&Cfg::default()), &["Evasion"]) {
            sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: m.ty, value: m.value.clone(), flags: mod_flag::Spell, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
        }
    }
    // 651-665: Spell damage applies to attacks
    if flag(sml, None, "SpellDamageAppliesToAttacks") || flag(sml, Some(cfg), "SpellDamageAppliesToAttacks") {
        let multiplier = sml.max(Some(cfg), &[pom_engine::sym!("ImprovedSpellDamageAppliesToAttacks")]).unwrap_or(100.0) / 100.0;
        for m in tab(sml, Some(ModType::Inc), Some(&cfg_flags(mod_flag::Spell)), &["Damage"]) {
            if m.flags & mod_flag::Spell != 0 {
                let tags = converted_tags(&m, multiplier, false);
                sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: ModType::Inc, value: n(mod_num(&m) * multiplier), flags: (m.flags & !mod_flag::Spell) | mod_flag::Attack, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: (tags).into() });
                if mod_source(&m) == "Strength" {
                    replace_zero(sml, "PhysicalDamage", ModType::Inc, "Strength", mod_flag::Melee);
                    replace_zero(sml, "PhysicalDamage", ModType::Inc, "Strength", mod_flag::Attack | mod_flag::Projectile);
                }
            }
        }
    }
    // 666-678: Cast speed applies to attacks
    if flag(sml, None, "CastSpeedAppliesToAttacks") {
        let multiplier = sml.max(Some(cfg), &[pom_engine::sym!("ImprovedCastSpeedAppliesToAttacks")]).unwrap_or(100.0) / 100.0;
        for m in tab(sml, Some(ModType::Inc), Some(&cfg_flags(mod_flag::Cast)), &["Speed"]) {
            if m.flags & mod_flag::Cast != 0 {
                let tags = converted_tags(&m, multiplier, false);
                sml.add_mod(Mod { name: pom_engine::sym!("Speed"), ty: ModType::Inc, value: n(mod_num(&m) * multiplier), flags: (m.flags & !mod_flag::Cast) | mod_flag::Attack, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: (tags).into() });
            }
        }
    }
    // 679-685: projectile speed applies to bow damage
    if flag(sml, None, "ProjectileSpeedAppliesToBowDamage") {
        for m in tab(sml, Some(ModType::Inc), Some(&Cfg::default()), &["ProjectileSpeed"]) {
            sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: m.ty, value: m.value.clone(), flags: mod_flag::Bow | mod_flag::Hit, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
        }
    }
    // 686-712: claw -> unarmed conversions (Rigwald's Curse)
    if flag(sml, None, "ClawDamageAppliesToUnarmed") {
        let c = Cfg { flags: mod_flag::Claw | mod_flag::Hit, keyword_flags: keyword_flag::Hit, ..Cfg::default() };
        for m in tab(sml, Some(ModType::Inc), Some(&c), &["Damage"]) {
            if m.flags & mod_flag::Claw != 0 {
                sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: m.ty, value: m.value.clone(), flags: (m.flags & !mod_flag::Claw) | mod_flag::Unarmed | mod_flag::Melee, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
            }
        }
    }
    if flag(sml, None, "ClawAttackSpeedAppliesToUnarmed") {
        let c = cfg_flags(mod_flag::Claw | mod_flag::Attack | mod_flag::Hit);
        for m in tab(sml, Some(ModType::Inc), Some(&c), &["Speed"]) {
            if m.flags & mod_flag::Claw != 0 && m.flags & mod_flag::Attack != 0 {
                sml.add_mod(Mod { name: pom_engine::sym!("Speed"), ty: m.ty, value: m.value.clone(), flags: (m.flags & !mod_flag::Claw) | mod_flag::Unarmed, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
            }
        }
    }
    if flag(sml, None, "ClawCritChanceAppliesToUnarmed") {
        let c = cfg_flags(mod_flag::Claw | mod_flag::Hit);
        for m in tab(sml, Some(ModType::Inc), Some(&c), &["CritChance"]) {
            if m.flags & mod_flag::Claw != 0 {
                sml.add_mod(Mod { name: pom_engine::sym!("CritChance"), ty: m.ty, value: m.value.clone(), flags: (m.flags & !mod_flag::Claw) | mod_flag::Unarmed, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
            }
        }
    }
    // 713-729: Law of the Wilds writes the claw crit chance / multiplier into the MINION's modDB (`env.minion.modDB`).
    if flag(sml, None, "ClawCritChanceAppliesToMinions") {
        let c = cfg_flags(mod_flag::Claw | mod_flag::Hit);
        for m in tab(sml, Some(ModType::Inc), Some(&c), &["CritChance"]) {
            if m.flags & mod_flag::Claw != 0 {
                MINION_MODS.with(|v| v.borrow_mut().push(Mod { name: pom_engine::sym!("CritChance"), ty: m.ty, value: m.value.clone(), flags: 0, keyword_flags: 0, source: m.source.clone(), tags: (vec![]).into() }));
            }
        }
    }
    if flag(sml, None, "ClawCritMultiplierAppliesToMinions") {
        let c = cfg_flags(mod_flag::Claw | mod_flag::Hit);
        for m in tab(sml, Some(ModType::Base), Some(&c), &["CritMultiplier"]) {
            if m.flags & mod_flag::Claw != 0 {
                MINION_MODS.with(|v| v.borrow_mut().push(Mod { name: pom_engine::sym!("CritMultiplier"), ty: m.ty, value: m.value.clone(), flags: 0, keyword_flags: 0, source: m.source.clone(), tags: (vec![]).into() }));
            }
        }
    }
    // 731-765: crit chance / penetration from resistances
    let out = |k: &str| i.output.get(k).copied().unwrap_or(0.0);
    for (flag_name, stat) in [
        ("CritChanceIncreasedByUncappedLightningRes", "LightningResistTotal"),
        ("CritChanceIncreasedByLightningRes", "LightningResist"),
        ("CritChanceIncreasedByOvercappedLightningRes", "LightningResistOverCap"),
        ("CritChanceIncreasedBySpellSuppressChance", "SpellSuppressionChance"),
    ] {
        if flag(sml, None, flag_name) {
            if let Some(m) = tab(i.player, Some(ModType::Flag), None, &[flag_name]).into_iter().next() {
                sml.add_mod(mk("CritChance", ModType::Inc, out(stat), mod_source(&m), 0, 0, vec![]));
            }
        }
    }
    if flag(sml, None, "FirePenIncreasedByUncappedFireRes") {
        if let Some(m) = tab(i.player, Some(ModType::Flag), None, &["FirePenIncreasedByUncappedFireRes"]).into_iter().next() {
            sml.add_mod(mk("FirePenetration", ModType::Base, out("FireResistOverCap"), mod_source(&m), 0, 0, vec![]));
        }
    }
    // 766-786: light radius conversions
    if flag(sml, None, "LightRadiusAppliesToAccuracy") {
        for m in tab(sml, Some(ModType::Inc), Some(&Cfg::default()), &["LightRadius"]) {
            sml.add_mod(Mod { name: pom_engine::sym!("Accuracy"), ty: ModType::Inc, value: m.value.clone(), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
        }
    }
    if flag(sml, None, "LightRadiusAppliesToAreaOfEffect") {
        for m in tab(sml, Some(ModType::Inc), Some(&Cfg::default()), &["LightRadius"]) {
            sml.add_mod(Mod { name: pom_engine::sym!("AreaOfEffect"), ty: ModType::Inc, value: n(floor(mod_num(&m) / 2.0)), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
        }
    }
    if flag(sml, None, "LightRadiusAppliesToDamage") {
        for m in tab(sml, Some(ModType::Inc), Some(&Cfg::default()), &["LightRadius"]) {
            sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: ModType::Inc, value: m.value.clone(), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
        }
    }
    // 787-802
    if flag(sml, None, "CastSpeedAppliesToTrapThrowingSpeed") {
        for m in tab(sml, Some(ModType::Inc), Some(&cfg_flags(mod_flag::Cast)), &["Speed"]) {
            if m.flags == 0 || m.flags & mod_flag::Cast != 0 {
                sml.add_mod(Mod { name: pom_engine::sym!("TrapThrowingSpeed"), ty: ModType::Inc, value: m.value.clone(), flags: m.flags & !mod_flag::Cast & !mod_flag::Attack, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
            }
        }
    }
    if matches!(skill_data.get("arrowSpeedAppliesToAreaOfEffect"), Some(v) if !matches!(v, ScalarValue::Bool(false))) {
        for m in tab(sml, Some(ModType::Inc), Some(&cfg_flags(mod_flag::Bow)), &["ProjectileSpeed"]) {
            sml.add_mod(Mod { name: pom_engine::sym!("AreaOfEffect"), ty: ModType::Inc, value: m.value.clone(), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
        }
    }

    // 803-806: sequentially fired projectiles: the DPS multiplier is the projectile count
    if flag(sml, None, "SequentialProjectiles")
        && !flag(sml, None, "OneShotProj")
        && !flag(sml, None, "NoAdditionalProjectiles")
        && !flag(sml, None, "SingleProjectile")
        && !flag(sml, None, "TriggeredBySnipe")
    {
        let count = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("ProjectileCount")]);
        skill_data.insert("dpsMultiplier".to_string(), ScalarValue::Num(count));
    }

    // 817-903: repeat multipliers
    if i.repeats > 1.0 {
        let repeat_mode = i.config_str.get("repeatMode").map(String::as_str);
        let repeats = i.repeats;
        if repeat_mode != Some("NONE") {
            let average = repeat_mode == Some("AVERAGE");
            for m in tab(sml, Some(ModType::Inc), Some(cfg), &["RepeatFinalAreaOfEffect"]) {
                let v = if average { mod_num(&m) / repeats } else { mod_num(&m) };
                sml.add_mod(Mod { name: pom_engine::sym!("AreaOfEffect"), ty: ModType::Inc, value: n(v), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
            }
            for m in tab(sml, Some(ModType::Inc), Some(cfg), &["RepeatPerRepeatAreaOfEffect"]) {
                let mut v = mod_num(&m) * (repeats - 1.0);
                if average {
                    v /= 2.0;
                }
                sml.add_mod(Mod { name: pom_engine::sym!("AreaOfEffect"), ty: ModType::Inc, value: n(v), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
            }
            for m in tab(sml, Some(ModType::Base), Some(cfg), &["RepeatFinalDoubleDamageChance"]) {
                let v = if average { mod_num(&m) / repeats } else { mod_num(&m) };
                sml.add_mod(Mod { name: pom_engine::sym!("DoubleDamageChance"), ty: ModType::Base, value: n(v), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
            }
            let mut damage_final_more_total = 1.0;
            let mut damage_more_total = 0.0;
            for m in tab(sml, Some(ModType::More), Some(cfg), &["RepeatFinalDamage"]) {
                let mut v = mod_num(&m);
                damage_final_more_total *= 1.0 + v / 100.0;
                damage_more_total += v;
                if average && !flag(sml, None, "OnlyFinalRepeat") {
                    v /= repeats;
                }
                sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: ModType::More, value: n(v), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
            }
            for m in tab(sml, Some(ModType::More), Some(cfg), &["RepeatPerRepeatDamage"]) {
                let mut v = mod_num(&m) * (repeats - 1.0);
                if average {
                    if damage_final_more_total != 1.0 {
                        let mv = mod_num(&m);
                        v = ((100.0 + mv * (repeats - 2.0) / 2.0) * (repeats - 1.0) + (100.0 + mv * (repeats - 1.0)) * damage_final_more_total) / (repeats + damage_more_total / 100.0) - 100.0;
                    } else {
                        v /= 2.0;
                    }
                }
                sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: ModType::More, value: n(v), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
            }
            let mut last_mod: Option<Mod> = None;
            damage_final_more_total = damage_more_total;
            for (count, word) in [(2.0, "One"), (3.0, "Two"), (4.0, "Three")] {
                if count > repeats {
                    break;
                } else if average {
                    for m in tab(sml, Some(ModType::More), Some(cfg), &[&format!("Repeat{word}Damage")]) {
                        damage_more_total += mod_num(&m);
                        last_mod = Some(m);
                    }
                } else if count == repeats {
                    for m in tab(sml, Some(ModType::More), Some(cfg), &[&format!("Repeat{word}Damage")]) {
                        sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: ModType::More, value: m.value.clone(), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
                    }
                }
            }
            if average {
                if let Some(m) = last_mod {
                    let v = (damage_more_total / repeats + 100.0) / (1.0 + damage_final_more_total / repeats / 100.0) - 100.0;
                    sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: ModType::More, value: n(v), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
                }
            }
            if flag(sml, None, "FinalRepeatSumsDamage") {
                for m in tab(sml, Some(ModType::Flag), Some(cfg), &["FinalRepeatSumsDamage"]) {
                    let v = (100.0 * repeats + damage_final_more_total) / (1.0 + damage_final_more_total / 100.0) - 100.0;
                    sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: ModType::More, value: n(v), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
                }
            }
            if i.skill_flags.contains("trap") || i.skill_flags.contains("mine") {
                sml.add_mod(mk("DPS", ModType::More, (repeats - 1.0) * 100.0, "Repeat Count", 0, 0, vec![]));
            }
        }
    }

    // 905-942: weapon damage applied to spells
    if flag(sml, None, "WeaponPhysAppliesToSpells") {
        // `(Sum(...) or 100) / 100`: a Sum is never nil, so the `or 100` never fires.
        let mult = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("WeaponPhysAppliesToSpellsPercent")]) / 100.0;
        sml.add_mod(mk("PhysicalMin", ModType::Base, floor(w1_num("PhysicalMin") * mult), "Runegraft of the Spellbound", mod_flag::Spell, 0, vec![]));
        sml.add_mod(mk("PhysicalMax", ModType::Base, floor(w1_num("PhysicalMax") * mult), "Runegraft of the Spellbound", mod_flag::Spell, 0, vec![]));
    }
    if let Some(ScalarValue::Num(pct)) = skill_data.get("gainPercentBaseWandDamageToSpells").cloned() {
        let mult = pct / 100.0;
        let is_wand = |w: &WeaponSource| w.weapon_type.as_deref() == Some("Wand");
        let w2 = i.weapon2.as_ref();
        if is_wand(w1) && w2.is_some_and(is_wand) {
            let w2 = w2.unwrap();
            for t in DMG_TYPES {
                sml.add_mod(mk(&format!("{t}Min"), ModType::Base, floor((w1_num(&format!("{t}Min")) + w2.get(&format!("{t}Min"))) / 2.0 * mult), "Spellslinger", mod_flag::Spell, 0, vec![]));
                sml.add_mod(mk(&format!("{t}Max"), ModType::Base, floor((w1_num(&format!("{t}Max")) + w2.get(&format!("{t}Max"))) / 2.0 * mult), "Spellslinger", mod_flag::Spell, 0, vec![]));
            }
        } else if is_wand(w1) {
            for t in DMG_TYPES {
                sml.add_mod(mk(&format!("{t}Min"), ModType::Base, floor(w1_num(&format!("{t}Min")) * mult), "Spellslinger", mod_flag::Spell, 0, vec![]));
                sml.add_mod(mk(&format!("{t}Max"), ModType::Base, floor(w1_num(&format!("{t}Max")) * mult), "Spellslinger", mod_flag::Spell, 0, vec![]));
            }
        } else if w2.is_some_and(is_wand) {
            let w2 = w2.unwrap();
            for t in DMG_TYPES {
                sml.add_mod(mk(&format!("{t}Min"), ModType::Base, floor(w2.get(&format!("{t}Min")) * mult), "Spellslinger", mod_flag::Spell, 0, vec![]));
                sml.add_mod(mk(&format!("{t}Max"), ModType::Base, floor(w2.get(&format!("{t}Max")) * mult), "Spellslinger", mod_flag::Spell, 0, vec![]));
            }
        }
    }
    if let Some(ScalarValue::Num(pct)) = skill_data.get("gainPercentBaseDaggerDamageToSpells").cloned() {
        let is_dagger = |w: Option<&WeaponSource>| w.is_some_and(|w| w.get("AddedUsingDagger") != 0.0 || w.weapon_type.as_deref() == Some("Dagger"));
        let w1d = is_dagger(Some(w1));
        let w2d = is_dagger(i.weapon2.as_ref());
        // With two daggers each contributes 60% as much (gem text, 3.26.0); upstream kept 0.5.
        let mult = pct / 100.0 * if w1d && w2d { if pom_offence::data::pom_fixes_on() { 0.6 } else { 0.5 } } else { 1.0 };
        for t in DMG_TYPES {
            let base_min = if w1d { w1_num(&format!("{t}Min")) } else { 0.0 } + if w2d { i.weapon2.as_ref().map_or(0.0, |w| w.get(&format!("{t}Min"))) } else { 0.0 };
            let base_max = if w1d { w1_num(&format!("{t}Max")) } else { 0.0 } + if w2d { i.weapon2.as_ref().map_or(0.0, |w| w.get(&format!("{t}Max"))) } else { 0.0 };
            sml.add_mod(mk(&format!("{t}Min"), ModType::Base, floor(base_min * mult), "Blade Blast of Dagger Detonation", mod_flag::Spell, 0, vec![]));
            sml.add_mod(mk(&format!("{t}Max"), ModType::Base, floor(base_max * mult), "Blade Blast of Dagger Detonation", mod_flag::Spell, 0, vec![]));
        }
    }

    // 978-1036: random physical conversion / gain-as
    let phys_mode = i.config_str.get("physMode").map(String::as_str).unwrap_or("AVERAGE").to_string();
    let random_names = ["PhysicalDamageGainAsRandom", "PhysicalDamageConvertToRandom", "PhysicalDamageGainAsColdOrLightning"];
    let mut processed: Vec<usize> = Vec::new();
    for c in [Some(cfg.clone()), weapon_cfg_for(i, cfg, true), weapon_cfg_for(i, cfg, false)].into_iter().flatten() {
        let syms: Vec<Sym> = random_names.iter().map(|s| Sym::new(s)).collect();
        if sml.sum(ModType::Base, Some(&c), &syms) > 0.0 {
            for (src_name, kind) in [("PhysicalDamageGainAsRandom", "GainAs"), ("PhysicalDamageConvertToRandom", "ConvertTo")] {
                for (m, id) in tab_id(sml, Some(ModType::Base), Some(&c), &[src_name]) {
                    if !processed.contains(&id) {
                        processed.push(id);
                        let eff = mod_num(&m) / 3.0;
                        let add = |sml: &mut ModStore, t: &str, v: f64| {
                            sml.add_mod(Mod { name: Sym::new(&format!("PhysicalDamage{kind}{t}")), ty: ModType::Base, value: n(v), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
                        };
                        match phys_mode.as_str() {
                            "AVERAGE" => {
                                add(sml, "Fire", eff);
                                add(sml, "Cold", eff);
                                add(sml, "Lightning", eff);
                            }
                            "FIRE" => add(sml, "Fire", mod_num(&m)),
                            "COLD" => add(sml, "Cold", mod_num(&m)),
                            "LIGHTNING" => add(sml, "Lightning", mod_num(&m)),
                            _ => {}
                        }
                    }
                }
            }
            for (m, id) in tab_id(sml, Some(ModType::Base), Some(&c), &["PhysicalDamageGainAsColdOrLightning"]) {
                if !processed.contains(&id) {
                    processed.push(id);
                    let eff = mod_num(&m) / 2.0;
                    let add = |sml: &mut ModStore, t: &str, v: f64| {
                        sml.add_mod(Mod { name: Sym::new(&format!("PhysicalDamageGainAs{t}")), ty: ModType::Base, value: n(v), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
                    };
                    match phys_mode.as_str() {
                        "AVERAGE" | "FIRE" => {
                            add(sml, "Cold", eff);
                            add(sml, "Lightning", eff);
                        }
                        "COLD" => add(sml, "Cold", mod_num(&m)),
                        "LIGHTNING" => add(sml, "Lightning", mod_num(&m)),
                        _ => {}
                    }
                }
            }
        }
    }

    // 1081-1087: projectile distance ramps
    if i.skill_flags.contains("projectile") {
        if flag(sml, None, "PointBlank") {
            sml.add_mod(mk(
                "Damage",
                ModType::More,
                30.0,
                "Point Blank",
                mod_flag::Attack | mod_flag::Projectile,
                0,
                vec![ramp_tag(&[(10.0, 1.0), (35.0, 0.0), (120.0, -1.0)])],
            ));
        }
        if flag(sml, None, "FarShot") {
            sml.add_mod(mk(
                "Damage",
                ModType::More,
                100.0,
                "Far Shot",
                mod_flag::Attack | mod_flag::Projectile,
                0,
                vec![ramp_tag(&[(10.0, -0.2), (25.0, 0.0), (70.0, 0.6)])],
            ));
        }
    }
}

fn ramp_tag(points: &[(f64, f64)]) -> Tag {
    let ramp = Value::List(Arc::new(points.iter().map(|(a, b)| Value::List(Arc::new(vec![Value::Num(*a), Value::Num(*b)]))).collect()));
    Tag { kind: pom_engine::sym!("DistanceRamp"), fields: vec![(pom_engine::sym!("ramp"), ramp)] }
}

/// The weapon-hand cfgs `activeSkill.weapon1Cfg`/`weapon2Cfg` (only `flags` and `skillCond` matter to these sums).
fn weapon_cfg_for(i: &PrepInput, cfg: &Cfg, first: bool) -> Option<Cfg> {
    if first {
        if !i.skill_flags.contains("weapon1Attack") {
            return None;
        }
        let wf = i.weapon1_flags.or_else(|| i.weapon1.weapon_type.as_deref().and_then(|t| pom_offence::weapon::weapon_flags(t, i.weapon1.counts_as_all_1h))).unwrap_or(0);
        Some(pom_offence::weapon::weapon_cfg(cfg, wf, "MainHandAttack"))
    } else {
        if !i.skill_flags.contains("weapon2Attack") {
            return None;
        }
        let w2 = i.weapon2.as_ref()?;
        let wf = i.weapon2_flags.or_else(|| w2.weapon_type.as_deref().and_then(|t| pom_offence::weapon::weapon_flags(t, w2.counts_as_all_1h))).unwrap_or(0);
        Some(pom_offence::weapon::weapon_cfg(cfg, wf, "OffHandAttack"))
    }
}

/// `skillModList:ReplaceMod(name, type, value, source, flags)` (ModList.lua:ReplaceModInternal, own list then the
/// parent chain): replaces the first matching mod (name/type/flags/keyword flags 0/source) with a zero-valued one.
/// The parent stores are shared snapshots; the replacement is made in place through the `Arc` (single-threaded, and
/// the snapshot is per skill computation, so it does not leak into the player's real modDB).
fn replace_zero(sml: &mut ModStore, name: &str, ty: ModType, source: &str, flags: u64) -> bool {
    use pom_engine::modstore::store::Backing;
    let hit = |m: &mut Mod| -> bool {
        if m.name.as_str() == name && m.ty == ty && m.flags == flags && m.keyword_flags == 0 && m.source.as_deref() == Some(source) {
            m.value = n(0.0);
            m.tags.clear();
            true
        } else {
            false
        }
    };
    match &mut sml.backing {
        Backing::List(v) => {
            for m in std::sync::Arc::make_mut(v).iter_mut() {
                if hit(m) {
                    return true;
                }
            }
        }
        Backing::Db(map) => {
            if let Some(v) = map.get_mut(&Sym::new(name)) {
                for m in v.iter_mut() {
                    if hit(m) {
                        return true;
                    }
                }
            }
        }
    }
    if let Some(p) = &sml.parent {
        // SAFETY: single-threaded; no reference into the parent is live across this call.
        let pm = unsafe { &mut *(std::sync::Arc::as_ptr(p) as *mut ModStore) };
        return replace_zero(pm, name, ty, source, flags);
    }
    false
}
