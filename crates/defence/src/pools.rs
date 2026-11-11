//! Shared helpers `calcs.buildDefenceEstimations` calls into repeatedly: `calcLifeHitPoolWithLossPrevention`
//! (Modules/CalcDefence.lua:179-183), `calcs.reducePoolsByDamage` (lines 190-424) and
//! `calcs.takenHitFromDamage` (lines 150-177), plus the `allyLifePoolList`/`buildAllyLifePools`
//! machinery (lines 33-55) they both depend on.
//!
//! `reduce_pools_by_damage` fills the Lua's `resourcesLostToTypeDamage` return field only in the Calcs
//! mode (`bd::on()`): it is read back only by `incomingDamageBreakdown` (Modules/CalcDefence.lua:426+), never by
//! an `output.X` assignment, so a normal calculation does not pay for it.
use crate::data::misc;
use crate::defence::armour_reduction_f;
use crate::tools::round;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::sym::Sym;
use pom_engine::fxhash::HashMap;

fn s(name: &str) -> Sym {
    Sym::new(name)
}
fn g(output: &HashMap<String, f64>, key: &str) -> f64 {
    output.get(key).copied().unwrap_or(0.0)
}
/// `output[a] or output[b]`: Lua falls back only on nil (a missing key), not on a present zero.
fn g_or(output: &HashMap<String, f64>, a: &str, b: &str) -> f64 {
    output.get(a).copied().unwrap_or_else(|| g(output, b))
}

pub const DMG_TYPES: &[&str] = &["Physical", "Lightning", "Cold", "Fire", "Chaos"];
pub fn is_elemental(e: &str) -> bool {
    matches!(e, "Fire" | "Cold" | "Lightning")
}

pub struct AllyPoolDef {
    pub key: &'static str,
    pub life: &'static str,
    pub mitigation: &'static str,
    pub redirect: Option<&'static str>,
    pub fallback: Option<&'static str>,
    pub melee_only: bool,
}

/// `allyLifePoolList` (lines 33-43). Order matters: it is both the ordering `buildAllyLifePools`
/// keys in and the drain order `reducePoolsByDamage`'s main loop consumes pools in.
pub const ALLY_LIFE_POOL_LIST: &[AllyPoolDef] = &[
    AllyPoolDef { key: "minion", life: "TotalMinionLife", mitigation: "MinionAllyDamageMitigation", redirect: Some("takenFromMinionBeforeYou"), fallback: Some("Multiplier:MinionLife"), melee_only: false },
    AllyPoolDef { key: "radianceSentinel", life: "TotalRadianceSentinelLife", mitigation: "RadianceSentinelAllyDamageMitigation", redirect: Some("takenFromRadianceSentinelBeforeYou"), fallback: None, melee_only: false },
    AllyPoolDef { key: "spectres", life: "TotalSpectreLife", mitigation: "SpectreAllyDamageMitigation", redirect: Some("takenFromSpectresBeforeYou"), fallback: None, melee_only: false },
    AllyPoolDef { key: "totems", life: "TotalTotemLife", mitigation: "TotemAllyDamageMitigation", redirect: Some("takenFromTotemsBeforeYou"), fallback: None, melee_only: false },
    AllyPoolDef { key: "vaalRejuvenationTotems", life: "TotalVaalRejuvenationTotemLife", mitigation: "VaalRejuvenationTotemAllyDamageMitigation", redirect: Some("takenFromVaalRejuvenationTotemsBeforeYou"), fallback: None, melee_only: false },
    AllyPoolDef { key: "voidSpawn", life: "TotalVoidSpawnLife", mitigation: "VoidSpawnAllyDamageMitigation", redirect: Some("takenFromVoidSpawnBeforeYou"), fallback: None, melee_only: false },
    AllyPoolDef { key: "stoneGolem", life: "TotalStoneGolemLife", mitigation: "StoneGolemAllyDamageMitigation", redirect: Some("takenFromStoneGolemBeforeYou"), fallback: None, melee_only: true },
    AllyPoolDef { key: "soulLink", life: "AlliedEnergyShield", mitigation: "SoulLinkMitigation", redirect: None, fallback: None, melee_only: false },
    AllyPoolDef { key: "frostShield", life: "FrostShieldLife", mitigation: "FrostShieldDamageMitigation", redirect: None, fallback: None, melee_only: false },
];

#[derive(Clone, Copy)]
pub struct AllyPoolState {
    pub remaining: f64,
    pub percent: f64,
}

