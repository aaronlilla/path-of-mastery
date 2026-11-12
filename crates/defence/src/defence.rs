//! Port of `calcs.defence(env, actor)` (Modules/CalcDefence.lua lines 651-1671).
//!
//! Fields this port does not set are left at their `pre_output` (recorded, pre-call) value, so a
//! field `calcs.defence` never touches still matches the answer key exactly; a field it changes only
//! shows a mismatch if this port's formula for it is missing or wrong. Named gaps are noted at the
//! code they affect.
use crate::data::misc;
use crate::snapshot::ArmourData;
use crate::tools::{mod_, round, val};
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_engine::fxhash::HashMap;

pub(crate) fn s(name: &str) -> Sym {
    Sym::new(name)
}
fn slot_cfg(slot: &str) -> Cfg {
    Cfg { slot_name: Some(std::sync::Arc::from(slot)), ..Default::default() }
}

pub struct DefenceEnv {
    pub enemy_level: f64,
    pub mode_effective: bool,
    pub necromantic_aegis: bool,
    pub config_input: HashMap<String, f64>,
    pub config_flags: HashMap<String, bool>,
    pub is_minion: bool,
    /// `actor.partyMembers.output` (party tab "Party Member Stats").
    pub party_output: HashMap<String, f64>,
    /// `calcs.resistances` already ran on the actor (a minion computes it before its Formless Inferno life recompute).
    pub resist_done: bool,
}

pub(crate) const DMG_TYPES: &[&str] = &["Physical", "Lightning", "Cold", "Fire", "Chaos"];
pub(crate) fn is_elemental(e: &str) -> bool {
    matches!(e, "Fire" | "Cold" | "Lightning")
}

/// `calcs.hitChance(evasion, accuracy)` (line 58-65).
pub fn hit_chance(evasion: f64, accuracy: f64) -> f64 {
    if accuracy < 0.0 {
        return 5.0;
    }
    let raw = accuracy / (accuracy + (evasion / 5.0).powf(0.9)) * 125.0;
    round(raw).min(100.0).max(5.0)
}

/// `calcs.armourReductionF` (line 67-73).
pub fn armour_reduction_f(armour: f64, raw: f64) -> f64 {
    if armour == 0.0 && raw == 0.0 {
        return 0.0;
    }
    armour / (armour + raw * 5.0) * 100.0
}
/// `calcs.armourReduction` (line 75-77).
pub fn armour_reduction(armour: f64, raw: f64) -> f64 {
    round(armour_reduction_f(armour, raw))
}

