// Port of Modules/CalcOffence.lua's ailment chance-to-inflict section (4195-4287), the
// calcAilmentDamage/calcAverageSourceDamage helpers (4315-4409), and the non-damaging-ailment
// magnitude/duration section (5332-5513: Chill/Shock/Scorch/Brittle/Sap "effect"/"threshold"
// formulas, the ChillingArea/NonHitChill special case, and the Freeze special case).
//
// `calcAverageSourceDamage` reads `output[<Type>HitAverage]`/`output[<Type>CritAverage]` - set by
// the un-ported hit-pass loop (CalcOffence.lua:3648/3657). Per leech.rs's isolation note, these are
// taken as recorded inputs (the golden's own `output_after`), not recomputed. Graded against the
// "Skill" pass only (non-attack skills, cfg == skillCfg).
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_engine::fxhash::HashMap;
use std::sync::Arc;

pub const DMG_TYPES: [&str; 5] = ["Physical", "Lightning", "Cold", "Fire", "Chaos"];
/// `data.elementalAilmentTypeList` (Modules/Data.lua:420).
pub const ELEMENTAL_AILMENT_TYPES: [&str; 7] = ["Ignite", "Chill", "Freeze", "Shock", "Scorch", "Brittle", "Sap"];
/// `data.ailmentTypeList` (Modules/Data.lua:419).
pub const AILMENT_TYPES: [&str; 9] = ["Bleed", "Poison", "Ignite", "Chill", "Freeze", "Shock", "Scorch", "Brittle", "Sap"];
/// `data.nonDamagingAilment` keys, i.e. `data.nonDamagingAilmentTypeList` (Modules/Data.lua:421).
pub const NON_DAMAGING_AILMENT_TYPES: [&str; 6] = ["Chill", "Freeze", "Shock", "Scorch", "Brittle", "Sap"];

/// `data.nonDamagingAilment[ailment]` (Modules/Data.lua:424-431).
pub struct AilmentDataEntry {
    pub associated_type: &'static str,
    pub alt: bool,
    pub default: Option<f64>,
    pub max: f64,
    pub duration: Option<f64>,
}
pub fn ailment_data(ailment: &str) -> AilmentDataEntry {
    match ailment {
        "Chill" => AilmentDataEntry { associated_type: "Cold", alt: false, default: Some(10.0), max: 30.0, duration: Some(2.0) },
        "Freeze" => AilmentDataEntry { associated_type: "Cold", alt: false, default: None, max: 3.0, duration: None },
        "Shock" => AilmentDataEntry { associated_type: "Lightning", alt: false, default: Some(15.0), max: 50.0, duration: Some(2.0) },
        "Scorch" => AilmentDataEntry { associated_type: "Fire", alt: true, default: Some(10.0), max: 30.0, duration: Some(4.0) },
        "Brittle" => AilmentDataEntry { associated_type: "Cold", alt: true, default: Some(2.0), max: 6.0, duration: Some(4.0) },
        "Sap" => AilmentDataEntry { associated_type: "Lightning", alt: true, default: Some(6.0), max: 20.0, duration: Some(4.0) },
        _ => panic!("ailment_data: unknown non-damaging ailment {ailment}"),
    }
}

/// `canDeal[damageType]` (CalcOffence.lua:1931-1935): `not skillModList:Flag(skillCfg, "DealNo"..t, "DealNoDamage")`.
pub fn can_deal(skill_mod_list: &ModStore, cfg: Option<&Cfg>, damage_type: &str) -> bool {
    !skill_mod_list.flag(cfg, &[Sym::new(&format!("DealNo{damage_type}")), pom_engine::sym!("DealNoDamage")])
}

/// Inputs the chance section needs beyond skillModList/enemyDB/cfg: `skillFlags.attack`/`.hit`,
/// `env.mode_effective`, `env.modDB` (for the global `IgniteCanScorch` flag, actor-wide not
/// skill-scoped).
pub struct ChanceCtx<'a> {
    pub skill_flags_attack: bool,
    pub skill_flags_hit: bool,
    pub mode_effective: bool,
    pub env_mod_db: &'a ModStore,
}

