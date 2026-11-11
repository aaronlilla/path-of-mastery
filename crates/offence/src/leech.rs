// Port of Modules/CalcOffence.lua's leech math: the per-damage-type/per-pass accumulation
// (3388-3396, 3613-3690, "Beginning of Leech Calculation for this DamageType" through the
// portion-weighted totals), the instant/duration split (3720-3756), and the leech-rate tail
// (4100-4153, "Calculate leech rates").
//
// This is squarely downstream of the un-ported hit-pass loop (crit/non-crit x damage-type,
// CalcOffence.lua:3300-3768 - base damage, resistances, crit chance): every damage type's
// post-mitigation average hit damage (`damageTypeHitAvg` in the Lua) only exists as a local inside
// that loop. To stay isolated, this module takes those already-computed averages
// (`output[<Type>HitAverage]`/`output[<Type>CritAverage]`, set at CalcOffence.lua:3648/3657) as
// recorded inputs rather than recomputing them - exactly as `conversion::calc_damage` already
// takes `<Type>MinBase`/`MaxBase` as recorded inputs instead of the un-ported weapon/base-damage
// step that produces them. Likewise `output.Life`/`EnergyShield`/`Mana`/`MaxLifeLeechRate`/
// `LifeRecoveryRateMod`/etc are set by CalcDefence.lua, a different crate entirely - also taken as
// recorded inputs. Graded against the "Skill" pass only (non-attack skills, cfg == skillCfg,
// output == the actor's own top-level output) - the attack case needs per-hand mainHandOutput/
// offHandOutput threaded the same way as for calcDamage in conversion.rs.
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;

/// One damage type's already-computed post-mitigation average hit damage, split by pass
/// (`output[<Type>CritAverage]` for pass 1/critical, `output[<Type>HitAverage]` for pass 2/
/// non-critical - CalcOffence.lua:3648/3657).
#[derive(Clone, Copy, Default)]
pub struct DamageTypeAvg {
    pub crit_avg: f64,
    pub hit_avg: f64,
}

pub const LEECH_DMG_TYPES: [&str; 5] = ["Physical", "Lightning", "Cold", "Fire", "Chaos"];
fn is_elemental(t: &str) -> bool {
    matches!(t, "Fire" | "Cold" | "Lightning")
}