/// `buildAllyLifePools(output)` (lines 45-55). The Lua's `pools[ally.key].damageType` field is
/// never assigned anywhere in the codebase, so `reducePoolsByDamage`'s
/// `(not allyValues.damageType or allyValues.damageType == damageType)` guard is always true and
/// is not modeled.
pub fn build_ally_life_pools(output: &HashMap<String, f64>) -> HashMap<&'static str, AllyPoolState> {
    let mut pools = HashMap::default();
    for ally in ALLY_LIFE_POOL_LIST {
        if let (Some(&life), Some(&mitigation)) = (output.get(ally.life), output.get(ally.mitigation)) {
            if life > 0.0 && mitigation > 0.0 {
                pools.insert(ally.key, AllyPoolState { remaining: life, percent: mitigation.min(100.0) / 100.0 });
            }
        }
    }
    pools
}

/// `calcLifeHitPoolWithLossPrevention` (lines 179-183).
pub fn calc_life_hit_pool_with_loss_prevention(life: f64, max_life: f64, life_loss_prevented: f64, life_loss_below_half_prevented: f64) -> f64 {
    let half_life = max_life * 0.5;
    let above_low = (life - half_life).max(0.0);
    above_low / (1.0 - life_loss_prevented / 100.0) + life.min(half_life) / (1.0 - life_loss_below_half_prevented / 100.0) / (1.0 - life_loss_prevented / 100.0)
}

#[derive(Default)]
pub struct PoolTable {
    pub allies_taken_before_you: Option<HashMap<&'static str, AllyPoolState>>,
    /// keys: "shared", "sharedElemental", plus a subset of `DMG_TYPES`.
    pub aegis: Option<HashMap<String, f64>>,
    /// keys: "shared", plus a subset of `DMG_TYPES`.
    pub guard: Option<HashMap<String, f64>>,
    pub ward: Option<f64>,
    pub ward_active_chance: Option<f64>,
    pub energy_shield: Option<f64>,
    pub mana: Option<f64>,
    pub life: Option<f64>,
    pub life_loss_lost_over_time: Option<f64>,
    pub life_below_half_loss_lost_over_time: Option<f64>,
    pub damage_taken_that_can_be_recouped: Option<HashMap<String, f64>>,
}

/// One `resourcesLostToTypeDamage[damageType]` table; `None` is the field being nil.
#[derive(Default, Clone)]
pub struct ResourcesLost {
    /// By `ALLY_LIFE_POOL_LIST` index.
    pub allies: [Option<f64>; 9],
    pub aegis: Option<f64>,
    pub shared_elemental_aegis: Option<f64>,
    pub shared_aegis: Option<f64>,
    pub guard: Option<f64>,
    pub shared_guard: Option<f64>,
    pub ward: Option<f64>,
    pub energy_shield: Option<f64>,
    pub mana: Option<f64>,
    pub life: Option<f64>,
    pub life_loss_prevented: Option<f64>,
    pub overkill: Option<f64>,
}

pub struct PoolsResult {
    /// By `DMG_TYPES` index; filled only when `bd::on()`.
    pub resources_lost: Vec<ResourcesLost>,
    pub allies_taken_before_you: HashMap<&'static str, AllyPoolState>,
    pub aegis: HashMap<String, f64>,
    pub guard: HashMap<String, f64>,
    pub ward: f64,
    pub ward_active_chance: f64,
    pub energy_shield: f64,
    pub mana: f64,
    pub life: f64,
    pub damage_taken_that_can_be_recouped: HashMap<String, f64>,
    pub life_loss_lost_over_time: f64,
    pub life_below_half_loss_lost_over_time: f64,
    pub overkill_damage: f64,
    pub hit_pool_remaining: f64,
}