/// The chance-to-inflict section (CalcOffence.lua:4195-4287, minus Knockback/Exposure which aren't
/// in this crate's DoT/ailment scope). Returns every `output[<Ailment>ChanceOnHit/OnCrit]` plus
/// `ChaosPoisonChance`/`ImpaleChance`/`ImpaleChanceOnCrit`/`ScorchChance`/`ScorchChanceOnCrit`,
/// keyed by the exact Lua field name. `output.EnemyScorchChance` NewMod side effect (4241) is not
/// replicated - this crate's ModStore snapshots are immutable; named gap.
/// Side-channel key in `calc_ailment_chances`' result: the value of the `EnemyScorchChance` mod upstream adds (4241).
pub const IGNITE_SCORCH_MOD_KEY: &str = "__IgniteScorchMod";

pub fn calc_ailment_chances(skill_mod_list: &ModStore, enemy_db: &ModStore, cfg: Option<&Cfg>, ctx: &ChanceCtx) -> HashMap<String, f64> {
    let mut out = HashMap::default();

    // `cfg.skillCond["CriticalStrike"] = true`/`false` (CalcOffence.lua:4196/4217): the Bleed/
    // Poison/Impale OnCrit queries run under an explicit crit condition, the OnHit ones (and the
    // elemental-ailment loop below, which never re-queries under a crit condition - see its own
    // comment) under non-crit. Cloned locally since this crate's `Cfg`s are shared/immutable.
    let cfg_crit = cfg.map(|c| {
        let mut c = c.clone();
        c.skill_cond.insert(Arc::from("CriticalStrike"), true);
        c
    });
    let cfg_nocrit = cfg.map(|c| {
        let mut c = c.clone();
        c.skill_cond.insert(Arc::from("CriticalStrike"), false);
        c
    });
    let cfg_crit = cfg_crit.as_ref();
    let cfg_nocrit_ref = cfg_nocrit.as_ref();

    let bleed_chance = |c: Option<&Cfg>| -> f64 {
        if !ctx.skill_flags_attack || skill_mod_list.flag(c, &[pom_engine::sym!("CannotBleed")]) {
            0.0
        } else {
            (skill_mod_list.sum(ModType::Base, c, &[pom_engine::sym!("BleedChance")]) + enemy_db.sum(ModType::Base, None, &[pom_engine::sym!("SelfBleedChance")])).min(100.0)
        }
    };
    out.insert("BleedChanceOnCrit".into(), bleed_chance(cfg_crit));
    let poison_chance = |c: Option<&Cfg>| -> f64 {
        if !ctx.skill_flags_hit || skill_mod_list.flag(c, &[pom_engine::sym!("CannotPoison")]) {
            0.0
        } else {
            (skill_mod_list.sum(ModType::Base, c, &[pom_engine::sym!("PoisonChance")]) + enemy_db.sum(ModType::Base, None, &[pom_engine::sym!("SelfPoisonChance")])).min(100.0)
        }
    };
    out.insert("PoisonChanceOnCrit".into(), poison_chance(cfg_crit));
    let impale_chance_on_crit = if !ctx.skill_flags_hit {
        0.0
    } else if ctx.mode_effective {
        skill_mod_list.sum(ModType::Base, cfg_crit, &[pom_engine::sym!("ImpaleChance")]).min(100.0)
    } else {
        0.0
    };
    out.insert("ImpaleChanceOnCrit".into(), impale_chance_on_crit);

    out.insert("BleedChanceOnHit".into(), bleed_chance(cfg_nocrit_ref));
    if !ctx.skill_flags_hit || skill_mod_list.flag(cfg_nocrit_ref, &[pom_engine::sym!("CannotPoison")]) {
        out.insert("PoisonChanceOnHit".into(), 0.0);
        out.insert("ChaosPoisonChance".into(), 0.0);
    } else {
        out.insert("PoisonChanceOnHit".into(), poison_chance(cfg_nocrit_ref));
        out.insert("ChaosPoisonChance".into(), skill_mod_list.sum(ModType::Base, cfg_nocrit_ref, &[pom_engine::sym!("ChaosPoisonChance")]).min(100.0));
    }

    let ignite_can_scorch = ctx.env_mod_db.flag(None, &[pom_engine::sym!("IgniteCanScorch")]);
    // `skillModList:NewMod("EnemyScorchChance", "BASE", chance, "Ignite Chance")` (4241): later reads of
    // `EnemyScorchChance` in this loop (Scorch comes after Ignite) see it; callers with a mutable
    // skill mod list add the mod for real when they find `IGNITE_SCORCH_MOD_KEY` in the result.
    let mut scorch_extra = 0.0;
    for &ailment in ELEMENTAL_AILMENT_TYPES.iter() {
        let cfg = cfg_nocrit_ref;
        let mut chance = skill_mod_list.sum(ModType::Base, cfg, &[Sym::new(&format!("Enemy{ailment}Chance"))]) + enemy_db.sum(ModType::Base, None, &[Sym::new(&format!("Self{ailment}Chance"))]);
        if ailment == "Scorch" {
            chance += scorch_extra;
        }
        let immune = enemy_db.flag(None, &[Sym::new(&format!("{ailment}Immune")), pom_engine::sym!("ElementalAilmentImmune")]);
        let avoid_sum = enemy_db.sum(ModType::Base, None, &[Sym::new(&format!("Avoid{ailment}")), pom_engine::sym!("AvoidAilments"), pom_engine::sym!("AvoidElementalAilments")]);
        // Lua: `enemyDB:Flag(...) and 100 or 0 + enemyDB:Sum(...)` - `and`/`or` bind looser than
        // `+` in Lua, so this is `immune and 100 or (0 + avoidSum)`, NOT `(immune and 100 or 0) +
        // avoidSum`: when immune, avoidSum is not added at all. Only observable when avoidSum < 0
        // (a "reduced chance to avoid" mod) - otherwise the outer `m_min(_, 100)` clamp hides it.
        let avoid = 1.0 - (if immune { 100.0 } else { avoid_sum }.min(100.0)) / 100.0;
        if ailment == "Chill" {
            chance = 100.0;
        }
        chance *= avoid;
        if ailment == "Ignite" && ignite_can_scorch {
            out.insert("ScorchChance".into(), chance.min(100.0));
            scorch_extra += chance;
            out.insert(IGNITE_SCORCH_MOD_KEY.into(), chance);
        }
        let (chance_on_hit, chance_on_crit);
        if ctx.skill_flags_hit && !(skill_mod_list.flag(cfg, &[Sym::new(&format!("Cannot{ailment}"))]) || avoid == 0.0) {
            chance_on_hit = chance.min(100.0);
            let alt = if ailment == "Ignite" { false } else { ailment_data(ailment).alt };
            if skill_mod_list.flag(cfg, &[Sym::new(&format!("CritsDontAlways{ailment}"))]) || (alt && !skill_mod_list.flag(cfg, &[pom_engine::sym!("CritAlwaysAltAilments")])) {
                chance_on_crit = chance_on_hit;
            } else {
                chance_on_crit = 100.0;
            }
        } else {
            chance_on_hit = 0.0;
            chance_on_crit = 0.0;
        }
        out.insert(format!("{ailment}ChanceOnHit"), chance_on_hit);
        out.insert(format!("{ailment}ChanceOnCrit"), chance_on_crit);
        if ailment == "Scorch" && ignite_can_scorch && avoid != 0.0 {
            out.insert("ScorchChanceOnCrit".into(), 100.0);
        }
    }

    let impale_chance = if ctx.mode_effective { skill_mod_list.sum(ModType::Base, cfg_nocrit_ref, &[pom_engine::sym!("ImpaleChance")]).min(100.0) } else { 0.0 };
    out.insert("ImpaleChance".into(), impale_chance);

    if ctx.mode_effective {
        for &ailment in AILMENT_TYPES.iter() {
            let immune = enemy_db.flag(None, &[Sym::new(&format!("{ailment}Immune"))]);
            let mult = if immune { 0.0 } else { 1.0 - enemy_db.sum(ModType::Base, None, &[Sym::new(&format!("Avoid{ailment}"))]) / 100.0 };
            let hit_key = format!("{ailment}ChanceOnHit");
            let crit_key = format!("{ailment}ChanceOnCrit");
            *out.entry(hit_key).or_insert(0.0) *= mult;
            *out.entry(crit_key).or_insert(0.0) *= mult;
            if ailment == "Poison" {
                *out.entry("ChaosPoisonChance".into()).or_insert(0.0) *= mult;
            }
        }
    }

    out
}