/// Everything CalcOffence.lua's leech block reads from outside its own scope: hit-path outputs
/// (`CritChance`, per-type Hit/CritAverage, `HitRate`'s own inputs), CalcDefence.lua outputs
/// (`Life`/`EnergyShield`/`Mana`/the `Max*LeechRate`/`*RecoveryRateMod` family), and the
/// on-hit-gain fields (CalcOffence.lua:3758-3770, adjacent but not itself leech math).
pub struct LeechExternal {
    pub crit_chance: f64,
    pub hit_rate: f64,
    pub damage_types: [DamageTypeAvg; 5], // indexed same order as LEECH_DMG_TYPES
    pub life: f64,
    pub energy_shield: f64,
    pub mana: f64,
    pub max_life_leech_instance: f64,
    pub max_energy_shield_leech_instance: f64,
    pub max_mana_leech_instance: f64,
    pub max_life_leech_rate: f64,
    pub max_energy_shield_leech_rate: f64,
    pub max_mana_leech_rate: f64,
    pub life_recovery_rate_mod: f64,
    pub energy_shield_recovery_rate_mod: f64,
    pub mana_recovery_rate_mod: f64,
    pub life_on_hit: f64,
    pub life_on_hit_rate: f64,
    pub energy_shield_on_hit: f64,
    pub energy_shield_on_hit_rate: f64,
    pub mana_on_hit: f64,
    pub mana_on_hit_rate: f64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct LeechOutput {
    pub life_leech: f64,
    pub life_leech_instant: f64,
    pub energy_shield_leech: f64,
    pub energy_shield_leech_instant: f64,
    pub mana_leech: f64,
    pub mana_leech_instant: f64,
    pub life_leech_instant_proportion: f64,
    pub energy_shield_leech_instant_proportion: f64,
    pub mana_leech_instant_proportion: f64,
    pub life_leech_duration: f64,
    pub life_leech_instances: f64,
    pub life_leech_instant_rate: f64,
    pub energy_shield_leech_duration: f64,
    pub energy_shield_leech_instances: f64,
    pub energy_shield_leech_instant_rate: f64,
    pub mana_leech_duration: f64,
    pub mana_leech_instances: f64,
    pub mana_leech_instant_rate: f64,
    pub life_leech_instance_rate: f64,
    pub life_leech_rate: f64,
    pub life_leech_per_hit: f64,
    pub energy_shield_leech_instance_rate: f64,
    pub energy_shield_leech_rate: f64,
    pub energy_shield_leech_per_hit: f64,
    pub mana_leech_instance_rate: f64,
    pub mana_leech_rate: f64,
    pub mana_leech_per_hit: f64,
    pub life_leech_gain_rate: Option<f64>,
    pub energy_shield_leech_gain_rate: Option<f64>,
    pub mana_leech_gain_rate: Option<f64>,
    pub life_leech_gain_per_hit: Option<f64>,
    pub energy_shield_leech_gain_per_hit: Option<f64>,
    pub mana_leech_gain_per_hit: Option<f64>,
}

fn clamp01_pct(v: f64) -> f64 {
    v.clamp(0.0, 100.0) / 100.0
}

/// One pass (crit or non-crit) of the per-damage-type leech accumulation
/// (CalcOffence.lua:3406-3639, "for _, damageType in ipairs(dmgTypeList) do ... end"), returning
/// the pass's `lifeLeechTotal`/`energyShieldLeechTotal`/`manaLeechTotal` before the per-use/cap/
/// portion step (3663-3689).
#[allow(clippy::too_many_arguments)]
fn accumulate_pass(
    skill_mod_list: &ModStore,
    enemy_db: &ModStore,
    cfg: Option<&Cfg>,
    mine_trap_totem: bool,
    life_based_on_chaos: bool,
    no_life_leech: bool,
    no_energy_shield_leech: bool,
    no_mana_leech: bool,
    avgs: &[DamageTypeAvg; 5],
    use_crit: bool,
) -> (f64, f64, f64) {
    let mut life_total = 0.0;
    let mut es_total = 0.0;
    let mut mana_total = 0.0;
    for (i, &damage_type) in LEECH_DMG_TYPES.iter().enumerate() {
        let damage_type_avg = if use_crit { avgs[i].crit_avg } else { avgs[i].hit_avg };

        let (mut life_leech, mut es_leech, mut mana_leech) = (0.0, 0.0, 0.0);
        if mine_trap_totem {
            life_leech = skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("DamageLifeLeechToPlayer")]);
        } else {
            if life_based_on_chaos {
                if damage_type == "Chaos" {
                    let names = ["DamageLeech", "DamageLifeLeech", "PhysicalDamageLifeLeech", "LightningDamageLifeLeech", "ColdDamageLifeLeech", "FireDamageLifeLeech", "ChaosDamageLifeLeech", "ElementalDamageLifeLeech"];
                    let syms: Vec<Sym> = names.iter().map(|s| Sym::new(s)).collect();
                    life_leech = skill_mod_list.sum(ModType::Base, cfg, &syms) + enemy_db.sum(ModType::Base, cfg, &[pom_engine::sym!("SelfDamageLifeLeech")]) / 100.0;
                }
            } else {
                let mut names = vec!["DamageLeech".to_string(), "DamageLifeLeech".to_string(), format!("{damage_type}DamageLifeLeech")];
                if is_elemental(damage_type) {
                    names.push("ElementalDamageLifeLeech".to_string());
                }
                let syms: Vec<Sym> = names.iter().map(|s| Sym::new(s)).collect();
                life_leech = skill_mod_list.sum(ModType::Base, cfg, &syms) + enemy_db.sum(ModType::Base, cfg, &[pom_engine::sym!("SelfDamageLifeLeech")]) / 100.0;
            }
            let mut es_names = vec!["DamageEnergyShieldLeech".to_string(), format!("{damage_type}DamageEnergyShieldLeech")];
            if is_elemental(damage_type) {
                es_names.push("ElementalDamageEnergyShieldLeech".to_string());
            }
            let es_syms: Vec<Sym> = es_names.iter().map(|s| Sym::new(s)).collect();
            es_leech = skill_mod_list.sum(ModType::Base, cfg, &es_syms) + enemy_db.sum(ModType::Base, cfg, &[pom_engine::sym!("SelfDamageEnergyShieldLeech")]) / 100.0;

            let mut mana_names = vec!["DamageLeech".to_string(), "DamageManaLeech".to_string(), format!("{damage_type}DamageManaLeech")];
            if is_elemental(damage_type) {
                mana_names.push("ElementalDamageManaLeech".to_string());
            }
            let mana_syms: Vec<Sym> = mana_names.iter().map(|s| Sym::new(s)).collect();
            mana_leech = skill_mod_list.sum(ModType::Base, cfg, &mana_syms) + enemy_db.sum(ModType::Base, cfg, &[pom_engine::sym!("SelfDamageManaLeech")]) / 100.0;
        }