/// `calcs.reducePoolsByDamage(poolTable, damageTable, actor)` (lines 190-424).
pub fn reduce_pools_by_damage(pool_table: Option<PoolTable>, damage_table_in: &HashMap<String, f64>, store: &ModStore, output: &HashMap<String, f64>) -> PoolsResult {
    let pt = pool_table.unwrap_or_default();

    let mut damage_table: HashMap<String, f64> = HashMap::default();
    let mut damage_total = 0.0;
    for (dt, &damage) in damage_table_in {
        if damage > 0.0 {
            let d = damage.ceil();
            damage_table.insert(dt.clone(), d);
            damage_total += d;
        }
    }

    let mut allies_taken_before_you = pt.allies_taken_before_you.unwrap_or_else(|| build_ally_life_pools(output));
    let mut damage_taken_that_can_be_recouped = pt.damage_taken_that_can_be_recouped.unwrap_or_default();

    let mut aegis = pt.aegis.unwrap_or_else(|| {
        let mut m = HashMap::default();
        m.insert("shared".to_string(), g(output, "sharedAegis"));
        m.insert("sharedElemental".to_string(), g(output, "sharedElementalAegis"));
        for dt in damage_table.keys() {
            m.insert(dt.clone(), g(output, &format!("{dt}Aegis")));
        }
        m
    });
    let mut guard = pt.guard.unwrap_or_else(|| {
        let mut m = HashMap::default();
        m.insert("shared".to_string(), g(output, "sharedGuardAbsorb"));
        for dt in damage_table.keys() {
            m.insert(dt.clone(), g(output, &format!("{dt}GuardAbsorb")));
        }
        m
    });

    let mut ward = pt.ward.unwrap_or_else(|| g(output, "Ward"));
    let mut ward_active_chance = pt.ward_active_chance.unwrap_or(if ward > 0.0 { 1.0 } else { 0.0 });
    let ward_avoid_break_chance = if store.flag(None, &[pom_engine::sym!("Condition:WardNotBreak")]) { 1.0 } else { (store.sum(ModType::Base, None, &[pom_engine::sym!("WardAvoidBreakChance")]) / 100.0).min(1.0) };
    let ward_bypass_below = store.sum(ModType::Base, None, &[pom_engine::sym!("WardBypassBelowPercent")]) / 100.0;

    let mut energy_shield = pt.energy_shield.unwrap_or_else(|| g(output, "EnergyShieldRecoveryCap"));
    let mut mana = pt.mana.unwrap_or_else(|| g(output, "ManaUnreserved"));
    let mut life = pt.life.unwrap_or_else(|| g(output, "LifeRecoverable"));
    let life_loss_below_half_prevented = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeLossBelowHalfPrevented")]);
    let mut life_loss_lost_over_time = pt.life_loss_lost_over_time.unwrap_or(0.0);
    let mut life_below_half_loss_lost_over_time = pt.life_below_half_loss_lost_over_time.unwrap_or(0.0);
    let mut overkill_damage = 0.0;
    let track = pom_offence::bd::on();
    let mut lost: Vec<ResourcesLost> = if track { vec![ResourcesLost::default(); 5] } else { vec![] };

    ward = ward.max(0.0);
    let ward_before_hit = ward;
    energy_shield = energy_shield.max(0.0);
    mana = mana.max(0.0);
    life = life.max(0.0);

    let out_life = g(output, "Life");
    let prevented_life_loss = g(output, "preventedLifeLoss");
    let life_hit_pool_initial = calc_life_hit_pool_with_loss_prevention(life, out_life, prevented_life_loss, life_loss_below_half_prevented);

    let mut mom_pools_remaining: HashMap<String, f64> = HashMap::default();
    let mut es_pools_remaining: HashMap<String, f64> = HashMap::default();
    let energy_shield_protects_mana = store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]);
    let shared_mom = g(output, "sharedMindOverMatter");
    for dt in damage_table.keys() {
        let mom_effect = (shared_mom + g(output, &format!("{dt}MindOverMatter"))).min(100.0) / 100.0;
        let max_mom = if mom_effect < 1.0 { life_hit_pool_initial / (1.0 - mom_effect) - life_hit_pool_initial } else { f64::INFINITY };
        let mom_pool = if mom_effect < 1.0 { max_mom.min(mana) } else { mana };
        let life_plus_mom_hit_pool = life_hit_pool_initial + mom_pool;
        let es_bypass = g(output, &format!("{dt}EnergyShieldBypass")) / 100.0;
        if energy_shield_protects_mana && es_bypass < 1.0 {
            let es_r = (max_mom * (1.0 - es_bypass)).min(energy_shield).min(life_plus_mom_hit_pool / (1.0 - (1.0 - es_bypass) * mom_effect) - life_plus_mom_hit_pool).floor();
            mom_pools_remaining.insert(dt.clone(), (max_mom - es_r).min(mom_pool).floor());
            es_pools_remaining.insert(dt.clone(), es_r);
        } else {
            let es_pool = if es_bypass > 0.0 { (life_plus_mom_hit_pool / es_bypass - life_plus_mom_hit_pool).min(energy_shield) } else { energy_shield };
            es_pools_remaining.insert(dt.clone(), es_pool.floor());
            mom_pools_remaining.insert(dt.clone(), mom_pool.floor());
        }
    }

    for (dt_idx, &dt) in DMG_TYPES.iter().enumerate() {
        let dt_s = dt.to_string();
        let Some(&damage_in) = damage_table.get(&dt_s) else { continue };
        let mut damage_remainder = damage_in;
        let nz = |t: f64| if t >= 1.0 { Some(t) } else { None };

        for (ally_idx, ally) in ALLY_LIFE_POOL_LIST.iter().enumerate() {
            if let Some(av) = allies_taken_before_you.get_mut(ally.key) {
                if av.remaining > 0.0 {
                    let temp = (damage_remainder * av.percent).min(av.remaining);
                    av.remaining = (av.remaining - temp).floor();
                    damage_remainder -= temp;
                    if track {
                        lost[dt_idx].allies[ally_idx] = nz(temp);
                    }
                }
            }
        }

        *damage_taken_that_can_be_recouped.entry(dt_s.clone()).or_insert(0.0) += damage_remainder;

        if let Some(&a) = aegis.get(&dt_s) {
            if a > 0.0 {
                let temp = damage_remainder.min(a);
                aegis.insert(dt_s.clone(), a - temp);
                damage_remainder -= temp;
                if track {
                    lost[dt_idx].aegis = nz(temp);
                }
            }
        }
        if is_elemental(dt) {
            let a = aegis.get("sharedElemental").copied().unwrap_or(0.0);
            if a > 0.0 {
                let temp = damage_remainder.min(a);
                aegis.insert("sharedElemental".into(), a - temp);
                damage_remainder -= temp;
                if track {
                    lost[dt_idx].shared_elemental_aegis = nz(temp);
                }
            }
        }
        let a_shared = aegis.get("shared").copied().unwrap_or(0.0);
        if a_shared > 0.0 {
            let temp = damage_remainder.min(a_shared);
            aegis.insert("shared".into(), a_shared - temp);
            damage_remainder -= temp;
            if track {
                lost[dt_idx].shared_aegis = nz(temp);
            }
        }
        if let Some(&gv) = guard.get(&dt_s) {
            if gv > 0.0 {
                let rate = g(output, &format!("{dt}GuardAbsorbRate"));
                let temp = (damage_remainder * rate / 100.0).min(gv);
                guard.insert(dt_s.clone(), (gv - temp).floor());
                damage_remainder -= temp;
                if track {
                    lost[dt_idx].guard = nz(temp);
                }
            }
        }
        let g_shared = guard.get("shared").copied().unwrap_or(0.0);
        if g_shared > 0.0 {
            let rate = g(output, "sharedGuardAbsorbRate");
            let temp = (damage_remainder * rate / 100.0).min(g_shared);
            guard.insert("shared".into(), (g_shared - temp).floor());
            damage_remainder -= temp;
            if track {
                lost[dt_idx].shared_guard = nz(temp);
            }
        }
        if ward > 0.0 && (ward_bypass_below == 0.0 || damage_total >= ward_before_hit * ward_bypass_below) {
            let ward_bypass = store.sum(ModType::Base, None, &[pom_engine::sym!("WardBypass")]);
            let mut temp = (damage_remainder * (1.0 - ward_bypass / 100.0)).min(ward);
            ward -= temp;
            temp *= ward_active_chance;
            damage_remainder -= temp;
            if track {
                lost[dt_idx].ward = nz(temp);
            }
        }
        let mom_effect = (shared_mom + g(output, &format!("{dt}MindOverMatter"))).min(100.0) / 100.0;
        let es_bypass = g(output, &format!("{dt}EnergyShieldBypass")) / 100.0;
        let es_pool = es_pools_remaining.get(&dt_s).copied().unwrap_or(0.0);
        if energy_shield > 0.0 && !energy_shield_protects_mana && es_bypass < 1.0 {
            let temp = (damage_remainder * (1.0 - es_bypass)).min(es_pool);
            for v in es_pools_remaining.values_mut() {
                *v = (*v - temp).max(0.0);
            }
            energy_shield -= temp;
            damage_remainder -= temp;
            if track {
                lost[dt_idx].energy_shield = nz(temp);
            }
        }
        if mom_effect > 0.0 {
            let mut mom_damage = (damage_remainder * mom_effect).ceil();
            if energy_shield_protects_mana && energy_shield > 0.0 && es_bypass < 1.0 {
                let temp = (mom_damage * (1.0 - es_bypass)).min(es_pool).ceil();
                for v in es_pools_remaining.values_mut() {
                    *v = (*v - temp).max(0.0).floor();
                }
                energy_shield -= temp;
                damage_remainder -= temp;
                mom_damage -= temp;
                if track {
                    lost[dt_idx].energy_shield = nz(temp);
                }
            }
            let mom_pool_dt = mom_pools_remaining.get(&dt_s).copied().unwrap_or(0.0);
            let temp = mom_damage.min(mom_pool_dt).ceil();
            for v in mom_pools_remaining.values_mut() {
                *v = (*v - temp).max(0.0).floor();
            }
            mana -= temp;
            damage_remainder -= temp;
            if track {
                lost[dt_idx].mana = nz(temp);
            }
        }
        let prevented_life_loss_total = g(output, "preventedLifeLossTotal");
        if prevented_life_loss_total > 0.0 {
            let half_life = out_life * 0.5;
            let life_over_half_life = (life - half_life).max(0.0);
            let prevent_percent = prevented_life_loss / 100.0;
            let pool_above_low = life_over_half_life / (1.0 - prevent_percent);
            let prevent_below_half_percent = life_loss_below_half_prevented / 100.0;
            let damage_that_life_can_still_take = pool_above_low + life.min(half_life).max(0.0) / (1.0 - prevent_below_half_percent) / (1.0 - prevented_life_loss / 100.0);
            if damage_that_life_can_still_take < damage_remainder {
                overkill_damage += damage_remainder - damage_that_life_can_still_take;
                damage_remainder = damage_that_life_can_still_take;
            }
            let prevented_life_loss_below_half = g(output, "preventedLifeLossBelowHalf");
            if prevented_life_loss_below_half != 0.0 {
                let damage_to_split = damage_remainder.min(pool_above_low);
                let lost_life = damage_to_split * (1.0 - prevent_percent);
                let prevented_loss = damage_to_split * prevent_percent;
                damage_remainder -= damage_to_split;
                life_loss_lost_over_time += prevented_loss;
                life -= lost_life;
                let mut bd_prevented = prevented_loss;
                if track {
                    lost[dt_idx].life = Some(lost_life);
                }
                if life <= half_life {
                    let unspecific = damage_remainder * prevent_percent;
                    life_loss_lost_over_time += unspecific;
                    damage_remainder -= unspecific;
                    let specific = damage_remainder * prevent_below_half_percent;
                    life_below_half_loss_lost_over_time += specific;
                    damage_remainder -= specific;
                    bd_prevented = bd_prevented + unspecific + specific;
                }
                if track {
                    lost[dt_idx].life_loss_prevented = nz(bd_prevented);
                }
            } else {
                let temp = damage_remainder * prevented_life_loss / 100.0;
                life_loss_lost_over_time += temp;
                damage_remainder -= temp;
                if track {
                    lost[dt_idx].life_loss_prevented = nz(temp);
                }
            }
        }
        if life > 0.0 {
            let temp = damage_remainder.min(life);
            life -= temp;
            damage_remainder -= temp;
            if track {
                lost[dt_idx].life = Some(lost[dt_idx].life.unwrap_or(0.0) + if temp > 0.0 { temp } else { 0.0 });
            }
        }
        overkill_damage += damage_remainder;
        if track {
            lost[dt_idx].overkill = nz(damage_remainder);
        }
    }

    let mut mom_pool_remaining = f64::INFINITY;
    let mut es_pool_remaining = f64::INFINITY;
    for dt in damage_table.keys() {
        mom_pool_remaining = mom_pool_remaining.min(mom_pools_remaining.get(dt).copied().unwrap_or(f64::INFINITY));
        es_pool_remaining = es_pool_remaining.min(es_pools_remaining.get(dt).copied().unwrap_or(f64::INFINITY));
    }
    let hit_pool_remaining = (if life >= 1.0 { calc_life_hit_pool_with_loss_prevention(life, out_life, prevented_life_loss, life_loss_below_half_prevented) } else { 0.0 })
        + (if mom_pool_remaining.is_finite() { mom_pool_remaining } else { 0.0 })
        + (if es_pool_remaining.is_finite() { es_pool_remaining } else { 0.0 });

    let ward_final = if ward < ward_before_hit {
        ward_active_chance *= ward_avoid_break_chance;
        if ward_avoid_break_chance > 0.0 { ward_before_hit } else { 0.0 }
    } else {
        ward
    };

    PoolsResult {
        resources_lost: lost,
        allies_taken_before_you,
        aegis,
        guard,
        ward: ward_final.floor(),
        ward_active_chance,
        energy_shield: energy_shield.floor(),
        mana: mana.floor(),
        life: life.floor(),
        damage_taken_that_can_be_recouped,
        life_loss_lost_over_time: life_loss_lost_over_time.ceil(),
        life_below_half_loss_lost_over_time: life_below_half_loss_lost_over_time.ceil(),
        overkill_damage: overkill_damage.ceil(),
        hit_pool_remaining: hit_pool_remaining.floor(),
    }
}