/// Applies `env.configInput.ailmentMode`/`AilmentsOnlyFromCrit`/`AilmentsAreNeverFromCrit`
/// (CalcOffence.lua:4289-4303) on top of `calc_ailment_chances`'s output, in place.
pub fn apply_ailment_mode(out: &mut HashMap<String, f64>, mod_db: &ModStore, ailment_mode_crit: bool) {
    let only_from_crit = mod_db.flag(None, &[pom_engine::sym!("AilmentsOnlyFromCrit")]);
    if ailment_mode_crit || only_from_crit {
        for &ailment in AILMENT_TYPES.iter() {
            out.insert(format!("{ailment}ChanceOnHit"), 0.0);
        }
    }
    if mod_db.flag(None, &[pom_engine::sym!("AilmentsAreNeverFromCrit")]) {
        for &ailment in AILMENT_TYPES.iter() {
            let hit = *out.get(&format!("{ailment}ChanceOnHit")).unwrap_or(&0.0);
            out.insert(format!("{ailment}ChanceOnCrit"), if only_from_crit { 0.0 } else { hit });
        }
    }
}

/// `calcAverageSourceDamage(ailment)` (CalcOffence.lua:4315-4330); `hit_avg`/`crit_avg` are
/// `output[<Type>HitAverage]`/`output[<Type>CritAverage]`, recorded (see module doc).
pub fn calc_average_source_damage(skill_mod_list: &ModStore, cfg: Option<&Cfg>, ailment: &str, hit_avg: &HashMap<&str, f64>, crit_avg: &HashMap<&str, f64>) -> (f64, f64) {
    let associated = ailment_data(ailment).associated_type;
    let mut source_hit = 0.0;
    let mut source_crit = 0.0;
    for &t in DMG_TYPES.iter() {
        if !can_deal(skill_mod_list, cfg, t) {
            continue;
        }
        let dealt = if t == associated { !skill_mod_list.flag(cfg, &[Sym::new(&format!("{t}Cannot{ailment}"))]) } else { skill_mod_list.flag(cfg, &[Sym::new(&format!("{t}Can{ailment}"))]) };
        if dealt {
            source_hit += *hit_avg.get(t).unwrap_or(&0.0);
            source_crit += *crit_avg.get(t).unwrap_or(&0.0);
        }
    }
    (source_hit, source_crit)
}