        if life_leech > 0.0 && !no_life_leech {
            life_total += damage_type_avg * life_leech / 100.0;
        }
        if mana_leech > 0.0 && !no_mana_leech {
            mana_total += damage_type_avg * mana_leech / 100.0;
        }
        if es_leech > 0.0 && !no_energy_shield_leech {
            es_total += damage_type_avg * es_leech / 100.0;
        }
    }
    (life_total, es_total, mana_total)
}

/// The full leech block (CalcOffence.lua:3388-3396, 3613-3756, 4100-4153) for the "Skill" pass
/// (`cfg == skillCfg`, non-attack skills). `ghost_reaver` is `skillModList:Flag(nil, "GhostReaver")`;
/// `mine_trap_totem` is `skillFlags.mine or skillFlags.trap or skillFlags.totem`;
/// `life_leech_per_use`/`mana_leech_per_use` are `skillData.lifeLeechPerUse`/`.manaLeechPerUse`
/// (absent -> Lua `nil`, falsy).
#[allow(clippy::too_many_arguments)]
pub fn calc_leech(
    skill_mod_list: &ModStore,
    enemy_db: &ModStore,
    cfg: Option<&Cfg>,
    ghost_reaver: bool,
    mine_trap_totem: bool,
    life_leech_per_use: Option<f64>,
    mana_leech_per_use: Option<f64>,
    show_average: bool,
    ext: &LeechExternal,
) -> LeechOutput {
    let no_life_leech = skill_mod_list.flag(cfg, &[pom_engine::sym!("CannotLeechLife")]) || enemy_db.flag(None, &[pom_engine::sym!("CannotLeechLifeFromSelf")]) || skill_mod_list.flag(cfg, &[pom_engine::sym!("CannotGainLife")]);
    let no_energy_shield_leech = skill_mod_list.flag(cfg, &[pom_engine::sym!("CannotLeechEnergyShield")]) || enemy_db.flag(None, &[pom_engine::sym!("CannotLeechEnergyShieldFromSelf")]) || skill_mod_list.flag(cfg, &[pom_engine::sym!("CannotGainEnergyShield")]);
    let no_mana_leech = skill_mod_list.flag(cfg, &[pom_engine::sym!("CannotLeechMana")]) || enemy_db.flag(None, &[pom_engine::sym!("CannotLeechManaFromSelf")]) || skill_mod_list.flag(cfg, &[pom_engine::sym!("CannotGainMana")]);
    let life_based_on_chaos = skill_mod_list.flag(None, &[pom_engine::sym!("LifeLeechBasedOnChaosDamage")]);

    let mut out = LeechOutput::default();
    let mut ghost_reaver_life_leech = 0.0;

    // pass 1 = critical strike damage, pass 2 = non-critical (CalcOffence.lua:3397-3398)
    for pass in 1..=2 {
        let use_crit = pass == 1;
        let (mut life_total, mut es_total, mut mana_total) =
            accumulate_pass(skill_mod_list, enemy_db, cfg, mine_trap_totem, life_based_on_chaos, no_life_leech, no_energy_shield_leech, no_mana_leech, &ext.damage_types, use_crit);

        if let Some(v) = life_leech_per_use {
            if !no_life_leech {
                life_total += v;
            }
        }
        if let Some(v) = mana_leech_per_use {
            mana_total += v;
        }

        if ghost_reaver {
            life_total = life_total.min(ext.max_energy_shield_leech_instance);
        } else {
            life_total = life_total.min(ext.max_life_leech_instance);
        }
        es_total = es_total.min(ext.max_energy_shield_leech_instance);
        mana_total = mana_total.min(ext.max_mana_leech_instance);
        if ghost_reaver && no_energy_shield_leech {
            life_total = 0.0;
        }

        let portion = if pass == 1 { ext.crit_chance / 100.0 } else { 1.0 - ext.crit_chance / 100.0 };
        if ghost_reaver {
            ghost_reaver_life_leech += life_total * portion;
        } else {
            out.life_leech += life_total * portion;
        }
        out.energy_shield_leech += es_total * portion;
        out.mana_leech += mana_total * portion;
    }

    // Instant Leech (CalcOffence.lua:3729-3749)
    out.life_leech_instant_proportion = clamp01_pct(skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("InstantLifeLeech")]));
    if out.life_leech_instant_proportion > 0.0 {
        out.life_leech_instant = out.life_leech * out.life_leech_instant_proportion;
        out.life_leech *= 1.0 - out.life_leech_instant_proportion;
    }
    if ghost_reaver && ghost_reaver_life_leech > 0.0 {
        out.energy_shield_leech += ghost_reaver_life_leech;
        out.life_leech = 0.0;
        out.life_leech_instant = 0.0;
    }
    out.energy_shield_leech_instant_proportion = clamp01_pct(skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("InstantEnergyShieldLeech")]));
    if out.energy_shield_leech_instant_proportion > 0.0 {
        out.energy_shield_leech_instant = out.energy_shield_leech * out.energy_shield_leech_instant_proportion;
        out.energy_shield_leech *= 1.0 - out.energy_shield_leech_instant_proportion;
    }
    out.mana_leech_instant_proportion = clamp01_pct(skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("InstantManaLeech")]));
    if out.mana_leech_instant_proportion > 0.0 {
        out.mana_leech_instant = out.mana_leech * out.mana_leech_instant_proportion;
        out.mana_leech *= 1.0 - out.mana_leech_instant_proportion;
    }

    let leech_rate_base = crate::data::misc("LeechRateBase");
    let get_leech_instances = |amount: f64, total: f64| -> (f64, f64) {
        if total == 0.0 {
            (0.0, 0.0)
        } else {
            let duration = amount / total / leech_rate_base;
            (duration, duration * ext.hit_rate)
        }
    };
    let (life_dur, life_inst) = get_leech_instances(out.life_leech, ext.life);
    out.life_leech_duration = life_dur;
    out.life_leech_instances = life_inst;
    out.life_leech_instant_rate = out.life_leech_instant * ext.hit_rate;
    let (es_dur, es_inst) = get_leech_instances(out.energy_shield_leech, ext.energy_shield);
    out.energy_shield_leech_duration = es_dur;
    out.energy_shield_leech_instances = es_inst;
    out.energy_shield_leech_instant_rate = out.energy_shield_leech_instant * ext.hit_rate;
    let (mana_dur, mana_inst) = get_leech_instances(out.mana_leech, ext.mana);
    out.mana_leech_duration = mana_dur;
    out.mana_leech_instances = mana_inst;
    out.mana_leech_instant_rate = out.mana_leech_instant * ext.hit_rate;

    leech_rates(skill_mod_list, cfg, ext, &mut out, show_average);

    out
}