pub fn defence(
    store: &mut ModStore,
    enemy: &ModStore,
    item_armour: &HashMap<String, ArmourData>,
    env: &DefenceEnv,
    pre_output: &HashMap<String, f64>,
) -> HashMap<String, f64> {
    let mut output = pre_output.clone();
    let unlucky_worst_of = env.config_input.get("EHPUnluckyWorstOf").copied();

    // Attribute bonuses (`doActorAttribsPoolsConditions`, Modules/CalcPerform.lua:516-543). Runs
    // as part of `calcs.perform`, strictly before `calcs.defence` in the real pipeline, mutating
    // the same persistent ModDB. Most recorded stores already contain these mods (`calcs.perform`
    // already ran for that pass), but a minority of events are missing them even though their
    // recorded `postOutput` was computed WITH them applied - a harness capture-timing gap (the
    // recorder's store snapshot for those specific passes was taken before `calcs.perform`
    // finished, not a real absence: confirmed with probes - `EnergyShield`/`Evasion`/
    // `ManaRegen`/etc. mismatches on affected builds are explained exactly by `floor(output.Int/10)`/
    // `floor(output.Dex/5)`/`floor(output.Int/2)` "Intelligence"/"Dexterity" mods absent from that
    // one event's store dump while sibling events for the same build/actor have them).
    // Replicated here, guarded by both the real flags AND a same-source presence
    // check so a store that already has the mod (the common case) is never double-counted. Only
    // the four sub-mods that feed a field this function computes are replicated - Strength's
    // PhysicalDamage/Melee mod and Dexterity's Accuracy mod are offence-only and never read by
    // anything below, so skipped.
    fn has_source(store: &ModStore, ty: ModType, name: Sym, source: &str) -> bool {
        store.tabulate(Some(ty), None, &[name]).into_iter().any(|(_, m)| unsafe { (*m).source.as_deref() } == Some(source))
    }
    if !store.flag(None, &[pom_engine::sym!("NoAttributeBonuses")]) {
        let str_ = output.get("Str").copied().unwrap_or(0.0);
        let dex = output.get("Dex").copied().unwrap_or(0.0);
        let int = output.get("Int").copied().unwrap_or(0.0);
        if !store.flag(None, &[pom_engine::sym!("NoStrengthAttributeBonuses")]) && !store.flag(None, &[pom_engine::sym!("NoStrBonusToLife")]) && !has_source(store, ModType::Base, pom_engine::sym!("Life"), "Strength") {
            store.add_mod(crate::modbuild::m("Life", ModType::Base, (str_ / 2.0).floor(), "Strength"));
        }
        if !store.flag(None, &[pom_engine::sym!("NoDexterityAttributeBonuses")]) && !store.flag(None, &[pom_engine::sym!("NoDexBonusToEvasion")]) && !has_source(store, ModType::Inc, pom_engine::sym!("Evasion"), "Dexterity") {
            store.add_mod(crate::modbuild::m("Evasion", ModType::Inc, (dex / 5.0).floor(), "Dexterity"));
        }
        if !store.flag(None, &[pom_engine::sym!("NoIntelligenceAttributeBonuses")]) {
            if !store.flag(None, &[pom_engine::sym!("NoIntBonusToMana")]) && !has_source(store, ModType::Base, pom_engine::sym!("Mana"), "Intelligence") {
                store.add_mod(crate::modbuild::m("Mana", ModType::Base, (int / 2.0).floor(), "Intelligence"));
            }
            if !store.flag(None, &[pom_engine::sym!("NoIntBonusToES")]) && !has_source(store, ModType::Inc, pom_engine::sym!("EnergyShield"), "Intelligence") {
                store.add_mod(crate::modbuild::m("EnergyShield", ModType::Inc, (int / 10.0).floor(), "Intelligence"));
            }
        }
    }

    if !env.resist_done {
        crate::resist::resistances(store, &mut output);
    }
    sync_actor_output(store, &output);

    // ===== Block / Spell Block (lines 679-790) =====
    let block_chance_max = store.sum(ModType::Base, None, &[pom_engine::sym!("BlockChanceMax")]).min(misc("BlockChanceCap"));
    let party_out = |k: &str| env.party_output.get(k).copied().unwrap_or(0.0);
    let block_chance_max = if store.flag(None, &[pom_engine::sym!("MaximumBlockAttackChanceIsEqualToPartyMember")]) { party_out("BlockChanceMax") } else { block_chance_max };
    output.insert("BlockChanceMax".into(), block_chance_max);
    output.insert("BlockChanceOverCap".into(), 0.0);
    output.insert("SpellBlockChanceOverCap".into(), 0.0);

    let mut base_block_chance = 0.0;
    if let Some(w2) = item_armour.get("Weapon 2") {
        base_block_chance += w2.block_chance;
    }
    if let Some(w3) = item_armour.get("Weapon 3") {
        base_block_chance += w3.block_chance;
    }
    output.insert("ShieldBlockChance".into(), base_block_chance);
    // `actor.output` is live: BlockChance PerStat mods read `ShieldBlockChance` (line 695).
    sync_actor_output(store, &output);
    // `not env.keystonesAdded["Necromantic Aegis"] and modDB:Override(...)`: Necromantic Aegis
    // reroutes the minion's own shield block onto the player and back (lines 696-699); minion
    // support and the parent/party-member block-chance fallbacks (lines 680-684, 701-704) are not
    // ported.
    if !env.necromantic_aegis {
        if let Some(v) = store.override_(None, &[pom_engine::sym!("ReplaceShieldBlock")]).and_then(|v| v.num()) {
            base_block_chance = v;
        }
    }

    let block_chance;
    if store.flag(None, &[pom_engine::sym!("BlockAttackChanceIsEqualToPartyMember")]) {
        block_chance = party_out("BlockChance").min(block_chance_max);
        output.insert("BlockChance".into(), block_chance);
    } else if store.flag(None, &[pom_engine::sym!("MaxBlockIfNotBlockedRecently")]) {
        block_chance = block_chance_max;
        output.insert("BlockChance".into(), block_chance);
    } else {
        let inc = store.sum(ModType::Inc, None, &[pom_engine::sym!("BlockChance")]);
        let more = store.more(None, &[pom_engine::sym!("BlockChance")]);
        let total = round((base_block_chance + store.sum(ModType::Base, None, &[pom_engine::sym!("BlockChance")])) * (1.0 + inc / 100.0) * more);
        block_chance = total.min(block_chance_max);
        output.insert("BlockChance".into(), block_chance);
        output.insert("BlockChanceOverCap".into(), (total - block_chance_max).max(0.0));
    }

    let projectile_block_chance = (block_chance + store.sum(ModType::Base, None, &[pom_engine::sym!("ProjectileBlockChance")]) * mod_(store, None, &[pom_engine::sym!("BlockChance")])).min(block_chance_max);
    output.insert("ProjectileBlockChance".into(), projectile_block_chance);

    let spell_block_chance_max = if store.flag(None, &[pom_engine::sym!("SpellBlockChanceMaxIsBlockChanceMax")]) {
        block_chance_max
    } else {
        store.sum(ModType::Base, None, &[pom_engine::sym!("SpellBlockChanceMax")]).min(misc("BlockChanceCap"))
    };
    output.insert("SpellBlockChanceMax".into(), spell_block_chance_max);

    // `actor.output` is live: SpellBlockChance PerStat mods read `BlockChanceOverCap` set just above.
    sync_actor_output(store, &output);
    let (spell_block_chance, spell_projectile_block_chance);
    if store.flag(None, &[pom_engine::sym!("MaxSpellBlockIfNotBlockedRecently")]) {
        spell_block_chance = spell_block_chance_max;
        spell_projectile_block_chance = spell_block_chance_max;
        output.insert("SpellBlockChance".into(), spell_block_chance);
        output.insert("SpellProjectileBlockChance".into(), spell_projectile_block_chance);
    } else if store.flag(None, &[pom_engine::sym!("SpellBlockChanceIsBlockChance")]) {
        spell_block_chance = block_chance;
        spell_projectile_block_chance = projectile_block_chance;
        output.insert("SpellBlockChance".into(), spell_block_chance);
        output.insert("SpellProjectileBlockChance".into(), spell_projectile_block_chance);
        output.insert("SpellBlockChanceOverCap".into(), *output.get("BlockChanceOverCap").unwrap_or(&0.0));
    } else {
        let inc = store.sum(ModType::Inc, None, &[pom_engine::sym!("BlockChance")]);
        let more = store.more(None, &[pom_engine::sym!("BlockChance")]);
        let total = round(store.sum(ModType::Base, None, &[pom_engine::sym!("SpellBlockChance")]) * (1.0 + inc / 100.0) * more);
        spell_block_chance = total.min(spell_block_chance_max);
        output.insert("SpellBlockChance".into(), spell_block_chance);
        output.insert("SpellBlockChanceOverCap".into(), (total - spell_block_chance_max).max(0.0));
        spell_projectile_block_chance = (spell_block_chance + store.sum(ModType::Base, None, &[pom_engine::sym!("ProjectileSpellBlockChance")]) * mod_(store, None, &[pom_engine::sym!("SpellBlockChance")])).min(spell_block_chance_max).max(0.0);
        output.insert("SpellProjectileBlockChance".into(), spell_projectile_block_chance);
    }

    crate::bd_def::block(base_block_chance, block_chance_max, block_chance, *output.get("BlockChanceOverCap").unwrap_or(&0.0), spell_block_chance_max, spell_block_chance, *output.get("SpellBlockChanceOverCap").unwrap_or(&0.0));
    if store.flag(None, &[pom_engine::sym!("CannotBlockAttacks")]) {
        output.insert("BlockChance".into(), 0.0);
        output.insert("ProjectileBlockChance".into(), 0.0);
    }
    if store.flag(None, &[pom_engine::sym!("CannotBlockSpells")]) {
        output.insert("SpellBlockChance".into(), 0.0);
        output.insert("SpellProjectileBlockChance".into(), 0.0);
    }

    for block_type in ["BlockChance", "ProjectileBlockChance", "SpellBlockChance", "SpellProjectileBlockChance"] {
        let base = *output.get(block_type).unwrap_or(&0.0);
        let mut eff = if env.mode_effective { (base - enemy.sum(ModType::Base, None, &[pom_engine::sym!("reduceEnemyBlock")])).max(0.0) } else { base };
        let mut rolls = 0i32;
        if env.mode_effective {
            if store.flag(None, &[s(&format!("{block_type}IsLucky"))]) {
                rolls += 1;
            }
            if store.flag(None, &[s(&format!("{block_type}IsUnlucky"))]) {
                rolls -= 1;
            }
            if store.flag(None, &[pom_engine::sym!("ExtremeLuck")]) {
                rolls *= 2;
            }
        }
        if let Some(worst_of) = unlucky_worst_of {
            if worst_of != 1.0 {
                rolls = (-worst_of / 2.0) as i32;
            }
        }
        if rolls != 0 {
            let p = eff / 100.0;
            if store.flag(None, &[pom_engine::sym!("Unexciting")]) {
                eff = (3.0 * p.powi(2) - 2.0 * p.powi(3)) * 100.0;
            } else if rolls > 0 {
                eff = (1.0 - (1.0 - p).powi(rolls + 1)) * 100.0;
            } else {
                eff = p.powi(rolls.abs()) * eff;
            }
        }
        output.insert(format!("Effective{block_type}"), eff);
    }
    let eff_avg = (output["EffectiveBlockChance"] + output["EffectiveProjectileBlockChance"] + output["EffectiveSpellBlockChance"] + output["EffectiveSpellProjectileBlockChance"]) / 4.0;
    output.insert("EffectiveAverageBlockChance".into(), eff_avg);
    let block_effect = 100.0 - store.sum(ModType::Base, None, &[pom_engine::sym!("BlockEffect")]);
    output.insert("BlockEffect".into(), block_effect);
    if block_effect != 0.0 {
        output.insert("ShowBlockEffect".into(), 1.0);
        output.insert("DamageTakenOnBlock".into(), 100.0 - block_effect);
    }

    // Armour to ES Recharge conversion from Armour and Energy Shield Mastery (lines 792-800).
    if store.flag(None, &[pom_engine::sym!("ArmourAppliesToEnergyShieldRecharge")]) {
        let multiplier = store.max(None, &[pom_engine::sym!("ImprovedArmourAppliesToEnergyShieldRecharge")]).unwrap_or(100.0) / 100.0;
        let found = store.tabulate(Some(ModType::Inc), None, &[pom_engine::sym!("Armour"), pom_engine::sym!("ArmourAndEvasion"), pom_engine::sym!("Defences")]);
        let mut new_mods: Vec<pom_engine::modifier::Mod> = Vec::new();
        for (_, mp) in found {
            let m = unsafe { &*mp };
            let pom_engine::value::Value::Num(v) = m.value else { continue };
            // `calcLib.getConvertedModTags`: tags are copied, a `limitTotal` tag's `limit` is scaled.
            let tags: Vec<pom_engine::modifier::Tag> = m
                .tags
                .iter()
                .map(|t| {
                    let mut t = t.clone();
                    if t.get(pom_engine::sym!("limitTotal")).truthy() {
                        for (k, fv) in t.fields.iter_mut() {
                            if k.as_str() == "limit" {
                                if let pom_engine::value::Value::Num(l) = fv {
                                    *l *= multiplier;
                                }
                            }
                        }
                    }
                    t
                })
                .collect();
            new_mods.push(pom_engine::modifier::Mod { name: pom_engine::sym!("EnergyShieldRecharge"), ty: ModType::Inc, value: pom_engine::value::Value::Num((v * multiplier).floor()), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: (tags).into() });
        }
        for nm in new_mods {
            store.add_mod(nm);
        }
    }
    // Rare mastery-node dynamic mods (lines 802-829).
    if store.flag(None, &[pom_engine::sym!("ArmourIncreasedByUncappedFireRes")]) {
        if let Some((_, m)) = store.tabulate(Some(ModType::Flag), None, &[pom_engine::sym!("ArmourIncreasedByUncappedFireRes")]).into_iter().next() {
            let src = unsafe { (*m).source.clone() };
            store.add_mod(crate::modbuild::m("Armour", ModType::Inc, output["FireResistTotal"], src.as_deref().unwrap_or("")));
        }
    }
    if store.flag(None, &[pom_engine::sym!("ArmourIncreasedByOvercappedFireRes")]) {
        if let Some((_, m)) = store.tabulate(Some(ModType::Flag), None, &[pom_engine::sym!("ArmourIncreasedByOvercappedFireRes")]).into_iter().next() {
            let src = unsafe { (*m).source.clone() };
            store.add_mod(crate::modbuild::m("Armour", ModType::Inc, output["FireResistOverCap"], src.as_deref().unwrap_or("")));
        }
    }
    if store.flag(None, &[pom_engine::sym!("EvasionRatingIncreasedByUncappedColdRes")]) {
        if let Some((_, m)) = store.tabulate(Some(ModType::Flag), None, &[pom_engine::sym!("EvasionRatingIncreasedByUncappedColdRes")]).into_iter().next() {
            let src = unsafe { (*m).source.clone() };
            store.add_mod(crate::modbuild::m("Evasion", ModType::Inc, output["ColdResistTotal"], src.as_deref().unwrap_or("")));
        }
    }
    if store.flag(None, &[pom_engine::sym!("EvasionRatingIncreasedByOvercappedColdRes")]) {
        if let Some((_, m)) = store.tabulate(Some(ModType::Flag), None, &[pom_engine::sym!("EvasionRatingIncreasedByOvercappedColdRes")]).into_iter().next() {
            let src = unsafe { (*m).source.clone() };
            store.add_mod(crate::modbuild::m("Evasion", ModType::Inc, output["ColdResistOverCap"], src.as_deref().unwrap_or("")));
        }
    }
    if store.flag(None, &[pom_engine::sym!("EnergyShieldIncreasedByChanceToBlockSpellDamage")]) {
        if let Some((_, m)) = store.tabulate(Some(ModType::Flag), None, &[pom_engine::sym!("EnergyShieldIncreasedByChanceToBlockSpellDamage")]).into_iter().next() {
            let src = unsafe { (*m).source.clone() };
            store.add_mod(crate::modbuild::m("EnergyShield", ModType::Inc, output["SpellBlockChance"], src.as_deref().unwrap_or("")));
        }
    }
    if store.flag(None, &[pom_engine::sym!("EnergyShieldIncreasedByChaosResistance")]) {
        if let Some((_, m)) = store.tabulate(Some(ModType::Flag), None, &[pom_engine::sym!("EnergyShieldIncreasedByChaosResistance")]).into_iter().next() {
            let src = unsafe { (*m).source.clone() };
            store.add_mod(crate::modbuild::m("EnergyShield", ModType::Inc, output["ChaosResist"], src.as_deref().unwrap_or("")));
        }
    }

    // ===== Primary defences: energy shield, evasion, armour, ward (lines 845-1135) =====
    let iron_reflexes = store.flag(None, &[pom_engine::sym!("IronReflexes")]);
    let (mut ward, mut energy_shield, mut armour, mut evasion) = (0.0, 0.0, 0.0, 0.0);
    let (mut gear_ward, mut gear_energy_shield, mut gear_armour, mut gear_evasion) = (0.0, 0.0, 0.0, 0.0);
    crate::bd_def::slots_init();
    for &slot in crate::conditionals::ARMOUR_SLOTS {
        let Some(a) = item_armour.get(slot) else { continue };
        let cfg = slot_cfg(slot);
        let es_base = if !store.flag(None, &[s(&format!("GainNoEnergyShieldFrom{slot}"))]) { a.energy_shield } else { 0.0 };
        let mut arm_base = if !store.flag(None, &[s(&format!("GainNoArmourFrom{slot}"))]) { a.armour } else { 0.0 };
        let mut eva_base = if !(store.flag(None, &[s(&format!("GainNoEvasionFrom{slot}"))]) || (store.flag(None, &[s(&format!("GainNoArmourFrom{slot}"))]) && iron_reflexes)) { a.evasion } else { 0.0 };
        let mut ward_base = if !store.flag(None, &[s(&format!("GainNoWardFrom{slot}"))]) { a.ward } else { 0.0 };
        if slot == "Body Armour" && store.flag(None, &[pom_engine::sym!("ConvertBodyArmourArmourEvasionToWard")]) {
            let conv = (store.sum(ModType::Base, None, &[pom_engine::sym!("BodyArmourArmourEvasionToWardPercent")]) / 100.0).min(1.0);
            let conv_arm = arm_base * conv;
            let conv_eva = eva_base * conv;
            arm_base -= conv_arm;
            eva_base -= conv_eva;
            ward_base += conv_eva + conv_arm;
        }
        if ward_base > 0.0 {
            if store.flag(None, &[pom_engine::sym!("EnergyShieldToWard")]) {
                let inc = store.sum(ModType::Inc, Some(&cfg), &[pom_engine::sym!("Ward"), pom_engine::sym!("Defences"), pom_engine::sym!("EnergyShield")]);
                let more = store.more(Some(&cfg), &[pom_engine::sym!("Ward"), pom_engine::sym!("Defences")]);
                ward += ward_base * (1.0 + inc / 100.0) * more;
                crate::bd_def::slot_row("Ward", ward_base, Some(inc), more, ward_base * (1.0 + inc / 100.0) * more, slot, true);
            } else {
                ward += ward_base * mod_(store, Some(&cfg), &[pom_engine::sym!("Ward"), pom_engine::sym!("Defences")]);
                crate::bd_def::slot(store, slot, None, Some(&cfg), ward_base, None, &["Ward", "Defences"], true);
            }
            gear_ward += ward_base;
        }
        if es_base > 0.0 {
            if store.flag(None, &[pom_engine::sym!("EnergyShieldToWard")]) {
                let more = store.more(Some(&cfg), &[pom_engine::sym!("EnergyShield"), pom_engine::sym!("Defences")]);
                energy_shield += es_base * more;
                gear_energy_shield += es_base;
                crate::bd_def::slot_row("EnergyShield", es_base, None, more, es_base * more, slot, true);
            } else if !store.flag(None, &[pom_engine::sym!("ConvertArmourESToLife")]) {
                energy_shield += es_base * mod_(store, Some(&cfg), &[pom_engine::sym!("EnergyShield"), pom_engine::sym!("Defences"), s(&format!("{slot}ESAndArmour"))]);
                gear_energy_shield += es_base;
                if pom_offence::bd::on() {
                    crate::bd_def::slot(store, slot, None, Some(&cfg), es_base, None, &["EnergyShield", "Defences", &format!("{slot}ESAndArmour")], true);
                }
            }
        }
        if arm_base > 0.0 {
            armour += arm_base * mod_(store, Some(&cfg), &[pom_engine::sym!("Armour"), pom_engine::sym!("ArmourAndEvasion"), pom_engine::sym!("Defences"), s(&format!("{slot}ESAndArmour"))]);
            gear_armour += arm_base;
            if pom_offence::bd::on() {
                crate::bd_def::slot(store, slot, None, Some(&cfg), arm_base, None, &["Armour", "ArmourAndEvasion", "Defences", &format!("{slot}ESAndArmour")], true);
            }
        }
        if eva_base > 0.0 {
            gear_evasion += eva_base;
            crate::bd_def::slot(store, slot, None, Some(&cfg), eva_base, None, &["Evasion", "ArmourAndEvasion", "Defences"], true);
            if iron_reflexes {
                armour += eva_base * mod_(store, Some(&cfg), &[pom_engine::sym!("Armour"), pom_engine::sym!("Evasion"), pom_engine::sym!("ArmourAndEvasion"), pom_engine::sym!("Defences")]);
            } else {
                evasion += eva_base * mod_(store, Some(&cfg), &[pom_engine::sym!("Evasion"), pom_engine::sym!("ArmourAndEvasion"), pom_engine::sym!("Defences")]);
            }
        }
        let _ = (es_base, arm_base, eva_base, ward_base);
    }

    let ward_base = store.sum(ModType::Base, None, &[pom_engine::sym!("Ward")]);
    if ward_base > 0.0 {
        if store.flag(None, &[pom_engine::sym!("EnergyShieldToWard")]) {
            let inc = store.sum(ModType::Inc, None, &[pom_engine::sym!("Ward"), pom_engine::sym!("Defences"), pom_engine::sym!("EnergyShield")]);
            let more = store.more(None, &[pom_engine::sym!("Ward"), pom_engine::sym!("Defences")]);
            ward += ward_base * (1.0 + inc / 100.0) * more;
            crate::bd_def::slot_row("Ward", ward_base, Some(inc), more, ward_base * (1.0 + inc / 100.0) * more, "Global", false);
        } else {
            ward += ward_base * mod_(store, None, &[pom_engine::sym!("Ward"), pom_engine::sym!("Defences")]);
            crate::bd_def::slot(store, "Global", None, None, ward_base, None, &["Ward", "Defences"], false);
        }
    }
    let es_base = store.sum(ModType::Base, None, &[pom_engine::sym!("EnergyShield")]);
    if es_base > 0.0 {
        if store.flag(None, &[pom_engine::sym!("EnergyShieldToWard")]) {
            energy_shield += es_base * store.more(None, &[pom_engine::sym!("EnergyShield"), pom_engine::sym!("Defences")]);
        } else {
            energy_shield += es_base * mod_(store, None, &[pom_engine::sym!("EnergyShield"), pom_engine::sym!("Defences")]);
        }
        if pom_offence::bd::on() {
            let inc = store.sum(ModType::Inc, None, &[pom_engine::sym!("Defences"), pom_engine::sym!("EnergyShield")]);
            let more = store.more(None, &[pom_engine::sym!("EnergyShield"), pom_engine::sym!("Defences")]);
            crate::bd_def::slot_row("EnergyShield", es_base, Some(inc), more, es_base * (1.0 + inc / 100.0) * more, "Global", false);
        }
    }
    let arm_base = store.sum(ModType::Base, None, &[pom_engine::sym!("Armour"), pom_engine::sym!("ArmourAndEvasion")]);
    if arm_base > 0.0 {
        armour += arm_base * mod_(store, None, &[pom_engine::sym!("Armour"), pom_engine::sym!("ArmourAndEvasion"), pom_engine::sym!("Defences")]);
        crate::bd_def::slot(store, "Global", None, None, arm_base, None, &["Armour", "ArmourAndEvasion", "Defences"], false);
    }
    let eva_base = store.sum(ModType::Base, None, &[pom_engine::sym!("Evasion"), pom_engine::sym!("ArmourAndEvasion")]);
    if eva_base > 0.0 {
        if iron_reflexes {
            armour += eva_base * mod_(store, None, &[pom_engine::sym!("Armour"), pom_engine::sym!("Evasion"), pom_engine::sym!("ArmourAndEvasion"), pom_engine::sym!("Defences")]);
            crate::bd_def::slot(store, "Conversion", Some("Evasion to Armour"), None, eva_base, None, &["Armour", "Evasion", "ArmourAndEvasion", "Defences"], false);
        } else {
            evasion += eva_base * mod_(store, None, &[pom_engine::sym!("Evasion"), pom_engine::sym!("ArmourAndEvasion"), pom_engine::sym!("Defences")]);
            crate::bd_def::slot(store, "Global", None, None, eva_base, None, &["Evasion", "ArmourAndEvasion", "Defences"], false);
        }
    }
    let conv_mana_to_armour = store.sum(ModType::Base, None, &[pom_engine::sym!("ManaConvertToArmour")]);
    if conv_mana_to_armour > 0.0 {
        let base = 2.0 * store.sum(ModType::Base, None, &[pom_engine::sym!("Mana")]) * conv_mana_to_armour / 100.0;
        let total = base * mod_(store, None, &[pom_engine::sym!("Mana"), pom_engine::sym!("Armour"), pom_engine::sym!("ArmourAndEvasion"), pom_engine::sym!("Defences")]);
        armour += total;
        crate::bd_def::slot(store, "Conversion", Some("Mana to Armour"), None, base, Some(total), &["Armour", "ArmourAndEvasion", "Defences", "Mana"], false);
    }
    let conv_mana_to_es = store.sum(ModType::Base, None, &[pom_engine::sym!("ManaGainAsEnergyShield")]);
    if conv_mana_to_es > 0.0 {
        let base = store.sum(ModType::Base, None, &[pom_engine::sym!("Mana")]) * conv_mana_to_es / 100.0;
        energy_shield += base * mod_(store, None, &[pom_engine::sym!("Mana"), pom_engine::sym!("EnergyShield"), pom_engine::sym!("Defences")]);
        crate::bd_def::slot(store, "Conversion", Some("Mana to Energy Shield"), None, base, None, &["EnergyShield", "Defences", "Mana"], false);
    }
    let conv_life_to_armour = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeGainAsArmour")]);
    if conv_life_to_armour > 0.0 {
        let base = store.sum(ModType::Base, None, &[pom_engine::sym!("Life")]) * conv_life_to_armour / 100.0;
        let total = if store.flag(None, &[pom_engine::sym!("ChaosInoculation")]) { 1.0 } else { base * mod_(store, None, &[pom_engine::sym!("Life"), pom_engine::sym!("Armour"), pom_engine::sym!("ArmourAndEvasion"), pom_engine::sym!("Defences")]) };
        armour += total;
        crate::bd_def::slot(store, "Conversion", Some("Life to Armour"), None, base, Some(total), &["Armour", "ArmourAndEvasion", "Defences", "Life"], false);
    }
    let conv_life_to_es = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeConvertToEnergyShield"), pom_engine::sym!("LifeGainAsEnergyShield")]);
    if conv_life_to_es > 0.0 {
        let base = store.sum(ModType::Base, None, &[pom_engine::sym!("Life")]) * conv_life_to_es / 100.0;
        let total = if store.flag(None, &[pom_engine::sym!("ChaosInoculation")]) { 1.0 } else { base * mod_(store, None, &[pom_engine::sym!("Life"), pom_engine::sym!("EnergyShield"), pom_engine::sym!("Defences")]) };
        energy_shield += total;
        crate::bd_def::slot(store, "Conversion", Some("Life to Energy Shield"), None, base, Some(total), &["EnergyShield", "Defences", "Life"], false);
    }
    let conv_eva_to_armour = store.sum(ModType::Base, None, &[pom_engine::sym!("EvasionGainAsArmour")]);
    if conv_eva_to_armour > 0.0 {
        let base = (store.sum(ModType::Base, None, &[pom_engine::sym!("Evasion"), pom_engine::sym!("ArmourAndEvasion")]) + gear_evasion) * conv_eva_to_armour / 100.0;
        let total = base * mod_(store, None, &[pom_engine::sym!("Evasion"), pom_engine::sym!("Armour"), pom_engine::sym!("ArmourAndEvasion"), pom_engine::sym!("Defences")]);
        armour += total;
        crate::bd_def::slot(store, "Conversion", Some("Evasion to Armour"), None, base, Some(total), &["Armour", "ArmourAndEvasion", "Defences", "Evasion"], false);
    }

    let out_energy_shield = store.override_(None, &[pom_engine::sym!("EnergyShield")]).and_then(|v| v.num()).unwrap_or_else(|| round(energy_shield).max(0.0));
    output.insert("EnergyShield".into(), out_energy_shield);
    let out_armour = round(armour).max(0.0);
    output.insert("Armour".into(), out_armour);
    let out_evasion = round(evasion).max(0.0);
    output.insert("Evasion".into(), out_evasion);
    output.insert("MeleeEvasion".into(), round(evasion * mod_(store, None, &[pom_engine::sym!("MeleeEvasion")])).max(0.0));
    output.insert("ProjectileEvasion".into(), round(evasion * mod_(store, None, &[pom_engine::sym!("ProjectileEvasion")])).max(0.0));
    output.insert("LowestOfArmourAndEvasion".into(), out_armour.min(out_evasion));
    let out_ward = ward.floor().max(0.0);
    output.insert("Ward".into(), out_ward);
    output.insert("Gear:Ward".into(), gear_ward);
    output.insert("Gear:EnergyShield".into(), gear_energy_shield);
    output.insert("Gear:Armour".into(), gear_armour);
    output.insert("Gear:Evasion".into(), gear_evasion);

    let armour_es_cap = store.flag(None, &[pom_engine::sym!("ArmourESRecoveryCap")]);
    let evasion_es_cap = store.flag(None, &[pom_engine::sym!("EvasionESRecoveryCap")]);
    let condition_low_es = env.config_flags.get("conditionLowEnergyShield").copied().unwrap_or(false);
    let capping_es = (armour_es_cap && out_armour < out_energy_shield) || (evasion_es_cap && out_evasion < out_energy_shield) || condition_low_es;
    if capping_es {
        output.insert("CappingES".into(), 1.0);
    }
    let es_recovery_cap = if capping_es {
        let base = if armour_es_cap && evasion_es_cap {
            out_armour.min(out_evasion)
        } else if armour_es_cap {
            out_armour
        } else if evasion_es_cap {
            out_evasion
        } else {
            out_energy_shield
        };
        if condition_low_es {
            (out_energy_shield * misc("LowPoolThreshold")).min(base)
        } else {
            base
        }
    } else {
        out_energy_shield
    };
    output.insert("EnergyShieldRecoveryCap".into(), es_recovery_cap);

    if store.flag(None, &[pom_engine::sym!("CannotEvade")]) || enemy.flag(None, &[pom_engine::sym!("CannotBeEvaded")]) {
        output.insert("EvadeChance".into(), 0.0);
        output.insert("MeleeEvadeChance".into(), 0.0);
        output.insert("ProjectileEvadeChance".into(), 0.0);
    } else if store.flag(None, &[pom_engine::sym!("AlwaysEvade")]) {
        output.insert("EvadeChance".into(), 100.0);
        output.insert("MeleeEvadeChance".into(), 100.0);
        output.insert("ProjectileEvadeChance".into(), 100.0);
    } else {
        let enemy_accuracy = round(val(enemy, pom_engine::sym!("Accuracy"), None));
        let evade_chance_mod = store.sum(ModType::Base, None, &[pom_engine::sym!("EvadeChance")]);
        let hit_chance_mod = mod_(enemy, None, &[pom_engine::sym!("HitChance")]);
        let (mut evade_stat, mut melee_evade_stat, mut projectile_evade_stat) = (out_evasion, output["MeleeEvasion"], output["ProjectileEvasion"]);
        if store.flag(None, &[pom_engine::sym!("EvadeChanceBasedOnWard")]) {
            let mult = store.override_(None, &[pom_engine::sym!("EvadeChanceBasedOnWardPercent")]).and_then(|v| v.num()).unwrap_or(0.0) / 100.0;
            evade_stat = out_ward * mult;
            melee_evade_stat = evade_stat;
            projectile_evade_stat = evade_stat;
        }
        let evade = 100.0 - (hit_chance(evade_stat, enemy_accuracy) - evade_chance_mod) * hit_chance_mod;
        let melee_evade = ((100.0 - (hit_chance(melee_evade_stat, enemy_accuracy) - evade_chance_mod) * hit_chance_mod) * mod_(store, None, &[pom_engine::sym!("EvadeChance"), pom_engine::sym!("MeleeEvadeChance")])).min(misc("EvadeChanceCap")).max(0.0);
        let proj_evade = ((100.0 - (hit_chance(projectile_evade_stat, enemy_accuracy) - evade_chance_mod) * hit_chance_mod) * mod_(store, None, &[pom_engine::sym!("EvadeChance"), pom_engine::sym!("ProjectileEvadeChance")])).min(misc("EvadeChanceCap")).max(0.0);
        output.insert("MeleeEvadeChance".into(), melee_evade);
        output.insert("ProjectileEvadeChance".into(), proj_evade);
        output.insert("EvadeChance".into(), if melee_evade != proj_evade { evade } else { melee_evade });
        output.insert(if melee_evade != proj_evade { "splitEvade" } else { "noSplitEvade" }.into(), 1.0);
        crate::bd_def::evade(env.enemy_level, env.config_input.contains_key("enemyLevel"), enemy_accuracy, output["EvadeChance"], melee_evade_stat, melee_evade, projectile_evade_stat, proj_evade);
    }

    // ===== Spell Suppression / Dodge (lines 1137-1210) =====
    let spell_suppression_chance = store.sum(ModType::Base, None, &[pom_engine::sym!("SpellSuppressionChance")]);
    let total_spell_suppression = store.override_(None, &[pom_engine::sym!("SpellSuppressionChance")]).and_then(|v| v.num()).unwrap_or(spell_suppression_chance);
    if store.flag(None, &[pom_engine::sym!("ConvertSpellSuppressionToSpellDodge")]) {
        store.add_mod(crate::modbuild::m("SpellDodgeChance", ModType::Base, spell_suppression_chance / 2.0, "Acrobatics"));
    }
    let spell_suppression_chance_out = total_spell_suppression.min(misc("SuppressionChanceCap"));
    output.insert("SpellSuppressionChance".into(), spell_suppression_chance_out);
    output.insert("SpellSuppressionEffect".into(), (misc("SuppressionEffect") + store.sum(ModType::Base, None, &[pom_engine::sym!("SpellSuppressionEffect")])).max(0.0));
    let mut eff_suppression = if enemy.flag(None, &[pom_engine::sym!("CannotBeSuppressed")]) { 0.0 } else { spell_suppression_chance_out };
    let mut suppress_rolls = 0i32;
    if env.mode_effective {
        if store.flag(None, &[pom_engine::sym!("SpellSuppressionChanceIsLucky")]) {
            suppress_rolls += 1;
        }
        if store.flag(None, &[pom_engine::sym!("SpellSuppressionChanceIsUnlucky")]) {
            suppress_rolls -= 1;
        }
        if store.flag(None, &[pom_engine::sym!("ExtremeLuck")]) {
            suppress_rolls *= 2;
        }
    }
    if let Some(worst_of) = unlucky_worst_of {
        if worst_of != 1.0 {
            suppress_rolls = (-worst_of / 2.0) as i32;
        }
    }
    if suppress_rolls != 0 {
        let p = eff_suppression / 100.0;
        if store.flag(None, &[pom_engine::sym!("Unexciting")]) {
            eff_suppression = (3.0 * p.powi(2) - 2.0 * p.powi(3)) * 100.0;
        } else if suppress_rolls > 0 {
            eff_suppression = (1.0 - (1.0 - p).powi(suppress_rolls + 1)) * 100.0;
        } else {
            eff_suppression = p.powi(suppress_rolls.abs()) * eff_suppression;
        }
    }
    output.insert("EffectiveSpellSuppressionChance".into(), eff_suppression);
    output.insert("SpellSuppressionChanceOverCap".into(), (total_spell_suppression - misc("SuppressionChanceCap")).max(0.0));

    let total_attack_dodge = store.sum(ModType::Base, None, &[pom_engine::sym!("AttackDodgeChance")]);
    let total_spell_dodge = store.sum(ModType::Base, None, &[pom_engine::sym!("SpellDodgeChance")]);
    let attack_dodge_max = misc("DodgeChanceCap");
    let spell_dodge_max = store.override_(None, &[pom_engine::sym!("SpellDodgeChanceMax")]).and_then(|v| v.num()).unwrap_or_else(|| store.sum(ModType::Base, None, &[pom_engine::sym!("SpellDodgeChanceMax")]));
    let enemy_reduce_dodge = enemy.sum(ModType::Base, None, &[pom_engine::sym!("reduceEnemyDodge")]);
    output.insert("AttackDodgeChance".into(), total_attack_dodge.min(attack_dodge_max));
    let mut eff_attack_dodge = if enemy.flag(None, &[pom_engine::sym!("CannotBeDodged")]) { 0.0 } else { (total_attack_dodge - enemy_reduce_dodge).max(0.0).min(attack_dodge_max) };
    output.insert("SpellDodgeChance".into(), total_spell_dodge.min(spell_dodge_max));
    let mut eff_spell_dodge = if enemy.flag(None, &[pom_engine::sym!("CannotBeDodged")]) { 0.0 } else { (total_spell_dodge - enemy_reduce_dodge).max(0.0).min(spell_dodge_max) };
    if env.mode_effective && store.flag(None, &[pom_engine::sym!("DodgeChanceIsUnlucky")]) {
        eff_attack_dodge = eff_attack_dodge / 100.0 * eff_attack_dodge;
        eff_spell_dodge = eff_spell_dodge / 100.0 * eff_spell_dodge;
    }
    output.insert("EffectiveAttackDodgeChance".into(), eff_attack_dodge);
    output.insert("EffectiveSpellDodgeChance".into(), eff_spell_dodge);
    output.insert("AttackDodgeChanceOverCap".into(), (total_attack_dodge - attack_dodge_max).max(0.0));
    output.insert("SpellDodgeChanceOverCap".into(), (total_spell_dodge - spell_dodge_max).max(0.0));
    crate::bd_def::dodge(total_attack_dodge, attack_dodge_max, output["AttackDodgeChance"], output["AttackDodgeChanceOverCap"], total_spell_dodge, spell_dodge_max, output["SpellDodgeChance"], output["SpellDodgeChanceOverCap"]);

    // ===== Recovery rate modifiers, leech caps (lines 1211-1252) =====
    let life_recovery_rate_mod = if store.flag(None, &[pom_engine::sym!("CannotRecoverLifeOutsideLeech")]) { 1.0 } else { mod_(store, None, &[pom_engine::sym!("LifeRecoveryRate")]) };
    if pom_engine::env::var("POM_DEBUG_REGEN").is_ok() {
        for ty in [ModType::Inc, ModType::More] {
            for (v, m) in store.tabulate(Some(ty), None, &[pom_engine::sym!("LifeRecoveryRate"), pom_engine::sym!("EnergyShieldRecharge")]) {
                let m = unsafe { &*m };
                eprintln!("  RECMOD {:?} {:?} {} src={:?} tags={:?}", ty, v, m.name.as_str(), m.source, m.tags.iter().map(|t| t.kind.as_str().to_string()).collect::<Vec<_>>());
            }
        }
    }
    output.insert("LifeRecoveryRateMod".into(), life_recovery_rate_mod);
    output.insert("ManaRecoveryRateMod".into(), mod_(store, None, &[pom_engine::sym!("ManaRecoveryRate")]));
    output.insert("EnergyShieldRecoveryRateMod".into(), mod_(store, None, &[pom_engine::sym!("EnergyShieldRecoveryRate")]));

    output.insert("MaxLifeLeechInstance".into(), out_life(&output) * val(store, pom_engine::sym!("MaxLifeLeechInstance"), None) / 100.0);
    let max_life_leech_rate_percent = if store.flag(None, &[pom_engine::sym!("MaximumLifeLeechIsEqualToPartyMember")]) { party_out("MaxLifeLeechRatePercent") } else { val(store, pom_engine::sym!("MaxLifeLeechRate"), None) };
    output.insert("MaxLifeLeechRatePercent".into(), max_life_leech_rate_percent);
    output.insert("MaxLifeLeechRate".into(), out_life(&output) * max_life_leech_rate_percent / 100.0);
    output.insert("MaxEnergyShieldLeechInstance".into(), out_energy_shield * val(store, pom_engine::sym!("MaxEnergyShieldLeechInstance"), None) / 100.0);
    output.insert("MaxEnergyShieldLeechRate".into(), out_energy_shield * val(store, pom_engine::sym!("MaxEnergyShieldLeechRate"), None) / 100.0);
    let out_mana = output.get("Mana").copied().unwrap_or(0.0);
    output.insert("MaxManaLeechInstance".into(), out_mana * val(store, pom_engine::sym!("MaxManaLeechInstance"), None) / 100.0);
    output.insert("MaxManaLeechRate".into(), out_mana * val(store, pom_engine::sym!("MaxManaLeechRate"), None) / 100.0);
    if pom_offence::bd::on() {
        crate::bd_def::leech_caps(store, out_life(&output), max_life_leech_rate_percent, output["MaxLifeLeechRate"], out_energy_shield, output["MaxEnergyShieldLeechRate"], out_mana, output["MaxManaLeechRate"]);
    }

    // `actor.output` is a live table in upstream, so a PerStat mod (`stat=FireResistTotal`, ...)
    // evaluated from here on sees everything computed above.
    sync_actor_output(store, &output);
    // ===== Regeneration (lines 1254-1340) =====
    let resources = ["Mana", "Life", "EnergyShield", "Rage"];
    for (i, &resource) in resources.iter().enumerate() {
        // `actor.output` is live: RageRegen's PercentStat(LifeRegen) mod reads the Life pass's result.
        sync_actor_output(store, &output);
        let pool = output.get(resource).copied().unwrap_or(0.0);
        let mut inc = store.sum(ModType::Inc, None, &[s(&format!("{resource}Regen"))]);
        let more = store.more(None, &[s(&format!("{resource}Regen"))]);
        let recovery_rate_mod = output.get(&format!("{resource}RecoveryRateMod")).copied().unwrap_or(1.0);
        let mut regen_rate = 0.0;
        let mut bd_base_regen = 0.0;
        if store.flag(None, &[s(&format!("No{resource}Regen"))]) || store.flag(None, &[s(&format!("CannotGain{resource}"))]) {
            output.insert(format!("{resource}Regen"), 0.0);
        } else if resource == "Life" && store.flag(None, &[pom_engine::sym!("ZealotsOath")]) {
            output.insert("LifeRegen".into(), 0.0);
            let life_base = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeRegen")]);
            if life_base > 0.0 {
                store.add_mod(crate::modbuild::m("EnergyShieldRegen", ModType::Base, life_base, "Zealot's Oath"));
            }
            let life_pct = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeRegenPercent")]);
            if life_pct > 0.0 {
                store.add_mod(crate::modbuild::m("EnergyShieldRegenPercent", ModType::Base, life_pct, "Zealot's Oath"));
            }
        } else {
            if inc != 0.0 {
                for &resource2 in &resources[i + 1..] {
                    if store.flag(None, &[s(&format!("{resource}RegenTo{resource2}Regen"))]) {
                        store.add_mod(crate::modbuild::m(&format!("{resource2}Regen"), ModType::Inc, inc, &format!("{resource} instead applies to {resource2}")));
                        inc = 0.0;
                    }
                }
            }
            if resource == "Life" && store.sum(ModType::Base, None, &[pom_engine::sym!("LifeRegenAppliesToEnergyShield")]) > 0.0 {
                let conv = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeRegenAppliesToEnergyShield")]).min(100.0) / 100.0;
                let life_base = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeRegen")]);
                let life_pct = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeRegenPercent")]);
                store.add_mod(crate::modbuild::m("EnergyShieldRegen", ModType::Base, crate::tools::floor_dec(life_base * conv, 2), "Life Regen to ES Regen"));
                store.add_mod(crate::modbuild::m("EnergyShieldRegenPercent", ModType::Base, crate::tools::floor_dec(life_pct * conv, 2), "Life Regen to ES Regen"));
            }
            let base_regen = store.sum(ModType::Base, None, &[s(&format!("{resource}Regen"))]) + pool * store.sum(ModType::Base, None, &[s(&format!("{resource}RegenPercent"))]) / 100.0;
            bd_base_regen = base_regen;
            let regen = base_regen * (1.0 + inc / 100.0) * more;
            if regen != 0.0 {
                for &resource2 in &resources[i + 1..] {
                    if store.flag(None, &[s(&format!("{resource}RegenerationRecovers{resource2}"))]) {
                        store.add_mod(crate::modbuild::m(&format!("{resource2}Recovery"), ModType::Base, regen, &format!("{resource} Regeneration Recovers {resource2}")));
                    }
                }
            }
            if pom_engine::env::var("POM_DEBUG_REGEN").is_ok() {
                for (v, m) in store.tabulate(Some(ModType::Base), None, &[s(&format!("{resource}Regen")), s(&format!("{resource}RegenPercent"))]) {
                    let m = unsafe { &*m };
                    eprintln!("  REGENMOD {resource} {:?} {} src={:?} tags={}", v, m.name.as_str(), m.source, m.tags.len());
                }
            }
            if pom_engine::env::var("POM_DEBUG_REGEN").is_ok() { eprintln!("REGEN {resource} base={base_regen} inc={inc} more={more} regen={regen} rrm={recovery_rate_mod} pool={pool}"); }
            regen_rate = crate::tools::round_dec(regen * recovery_rate_mod, 1);
            output.insert(format!("{resource}Regen"), regen_rate);
        }
        output.insert(format!("{resource}RegenInc"), inc);
        let base_degen = store.sum(ModType::Base, None, &[s(&format!("{resource}Degen"))]) + pool * store.sum(ModType::Base, None, &[s(&format!("{resource}DegenPercent"))]) / 100.0;
        let tincture_degen_pct = store.sum(ModType::Base, None, &[s(&format!("{resource}DegenPercentTincture"))]);
        let base_degen = base_degen + (pool * tincture_degen_pct / 100.0).max(tincture_degen_pct);
        let degen_rate = if base_degen > 0.0 { base_degen * mod_(store, None, &[s(&format!("{resource}Degen"))]) } else { 0.0 };
        output.insert(format!("{resource}Degen"), degen_rate);
        let recovery_rate = store.sum(ModType::Base, None, &[s(&format!("{resource}Recovery"))]) * recovery_rate_mod;
        output.insert(format!("{resource}Recovery"), recovery_rate);
        let regen_recovery = (if store.flag(None, &[s(&format!("UnaffectedBy{resource}Regen"))]) { 0.0 } else { regen_rate }) - degen_rate + recovery_rate;
        output.insert(format!("{resource}RegenRecovery"), regen_recovery);
        if regen_recovery > 0.0 {
            store.add_mod(crate::modbuild::mb(&format!("Condition:CanGain{resource}"), &format!("{resource}Regen")));
        }
        output.insert(format!("{resource}RegenPercent"), if pool > 0.0 { crate::tools::round_dec(regen_recovery / pool * 100.0, 1) } else { 0.0 });
        if pom_offence::bd::on() {
            crate::bd_def::regen_recovery(store, resource, if resource == "EnergyShield" { "Energy Shield" } else { resource }, bd_base_regen, inc, more, recovery_rate_mod, regen_rate, degen_rate, recovery_rate, regen_recovery);
        }
    }

    // ===== Energy Shield Recharge (lines 1342-1401) =====
    let recharge_to_life = store.flag(None, &[pom_engine::sym!("EnergyShieldRechargeAppliesToLife")]) && !store.flag(None, &[pom_engine::sym!("CannotRecoverLifeOutsideLeech")]);
    let recharge_to_es = !(store.flag(None, &[pom_engine::sym!("NoEnergyShieldRecharge")]) || store.flag(None, &[pom_engine::sym!("CannotGainEnergyShield")]) || recharge_to_life);
    // `Flag` yields `true`/`nil`, so the Life key is absent (not `false`) when the flag isn't set.
    if store.flag(None, &[pom_engine::sym!("EnergyShieldRechargeAppliesToLife")]) {
        output.insert("EnergyShieldRechargeAppliesToLife".into(), recharge_to_life as u8 as f64);
    }
    output.insert("EnergyShieldRechargeAppliesToEnergyShield".into(), recharge_to_es as u8 as f64);
    if recharge_to_life || recharge_to_es {
        let inc = store.sum(ModType::Inc, None, &[pom_engine::sym!("EnergyShieldRecharge")]);
        let more = store.more(None, &[pom_engine::sym!("EnergyShieldRecharge")]);
        let base = store.override_(None, &[pom_engine::sym!("EnergyShieldRecharge")]).and_then(|v| v.num()).unwrap_or_else(|| misc("EnergyShieldRechargeBase"));
        if recharge_to_life {
            let recharge = out_life(&output) * base * (1.0 + inc / 100.0) * more;
            output.insert("LifeRecharge".into(), round(recharge * life_recovery_rate_mod));
            crate::bd_def::recharge("LifeRecharge", out_life(&output), base, inc, more, recharge, life_recovery_rate_mod, output["LifeRecharge"]);
        } else {
            let recharge = out_energy_shield * base * (1.0 + inc / 100.0) * more;
            output.insert("EnergyShieldRecharge".into(), round(recharge * output["EnergyShieldRecoveryRateMod"]));
            crate::bd_def::recharge("EnergyShieldRecharge", out_energy_shield, base, inc, more, recharge, output["EnergyShieldRecoveryRateMod"], output["EnergyShieldRecharge"]);
        }
        output.insert("EnergyShieldRechargeDelay".into(), misc("EnergyShieldRechargeDelay") / (1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("EnergyShieldRechargeFaster")]) / 100.0));
        crate::bd_def::recharge_delay("EnergyShieldRechargeDelay", misc("EnergyShieldRechargeDelay"), store.sum(ModType::Inc, None, &[pom_engine::sym!("EnergyShieldRechargeFaster")]), output["EnergyShieldRechargeDelay"]);
    } else {
        output.insert("EnergyShieldRecharge".into(), 0.0);
    }

    // ===== Recoup (lines 1403-1520): cross-conversion, base + per-damage-type recoup, pseudo recoup =====
    let recoup_types = ["Life", "Mana", "EnergyShield"];
    let recoup_inc = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("RecoupRecoveryAmount")]) / 100.0;
    let recoup_more = store.more(None, &[pom_engine::sym!("RecoupRecoveryAmount")]);
    let mut any_recoup = 0.0;
    // source of the first FLAG mod of that name (`modDB:Tabulate("FLAG", nil, flag)[1].mod.source`)
    let flag_source = |store: &ModStore, flag: &str| -> String {
        store.tabulate(Some(ModType::Flag), None, &[s(flag)]).first()
            .and_then(|(_, m)| unsafe { m.as_ref() }).and_then(|m| m.source.as_ref().map(|x| x.to_string())).unwrap_or_default()
    };
    for &rt in &recoup_types {
        for &rt2 in &recoup_types {
            if rt != rt2 {
                let add_flag = format!("Add{rt}RecoupTo{rt2}");
                if store.flag(None, &[s(&add_flag)]) {
                    let base = store.sum(ModType::Base, None, &[s(&format!("{rt}Recoup"))]);
                    let src = flag_source(store, &add_flag);
                    store.add_mod(crate::modbuild::m(&format!("{rt2}Recoup"), ModType::Base, base, &src));
                }
            }
        }
    }
    for &rt in &recoup_types {
        if rt == "Life" && store.flag(None, &[pom_engine::sym!("EnergyShieldRecoupInsteadOfLife")]) {
            output.insert("LifeRecoup".into(), 0.0);
            let life_recoup = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeRecoup")]);
            store.add_mod(crate::modbuild::m("EnergyShieldRecoup", ModType::Base, life_recoup, "Life Recoup Conversion"));
        } else {
            let base = store.sum(ModType::Base, None, &[s(&format!("{rt}Recoup"))]);
            let rrm = output.get(&format!("{rt}RecoveryRateMod")).copied().unwrap_or(1.0);
            let v = base * rrm * recoup_inc * recoup_more;
            output.insert(format!("{rt}Recoup"), v);
            any_recoup += v;
            if pom_offence::bd::on() {
                crate::bd_def::recoup(&format!("{rt}Recoup"), base, recoup_inc, recoup_more, rrm, v, store.flag(None, &[s(&format!("3Second{rt}Recoup"))]) || store.flag(None, &[pom_engine::sym!("3SecondRecoup")]), true);
            }
        }
    }
    if store.flag(None, &[pom_engine::sym!("UsePowerCharges")]) && store.flag(None, &[pom_engine::sym!("PowerChargesConvertToAbsorptionCharges")]) {
        let per = store.sum(ModType::Base, None, &[pom_engine::sym!("PerAbsorptionElementalEnergyShieldRecoup")]);
        for dt in ["Cold", "Fire", "Lightning"] {
            store.add_mod(crate::modbuild::mt(&format!("{dt}EnergyShieldRecoup"), ModType::Base, per, "Absorption Charges", vec![crate::modbuild::multiplier("AbsorptionCharge")]));
        }
    }
    for &rt in &recoup_types {
        for &dt in DMG_TYPES {
            let recoup = store.sum(ModType::Base, None, &[s(&format!("{dt}{rt}Recoup"))]);
            if rt == "Life" && store.flag(None, &[pom_engine::sym!("EnergyShieldRecoupInsteadOfLife")]) {
                output.insert(format!("{dt}{rt}Recoup"), 0.0);
                store.add_mod(crate::modbuild::m(&format!("{dt}EnergyShieldRecoup"), ModType::Base, recoup, "Life Recoup Conversion"));
            } else {
                let rrm = output.get(&format!("{rt}RecoveryRateMod")).copied().unwrap_or(1.0);
                let v = recoup * rrm * recoup_inc * recoup_more;
                output.insert(format!("{dt}{rt}Recoup"), v);
                any_recoup += v;
                if pom_offence::bd::on() {
                    crate::bd_def::recoup(&format!("{dt}{rt}Recoup"), recoup, recoup_inc, recoup_more, rrm, v, store.flag(None, &[s(&format!("3Second{rt}Recoup"))]) || store.flag(None, &[pom_engine::sym!("3SecondRecoup")]), false);
                }
            }
            for &rt2 in &recoup_types {
                if rt != rt2 {
                    let add_flag = format!("Add{rt}RecoupTo{rt2}");
                    if store.flag(None, &[s(&add_flag)]) {
                        let src = flag_source(store, &add_flag);
                        let newm = crate::modbuild::m(&format!("{dt}{rt2}Recoup"), ModType::Base, recoup, &src);
                        // ModDB:ReplaceMod: replace the first mod with the same name/type/flags/source, else add
                        let mut replaced = false;
                        if let pom_engine::modstore::store::Backing::Db(map) = &mut store.backing {
                            if let Some(list) = map.get_mut(&newm.name) {
                                if let Some(slot) = list.iter_mut().find(|c| c.ty == newm.ty && c.flags == newm.flags && c.keyword_flags == newm.keyword_flags && c.source == newm.source) {
                                    *slot = newm.clone();
                                    replaced = true;
                                }
                            }
                        }
                        if !replaced { store.add_mod(newm); }
                    }
                }
            }
        }
    }
    // pseudo recoup (eg %physical damage prevented from hits regenerated)
    for &res in &recoup_types {
        if !store.flag(None, &[s(&format!("No{res}Regen"))]) && !store.flag(None, &[s(&format!("CannotGain{res}"))]) {
            let pseudo = store.sum(ModType::Base, None, &[s(&format!("PhysicalDamageMitigated{res}PseudoRecoup"))]);
            if pseudo > 0.0 {
                // the parser stores the duration as the captured string; Lua's `+` in Sum coerces it
                let mut dur: f64 = store.mods_named(s(&format!("PhysicalDamageMitigated{res}PseudoRecoupDuration")))
                    .filter(|m| m.ty == ModType::Base)
                    .map(|m| match &m.value { pom_engine::value::Value::Str(x) => x.trim().parse::<f64>().unwrap_or(0.0), v => v.num().unwrap_or(0.0) })
                    .sum();
                if dur == 0.0 { dur = 4.0; }
                output.insert(format!("PhysicalDamageMitigated{res}PseudoRecoupDuration"), dur);
                let inc = store.sum(ModType::Inc, None, &[s(&format!("{res}Regen"))]);
                let more = store.more(None, &[s(&format!("{res}Regen"))]);
                let rrm = output.get(&format!("{res}RecoveryRateMod")).copied().unwrap_or(1.0);
                let v = pseudo * (1.0 + inc / 100.0) * more * rrm;
                output.insert(format!("PhysicalDamageMitigated{res}PseudoRecoup"), v);
                any_recoup += v;
                crate::bd_def::pseudo_recoup(res, pseudo, inc, more, rrm, v, dur);
            }
        }
    }
    output.insert("anyRecoup".into(), any_recoup);

    // ===== Ward recharge, damage reduction base (lines 1522-1540) =====
    output.insert("WardRechargeDelay".into(), misc("WardRechargeDelay") / (1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("WardRechargeFaster")]) / 100.0));
    crate::bd_def::recharge_delay("WardRechargeDelay", misc("WardRechargeDelay"), store.sum(ModType::Inc, None, &[pom_engine::sym!("WardRechargeFaster")]), output["WardRechargeDelay"]);

    let damage_reduction_max = store.override_(None, &[pom_engine::sym!("DamageReductionMax")]).and_then(|v| v.num()).unwrap_or_else(|| misc("DamageReductionCap"));
    output.insert("DamageReductionMax".into(), damage_reduction_max);
    store.add_mod(crate::modbuild::m("ArmourAppliesToPhysicalDamageTaken", ModType::Base, 100.0, ""));
    for &dt in DMG_TYPES {
        let elem_alias = is_elemental(dt).then_some("ElementalDamageReduction");
        let mut names = vec![s(&format!("{dt}DamageReduction"))];
        if let Some(a) = elem_alias {
            names.push(s(a));
        }
        let base_dr = store.override_(None, &[s(&format!("{dt}DamageReduction"))]).and_then(|v| v.num()).unwrap_or_else(|| store.sum(ModType::Base, None, &names).max(0.0).min(damage_reduction_max));
        output.insert(format!("Base{dt}DamageReduction"), base_dr);
        let when_hit = store
            .override_(None, &[s(&format!("{dt}DamageReduction"))])
            .and_then(|v| v.num())
            .unwrap_or_else(|| (base_dr + store.sum(ModType::Base, None, &[s(&format!("{dt}DamageReductionWhenHit"))])).max(0.0).min(damage_reduction_max));
        output.insert(format!("Base{dt}DamageReductionWhenHit"), when_hit);
    }

    // ===== Movement speed (lines 1542-1547): `EffectiveMovementSpeedMod` needs
    // `calcs.actionSpeedMod` (Modules/CalcPerform.lua, outside this crate) =====
    let movement_speed_mod = store.override_(None, &[pom_engine::sym!("MovementSpeed")]).and_then(|v| v.num()).unwrap_or_else(|| if store.flag(None, &[pom_engine::sym!("MovementSpeedEqualHighestLinkedPlayers")]) { env.party_output.get("MovementSpeedMod").copied().unwrap_or_else(|| mod_(store, None, &[pom_engine::sym!("MovementSpeed")])) } else { mod_(store, None, &[pom_engine::sym!("MovementSpeed")]) });
    let movement_speed_mod = if store.flag(None, &[pom_engine::sym!("MovementSpeedCannotBeBelowBase")]) { movement_speed_mod.max(1.0) } else { movement_speed_mod };
    output.insert("MovementSpeedMod".into(), movement_speed_mod);
    if let Some(&asm) = output.get("ActionSpeedMod") {
        crate::bd_def::effective_movement_speed(movement_speed_mod, asm, movement_speed_mod * asm);
    }

    if enemy.flag(None, &[pom_engine::sym!("Blind")]) {
        output.insert("BlindEffectMod".into(), mod_(enemy, None, &[pom_engine::sym!("BlindEffect"), pom_engine::sym!("BuffEffectOnSelf")]) * 100.0);
    }

    // ===== Recovery on block, avoidances, ailment durations (lines 1561-1671) =====
    if !store.flag(None, &[pom_engine::sym!("CannotRecoverLifeOutsideLeech")]) {
        output.insert("LifeOnBlock".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("LifeOnBlock")]));
        output.insert("LifeOnSuppress".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("LifeOnSuppress")]));
    } else {
        output.insert("LifeOnBlock".into(), 0.0);
        output.insert("LifeOnSuppress".into(), 0.0);
    }
    output.insert("ManaOnBlock".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("ManaOnBlock")]));
    output.insert("EnergyShieldOnBlock".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("EnergyShieldOnBlock")]));
    output.insert("EnergyShieldOnSpellBlock".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("EnergyShieldOnSpellBlock")]));
    output.insert("EnergyShieldOnSuppress".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("EnergyShieldOnSuppress")]));

    let mut specific_type_avoidance = false;
    for &dt in DMG_TYPES {
        let v = store.sum(ModType::Base, None, &[s(&format!("Avoid{dt}DamageChance"))]).min(misc("AvoidChanceCap"));
        output.insert(format!("Avoid{dt}DamageChance"), v);
        if v > 0.0 {
            specific_type_avoidance = true;
        }
    }
    output.insert("specificTypeAvoidance".into(), specific_type_avoidance as u8 as f64);
    output.insert("AvoidProjectilesChance".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("AvoidProjectilesChance")]).min(misc("AvoidChanceCap")));
    output.insert("AvoidAllDamageFromHitsChance".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("AvoidAllDamageFromHitsChance")]).min(misc("AvoidChanceCap")));
    // Status immunities: `Flag` is `true`/`nil`, so each key is only present when set.
    for (key, flag) in [("CorruptedBloodImmunity", "CorruptedBloodImmune"), ("MaimImmunity", "MaimImmune"), ("HinderImmunity", "HinderImmune"), ("KnockbackImmunity", "KnockbackImmune")] {
        if store.flag(None, &[s(flag)]) {
            output.insert(key.into(), 1.0);
        }
    }
    output.insert("BlindAvoidChance".into(), if store.flag(None, &[pom_engine::sym!("BlindImmune")]) { 100.0 } else { store.sum(ModType::Base, None, &[pom_engine::sym!("AvoidBlind")]).min(100.0) });
    output.insert("ImpaleAvoidChance".into(), if store.flag(None, &[pom_engine::sym!("ImpaleImmune")]) { 100.0 } else { store.sum(ModType::Base, None, &[pom_engine::sym!("AvoidImpale")]).min(100.0) });

    if store.flag(None, &[pom_engine::sym!("SpellSuppressionAppliesToAilmentAvoidance")]) {
        let pct = store.sum(ModType::Base, None, &[pom_engine::sym!("SpellSuppressionAppliesToAilmentAvoidancePercent")]) / 100.0;
        store.add_mod(crate::modbuild::m("AvoidElementalAilments", ModType::Base, (pct * spell_suppression_chance).floor(), "Ancestral Vision"));
    }
    output.insert("ArmourDefense".into(), store.max(None, &[pom_engine::sym!("ArmourDefense")]).unwrap_or(0.0) / 100.0);
    {
        let armour_defense = store.max(None, &[pom_engine::sym!("ArmourDefense")]).unwrap_or(0.0) / 100.0;
        if armour_defense > 0.0 {
            output.insert("RawArmourDefense".into(), (1.0 + armour_defense) * 100.0);
        }
    }

    for &ailment in crate::data::NON_ELEMENTAL_AILMENT_TYPE_LIST {
        let v = if store.flag(None, &[s(&format!("{ailment}Immune"))]) { 100.0 } else { store.sum(ModType::Base, None, &[s(&format!("Avoid{ailment}")), pom_engine::sym!("AvoidAilments")]).min(100.0).floor() };
        output.insert(format!("{ailment}AvoidChance"), v);
    }
    for &ailment in crate::data::ELEMENTAL_AILMENT_TYPE_LIST {
        let shock_all = store.flag(None, &[pom_engine::sym!("ShockAvoidAppliesToElementalAilments")]) && ailment != "Shock";
        let v = if store.flag(None, &[s(&format!("{ailment}Immune"))]) || store.flag(None, &[pom_engine::sym!("ElementalAilmentImmune")]) {
            100.0
        } else {
            (store.sum(ModType::Base, None, &[s(&format!("Avoid{ailment}")), pom_engine::sym!("AvoidAilments"), pom_engine::sym!("AvoidElementalAilments")]) + if shock_all { store.sum(ModType::Base, None, &[pom_engine::sym!("AvoidShock")]) } else { 0.0 }).min(100.0).floor()
        };
        output.insert(format!("{ailment}AvoidChance"), v);
    }
    let curse_avoid = if store.flag(None, &[pom_engine::sym!("CurseImmune")]) { 100.0 } else { store.sum(ModType::Base, None, &[pom_engine::sym!("AvoidCurse")]).min(100.0) };
    output.insert("CurseAvoidChance".into(), curse_avoid);
    output.insert("SilenceAvoidChance".into(), if store.flag(None, &[pom_engine::sym!("SilenceImmune")]) { 100.0 } else { curse_avoid });
    output.insert("CritExtraDamageReduction".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("ReduceCritExtraDamage")]).min(100.0));
    output.insert("LightRadiusMod".into(), mod_(store, None, &[pom_engine::sym!("LightRadius")]));
    crate::bd_def::light_radius(store);
    output.insert("LightRadiusInc".into(), store.sum(ModType::Inc, None, &[pom_engine::sym!("LightRadius")]).max(0.0));
    output.insert("CurseEffectOnSelf".into(), (store.more(None, &[pom_engine::sym!("CurseEffectOnSelf")]) * (100.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("CurseEffectOnSelf")]))).max(0.0));
    output.insert("ExposureEffectOnSelf".into(), store.more(None, &[pom_engine::sym!("ExposureEffectOnSelf")]) * (100.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("ExposureEffectOnSelf")])));
    output.insert("WitherEffectOnSelf".into(), store.more(None, &[pom_engine::sym!("WitherEffectOnSelf")]) * (100.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("WitherEffectOnSelf")])));

    let debuff_expiration_rate = store.sum(ModType::Base, None, &[pom_engine::sym!("SelfDebuffExpirationRate")]);
    output.insert("DebuffExpirationRate".into(), debuff_expiration_rate);
    let debuff_expiration_mod = 10000.0 / (100.0 + debuff_expiration_rate);
    output.insert("DebuffExpirationModifier".into(), debuff_expiration_mod);
    output.insert("showDebuffExpirationModifier".into(), (debuff_expiration_mod != 100.0) as u8 as f64);
    output.insert(
        "SelfBlindDuration".into(),
        store.more(None, &[pom_engine::sym!("SelfBlindDuration")]) * (100.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("SelfBlindDuration")])) * debuff_expiration_mod / 100.0,
    );

    for &ailment in crate::data::NON_ELEMENTAL_AILMENT_TYPE_LIST {
        let more = store.more(None, &[s(&format!("Self{ailment}Duration")), pom_engine::sym!("SelfAilmentDuration")]);
        let inc = (100.0 + store.sum(ModType::Inc, None, &[s(&format!("Self{ailment}Duration")), pom_engine::sym!("SelfAilmentDuration")])) * 100.0;
        output.insert(format!("Self{ailment}Duration"), inc * more / (100.0 + debuff_expiration_rate + store.sum(ModType::Base, None, &[s(&format!("Self{ailment}DebuffExpirationRate"))])));
    }
    for &ailment in crate::data::ELEMENTAL_AILMENT_TYPE_LIST {
        let ignite_all = store.flag(None, &[pom_engine::sym!("IgniteDurationAppliesToElementalAilments")]) && ailment != "Ignite";
        let more = store.more(None, &[s(&format!("Self{ailment}Duration")), pom_engine::sym!("SelfAilmentDuration"), pom_engine::sym!("SelfElementalAilmentDuration")]) * (if ignite_all { store.more(None, &[pom_engine::sym!("SelfIgniteDuration")]) } else { 1.0 });
        let inc = (100.0
            + store.sum(ModType::Inc, None, &[s(&format!("Self{ailment}Duration")), pom_engine::sym!("SelfAilmentDuration"), pom_engine::sym!("SelfElementalAilmentDuration")])
            + if ignite_all { store.sum(ModType::Inc, None, &[pom_engine::sym!("SelfIgniteDuration")]) } else { 0.0 })
            * 100.0;
        output.insert(format!("Self{ailment}Duration"), more * inc / (100.0 + debuff_expiration_rate + store.sum(ModType::Base, None, &[s(&format!("Self{ailment}DebuffExpirationRate"))])));
    }
    for &ailment in crate::data::AILMENT_TYPE_LIST {
        let self_mod = mod_(store, None, &[s(&format!("Self{ailment}Effect"))]);
        let enemy_mod = if store.flag(None, &[s(&format!("Condition:{ailment}edSelf"))]) {
            mod_(store, None, &[s(&format!("Enemy{ailment}Effect"))])
        } else {
            mod_(enemy, None, &[s(&format!("Enemy{ailment}Effect"))])
        };
        output.insert(format!("Self{ailment}Effect"), self_mod * enemy_mod * 100.0);
    }

    output
}