/// Builds a `cfg` clone with `skillCond["CriticalStrike"]` forced to `crit` (CalcOffence.lua:
/// 5424-5428's `cfg.skillCond["CriticalStrike"] = (ailmentMode == "CRIT" and not
/// AilmentsAreNeverFromCrit)` toggle, applied before both `calcAverageSourceDamage` and the
/// `<Ailment>AsThoughDealing` More query in the non-damaging-ailment loop). Callers pass the
/// result to both `calc_average_source_damage` and `calc_non_damaging_ailment` so they see the
/// same cfg the Lua's single shared `cfg` object would have at that point.
pub fn with_crit_cond(cfg: Option<&Cfg>, crit: bool) -> Option<Cfg> {
    cfg.map(|c| {
        let mut c = c.clone();
        c.skill_cond.insert(Arc::from("CriticalStrike"), crit);
        c
    })
}

/// `calcAilmentDamage(type, sourceCritChance, sourceHitDmg, sourceCritDmg)` (CalcOffence.lua:
/// 4333-4409, breakdown text stripped). Note: does NOT apply the `<Type>AsThoughDealing` More
/// multiplier - the Lua applies that at the call site, not inside this helper; callers must do the
/// same. `chance_out` receives `output[<Type>.."Chance"]` (a genuine side output, 4339).
/// `0.0 / 0.0 = NaN` when both chances are 0 is a faithful reproduction of the Lua's own
/// `baseFromHit/baseFromCrit` division (no zero-chance guard exists in the source).
pub fn calc_ailment_damage(chance_on_hit: f64, chance_on_crit: f64, source_crit_chance: f64, source_hit_dmg: f64, source_crit_dmg: f64) -> (f64, f64) {
    let chance_from_hit = chance_on_hit * (1.0 - source_crit_chance / 100.0);
    let chance_from_crit = chance_on_crit * source_crit_chance / 100.0;
    let chance = chance_from_hit + chance_from_crit;
    let base_from_hit = source_hit_dmg * chance_from_hit / (chance_from_hit + chance_from_crit);
    let base_from_crit = source_crit_dmg * chance_from_crit / (chance_from_hit + chance_from_crit);
    (chance, base_from_hit + base_from_crit)
}

