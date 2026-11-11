//! Port of Modules/CalcSetup.lua: `calcs.initModDB` (line 19) in full, and the constant part of
//! `calcs.initEnv` (lines 475-694) that builds the player's and the enemy's base ModDB contents
//! before any item, tree, config-tab or skill mod gets added. Those later additions come from the
//! item/passives/config crates' own recordings and from this
//! crate's own `snapshot.rs`, not from here.
//!
//! Every function here returns a plain `Vec<Mod>` plus the handful of `conditions`/`multipliers`
//! entries the Lua sets directly on the ModDB (`modDB.conditions[...]`, `modDB.multipliers[...]`)
//! rather than through `NewMod`. The caller (the code that builds a real `Env`, or `calc_golden`'s grading
//! pass) is responsible for folding these into an actual `ModStore`.
//!
//! Pantheon mods (`initEnv` lines 662-673) are NOT ported: they go through `parseMod` on
//! `data.pantheons`, a general-purpose mod-string parser call this crate does not need for
//! anything else yet. Builds with a pantheon selected will show extra mods in golden's `player`
//! actor that this port does not produce.
use crate::data::{class_base_stats, game_data, monster_accuracy, CharacterConstants};
use crate::modbuild::*;
use pom_engine::modifier::{Mod, ModType};
use pom_engine::modparser::flags::{keyword_flag as kf, mod_flag as mf_};
use pom_engine::sym::Sym;
use pom_engine::fxhash::HashMap;

/// The config tab fields `initEnv`'s base-mod block reads directly (Modules/CalcSetup.lua lines
/// 605-608, 652-660). Everything else the config tab contributes comes in as `configModList`/
/// `enemyModList`, already-built mods this crate does not need to reconstruct.
#[derive(Default, Clone)]
pub struct ConfigInputSubset {
    pub bandit: Option<String>,
    pub resistance_penalty: Option<f64>,
}

/// `calcs.initModDB(env, modDB)`: stats and conditions common to every actor (player and enemy
/// both call this). `mode_buffs`/`mode_combat`/`mode_effective` are `env.mode_buffs` etc.
/// (`initEnv` lines 565-587, derived from the calc mode and, in CALCS mode, the buff-mode config
/// option; MAIN/CALCULATOR/TREE always resolve to `EFFECTIVE`, i.e. all three `true`).
#[derive(Clone)]
pub struct InitModDbResult {
    pub mods: Vec<Mod>,
    /// `(name, value)` pairs written straight to `modDB.conditions[name]`.
    pub conditions: Vec<(&'static str, bool)>,
}

/// The buff mode of the calculation in progress (`env.mode_buffs`, `env.mode_combat`, `env.mode_effective`).
/// Every calculation but the Calcs tab's runs EFFECTIVE (all three true, the default here); the Calcs view sets another
/// mode for the length of its own run with `set_buff_mode` (CalcSetup.lua:565-587).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct BuffMode {
    pub buffs: bool,
    pub combat: bool,
    pub effective: bool,
}

impl BuffMode {
    pub const EFFECTIVE: BuffMode = BuffMode { buffs: true, combat: true, effective: true };

    /// `calcsTab.input.misc_buffMode`: EFFECTIVE, COMBAT, BUFFED; anything else (UNBUFFED) is all off.
    pub fn from_name(name: &str) -> BuffMode {
        match name {
            "EFFECTIVE" => BuffMode::EFFECTIVE,
            "COMBAT" => BuffMode { buffs: true, combat: true, effective: false },
            "BUFFED" => BuffMode { buffs: true, combat: false, effective: false },
            _ => BuffMode { buffs: false, combat: false, effective: false },
        }
    }
}

thread_local! {
    static BUFF_MODE: std::cell::Cell<BuffMode> = const { std::cell::Cell::new(BuffMode::EFFECTIVE) };
}

/// The buff mode of the calculation in progress.
pub fn buff_mode() -> BuffMode {
    BUFF_MODE.with(|m| m.get())
}

/// Restores the previous buff mode on drop.
pub struct BuffModeGuard(BuffMode);

impl Drop for BuffModeGuard {
    fn drop(&mut self) {
        BUFF_MODE.with(|m| m.set(self.0));
    }
}