fn out_life(output: &HashMap<String, f64>) -> f64 {
    output.get("Life").copied().unwrap_or(0.0)
}

/// Refresh `store.actor`'s output snapshot from the live `output` map (PerStat/Multiplier tags
/// read `actor.output` mid-function in upstream).
fn sync_actor_output(store: &mut ModStore, output: &HashMap<String, f64>) {
    // Every field but the output table, which is replaced.
    let mut actor = match store.actor.as_deref() {
        Some(a) => pom_engine::modstore::types::Actor {
            output: Default::default(),
            mana_efficiency: a.mana_efficiency,
            weapon1: a.weapon1.clone(),
            weapon2: a.weapon2.clone(),
            minion_monster_tags: a.minion_monster_tags.clone(),
            reservations: a.reservations.clone(),
            items: a.items.clone(),
            item_search: a.item_search.clone(),
            related: a.related.clone(),
        },
        None => Default::default(),
    };
    actor.output = output.iter().map(|(k, v)| (Sym::new(k), *v)).collect();
    let actor = std::sync::Arc::new(actor);
    // `env.modDB.actor.player = env.player` is the live player table: a `PerStat`/`Multiplier` tag with
    // `actor = "player"` on the player's own store must see the current output, not the snapshot taken
    // when the actors were last refreshed.
    let has_player = actor.related.borrow().contains_key("player");
    if has_player {
        let snap = ModStore {
            parent: store.parent.clone(),
            actor: Some(actor.clone()),
            conditions: store.conditions.clone(),
            multipliers: store.multipliers.clone(),
            backing: match &store.backing {
                pom_engine::modstore::store::Backing::List(v) => pom_engine::modstore::store::Backing::List(v.clone()),
                pom_engine::modstore::store::Backing::Db(m) => pom_engine::modstore::store::Backing::Db(m.clone()),
            },
        };
        actor.related.borrow_mut().insert(std::sync::Arc::from("player"), std::sync::Arc::new(snap));
        pom_engine::modstore::types::register_links(&actor);
    }
    store.actor = Some(actor);
}