/// One non-damaging ailment's computed `Duration`/`EffectMod` (CalcOffence.lua:5430-5438), and the
/// intermediate `damage` used to gate them (`damage > 0` at 5432).
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct NonDamagingAilmentOutput {
    pub damage: f64,
    pub duration: Option<f64>,
    pub effect_mod: Option<f64>,
}

/// Everything the non-damaging-ailment loop (CalcOffence.lua:5416-5513) reads beyond
/// skillModList/enemyDB/cfg for a single `ailment`.
pub struct NonDamagingAilmentCtx {
    pub chance_on_hit: f64,
    pub chance_on_crit: f64,
    pub crit_chance: f64,
    pub source_hit_dmg: f64,
    pub source_crit_dmg: f64,
    pub debuff_duration_mult: f64,
}

/// One ailment of CalcOffence.lua:5416-5513 ("Cycle through all non-damage ailments here").
pub fn calc_non_damaging_ailment(skill_mod_list: &ModStore, enemy_db: &ModStore, cfg: Option<&Cfg>, ailment: &str, ctx: &NonDamagingAilmentCtx) -> NonDamagingAilmentOutput {
    if ctx.chance_on_hit + ctx.chance_on_crit <= 0.0 {
        return NonDamagingAilmentOutput::default();
    }
    let (_chance, base_val) = calc_ailment_damage(ctx.chance_on_hit, ctx.chance_on_crit, ctx.crit_chance, ctx.source_hit_dmg, ctx.source_crit_dmg);
    let as_though_dealing = skill_mod_list.more(cfg, &[Sym::new(&format!("{ailment}AsThoughDealing"))]);
    let damage = base_val * as_though_dealing;
    if !(damage > 0.0) {
        return NonDamagingAilmentOutput { damage, ..Default::default() };
    }
    let inc_dur = skill_mod_list.sum(ModType::Inc, cfg, &[Sym::new(&format!("Enemy{ailment}Duration")), pom_engine::sym!("EnemyElementalAilmentDuration"), pom_engine::sym!("EnemyAilmentDuration")])
        + enemy_db.sum(ModType::Inc, None, &[Sym::new(&format!("Self{ailment}Duration")), pom_engine::sym!("SelfElementalAilmentDuration"), pom_engine::sym!("SelfAilmentDuration")]);
    let more_dur = skill_mod_list.more(cfg, &[Sym::new(&format!("Enemy{ailment}Duration")), pom_engine::sym!("EnemyElementalAilmentDuration"), pom_engine::sym!("EnemyAilmentDuration")])
        * enemy_db.more(None, &[Sym::new(&format!("Self{ailment}Duration")), pom_engine::sym!("SelfElementalAilmentDuration"), pom_engine::sym!("SelfAilmentDuration")]);
    let base_duration = ailment_data(ailment).duration.expect("non-damaging ailment must have a base duration");
    let duration = base_duration * (1.0 + inc_dur / 100.0) * more_dur * ctx.debuff_duration_mult;
    let skill_effect_name = format!("Enemy{ailment}Effect");
    let enemy_effect_name = format!("Self{ailment}Effect");
    let effect_mod = crate::tools::calc_lib_mod(skill_mod_list, cfg, &[skill_effect_name.as_str()]) * crate::tools::calc_lib_mod(enemy_db, None, &[enemy_effect_name.as_str()]);
    NonDamagingAilmentOutput { damage, duration: Some(duration), effect_mod: Some(effect_mod) }
}