/// Sets the buff mode until the guard is dropped.
pub fn set_buff_mode(mode: BuffMode) -> BuffModeGuard {
    BuffModeGuard(BUFF_MODE.with(|m| m.replace(mode)))
}

/// `init_mod_db` over the shared constants, built once per mode combination.
pub fn init_mod_db_shared(mode_buffs: bool, mode_combat: bool, mode_effective: bool) -> std::rc::Rc<InitModDbResult> {
    thread_local! {
        static MEMO: std::cell::RefCell<Vec<((bool, bool, bool), std::rc::Rc<InitModDbResult>)>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    let key = (mode_buffs, mode_combat, mode_effective);
    if let Some(r) = MEMO.with(|m| m.borrow().iter().find(|e| e.0 == key).map(|e| e.1.clone())) {
        return r;
    }
    let r = std::rc::Rc::new(init_mod_db(CharacterConstants::shared(), mode_buffs, mode_combat, mode_effective));
    MEMO.with(|m| m.borrow_mut().push((key, r.clone())));
    r
}

pub fn init_mod_db(cc: &CharacterConstants, mode_buffs: bool, mode_combat: bool, mode_effective: bool) -> InitModDbResult {
    let r = cc.get("base_maximum_all_resistances_%");
    // Malignant Madness damage and action speed are additive in game (`damage_+%`, `action_speed_-%`); upstream stores them as MORE.
    // POM_STRICT_COMPAT=1 restores the upstream behaviour.
    let mm_ty = if pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") { ModType::More } else { ModType::Inc };
    let mut mods = vec![
        m("FireResistMax", ModType::Base, r, "Base"),
        m("ColdResistMax", ModType::Base, r, "Base"),
        m("LightningResistMax", ModType::Base, r, "Base"),
        m("ChaosResistMax", ModType::Base, r, "Base"),
        m("TotemFireResistMax", ModType::Base, r, "Base"),
        m("TotemColdResistMax", ModType::Base, r, "Base"),
        m("TotemLightningResistMax", ModType::Base, r, "Base"),
        m("TotemChaosResistMax", ModType::Base, r, "Base"),
        m("BlockChanceMax", ModType::Base, cc.get("maximum_block_%"), "Base"),
        m("SpellBlockChanceMax", ModType::Base, cc.get("base_maximum_spell_block_%"), "Base"),
        m("SpellDodgeChanceMax", ModType::Base, 75.0, "Base"),
        m("ChargeDuration", ModType::Base, 10.0, "Base"),
        m("PowerChargesMax", ModType::Base, cc.get("max_power_charges"), "Base"),
        m("FrenzyChargesMax", ModType::Base, cc.get("max_frenzy_charges"), "Base"),
        m("EnduranceChargesMax", ModType::Base, cc.get("max_endurance_charges"), "Base"),
        m("SiphoningChargesMax", ModType::Base, 0.0, "Base"),
        m("ChallengerChargesMax", ModType::Base, 0.0, "Base"),
        m("BlitzChargesMax", ModType::Base, 0.0, "Base"),
        m("InspirationChargesMax", ModType::Base, cc.get("maximum_righteous_charges"), "Base"),
        m("CrabBarriersMax", ModType::Base, 0.0, "Base"),
        m("BrutalChargesMax", ModType::Base, 0.0, "Base"),
        m("BrineChargesMax", ModType::Base, 0.0, "Base"),
        mt("PhysicalDamageGainAsCold", ModType::Base, cc.get("physical_damage_%_to_add_as_cold_per_brine_charge"), "Base", vec![mult("BrineCharge")]),
        mt("PhysicalDamageGainAsLightning", ModType::Base, cc.get("physical_damage_%_to_add_as_lightning_per_brine_charge"), "Base", vec![mult("BrineCharge")]),
        m("AbsorptionChargesMax", ModType::Base, 0.0, "Base"),
        m("AfflictionChargesMax", ModType::Base, 0.0, "Base"),
        m("BloodChargesMax", ModType::Base, cc.get("maximum_blood_scythe_charges"), "Base"),
        m("MaxLifeLeechRate", ModType::Base, cc.get("maximum_life_leech_rate_%_per_minute") / 60.0, "Base"),
        m("MaxManaLeechRate", ModType::Base, cc.get("maximum_mana_leech_rate_%_per_minute") / 60.0, "Base"),
        m("ImpaleStacksMax", ModType::Base, cc.get("impaled_debuff_number_of_reflected_hits"), "Base"),
        m("SoulEaterMax", ModType::Base, cc.get("soul_eater_maximum_stacks"), "Base"),
        m("BleedStacksMax", ModType::Base, 1.0, "Base"),
        m("MaxEnergyShieldLeechRate", ModType::Base, 10.0, "Base"),
        m("MaxLifeLeechInstance", ModType::Base, cc.get("maximum_life_leech_amount_per_leech_%_max_life"), "Base"),
        m("MaxManaLeechInstance", ModType::Base, cc.get("maximum_mana_leech_amount_per_leech_%_max_mana"), "Base"),
        m("MaxEnergyShieldLeechInstance", ModType::Base, cc.get("maximum_energy_shield_leech_amount_per_leech_%_max_energy_shield"), "Base"),
        m("TrapThrowingTime", ModType::Base, 0.6, "Base"),
        m("MineLayingTime", ModType::Base, 0.3, "Base"),
        m("WarcryCastTime", ModType::Base, 0.8, "Base"),
        m("TotemPlacementTime", ModType::Base, 0.6, "Base"),
        m("BallistaPlacementTime", ModType::Base, 0.5, "Base"),
        m("ActiveTotemLimit", ModType::Base, cc.get("base_number_of_totems_allowed"), "Base"),
        m("ShockStacksMax", ModType::Base, 1.0, "Base"),
        m("ScorchStacksMax", ModType::Base, 1.0, "Base"),
        mt("MovementSpeed", ModType::Inc, -30.0, "Base", vec![cond("Maimed")]),
        mf("DamageTaken", ModType::Inc, 10.0, "Base", mf_::Attack, vec![cond("Intimidated")]),
        mf("DamageTaken", ModType::Inc, 10.0, "Base", mf_::Attack, vec![cond_neg("Intimidated"), cond("Party:Intimidated")]),
        mf("DamageTaken", ModType::Inc, 10.0, "Base", mf_::Spell, vec![cond("Unnerved")]),
        mf("DamageTaken", ModType::Inc, 10.0, "Base", mf_::Spell, vec![cond_neg("Unnerved"), cond("Party:Unnerved")]),
        mt("Damage", ModType::More, -10.0, "Base", vec![cond("Debilitated"), global_effect("Debilitated", "Debuff")]),
        mt("MovementSpeed", ModType::More, -20.0, "Base", vec![cond("Debilitated"), global_effect("Debilitated", "Debuff")]),
        mt("Damage", mm_ty, -10.0, "Base", vec![cond("MalignantMadness"), global_effect("Malignant Madness", "Debuff")]),
        mt("ActionSpeed", mm_ty, -10.0, "Base", vec![cond("MalignantMadness"), global_effect("Malignant Madness", "Debuff")]),
        mt("Condition:Burning", ModType::Flag, 1.0, "Base", vec![ignore_cond(), cond("Ignited")]),
        mt("Condition:Poisoned", ModType::Flag, 1.0, "Base", vec![ignore_cond(), mult_threshold("PoisonStack", 1.0)]),
        mt("Blind", ModType::Flag, 1.0, "Base", vec![cond("Blinded")]),
        mt("Chill", ModType::Flag, 1.0, "Base", vec![cond("Chilled")]),
        mt("Freeze", ModType::Flag, 1.0, "Base", vec![cond("Frozen")]),
        mt("Fortify", ModType::Flag, 1.0, "Base", vec![cond("Fortify")]),
        mt("Fortified", ModType::Flag, 1.0, "Base", vec![cond("Fortified")]),
        mt("Excommunicated", ModType::Flag, 1.0, "Base", vec![cond("Excommunicated")]),
        mt("Fanaticism", ModType::Flag, 1.0, "Base", vec![cond("Fanaticism")]),
        mt("Onslaught", ModType::Flag, 1.0, "Base", vec![cond("Onslaught")]),
        mt("UnholyMight", ModType::Flag, 1.0, "Base", vec![cond("UnholyMight")]),
        mt("ChaoticMight", ModType::Flag, 1.0, "Base", vec![cond("ChaoticMight")]),
        mt("Tailwind", ModType::Flag, 1.0, "Base", vec![cond("Tailwind")]),
        mt("Adrenaline", ModType::Flag, 1.0, "Base", vec![cond("Adrenaline")]),
        mt("AccelerationShrine", ModType::Flag, 1.0, "Base", vec![cond("AccelerationShrine")]),
        mt("BrutalShrine", ModType::Flag, 1.0, "Base", vec![cond("BrutalShrine")]),
        mt("DiamondShrine", ModType::Flag, 1.0, "Base", vec![cond("DiamondShrine")]),
        mt("DivineShrine", ModType::Flag, 1.0, "Base", vec![cond("DivineShrine")]),
        mt("EchoingShrine", ModType::Flag, 1.0, "Base", vec![cond("EchoingShrine")]),
        mt("GloomShrine", ModType::Flag, 1.0, "Base", vec![cond("GloomShrine")]),
        mt("GreaterFreezingShrine", ModType::Flag, 1.0, "Base", vec![cond("GreaterFreezingShrine")]),
        mt("GreaterShockingShrine", ModType::Flag, 1.0, "Base", vec![cond("GreaterShockingShrine")]),
        mt("GreaterSkeletalShrine", ModType::Flag, 1.0, "Base", vec![cond("GreaterSkeletalShrine")]),
        mt("ImpenetrableShrine", ModType::Flag, 1.0, "Base", vec![cond("ImpenetrableShrine")]),
        mt("MassiveShrine", ModType::Flag, 1.0, "Base", vec![cond("MassiveShrine")]),
        mt("ReplenishingShrine", ModType::Flag, 1.0, "Base", vec![cond("ReplenishingShrine")]),
        mt("ResistanceShrine", ModType::Flag, 1.0, "Base", vec![cond("ResistanceShrine")]),
        mt("ResonatingShrine", ModType::Flag, 1.0, "Base", vec![cond("ResonatingShrine")]),
        mt("LesserAccelerationShrine", ModType::Flag, 1.0, "Base", vec![cond("LesserAccelerationShrine"), cond_neg("AccelerationShrine")]),
        mt("LesserBrutalShrine", ModType::Flag, 1.0, "Base", vec![cond("LesserBrutalShrine"), cond_neg("BrutalShrine")]),
        mt("LesserImpenetrableShrine", ModType::Flag, 1.0, "Base", vec![cond("LesserImpenetrableShrine"), cond_neg("ImpenetrableShrine")]),
        mt("LesserMassiveShrine", ModType::Flag, 1.0, "Base", vec![cond("LesserMassiveShrine"), cond_neg("MassiveShrine")]),
        mt("LesserReplenishingShrine", ModType::Flag, 1.0, "Base", vec![cond("LesserReplenishingShrine"), cond_neg("ReplenishingShrine")]),
        mt("LesserResistanceShrine", ModType::Flag, 1.0, "Base", vec![cond("LesserResistanceShrine"), cond_neg("ResistanceShrine")]),
        mt("BloodShrineOfRats", ModType::Flag, 1.0, "Base", vec![cond("BloodShrineOfRats")]),
        mt("BloodShrineOfLocusts", ModType::Flag, 1.0, "Base", vec![cond("BloodShrineOfLocusts")]),
        mt("BloodShrineOfToads", ModType::Flag, 1.0, "Base", vec![cond("BloodShrineOfToads")]),
        mt("BloodShrineOfCrows", ModType::Flag, 1.0, "Base", vec![cond("BloodShrineOfCrows")]),
        mt("BloodShrineOfBats", ModType::Flag, 1.0, "Base", vec![cond("BloodShrineOfBats")]),
        mt("AlchemistsGenius", ModType::Flag, 1.0, "Base", vec![cond("AlchemistsGenius")]),
        mt("LuckyHits", ModType::Flag, 1.0, "Base", vec![cond("LuckyHits")]),
        mt("Convergence", ModType::Flag, 1.0, "Base", vec![cond("Convergence")]),
        mt("PhysicalDamageReduction", ModType::Base, -15.0, "Base", vec![cond("Crushed")]),
        m("CritChanceCap", ModType::Base, 100.0, "Base"),
    ];
    // Flag mods carry a boolean `true` value in the Lua, not the number 1.0 `mt()` gives them
    // above; fix that up here so every FLAG mod matches the golden shape exactly.
    for md in mods.iter_mut() {
        if md.ty == ModType::Flag {
            md.value = pom_engine::value::Value::Bool(true);
        }
    }
    InitModDbResult {
        mods,
        conditions: vec![("Buffed", mode_buffs), ("Combat", mode_combat), ("Effective", mode_effective)],
    }
}

/// The player-only part of `initEnv`'s base-mod block: attributes, life/mana/evasion/accuracy
/// bases, resistances, the charge/rampage/dual-wield/bleed constants (lines 592-650), and the
/// bandit reward (lines 651-660). Does not include `calcs.initModDB` (call `init_mod_db`
/// separately) or the pantheon mods (unported, see module doc).
pub fn player_base_mods(cc: &CharacterConstants, tree_version: &str, class_id: i64, character_level: f64, config: &ConfigInputSubset) -> Vec<Mod> {
    let stats = class_base_stats(tree_version, class_id);
    let penalty = config.resistance_penalty.unwrap_or(-60.0);
    let mut mods = vec![
        m("Str", ModType::Base, stats.str_, "Base"),
        m("Dex", ModType::Base, stats.dex, "Base"),
        m("Int", ModType::Base, stats.int_, "Base"),
        mt("Life", ModType::Base, cc.get("life_per_level"), "Base", vec![mult_base("Level", 38.0)]),
        mt("Mana", ModType::Base, cc.get("mana_per_level"), "Base", vec![mult_base("Level", 34.0)]),
        mt("ManaRegen", ModType::Base, game_data().misc.get("ManaRegenBase").unwrap_or(0.0), "Base", vec![per_stat_div("Mana", 1.0)]),
        m("Devotion", ModType::Base, 0.0, "Base"),
        m("Evasion", ModType::Base, cc.get("base_evasion_rating"), "Base"),
        mt("Accuracy", ModType::Base, cc.get("accuracy_rating_per_level"), "Base", vec![mult_base("Level", -cc.get("accuracy_rating_per_level"))]),
        m("CritMultiplier", ModType::Base, cc.get("base_critical_strike_multiplier") - 100.0, "Base"),
        mt("DotMultiplier", ModType::Base, cc.get("critical_ailment_dot_multiplier_+"), "Base", vec![cond("CriticalStrike")]),
        m("FireResist", ModType::Base, penalty, "Base"),
        m("ColdResist", ModType::Base, penalty, "Base"),
        m("LightningResist", ModType::Base, penalty, "Base"),
        m("ChaosResist", ModType::Base, penalty, "Base"),
        m("TotemFireResist", ModType::Base, 40.0, "Base"),
        m("TotemColdResist", ModType::Base, 40.0, "Base"),
        m("TotemLightningResist", ModType::Base, 40.0, "Base"),
        m("TotemChaosResist", ModType::Base, 20.0, "Base"),
        mt("CritChance", ModType::Inc, cc.get("critical_strike_chance_+%_per_power_charge"), "Base", vec![mult("PowerCharge")]),
        mf("Speed", ModType::Inc, cc.get("base_attack_speed_+%_per_frenzy_charge"), "Base", mf_::Attack, vec![mult("FrenzyCharge")]),
        mf("Speed", ModType::Inc, cc.get("base_cast_speed_+%_per_frenzy_charge"), "Base", mf_::Cast, vec![mult("FrenzyCharge")]),
        mt("Damage", ModType::More, cc.get("object_inherent_damage_+%_final_per_frenzy_charge"), "Base", vec![mult("FrenzyCharge")]),
        mt("PhysicalDamageReduction", ModType::Base, cc.get("physical_damage_reduction_%_per_endurance_charge"), "Base", vec![mult("EnduranceCharge")]),
        mt("ElementalDamageReduction", ModType::Base, cc.get("elemental_damage_reduction_%_per_endurance_charge"), "Base", vec![mult("EnduranceCharge")]),
        m("MaximumRage", ModType::Base, cc.get("maximum_rage"), "Base"),
        m("Multiplier:GaleForce", ModType::Base, 0.0, "Base"),
        m("MaximumGaleForce", ModType::Base, 10.0, "Base"),
        m("MaximumFortification", ModType::Base, cc.get("base_max_fortification"), "Base"),
        m("MaximumValour", ModType::Base, 50.0, "Base"),
        m("Multiplier:IntensityLimit", ModType::Base, 3.0, "Base"),
        mt("Damage", ModType::Inc, cc.get("damage_+%_per_10_rampage_stacks"), "Base", vec![mult_ld("Rampage", cc.get("max_rampage_stacks") / 20.0, 20.0)]),
        mt("MovementSpeed", ModType::Inc, cc.get("movement_velocity_+%_per_10_rampage_stacks"), "Base", vec![mult_ld("Rampage", cc.get("max_rampage_stacks") / 20.0, 20.0)]),
        m("ActiveTrapLimit", ModType::Base, cc.get("base_number_of_traps_allowed"), "Base"),
        m("ActiveMineLimit", ModType::Base, cc.get("base_number_of_remote_mines_allowed"), "Base"),
        m("MineThrowCount", ModType::Base, 1.0, "Base"),
        m("TrapThrowCount", ModType::Base, 1.0, "Base"),
        m("ActiveBrandLimit", ModType::Base, 3.0, "Base"),
        m("EnemyCurseLimit", ModType::Base, 1.0, "Base"),
        m("SocketedCursesHexLimitValue", ModType::Base, 1.0, "Base"),
        m("ProjectileCount", ModType::Base, 1.0, "Base"),
        mf("Speed", ModType::More, cc.get("dual_wield_inherent_attack_speed_+%_final"), "Base", mf_::Attack, vec![cond("DualWielding"), cond_neg("DoubledInherentDualWieldingSpeed")]),
        mf("Speed", ModType::More, 2.0 * cc.get("dual_wield_inherent_attack_speed_+%_final"), "Base", mf_::Attack, vec![cond("DualWielding"), cond("DoubledInherentDualWieldingSpeed")]),
        mt("BlockChance", ModType::Base, cc.get("inherent_block_while_dual_wielding_%"), "Base", vec![cond("DualWielding"), cond_neg("NoInherentBlock"), cond_neg("DoubledInherentDualWieldingBlock")]),
        mt("BlockChance", ModType::Base, 2.0 * cc.get("inherent_block_while_dual_wielding_%"), "Base", vec![cond("DualWielding"), cond_neg("NoInherentBlock"), cond("DoubledInherentDualWieldingBlock")]),
        mfk("Damage", ModType::More, 200.0, "Base", 0, kf::Bleed, vec![actor_cond("enemy", "Moving"), cond_neg("NoExtraBleedDamageToMovingEnemy")]),
        mt("Condition:BloodStance", ModType::Flag, 1.0, "Base", vec![cond_neg("SandStance")]),
        mt("Condition:PrideMinEffect", ModType::Flag, 1.0, "Base", vec![cond_neg("PrideMaxEffect")]),
        m("PerBrutalTripleDamageChance", ModType::Base, cc.get("chance_to_deal_triple_damage_%_per_brutal_charge"), "Base"),
        m("PerAfflictionAilmentDamage", ModType::Base, cc.get("ailment_damage_+%_final_per_affliction_charge"), "Base"),
        m("PerAfflictionNonDamageEffect", ModType::Base, cc.get("non_damaging_ailment_effect_+%_final_per_affliction_charge"), "Base"),
        m("PerAbsorptionElementalEnergyShieldRecoup", ModType::Base, cc.get("elemental_damage_taken_goes_to_energy_shield_over_4_seconds_%_per_absorption_charge"), "Base"),
        m("TinctureLimit", ModType::Base, 1.0, "Base"),
        mt("ManaDegenPercentTincture", ModType::Base, 1.0, "Base", vec![mult("EffectiveManaBurnStacks")]),
        mt("LifeDegenPercentTincture", ModType::Base, 1.0, "Base", vec![mult("WeepingWoundsStacks")]),
        m("PresenceRadius", ModType::Base, cc.get("base_presence_radius"), "Base"),
    ];
    for md in mods.iter_mut() {
        if md.ty == ModType::Flag {
            md.value = pom_engine::value::Value::Bool(true);
        }
    }
    mods.push(bandit_mod(config.bandit.as_deref()));
    let _ = character_level; // Level goes on modDB.multipliers, not a NewMod call; see level_multiplier() below
    mods
}

/// `initEnv` lines 652-660: exactly one bandit reward mod, keyed by the bandit tab choice.
fn bandit_mod(bandit: Option<&str>) -> Mod {
    match bandit {
        Some("Alira") => m("ElementalResist", ModType::Base, 15.0, "Bandit"),
        Some("Kraityn") => m("MovementSpeed", ModType::Inc, 8.0, "Bandit"),
        Some("Oak") => m("Life", ModType::Base, 40.0, "Bandit"),
        _ => m("ExtraPoints", ModType::Base, 1.0, "Bandit"),
    }
}

/// `modDB.multipliers["Level"] = m_max(1, m_min(100, build.characterLevel))` (`initEnv` line 595).
pub fn level_multiplier(character_level: f64) -> f64 {
    character_level.min(100.0).max(1.0)
}

/// The enemy-only part of the base-mod block (`initEnv` lines 676-678), after `init_mod_db`
/// (which the enemy's ModDB also gets, per line 676).
pub fn enemy_base_mods(enemy_level: i64) -> Vec<Mod> {
    vec![
        m("Accuracy", ModType::Base, monster_accuracy(enemy_level), "Base"),
        mbk("Condition:AgainstDamageOverTime", "Base", mf_::Dot, 0, vec![actor_cond("player", "Combat")]),
    ]
}

/// Symbol form of a mod name, for looking a built mod set up by name in tests/grading.
pub fn sym(name: &str) -> Sym {
    Sym::new(name)
}

/// `initEnv`'s item-merge loop (CalcSetup.lua:802-844) only ever merges ONE of "Weapon N" /
/// "Weapon N Swap" per weapon slot number into `env.modDB` - whichever `slot.weaponSet` matches
/// `build.itemsTab.activeItemSet.useSecondWeaponSet` (false -> weaponSet 1, i.e. "Weapon N"; true
/// -> weaponSet 2, i.e. "Weapon N Swap", renamed by stripping " Swap" as it merges, line 843-844).
/// The other slot's item is skipped entirely (`goto continue`, line 840-842), not merged and then
/// overridden - it must not contribute any mods at all. `item_slots` (this crate's recorded
/// `itemSlots`, and the real `build.itemsTab` equivalent for a live caller)
/// always has both slots present whenever both have a selected item, so this filters and renames
/// down to just the slots CalcSetup.lua would actually reach.
///
/// Also drops a jewel-socket slot ("Jewel <nodeId>", `ItemsTab.lua:231`'s `"Jewel "..node.id`)
/// whose `nodeId` is not a member of `allocated_node_ids` (CalcSetup.lua:816-818: `if
/// slot.nodeId then if not env.allocNodes[slot.nodeId] then goto continue end`). `itemsTab`
/// keeps one such slot per jewel socket node the tree has ever exposed (including ones a stale
/// cluster-jewel graph or a since-reworked tree version no longer allocates), so `item_slots` can
/// carry a jewel under a node id that is not part of the build's *current* `env.allocNodes` - an
/// item there must not contribute any mods, matching every other jewel socket that never got a
/// node id allocated in the first place.
pub fn active_item_slots(item_slots: &HashMap<String, i64>, use_second_weapon_set: bool, allocated_node_ids: &pom_engine::fxhash::HashSet<i64>) -> HashMap<String, i64> {
    let mut out = HashMap::default();
    for (slot_name, item_id) in item_slots {
        if let Some(node_id_str) = slot_name.strip_prefix("Jewel ") {
            if let Ok(node_id) = node_id_str.parse::<i64>() {
                if !allocated_node_ids.contains(&node_id) {
                    continue;
                }
            }
        }
        if !slot_name.starts_with("Weapon ") {
            out.insert(slot_name.clone(), *item_id);
            continue;
        }
        // weaponSet 1 is every plain "Weapon N"/"Weapon N Abyssal Socket M" slot; weaponSet 2 is
        // its "... Swap ..." counterpart (ItemsTab.lua:158-194). Only the set matching
        // `use_second_weapon_set` is reached by CalcSetup.lua's merge loop.
        let is_swap = slot_name.contains(" Swap");
        if is_swap != use_second_weapon_set {
            continue;
        }
        let name = if is_swap { slot_name.replace(" Swap", "") } else { slot_name.clone() };
        out.insert(name, *item_id);
    }
    out
}

/// `initEnv` lines 778-789: `Multiplier:AllocatedNotable`/`AllocatedKeystone`/`AllocatedMastery`/
/// `AllocatedMasteryType`, each only added when its count is greater than 0, and each with no
/// `source` argument (Lua `NewMod` with the arg omitted, not `nil` passed explicitly - matches
/// golden's `source: null`). `AllocatedLifeMastery` (per mastery-group-name grouping) and the
/// tattoo-type multipliers (lines 793-797) are not covered.
///
/// The four counts here are `env.spec.allocatedNotableCount`/`allocatedKeystoneCount`/
/// `allocatedMasteryCount`/`allocatedMasteryTypeCount` (CalcSetup.lua:702-705) taken as-is, NOT
/// derived by counting `env.allocNodes`/a build's allocated-node set: those are two different
/// things in upstream. `PassiveSpec.lua`'s `BuildAllDependsAndPaths` recomputes these four
/// scalars from scratch (a loop over every node checking `node.alloc`) and is the only place that
/// ever does, but a spec loaded from a legacy `<Spec><URL>` element (`PassiveSpec:DecodeURL`)
/// allocates its real nodes via `AllocateDecodedNodes` without ever calling
/// `BuildAllDependsAndPaths` itself; the one correct recompute for such a spec happens earlier,
/// during `PassiveSpec:PostLoad` -> `BuildClusterJewelGraphs`'s own trailing
/// `BuildAllDependsAndPaths` call (using the fully-populated node set at that point). Something
/// between that point and any later read of `env.spec.allocNodes` prunes it back down to just the
/// class-start nodes for these builds (traced as far as `ItemsTab.lua`'s jewel-comparison
/// spec-cloning code sharing structure with the real spec - not fully root-caused) without ever
/// re-running the count-reset loop, so the four scalars are left "stuck" at that last-correct
/// value while `env.allocNodes` no longer reflects it. Confirmed on the sample set
/// (45 of 198 builds hit this). A calculator
/// that (like upstream) never revisits these scalars after the spec's own load simply carries
/// whatever `env.spec.allocatedNotableCount`-equivalent state it was given; this crate cannot
/// derive that value on its own from a node set alone; the caller (`calc_golden`'s corpus reader,
/// or the eventual live spec-loading path) must supply it.
pub fn allocated_count_mods(notable: usize, keystone: usize, mastery: usize, mastery_type: usize, life_mastery: usize) -> Vec<Mod> {
    let mut mods = Vec::new();
    let no_source = |name: &str, v: f64| Mod { name: Sym::new(name), ty: ModType::Base, value: pom_engine::value::Value::Num(v), flags: 0, keyword_flags: 0, source: None, tags: (vec![]).into() };
    if notable > 0 {
        mods.push(no_source("Multiplier:AllocatedNotable", notable as f64));
    }
    if keystone > 0 {
        mods.push(no_source("Multiplier:AllocatedKeystone", keystone as f64));
    }
    if mastery > 0 {
        mods.push(no_source("Multiplier:AllocatedMastery", mastery as f64));
    }
    if mastery_type > 0 {
        mods.push(no_source("Multiplier:AllocatedMasteryType", mastery_type as f64));
    }
    // CalcSetup.lua:790-792: `allocatedMasteryTypes["Life Mastery"]`, same stale-scalar source as
    // the four counts above (see this fn's doc comment) but keyed by mastery group name rather
    // than a flat scalar - "Life Mastery" is the only group name upstream reads out of it.
    if life_mastery > 0 {
        mods.push(no_source("Multiplier:AllocatedLifeMastery", life_mastery as f64));
    }
    mods
}

#[cfg(test)]
mod tests {
    use super::*;
    use pom_engine::value::Value;

    #[test]
    fn malignant_madness_is_inc() {
        let r = init_mod_db(CharacterConstants::shared(), true, true, true);
        let (cond_k, var_k) = (Sym::new("Condition"), Sym::new("var"));
        let mm: Vec<&Mod> = r.mods.iter()
            .filter(|m| m.tags.iter().any(|t| t.kind == cond_k && matches!(t.get(var_k), Value::Str(s) if &**s == "MalignantMadness")))
            .collect();
        assert_eq!(mm.len(), 2);
        for m in mm {
            assert_eq!(m.ty, ModType::Inc);
            assert!(matches!(m.value, Value::Num(v) if v == -10.0));
        }
    }
}