/// `calcs.takenHitFromDamage(rawDamage, damageType, actor)` (lines 150-177). `shift_table` is
/// `actor.damageShiftTable[damageType]` (`damage_taken_as::shift_table_for` builds it). Iterates
/// in `shift_table`'s own insertion order (`DMG_TYPES` minus `damage_type`, then `damage_type`
/// itself last - see `damage_taken_as`), matching LuaJIT's small-table iteration closely enough
/// that summation order cannot itself flip a mismatch (`damages` is keyed independently per type).
pub fn taken_hit_from_damage(raw_damage: f64, damage_type: &str, shift_table: &HashMap<String, f64>, store: &ModStore, output: &HashMap<String, f64>) -> (f64, HashMap<String, f64>) {
    fn damage_mitigation_multiplier_for_type(damage: f64, ty: &str, store: &ModStore, output: &HashMap<String, f64>) -> f64 {
        let total_resist_mult = g(output, &format!("{ty}ResistTakenHitMulti"));
        let effective_applied_armour = g(output, &format!("{ty}EffectiveAppliedArmour"));
        let armour_dr_percent = armour_reduction_f(effective_applied_armour, damage * total_resist_mult);
        let flat_dr_percent = if store.flag(None, &[s(&format!("SelfIgnoreBase{ty}DamageReduction"))]) { 0.0 } else { g_or(output, &format!("Base{ty}DamageReductionWhenHit"), &format!("Base{ty}DamageReduction")) };
        let total_dr_percent = g(output, "DamageReductionMax").min(armour_dr_percent + flat_dr_percent);
        let enemy_overwhelm_percent = if store.flag(None, &[s(&format!("SelfIgnore{ty}DamageReduction"))]) { 0.0 } else { g(output, &format!("{ty}EnemyOverwhelm")) };
        let total_dr_multi = 1.0 - g(output, "DamageReductionMax").min(total_dr_percent - enemy_overwhelm_percent).max(0.0) / 100.0;
        total_resist_mult * total_dr_multi
    }
    let mut order: Vec<&str> = DMG_TYPES.iter().copied().filter(|&d| d != damage_type).collect();
    order.push(damage_type);

    let vaal_arctic = (-store.sum(ModType::More, None, &[pom_engine::sym!("VaalArcticArmourMitigation")]) / 100.0).min(1.0);
    let mut received_damage_sum = 0.0;
    let mut damages = HashMap::default();
    for &damage_converted_type in &order {
        let convert_percent = shift_table.get(damage_converted_type).copied().unwrap_or(0.0);
        let taken_flat = g(output, &format!("{damage_converted_type}takenFlat"));
        if convert_percent > 0.0 || taken_flat != 0.0 {
            let converted_damage = raw_damage * convert_percent / 100.0;
            let mult = damage_mitigation_multiplier_for_type(converted_damage, damage_converted_type, store, output);
            let reduced_damage = round((converted_damage * mult + taken_flat).max(0.0) * g(output, &format!("{damage_converted_type}AfterReductionTakenHitMulti"))) * (1.0 - vaal_arctic);
            received_damage_sum += reduced_damage;
            if reduced_damage > 0.0 || convert_percent > 0.0 {
                damages.insert(damage_converted_type.to_string(), reduced_damage);
            }
        }
    }
    (received_damage_sum, damages)
}