/// The Freeze special case (CalcOffence.lua:5398-5414): `output.FreezeDurationMod`, set only when
/// `(FreezeChanceOnHit + FreezeChanceOnCrit) > 0` AND the computed `baseVal > 0`.
#[allow(clippy::too_many_arguments)]
pub fn calc_freeze_duration_mod(skill_mod_list: &ModStore, enemy_db: &ModStore, cfg: Option<&Cfg>, chance_on_hit: f64, chance_on_crit: f64, crit_chance: f64, source_hit_dmg: f64, source_crit_dmg: f64) -> Option<f64> {
    if chance_on_hit + chance_on_crit <= 0.0 {
        return None;
    }
    let (_chance, base_val) = calc_ailment_damage(chance_on_hit, chance_on_crit, crit_chance, source_hit_dmg, source_crit_dmg);
    let base_val = base_val * skill_mod_list.more(cfg, &[pom_engine::sym!("FreezeAsThoughDealing")]);
    if !(base_val > 0.0) {
        return None;
    }
    let inc = skill_mod_list.sum(ModType::Inc, cfg, &[pom_engine::sym!("EnemyFreezeDuration"), pom_engine::sym!("EnemyAilmentDuration"), pom_engine::sym!("EnemyElementalAilmentDuration")])
        + enemy_db.sum(ModType::Inc, None, &[pom_engine::sym!("SelfFreezeDuration"), pom_engine::sym!("SelfElementalAilmentDuration"), pom_engine::sym!("SelfAilmentDuration"), pom_engine::sym!("HoarfrostFreezeDuration")]);
    Some(1.0 + inc / 100.0)
}

/// The Chilling Area / Non-Hit Chill special case (CalcOffence.lua:5377-5397). `is_chilling_area`
/// is `activeSkill.skillTypes[SkillType.ChillingArea] or activeSkill.skillTypes[SkillType.NonHitChill]`
/// (ids 68/67, Data/Global.lua:285-286).
pub struct ChillingAreaOutput {
    pub chill_effect_mod: f64,
    pub chill_duration_mod: f64,
    pub chill_source_effect: f64,
}
pub fn calc_chilling_area(skill_mod_list: &ModStore, enemy_db: &ModStore, cfg: Option<&Cfg>) -> ChillingAreaOutput {
    let inc_chill = skill_mod_list.sum(ModType::Inc, cfg, &[pom_engine::sym!("EnemyChillEffect")]);
    let more_chill = skill_mod_list.more(cfg, &[pom_engine::sym!("EnemyChillEffect")]);
    let chill_effect_mod = (1.0 + inc_chill / 100.0) * more_chill * crate::tools::calc_lib_mod_s(enemy_db, None, &[pom_engine::sym!("SelfChillEffect")]);
    let inc_dur = skill_mod_list.sum(ModType::Inc, cfg, &[pom_engine::sym!("EnemyChillDuration"), pom_engine::sym!("EnemyAilmentDuration"), pom_engine::sym!("EnemyElementalAilmentDuration")])
        + enemy_db.sum(ModType::Inc, None, &[pom_engine::sym!("SelfChillDuration"), pom_engine::sym!("SelfAilmentDuration"), pom_engine::sym!("SelfElementalAilmentDuration")]);
    let more_dur = skill_mod_list.more(cfg, &[pom_engine::sym!("EnemyChillDuration"), pom_engine::sym!("EnemyAilmentDuration"), pom_engine::sym!("EnemyElementalAilmentDuration")])
        * enemy_db.more(None, &[pom_engine::sym!("SelfChillDuration"), pom_engine::sym!("SelfAilmentDuration"), pom_engine::sym!("SelfElementalAilmentDuration")]);
    let chill_duration_mod = (1.0 + inc_dur / 100.0) * more_dur;
    let chill_max = skill_mod_list.override_(None, &[pom_engine::sym!("ChillMax")]).and_then(|v| v.num()).unwrap_or_else(|| ailment_data("Chill").max);
    let chill_default = ailment_data("Chill").default.unwrap_or(0.0);
    let chill_source_effect = chill_max.min((chill_default * chill_effect_mod).floor());
    ChillingAreaOutput { chill_effect_mod, chill_duration_mod, chill_source_effect }
}