/// "Calculate leech rates" (CalcOffence.lua:4100-4153), reading/writing the (for an attack, already
/// hand-combined) `out.Life/ES/Mana LeechDuration/Instances/Instant/InstantRate` fields. Split out
/// of `calc_leech` so an attack can run it on the combined values.
pub fn leech_rates(skill_mod_list: &ModStore, cfg: Option<&Cfg>, ext: &LeechExternal, out: &mut LeechOutput, show_average: bool) {
    let leech_rate_base = crate::data::misc("LeechRateBase");
    let life_leech_rate_mod = crate::tools::calc_lib_mod_s(skill_mod_list, cfg, &[pom_engine::sym!("LifeLeechRate")]);
    out.life_leech_instance_rate = ext.life * leech_rate_base * life_leech_rate_mod;
    out.life_leech_rate = out.life_leech_instances * out.life_leech_instance_rate;
    out.life_leech_per_hit = out.life_leech_instance_rate;
    let es_leech_rate_mod = crate::tools::calc_lib_mod_s(skill_mod_list, cfg, &[pom_engine::sym!("EnergyShieldLeechRate")]);
    out.energy_shield_leech_instance_rate = ext.energy_shield * leech_rate_base * es_leech_rate_mod;
    out.energy_shield_leech_rate = out.energy_shield_leech_instances * out.energy_shield_leech_instance_rate;
    out.energy_shield_leech_per_hit = out.energy_shield_leech_instance_rate;
    let mana_leech_rate_mod = crate::tools::calc_lib_mod_s(skill_mod_list, cfg, &[pom_engine::sym!("ManaLeechRate")]);
    out.mana_leech_instance_rate = ext.mana * leech_rate_base * mana_leech_rate_mod;
    out.mana_leech_rate = out.mana_leech_instances * out.mana_leech_instance_rate;
    out.mana_leech_per_hit = out.mana_leech_instance_rate;

    if skill_mod_list.flag(None, &[pom_engine::sym!("ImmortalAmbition")]) {
        out.energy_shield_leech_rate += out.life_leech_rate;
        out.energy_shield_leech_per_hit += out.life_leech_per_hit;
        out.life_leech_rate = 0.0;
        out.life_leech_per_hit = 0.0;
    }
    if skill_mod_list.flag(None, &[pom_engine::sym!("UnaffectedByNonInstantLifeLeech")]) {
        out.life_leech_rate = 0.0;
        out.life_leech_per_hit = 0.0;
        out.life_leech_instances = 0.0;
    }
    out.life_leech_rate = out.life_leech_instant_rate + out.life_leech_rate.min(ext.max_life_leech_rate) * ext.life_recovery_rate_mod;
    out.life_leech_per_hit = out.life_leech_instant + out.life_leech_per_hit.min(ext.max_life_leech_rate) * out.life_leech_duration * ext.life_recovery_rate_mod;
    out.energy_shield_leech_rate = out.energy_shield_leech_instant_rate + out.energy_shield_leech_rate.min(ext.max_energy_shield_leech_rate) * ext.energy_shield_recovery_rate_mod;
    out.energy_shield_leech_per_hit = out.energy_shield_leech_instant + out.energy_shield_leech_per_hit.min(ext.max_energy_shield_leech_rate) * out.energy_shield_leech_duration * ext.energy_shield_recovery_rate_mod;
    out.mana_leech_rate = out.mana_leech_instant_rate + out.mana_leech_rate.min(ext.max_mana_leech_rate) * ext.mana_recovery_rate_mod;
    out.mana_leech_per_hit = out.mana_leech_instant + out.mana_leech_per_hit.min(ext.max_mana_leech_rate) * out.mana_leech_duration * ext.mana_recovery_rate_mod;

    if show_average {
        out.life_leech_gain_per_hit = Some(out.life_leech_per_hit + ext.life_on_hit);
        out.energy_shield_leech_gain_per_hit = Some(out.energy_shield_leech_per_hit + ext.energy_shield_on_hit);
        out.mana_leech_gain_per_hit = Some(out.mana_leech_per_hit + ext.mana_on_hit);
    } else {
        out.life_leech_gain_rate = Some(out.life_leech_rate + ext.life_on_hit_rate);
        out.energy_shield_leech_gain_rate = Some(out.energy_shield_leech_rate + ext.energy_shield_on_hit_rate);
        out.mana_leech_gain_rate = Some(out.mana_leech_rate + ext.mana_on_hit_rate);
    }

}