/// Input to `numberOfHitsToDie` (a closure inside `calcs.buildDefenceEstimations`, Lua lines
/// 2612-2777). The Lua passes a single mutable table recursively; every field this port's
/// recursive sub-call would need to see reset stays hard-set to its "nested call" value at the
/// recursive call site below (`track_recoupable`/`track_life_loss_over_time`/`missing_*` are never
/// copied onto the Lua's own recursive `Damage` table either), so callers only ever need to
/// populate a top-level `HitsToDieInput`.
pub struct HitsToDieInput {
    pub damage: HashMap<String, f64>,
    pub cycles: f64,
    pub limit_ehp_speedup: bool,
    pub track_recoupable: bool,
    pub track_life_loss_over_time: bool,
    pub gain_when_hit: bool,
    pub life_when_hit: f64,
    pub mana_when_hit: f64,
    pub energy_shield_when_hit: f64,
    pub missing_life_before_enemy_hit: Option<f64>,
    pub missing_mana_before_enemy_hit: Option<f64>,
}

impl HitsToDieInput {
    pub fn new(damage: HashMap<String, f64>) -> Self {
        HitsToDieInput {
            damage,
            cycles: 1.0,
            limit_ehp_speedup: false,
            track_recoupable: false,
            track_life_loss_over_time: false,
            gain_when_hit: false,
            life_when_hit: 0.0,
            mana_when_hit: 0.0,
            energy_shield_when_hit: 0.0,
            missing_life_before_enemy_hit: None,
            missing_mana_before_enemy_hit: None,
        }
    }
}

/// `numberOfHitsToDie(DamageIn)` (Lua lines 2613-2777): iteratively (with a recursive doubling
/// speed-up) reduces pools by `input.damage` per "hit" until life reaches 0, returning the
/// (possibly fractional) number of hits survived. `iterations` is `DamageIn["iterations"]`,
/// threaded through by `&mut` the same way the Lua shares one mutable table across the whole
/// recursion tree (a nested call consumes from, and advances, the same iteration budget the outer
/// call's `while` loop is bounded by).
pub fn number_of_hits_to_die(input: &HitsToDieInput, iterations: &mut f64, store: &ModStore, output: &mut HashMap<String, f64>) -> f64 {
    let mut num_hits = 0.0;
    for &dt in DMG_TYPES {
        num_hits += input.damage.get(dt).copied().unwrap_or(0.0);
    }
    if num_hits == 0.0 {
        return f64::INFINITY;
    }

    let ward_avoid_break_chance = if store.flag(None, &[pom_engine::sym!("Condition:WardNotBreak")]) { 1.0 } else { (store.sum(ModType::Base, None, &[pom_engine::sym!("WardAvoidBreakChance")]) / 100.0).min(1.0) };
    let out_ward = g(output, "Ward");
    if ward_avoid_break_chance == 1.0 && out_ward > 0.0 && num_hits < out_ward {
        return f64::INFINITY;
    }
    num_hits = 0.0;

    let mut ward = out_ward;
    if ward_avoid_break_chance < 1.0 && input.cycles > 1.0 {
        ward = 0.0;
    }
    let mut aegis: HashMap<String, f64> = HashMap::default();
    aegis.insert("shared".into(), g(output, "sharedAegis"));
    aegis.insert("sharedElemental".into(), g(output, "sharedElementalAegis"));
    let mut guard: HashMap<String, f64> = HashMap::default();
    guard.insert("shared".into(), g(output, "sharedGuardAbsorb"));
    for &dt in DMG_TYPES {
        aegis.insert(dt.to_string(), g(output, &format!("{dt}Aegis")));
        guard.insert(dt.to_string(), g(output, &format!("{dt}GuardAbsorb")));
    }
    let allies_taken_before_you = build_ally_life_pools(output);

    let mut pool = PoolsResult {
        resources_lost: vec![],
        allies_taken_before_you,
        aegis,
        guard,
        ward,
        ward_active_chance: if ward > 0.0 { 1.0 } else { 0.0 },
        energy_shield: g(output, "EnergyShieldRecoveryCap"),
        mana: g(output, "ManaUnreserved"),
        life: g(output, "LifeRecoverable"),
        damage_taken_that_can_be_recouped: HashMap::default(),
        life_loss_lost_over_time: g(output, "LifeLossLostOverTime"),
        life_below_half_loss_lost_over_time: g(output, "LifeBelowHalfLossLostOverTime"),
        overkill_damage: 0.0,
        hit_pool_remaining: 0.0,
    };

    let vaal_arctic_mitigation = g(output, "VaalArcticArmourMitigation");
    let mut vaal_arctic_hits_left = if input.cycles > 1.0 { 0.0 } else { g(output, "VaalArcticArmourLife") };

    let mut iteration_multiplier = 1.0;
    let mut damage_total = 0.0;
    let max_damage = ehp_calc_max_damage();
    let max_iterations = ehp_calc_max_iterations();
    let mut cycles_ran = false;

    while pool.life > 0.0 && *iterations < max_iterations {
        *iterations += 1.0;
        let mut damage_map: HashMap<String, f64> = HashMap::default();
        damage_total = 0.0;
        let vaal_mult = if vaal_arctic_hits_left > 0.0 { 1.0 - vaal_arctic_mitigation * (vaal_arctic_hits_left / iteration_multiplier).min(1.0) } else { 1.0 };
        vaal_arctic_hits_left -= iteration_multiplier;
        for &dt in DMG_TYPES {
            let damage = input.damage.get(dt).copied().unwrap_or(0.0);
            damage_map.insert(dt.to_string(), damage * iteration_multiplier * vaal_mult);
            damage_total += damage;
        }

        let has_gain_trigger = input.gain_when_hit || input.missing_life_before_enemy_hit.is_some() || input.missing_mana_before_enemy_hit.is_some();
        if has_gain_trigger && (iteration_multiplier > 1.0 || input.cycles > 1.0) {
            let gain_mult = iteration_multiplier * input.cycles;
            if let Some(mlb) = input.missing_life_before_enemy_hit {
                pool.life = (pool.life + mlb * (g(output, "LifeUnreserved") - pool.life) * (gain_mult - 1.0) / 100.0).min(gain_mult * g(output, "LifeRecoverable"));
            }
            if let Some(mmb) = input.missing_mana_before_enemy_hit {
                pool.mana = (pool.mana + mmb * (g(output, "ManaUnreserved") - pool.mana) * (gain_mult - 1.0) / 100.0).min(gain_mult * g(output, "ManaUnreserved"));
            }
            if input.gain_when_hit {
                pool.life = (pool.life + input.life_when_hit * (gain_mult - 1.0)).min(gain_mult * g(output, "LifeRecoverable"));
                pool.mana = (pool.mana + input.mana_when_hit * (gain_mult - 1.0)).min(gain_mult * g(output, "ManaUnreserved"));
                pool.energy_shield = (pool.energy_shield + input.energy_shield_when_hit * (gain_mult - 1.0)).min(gain_mult * g(output, "EnergyShieldRecoveryCap"));
            }
        }
        if let Some(mlb) = input.missing_life_before_enemy_hit {
            if pool.life > 0.0 {
                pool.life = (pool.life + mlb * (g(output, "LifeUnreserved") - pool.life) / 100.0).min(g(output, "LifeRecoverable"));
            }
        }
        if let Some(mmb) = input.missing_mana_before_enemy_hit {
            if pool.mana > 0.0 {
                pool.mana = (pool.mana + mmb * (g(output, "ManaUnreserved") - pool.mana) / 100.0).min(g(output, "ManaUnreserved"));
            }
        }

        let pool_table = PoolTable {
            allies_taken_before_you: Some(pool.allies_taken_before_you.clone()),
            aegis: Some(pool.aegis.clone()),
            guard: Some(pool.guard.clone()),
            ward: Some(pool.ward),
            ward_active_chance: Some(pool.ward_active_chance),
            energy_shield: Some(pool.energy_shield),
            mana: Some(pool.mana),
            life: Some(pool.life),
            life_loss_lost_over_time: Some(pool.life_loss_lost_over_time),
            life_below_half_loss_lost_over_time: Some(pool.life_below_half_loss_lost_over_time),
            damage_taken_that_can_be_recouped: Some(pool.damage_taken_that_can_be_recouped.clone()),
        };
        pool = reduce_pools_by_damage(Some(pool_table), &damage_map, store, output);

        if pool.life > 0.0 && damage_total >= max_damage {
            return f64::INFINITY;
        }
        if input.gain_when_hit && pool.life > 0.0 {
            pool.life = (pool.life + input.life_when_hit).min(g(output, "LifeRecoverable"));
            pool.mana = (pool.mana + input.mana_when_hit).min(g(output, "ManaUnreserved"));
            pool.energy_shield = (pool.energy_shield + input.energy_shield_when_hit).min(g(output, "EnergyShieldRecoveryCap"));
        }
        iteration_multiplier = 1.0;
        let speed_up = if input.limit_ehp_speedup { 4.0 } else { ehp_calc_speed_up() };
        let ward_avoid_break_active = ward_avoid_break_chance < 1.0 && pool.ward_active_chance > 0.01;
        if !cycles_ran && !ward_avoid_break_active && pool.life > 0.0 && *iterations < max_iterations {
            let mut sub_damage = HashMap::default();
            for &dt in DMG_TYPES {
                sub_damage.insert(dt.to_string(), input.damage.get(dt).copied().unwrap_or(0.0) * speed_up);
            }
            let sub_input = HitsToDieInput {
                damage: sub_damage,
                cycles: input.cycles * speed_up,
                limit_ehp_speedup: input.limit_ehp_speedup,
                track_recoupable: false,
                track_life_loss_over_time: false,
                gain_when_hit: input.gain_when_hit,
                life_when_hit: input.life_when_hit,
                mana_when_hit: input.mana_when_hit,
                energy_shield_when_hit: input.energy_shield_when_hit,
                missing_life_before_enemy_hit: None,
                missing_mana_before_enemy_hit: None,
            };
            let sub_result = number_of_hits_to_die(&sub_input, iterations, store, output);
            iteration_multiplier = ((sub_result - 1.0) * speed_up - 1.0).max(1.0);
            if iteration_multiplier.is_infinite() {
                return f64::INFINITY;
            }
            cycles_ran = true;
        }
        num_hits += iteration_multiplier;
    }

    if input.track_recoupable {
        for &dt in DMG_TYPES {
            if let Some(&recoupable) = pool.damage_taken_that_can_be_recouped.get(dt) {
                let key = format!("{dt}RecoupableDamageTaken");
                let cur = g(output, &key);
                output.insert(key, cur + recoupable);
            }
        }
    }
    if input.track_life_loss_over_time {
        output.insert("LifeLossLostOverTime".into(), g(output, "LifeLossLostOverTime") + pool.life_loss_lost_over_time);
        output.insert("LifeBelowHalfLossLostOverTime".into(), g(output, "LifeBelowHalfLossLostOverTime") + pool.life_below_half_loss_lost_over_time);
    }

    if pool.life == 0.0 && input.cycles == 1.0 {
        num_hits -= pool.overkill_damage / damage_total;
    }
    let mut damage_total2 = 0.0;
    for &dt in DMG_TYPES {
        damage_total2 += input.damage.get(dt).copied().unwrap_or(0.0) * num_hits;
    }
    if pool.life >= 0.0 && damage_total2 >= max_damage {
        return f64::INFINITY;
    }
    if num_hits.is_nan() {
        return 0.0;
    }
    num_hits.max(0.0)
}

/// `data.misc.ehpCalcMaxDamage`/`ehpCalcMaxIterationsToCalc`/`ehpCalcSpeedUp` cached, since
/// `number_of_hits_to_die` re-reads them every recursive call.
pub fn ehp_calc_max_damage() -> f64 {
    misc("ehpCalcMaxDamage")
}
pub fn ehp_calc_max_iterations() -> f64 {
    misc("ehpCalcMaxIterationsToCalc")
}
pub fn ehp_calc_speed_up() -> f64 {
    misc("ehpCalcSpeedUp")
}
