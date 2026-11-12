// Port of the per-pass hit-damage section of CalcOffence.lua's damage loop (the second
// `for _, pass in ipairs(passList)` loop): 3273-3312 (scaled damage effect, triple/double damage,
// cull, reservation DPS multiplier), 3346-3384 (base hit damage), 3385-3719 (hit/crit damage per
// damage type incl. resistances/penetration, leech totals) and 3720-3856 (leech rates, gain on
// hit/kill, enemy regeneration, AverageHit/AverageDamage/TotalDPS).
//
// Named gaps (each bounded, none faked): skill-specific `postCritFunc`; the Cryogenesis added-damage
// redirect (3317-3344); Elemental Equilibrium's enemy-condition update (3703-3708); PvP values
// (3857-3957, behind `PvpScaling`); `monsterExplode`; `env.partyMembers` resist-equal-to-yours; the
// warcry exert/uptime loops (2606-2985) - their outputs are taken as inputs (`OffensiveWarcryEffect`
// and friends default to 1, see `HitDmgInput`).
use crate::basedamage;
use crate::conversion::{calc_damage, ConversionTable, DmgTypeFlags, DMG_TYPES};
use crate::bd;
use crate::sf;
use crate::tools::{calc_lib_mod, calc_lib_val, calc_lib_mod_s};
use crate::weapon::WeaponSource;
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::{Cfg, ScalarValue};
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_engine::fxhash::{HashMap, HashSet};
use std::sync::Arc;

pub struct HitDmgInput<'a> {
    /// `enemyDB`.
    pub enemy_db: &'a ModStore,
    /// The actor's own `modDB` (`modDB:Flag(nil, "LightningLuckHits")`).
    pub mod_db: &'a ModStore,
    /// `env.modDB` / `env.player.output`: the real player's, even while a minion is the acting actor.
    pub real_mod_db: &'a ModStore,
    pub real_player_output: &'a HashMap<String, f64>,
    /// `env.partyMembers.modDB` flag names and `env.partyMembers.output` (the Party tab actor).
    pub party_flags: &'a [String],
    pub party_output: &'a HashMap<String, f64>,
    /// `skillCfg` (the skill's own cfg - `cfg` for a non-attack pass, distinct from the weapon cfg
    /// for an attack pass).
    pub skill_cfg: &'a Cfg,
    /// `globalOutput` of the player actor: `Life`/`Mana`/`EnergyShield`/`Max*LeechInstance`/`<Type>Resist`.
    pub player_output: &'a HashMap<String, f64>,
    pub config_num: &'a HashMap<String, f64>,
    pub config_str: &'a HashMap<String, String>,
    pub mode_effective: bool,
    pub mode_combat: bool,
    pub can_deal: [bool; 5],
    pub skill_flags: &'a HashSet<String>,
    pub skill_types: &'a HashSet<i64>,
    pub skill_data: &'a HashMap<String, ScalarValue>,
    pub base_multiplier: f64,
    pub damage_effectiveness: f64,
    pub source: &'a WeaponSource,
    /// `globalOutput.HitSpeed`, `globalOutput.Speed`.
    pub hit_speed: Option<f64>,
    pub speed: f64,
    pub dps_multiplier: f64,
    /// `skillData.dpsMultiplier` as it stood when `hitRate` was taken (CalcOffence.lua:3300), before `postCritFunc`.
    pub hit_rate_dps_multiplier: f64,
    /// Extra factor on `TotalDPS` only (trap trigger-twice chance); 1.0 upstream.
    pub total_dps_multiplier: f64,
    pub quantity_multiplier: f64,
    pub offensive_warcry_effect: f64,
    pub max_offensive_warcry_effect: f64,
    pub intimidating_up_time_ratio: Option<f64>,
    /// `output.AverageBurstHits` as set at the top of the pass (`skillData.averageBurstHits` or Repeats).
    pub average_burst_hits: Option<f64>,
    /// `activeSkill.skillTypes[SkillType.CanRapidFire]`.
    pub can_rapid_fire: bool,
    /// `monsterLife` and the hook's `output.ExplodeChance` (`skillFlags.monsterExplode`, CalcOffence.lua:3790).
    pub monster_life: f64,
    pub explode_chance: Option<f64>,
    /// `pass.label` as upstream writes it ("Main Hand", "Off Hand", "Skill"), for the breakdown lines.
    pub pass_label: &'a str,
}

fn s(n: &str) -> Sym {
    Sym::new(n)
}
fn syms(names: &[&str]) -> Vec<Sym> {
    names.iter().map(|n| Sym::new(n)).collect()
}
fn is_elemental(t: &str) -> bool {
    matches!(t, "Fire" | "Cold" | "Lightning")
}
fn get(m: &HashMap<String, f64>, k: &str) -> f64 {
    m.get(k).copied().unwrap_or(0.0)
}
fn flag_mod(name: &str, source: &str) -> Mod {
    Mod { name: s(name), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (vec![]).into() }
}

/// `calcs.armourReductionF` (CalcDefence.lua:67-72).
pub fn armour_reduction_f(armour: f64, raw: f64) -> f64 {
    if armour == 0.0 && raw == 0.0 {
        return 0.0;
    }
    armour / (armour + raw * 5.0) * 100.0
}

/// `calcResistForType(damageType, cfg)` (CalcOffence.lua:494-508) with `cfg = nil` (the only
/// call sites inside the hit loop pass the never-assigned `dotCfg` global).
fn calc_resist_for_type(i: &HitDmgInput, damage_type: &str) -> f64 {
    let enemy = i.enemy_db;
    let mut resist = enemy.override_(None, &[s(&format!("{damage_type}Resist"))]).and_then(|v| v.num());
    let max_resist = if enemy.flag(None, &[pom_engine::sym!("DoNotChangeMaxResFromConfig")]) {
        crate::data::misc("EnemyMaxResist")
    } else {
        let c = i.config_num.get(&format!("enemy{damage_type}Resist")).copied().unwrap_or(crate::data::misc("EnemyMaxResist"));
        c.max(crate::data::misc("EnemyMaxResist")).min(crate::data::misc("MaxResistCap"))
    };
    if resist.is_none() {
        let r = if i.real_mod_db.flag(None, &[s(&format!("Enemy{damage_type}ResistEqualToYours"))]) {
            get(i.real_player_output, &format!("{damage_type}Resist"))
        } else if i.party_flags.iter().any(|f| *f == format!("Enemy{damage_type}ResistEqualToYours")) {
            get(i.party_output, &format!("{damage_type}Resist"))
        } else {
            let mut names = vec![format!("{damage_type}Resist")];
            if is_elemental(damage_type) {
                names.push("ElementalResist".to_string());
            }
            let ns: Vec<&str> = names.iter().map(|x| x.as_str()).collect();
            enemy.sum(ModType::Base, None, &syms(&ns)) * calc_lib_mod(enemy, None, &ns).max(0.0)
        };
        resist = Some(r);
    }
    resist.unwrap().min(max_resist).max(crate::data::misc("ResistFloor"))
}

/// Runs one pass's hit-damage section. `out` is the pass's own output map (already holding
/// `HitChance`/`CritChance`/`CritMultiplier`/`CritEffect`/`Speed`...); `cfg` is the pass's cfg
/// (`weapon1Cfg`/`weapon2Cfg`/`skillCfg`), `conv` its conversion table. `global` receives the
/// `globalOutput.*` writes of this section.
/// `ModList:ConvertModInternal` / `ModDB:ConvertModInternal`: swaps the first mod of `old` with the same type, flags, keyword flags and
/// source for `m` (moving it to the new name's bucket in a ModDB), searching parents; the parent snapshot is un-shared first so the
/// swap is visible to every later query through this store, like upstream's in-place edit of the player's modDB.
fn convert_mod_internal(store: &mut ModStore, old: Sym, m: &Mod) -> bool {
    use pom_engine::modstore::store::Backing;
    let same = |c: &Mod| c.name == old && c.ty == m.ty && c.flags == m.flags && c.keyword_flags == m.keyword_flags && c.source == m.source;
    match &mut store.backing {
        Backing::List(v) => {
            if let Some(i) = v.iter().position(|c| same(c)) {
                std::sync::Arc::make_mut(v)[i] = m.clone();
                return true;
            }
        }
        Backing::Db(map) => {
            if let Some(list) = map.get_mut(&old) {
                if let Some(i) = list.iter().position(|c| same(c)) {
                    list.remove(i);
                    map.entry(m.name).or_default().push(m.clone());
                    return true;
                }
            }
        }
    }
    if let Some(p) = store.parent.as_mut() {
        if Arc::get_mut(p).is_none() {
            let backing = match &p.backing {
                Backing::List(v) => Backing::List(v.clone()),
                Backing::Db(map) => Backing::Db(map.clone()),
            };
            *p = Arc::new(ModStore { parent: p.parent.clone(), actor: p.actor.clone(), conditions: p.conditions.clone(), multipliers: p.multipliers.clone(), backing });
        }
        if let Some(pm) = Arc::get_mut(p) {
            return convert_mod_internal(pm, old, m);
        }
    }
    false
}

pub fn calc_hit_damage(i: &HitDmgInput, sml: &mut ModStore, cfg: &mut Cfg, conv: &ConversionTable, out: &mut HashMap<String, f64>, global: &mut HashMap<String, f64>) {
    let enemy = i.enemy_db;
    let crit_chance = get(out, "CritChance");
    if crit_chance != 0.0 {
        sml.conditions.insert(pom_engine::sym!("CritInPast8Sec"), true);
    }

    out.insert("ScaledDamageEffect".to_string(), 1.0);

    // ---- triple / double damage (3279-3298)
    let triple_on_crit = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("TripleDamageChanceOnCrit")]).min(100.0);
    out.insert("TripleDamageChanceOnCrit".to_string(), triple_on_crit);
    // `Sum(...) or 0 + (...)` parses as `Sum(...) or (0 + ...)` and Sum never returns nil, so only the
    // plain BASE sum survives (a genuine quirk of upstream).
    let triple = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("TripleDamageChance")]).min(100.0);
    out.insert("TripleDamageChance".to_string(), triple);
    out.insert("TripleDamageEffect".to_string(), 2.0 * triple / 100.0);

    let double_on_crit = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("DoubleDamageChanceOnCrit")]).min(100.0);
    out.insert("DoubleDamageChanceOnCrit".to_string(), double_on_crit);
    let mut double = (sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("DoubleDamageChance")]) + if i.mode_effective { enemy.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("SelfDoubleDamageChance")]) } else { 0.0 } + double_on_crit * crit_chance / 100.0).min(100.0);
    if let Some(up) = i.intimidating_up_time_ratio {
        if sml.flag(None, &[pom_engine::sym!("Condition:WarcryMaxHit")]) {
            double = 100.0;
        } else {
            double = (double + up).min(100.0);
        }
    }
    if triple > 0.0 {
        double = (double - triple * double / 100.0).max(0.0);
    }
    out.insert("DoubleDamageChance".to_string(), double);
    out.insert("DoubleDamageEffect".to_string(), double / 100.0);
    let scaled = 1.0 * (1.0 + double / 100.0 + 2.0 * triple / 100.0);
    out.insert("ScaledDamageEffect".to_string(), scaled);

    let hit_rate = get(out, "HitChance") / 100.0 * i.hit_speed.unwrap_or(i.speed) * i.hit_rate_dps_multiplier;

    // ---- cull (3302-3311)
    let mut critical_cull = sml.max(Some(cfg), &[pom_engine::sym!("CriticalCullPercent")]).unwrap_or(0.0);
    if critical_cull > 0.0 {
        critical_cull = critical_cull.min(critical_cull * (1.0 - (1.0 - crit_chance / 100.0).powf(hit_rate)));
    }
    let regular_cull = sml.max(Some(cfg), &[pom_engine::sym!("CullPercent")]).unwrap_or(0.0);
    let cull_percent = critical_cull.max(regular_cull);
    global.insert("CullPercent".to_string(), cull_percent);
    global.insert("CullMultiplier".to_string(), 100.0 / (100.0 - cull_percent));
    global.insert("ReservationDpsMultiplier".to_string(), 100.0 / (100.0 - enemy.sum(ModType::Base, None, &[pom_engine::sym!("LifeReservationPercent")])));

    // ---- added damage redirection, Cryogenesis (3316-3343): every added-damage mod of another type becomes the target type.
    let redirect: Option<&str> = if sml.flag(Some(cfg), &[pom_engine::sym!("AllAddedDamageAsLightning")]) {
        Some("Lightning")
    } else if sml.flag(Some(cfg), &[pom_engine::sym!("AllAddedDamageAsCold")]) {
        Some("Cold")
    } else {
        None
    };
    if let Some(target) = redirect {
        for damage_type in DMG_TYPES.iter().copied().filter(|d| *d != target) {
            for suffix in ["Min", "Max"] {
                let (old_name, new_name) = (format!("{damage_type}{suffix}"), format!("{target}{suffix}"));
                let found: Vec<Mod> = sml.tabulate(Some(ModType::Base), Some(cfg), &[s(&old_name)]).into_iter().map(|(_, p)| unsafe { (*p).clone() }).collect();
                for m in found {
                    if m.source.as_deref().is_some_and(|src| src.contains("ElementalHit")) {
                        continue;
                    }
                    let mut tags = vec![Tag { kind: pom_engine::sym!("Cryogenesis Added Damage"), fields: Vec::new() }];
                    tags.extend(m.tags.iter().cloned());
                    let new_mod = Mod { name: s(&new_name), ty: ModType::Base, value: m.value.clone(), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: (tags).into() };
                    // ModStore:ConvertMod: replace the first matching mod in this store or its parents, else add.
                    if !convert_mod_internal(sml, s(&old_name), &new_mod) {
                        sml.add_mod(new_mod);
                    }
                }
            }
        }
    }

    // ---- base hit damage (3346-3384)
    let base = basedamage::assign_base_damage(sml, enemy, Some(cfg), i.source, i.base_multiplier, i.damage_effectiveness);
    for (k, v) in base {
        out.insert(k, v);
    }
    if bd::on() {
        bd_base_damage(i, sml, cfg, out);
    }

    // ---- hit damage per type (3385-3719)
    let (mut total_hit_min, mut total_hit_max, mut total_hit_avg) = (0.0, 0.0, 0.0);
    let (mut total_crit_avg,) = (0.0,);
    let ghost_reaver = sml.flag(None, &[pom_engine::sym!("GhostReaver")]);
    let mut ghost_reaver_life_leech = 0.0;
    for k in ["LifeLeech", "LifeLeechInstant", "EnergyShieldLeech", "EnergyShieldLeechInstant", "ManaLeech", "ManaLeechInstant", "impaleStoredHitAvg"] {
        out.insert(k.to_string(), 0.0);
    }
    let mut hit_avg_by_type = [0.0f64; 5];
    let bd_on = bd::on();
    let (mut total_crit_min, mut total_crit_max) = (0.0f64, 0.0f64);
    let skill_flag = |n: &str| i.skill_flags.contains(n);
    let ruthless_hit_effect = get(out, "RuthlessBlowHitEffect");
    let fist_of_war = get(out, "FistOfWarDamageEffect");
    let warcry_max_hit = sml.flag(None, &[pom_engine::sym!("Condition:WarcryMaxHit")]);
    let crit_multiplier = get(out, "CritMultiplier");
    for pass in 1..=2 {
        cfg.skill_cond.insert(Arc::from("CriticalStrike"), pass == 1);
        let (mut life_leech_total, mut es_leech_total, mut mana_leech_total) = (0.0, 0.0, 0.0);
        let no_life_leech = sml.flag(Some(cfg), &[pom_engine::sym!("CannotLeechLife")]) || enemy.flag(None, &[pom_engine::sym!("CannotLeechLifeFromSelf")]) || sml.flag(Some(cfg), &[pom_engine::sym!("CannotGainLife")]);
        let no_es_leech = sml.flag(Some(cfg), &[pom_engine::sym!("CannotLeechEnergyShield")]) || enemy.flag(None, &[pom_engine::sym!("CannotLeechEnergyShieldFromSelf")]) || sml.flag(Some(cfg), &[pom_engine::sym!("CannotGainEnergyShield")]);
        let no_mana_leech = sml.flag(Some(cfg), &[pom_engine::sym!("CannotLeechMana")]) || enemy.flag(None, &[pom_engine::sym!("CannotLeechManaFromSelf")]) || sml.flag(Some(cfg), &[pom_engine::sym!("CannotGainMana")]);
        for (ti, damage_type) in DMG_TYPES.iter().enumerate() {
            let damage_type = *damage_type;
            let (mut hit_min, mut hit_max, mut hit_avg) = (0.0, 0.0, 0.0);
            if skill_flag("hit") && i.can_deal[ti] {
                let (mn, mx) = calc_damage(sml, out, Some(cfg), conv, damage_type, DmgTypeFlags::default(), None, if pass == 2 && bd_on { Some(damage_type) } else { None });
                hit_min = mn;
                hit_max = mx;
                let conv_mult = conv.get(damage_type).mult;
                if pass == 2 && bd_on {
                    bd_hit_header(i, out, damage_type, hit_min, hit_max, conv_mult, warcry_max_hit);
                }
                let all_mult = if warcry_max_hit {
                    conv_mult * scaled * ruthless_hit_effect * fist_of_war * i.max_offensive_warcry_effect
                } else {
                    conv_mult * scaled * ruthless_hit_effect * fist_of_war * i.offensive_warcry_effect
                };
                out.insert("allMult".to_string(), all_mult);
                let mut all_mult = all_mult;
                if pass == 1 {
                    all_mult *= crit_multiplier;
                }
                hit_min *= all_mult;
                hit_max *= all_mult;

                let sc = Some(i.skill_cfg);
                let mut lucky_chance;
                if sml.flag(sc, &[pom_engine::sym!("LuckyHits")])
                    || (pass == 2 && damage_type == "Lightning" && sml.flag(sc, &[pom_engine::sym!("LightningNoCritLucky")]))
                    || (pass == 1 && sml.flag(sc, &[pom_engine::sym!("CritLucky")]))
                    || (damage_type == "Lightning" && i.mod_db.flag(None, &[pom_engine::sym!("LightningLuckHits")]))
                    || (damage_type == "Chaos" && i.mod_db.flag(None, &[pom_engine::sym!("ChaosLuckyHits")]))
                    || (damage_type == "Fire" && i.mod_db.flag(None, &[pom_engine::sym!("FireLuckyHits")]))
                    || (damage_type == "Cold" && i.mod_db.flag(None, &[pom_engine::sym!("ColdLuckyHits")]))
                    || (is_elemental(damage_type) && sml.flag(sc, &[pom_engine::sym!("ElementalLuckHits")]))
                {
                    lucky_chance = 1.0;
                } else {
                    lucky_chance = sml.sum(ModType::Base, sc, &[pom_engine::sym!("LuckyHitsChance")]).min(100.0) / 100.0;
                }
                if sml.flag(sc, &[pom_engine::sym!("UnluckyHits")]) {
                    lucky_chance -= 1.0;
                }
                let mut rolls = lucky_chance;
                if sml.flag(sc, &[pom_engine::sym!("ExtremeLuck")]) {
                    rolls *= 2.0;
                }
                if sml.flag(sc, &[pom_engine::sym!("Unexciting")]) {
                    rolls = 0.0;
                }
                out.insert("DamageRolls".to_string(), rolls);
                if pass == 1 {
                    out.insert("CritDamageRolls".to_string(), rolls);
                }
                let rolls = rolls.abs() + 2.0;
                let not_lucky = hit_min / rolls + hit_max / rolls;
                let lucky = hit_min / rolls + (rolls - 1.0) * hit_max / rolls;
                let unlucky = (rolls - 1.0) * hit_min / rolls + hit_max / rolls;
                hit_avg = if lucky_chance >= 0.0 { not_lucky * (1.0 - lucky_chance) + lucky * lucky_chance } else { not_lucky * (1.0 - lucky_chance.abs()) + unlucky * lucky_chance.abs() };

                if (hit_min != 0.0 || hit_max != 0.0) && i.mode_effective {
                    let mut resist;
                    let mut pen = 0.0;
                    let mut source_res: &str = damage_type;
                    let mut taken_inc = enemy.sum(ModType::Inc, Some(cfg), &syms(&["DamageTaken", &format!("{damage_type}DamageTaken")]));
                    let taken_more = enemy.more(Some(cfg), &syms(&["DamageTaken", &format!("{damage_type}DamageTaken")]));
                    let ignore_names = |dt: &str, pre: &str| -> Vec<Sym> {
                        let mut v = vec![s(&format!("{pre}{dt}Resistance"))];
                        if is_elemental(dt) {
                            v.push(s(if pre == "Ignore" { "IgnoreElementalResistances" } else { "ChanceToIgnoreElementalResistances" }));
                        }
                        v
                    };
                    let use_this_resist = |dt: &str| -> f64 {
                        if sml.flag(Some(cfg), &ignore_names(dt, "Ignore")) || enemy.flag(None, &[s(&format!("SelfIgnore{dt}Resistance"))]) {
                            return 0.0;
                        }
                        let mut names = vec![s(&format!("ChanceToIgnore{dt}Resistance"))];
                        if is_elemental(dt) {
                            names.push(pom_engine::sym!("ChanceToIgnoreElementalResistances"));
                        }
                        let chance = sml.sum(ModType::Base, Some(cfg), &names).max(0.0).min(100.0);
                        1.0 - chance / 100.0
                    };
                    if damage_type == "Physical" {
                        let stored = get(out, "impaleStoredHitAvg");
                        let cc = get(out, "CritChance");
                        out.insert("impaleStoredHitAvg".to_string(), stored + if pass == 1 { hit_avg * (cc / 100.0) } else { hit_avg * (1.0 - cc / 100.0) });
                        let enemy_armour = calc_lib_val(enemy, "Armour", None).max(0.0);
                        let armour_reduction = armour_reduction_f(enemy_armour, hit_avg * sml.more(Some(cfg), &[pom_engine::sym!("CalcArmourAsThoughDealing")]));
                        let mut chance_ignore = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("ChanceToIgnoreEnemyPhysicalDamageReduction")]).min(100.0);
                        if chance_ignore > 0.0 && chance_ignore < 100.0 {
                            match i.config_str.get("ChanceToIgnoreEnemyPhysicalDamageReductionMode").map(|x| x.as_str()) {
                                Some("MAX") => chance_ignore = 100.0,
                                Some("MIN") => chance_ignore = 0.0,
                                _ => {}
                            }
                        }
                        if sml.flag(Some(cfg), &[pom_engine::sym!("IgnoreEnemyPhysicalDamageReduction")]) || chance_ignore >= 100.0 {
                            resist = 0.0;
                        } else {
                            resist = (enemy.sum(ModType::Base, None, &[pom_engine::sym!("PhysicalDamageReduction")]) + sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("EnemyPhysicalDamageReduction")]) + armour_reduction).max(0.0).min(crate::data::misc("EnemyPhysicalDamageReductionCap"));
                            resist = if resist > 0.0 { resist * (1.0 - (sml.sum(ModType::Base, None, &[pom_engine::sym!("PartialIgnoreEnemyPhysicalDamageReduction")]) / 100.0 + chance_ignore / 100.0)) } else { resist };
                        }
                    } else {
                        resist = calc_resist_for_type(i, damage_type);
                        if ((sml.flag(Some(cfg), &[pom_engine::sym!("ChaosDamageUsesLowestResistance")]) || sml.flag(Some(cfg), &[pom_engine::sym!("ChaosDamageUsesHighestResistance")])) && damage_type == "Chaos") || (sml.flag(Some(cfg), &[pom_engine::sym!("ElementalDamageUsesLowestResistance")]) && is_elemental(damage_type)) {
                            let mut element_used = damage_type;
                            if is_elemental(damage_type) {
                                taken_inc += enemy.sum(ModType::Inc, Some(cfg), &[pom_engine::sym!("ElementalDamageTaken")]);
                            }
                            for ele in DMG_TYPES {
                                if is_elemental(ele) && use_this_resist(ele) > 0.0 && damage_type != ele {
                                    let current = calc_resist_for_type(i, ele);
                                    if sml.flag(Some(cfg), &[pom_engine::sym!("ChaosDamageUsesHighestResistance")]) {
                                        if resist < current {
                                            resist = current;
                                            element_used = ele;
                                        }
                                    } else if resist > current {
                                        resist = current;
                                        element_used = ele;
                                    }
                                }
                            }
                            if is_elemental(element_used) {
                                pen = sml.sum(ModType::Base, Some(cfg), &syms(&[&format!("{element_used}Penetration"), "ElementalPenetration"]));
                            } else if element_used == "Chaos" {
                                pen = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("ChaosPenetration")]);
                            }
                            source_res = element_used;
                        } else if is_elemental(damage_type) {
                            pen = sml.sum(ModType::Base, Some(cfg), &syms(&[&format!("{damage_type}Penetration"), "ElementalPenetration"]));
                            taken_inc += enemy.sum(ModType::Inc, Some(cfg), &[pom_engine::sym!("ElementalDamageTaken")]);
                        } else if damage_type == "Chaos" {
                            pen = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("ChaosPenetration")]);
                        }
                    }
                    let invert_ele = sml.sum(ModType::Chance, Some(cfg), &[pom_engine::sym!("HitsInvertEleResChance")]).min(1.0).max(0.0);
                    let invert_chaos = sml.sum(ModType::Chance, Some(cfg), &[pom_engine::sym!("HitsInvertChaosResChance")]).min(1.0).max(0.0);
                    let invert_chance = if is_elemental(damage_type) { invert_ele } else if damage_type == "Chaos" { invert_chaos } else { 0.0 };
                    if skill_flag("projectile") {
                        taken_inc += enemy.sum(ModType::Inc, None, &[pom_engine::sym!("ProjectileDamageTaken")]);
                    }
                    if skill_flag("projectile") && skill_flag("attack") {
                        taken_inc += enemy.sum(ModType::Inc, None, &[pom_engine::sym!("ProjectileAttackDamageTaken")]);
                    }
                    if skill_flag("trap") || skill_flag("mine") {
                        taken_inc += enemy.sum(ModType::Inc, None, &[pom_engine::sym!("TrapMineDamageTaken")]);
                    }
                    let mut eff_mult = (1.0 + taken_inc / 100.0) * taken_more;
                    let use_res_chance = use_this_resist(damage_type);
                    let use_res = use_res_chance > 0.0;
                    let mut effective_resist = resist;
                    let mut cannot_ele_pen_ignore = false;
                    if is_elemental(damage_type) && sml.flag(Some(cfg), &[pom_engine::sym!("CannotElePenIgnore")]) {
                        cannot_ele_pen_ignore = true;
                        effective_resist = if invert_chance > 0.0 { resist - 2.0 * invert_chance * resist } else { resist };
                        eff_mult *= 1.0 - effective_resist / 100.0;
                    } else if use_res {
                        effective_resist = if invert_chance > 0.0 { ((resist - pen) * (1.0 - invert_chance) + (-resist - pen) * invert_chance) * use_res_chance } else { (resist - pen) * use_res_chance };
                        eff_mult *= 1.0 - effective_resist / 100.0;
                    }
                    if pom_engine::env::var("POM_DEBUG_EFF").is_ok() { eprintln!("EFF {damage_type} pass={pass} avg={hit_avg} inc={taken_inc} more={taken_more} resist={resist} pen={pen} eff={eff_mult}"); }
                    hit_min *= eff_mult;
                    hit_max *= eff_mult;
                    hit_avg *= eff_mult;
                    if pass == 2 && bd_on {
                        // CalcOffence.lua:3570 (sourceRes label) and 3601-3607
                        let src_label = if i.real_mod_db.flag(None, &[s(&format!("Enemy{source_res}ResistEqualToYours"))]) {
                            format!("Your {source_res} Resistance")
                        } else if i.party_flags.iter().any(|f| *f == format!("Enemy{source_res}ResistEqualToYours")) {
                            format!("Party Member {source_res} Resistance")
                        } else {
                            source_res.to_string()
                        };
                        if eff_mult != 1.0 || src_label != damage_type || invert_chance > 0.0 {
                            let eff_bd = crate::bdbuild::eff_mult(damage_type, resist, if cannot_ele_pen_ignore { 0.0 } else { pen }, taken_inc, eff_mult, taken_more, Some(&src_label), use_res, Some(invert_chance), Some(effective_resist));
                            bd::cur(|b| {
                                bd::ins_s(bd::t(b, damage_type), sf!("x %.3f ^8(effective DPS modifier)", eff_mult));
                                bd::set(b, &format!("{damage_type}EffMult"), eff_bd);
                            });
                        }
                    }
                    // CalcOffence.lua:3598-3600
                    if crate::CALCS_MODE.with(|c| c.get()) {
                        out.insert(format!("{damage_type}EffMult"), eff_mult);
                    }
                }

                // ---- leech (per damage type) (3620-3668)
                let (mut life_leech, mut es_leech, mut mana_leech) = (0.0, 0.0, 0.0);
                if skill_flag("mine") || skill_flag("trap") || skill_flag("totem") {
                    life_leech = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("DamageLifeLeechToPlayer")]);
                } else {
                    if sml.flag(None, &[pom_engine::sym!("LifeLeechBasedOnChaosDamage")]) {
                        if damage_type == "Chaos" {
                            life_leech = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("DamageLeech"), pom_engine::sym!("DamageLifeLeech"), pom_engine::sym!("PhysicalDamageLifeLeech"), pom_engine::sym!("LightningDamageLifeLeech"), pom_engine::sym!("ColdDamageLifeLeech"), pom_engine::sym!("FireDamageLifeLeech"), pom_engine::sym!("ChaosDamageLifeLeech"), pom_engine::sym!("ElementalDamageLifeLeech")]) + enemy.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("SelfDamageLifeLeech")]) / 100.0;
                        }
                    } else {
                        let mut names = vec!["DamageLeech".to_string(), "DamageLifeLeech".to_string(), format!("{damage_type}DamageLifeLeech")];
                        if is_elemental(damage_type) {
                            names.push("ElementalDamageLifeLeech".to_string());
                        }
                        let ns: Vec<&str> = names.iter().map(|x| x.as_str()).collect();
                        life_leech = sml.sum(ModType::Base, Some(cfg), &syms(&ns)) + enemy.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("SelfDamageLifeLeech")]) / 100.0;
                    }
                    let mut es_names = vec!["DamageEnergyShieldLeech".to_string(), format!("{damage_type}DamageEnergyShieldLeech")];
                    if is_elemental(damage_type) {
                        es_names.push("ElementalDamageEnergyShieldLeech".to_string());
                    }
                    let ns: Vec<&str> = es_names.iter().map(|x| x.as_str()).collect();
                    es_leech = sml.sum(ModType::Base, Some(cfg), &syms(&ns)) + enemy.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("SelfDamageEnergyShieldLeech")]) / 100.0;
                    let mut mana_names = vec!["DamageLeech".to_string(), "DamageManaLeech".to_string(), format!("{damage_type}DamageManaLeech")];
                    if is_elemental(damage_type) {
                        mana_names.push("ElementalDamageManaLeech".to_string());
                    }
                    let ns: Vec<&str> = mana_names.iter().map(|x| x.as_str()).collect();
                    mana_leech = sml.sum(ModType::Base, Some(cfg), &syms(&ns)) + enemy.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("SelfDamageManaLeech")]) / 100.0;
                }
                if pass == 2 && bd_on {
                    bd::cur(|b| bd::ins_s(bd::t(b, damage_type), sf!("= %d to %d", hit_min, hit_max)));
                }
                if life_leech > 0.0 && !no_life_leech {
                    life_leech_total += hit_avg * life_leech / 100.0;
                }
                if mana_leech > 0.0 && !no_mana_leech {
                    mana_leech_total += hit_avg * mana_leech / 100.0;
                }
                if es_leech > 0.0 && !no_es_leech {
                    es_leech_total += hit_avg * es_leech / 100.0;
                }
            } else if bd_on {
                bd::cur(|b| bd::set(b, damage_type, serde_json::Value::Array(vec![bd::s(format!("You can't deal {damage_type} damage"))])));
            }
            if pass == 1 {
                out.insert(format!("{damage_type}CritAverage"), hit_avg);
                total_crit_avg += hit_avg;
                total_crit_min += hit_min;
                total_crit_max += hit_max;
            } else {
                // CalcOffence.lua:3653-3656
                if crate::CALCS_MODE.with(|c| c.get()) {
                    out.insert(format!("{damage_type}Min"), hit_min);
                    out.insert(format!("{damage_type}Max"), hit_max);
                }
                out.insert(format!("{damage_type}HitAverage"), hit_avg);
                hit_avg_by_type[ti] = hit_avg;
                total_hit_avg += hit_avg;
                total_hit_min += hit_min;
                total_hit_max += hit_max;
            }
        }
        if let Some(ScalarValue::Num(v)) = i.skill_data.get("lifeLeechPerUse") {
            if !no_life_leech {
                life_leech_total += v;
            }
        }
        if let Some(ScalarValue::Num(v)) = i.skill_data.get("manaLeechPerUse") {
            mana_leech_total += v;
        }
        // leech caps per instance
        if ghost_reaver {
            life_leech_total = life_leech_total.min(get(i.player_output, "MaxEnergyShieldLeechInstance"));
        } else {
            life_leech_total = life_leech_total.min(get(i.player_output, "MaxLifeLeechInstance"));
        }
        es_leech_total = es_leech_total.min(get(i.player_output, "MaxEnergyShieldLeechInstance"));
        mana_leech_total = mana_leech_total.min(get(i.player_output, "MaxManaLeechInstance"));
        if ghost_reaver && no_es_leech {
            life_leech_total = 0.0;
        }
        let cc = get(out, "CritChance");
        let portion = if pass == 1 { cc / 100.0 } else { 1.0 - cc / 100.0 };
        if ghost_reaver {
            ghost_reaver_life_leech += life_leech_total * portion;
        } else {
            let v = get(out, "LifeLeech") + life_leech_total * portion;
            out.insert("LifeLeech".to_string(), v);
        }
        let v = get(out, "EnergyShieldLeech") + es_leech_total * portion;
        out.insert("EnergyShieldLeech".to_string(), v);
        let v = get(out, "ManaLeech") + mana_leech_total * portion;
        out.insert("ManaLeech".to_string(), v);
    }
    out.insert("TotalMin".to_string(), total_hit_min);
    out.insert("TotalMax".to_string(), total_hit_max);

    // ---- highest damage type conditions (3711-3730)
    let mut highest = 0usize;
    for (ti, dt) in DMG_TYPES.iter().enumerate() {
        if hit_avg_by_type[ti] > 0.0 {
            sml.add_mod(flag_mod(&format!("Condition:{dt}HasDamage"), "Config"));
            if hit_avg_by_type[ti] > hit_avg_by_type[highest] {
                highest = ti;
            }
            if bd_on {
                let portion = hit_avg_by_type[ti] / total_hit_avg * 100.0;
                bd::cur(|b| bd::ins_s(bd::t(b, dt), sf!("Portion of total damage: %d%%", portion)));
            }
        }
    }
    if !sml.flag(None, &[pom_engine::sym!("IsHighestDamageTypeOVERRIDE")]) {
        sml.add_mod(flag_mod(&format!("Condition:{}IsHighestDamageType", DMG_TYPES[highest]), "Config"));
    }

    // ---- leech rates (3721-3757)
    let leech_rate_base = crate::data::misc("LeechRateBase");
    let leech_instances = |amount: f64, total: f64| -> (f64, f64) {
        if total == 0.0 {
            return (0.0, 0.0);
        }
        let duration = amount / total / leech_rate_base;
        (duration, duration * hit_rate)
    };
    let inst_prop = |sml: &ModStore, name: &str| sml.sum(ModType::Base, Some(cfg), &[s(name)]).min(100.0).max(0.0) / 100.0;
    let life_inst_prop = inst_prop(sml, "InstantLifeLeech");
    out.insert("LifeLeechInstantProportion".to_string(), life_inst_prop);
    if life_inst_prop > 0.0 {
        let l = get(out, "LifeLeech");
        out.insert("LifeLeechInstant".to_string(), l * life_inst_prop);
        out.insert("LifeLeech".to_string(), l * (1.0 - life_inst_prop));
    }
    if ghost_reaver && ghost_reaver_life_leech > 0.0 {
        let v = get(out, "EnergyShieldLeech") + ghost_reaver_life_leech;
        out.insert("EnergyShieldLeech".to_string(), v);
        out.insert("LifeLeech".to_string(), 0.0);
        out.insert("LifeLeechInstant".to_string(), 0.0);
    }
    let es_inst_prop = inst_prop(sml, "InstantEnergyShieldLeech");
    out.insert("EnergyShieldLeechInstantProportion".to_string(), es_inst_prop);
    if es_inst_prop > 0.0 {
        let l = get(out, "EnergyShieldLeech");
        out.insert("EnergyShieldLeechInstant".to_string(), l * es_inst_prop);
        out.insert("EnergyShieldLeech".to_string(), l * (1.0 - es_inst_prop));
    }
    let mana_inst_prop = inst_prop(sml, "InstantManaLeech");
    out.insert("ManaLeechInstantProportion".to_string(), mana_inst_prop);
    if mana_inst_prop > 0.0 {
        let l = get(out, "ManaLeech");
        out.insert("ManaLeechInstant".to_string(), l * mana_inst_prop);
        out.insert("ManaLeech".to_string(), l * (1.0 - mana_inst_prop));
    }
    let (d, n) = leech_instances(get(out, "LifeLeech"), get(i.player_output, "Life"));
    out.insert("LifeLeechDuration".to_string(), d);
    out.insert("LifeLeechInstances".to_string(), n);
    out.insert("LifeLeechInstantRate".to_string(), get(out, "LifeLeechInstant") * hit_rate);
    let (d, n) = leech_instances(get(out, "EnergyShieldLeech"), get(i.player_output, "EnergyShield"));
    out.insert("EnergyShieldLeechDuration".to_string(), d);
    out.insert("EnergyShieldLeechInstances".to_string(), n);
    out.insert("EnergyShieldLeechInstantRate".to_string(), get(out, "EnergyShieldLeechInstant") * hit_rate);
    let (d, n) = leech_instances(get(out, "ManaLeech"), get(i.player_output, "Mana"));
    out.insert("ManaLeechDuration".to_string(), d);
    out.insert("ManaLeechInstances".to_string(), n);
    out.insert("ManaLeechInstantRate".to_string(), get(out, "ManaLeechInstant") * hit_rate);

    // ---- gain on hit / kill (3758-3781)
    if skill_flag("mine") || skill_flag("trap") || skill_flag("totem") {
        for k in ["LifeOnHit", "EnergyShieldOnHit", "ManaOnHit", "LifeOnKill", "EnergyShieldOnKill", "ManaOnKill"] {
            out.insert(k.to_string(), 0.0);
        }
    } else {
        let c = Some(&*cfg);
        let life_on_hit = if !sml.flag(c, &[pom_engine::sym!("CannotGainLife")]) && !sml.flag(c, &[pom_engine::sym!("CannotRecoverLifeOutsideLeech")]) { sml.sum(ModType::Base, c, &[pom_engine::sym!("LifeOnHit")]) + enemy.sum(ModType::Base, c, &[pom_engine::sym!("SelfLifeOnHit")]) } else { 0.0 };
        let es_on_hit = if !sml.flag(c, &[pom_engine::sym!("CannotGainEnergyShield")]) { sml.sum(ModType::Base, c, &[pom_engine::sym!("EnergyShieldOnHit")]) + enemy.sum(ModType::Base, c, &[pom_engine::sym!("SelfEnergyShieldOnHit")]) } else { 0.0 };
        let mana_on_hit = if !sml.flag(c, &[pom_engine::sym!("CannotGainMana")]) { sml.sum(ModType::Base, c, &[pom_engine::sym!("ManaOnHit")]) + enemy.sum(ModType::Base, c, &[pom_engine::sym!("SelfManaOnHit")]) } else { 0.0 };
        out.insert("LifeOnHit".to_string(), life_on_hit);
        out.insert("EnergyShieldOnHit".to_string(), es_on_hit);
        out.insert("ManaOnHit".to_string(), mana_on_hit);
        let life_on_kill = if !sml.flag(c, &[pom_engine::sym!("CannotGainLife")]) && !sml.flag(c, &[pom_engine::sym!("CannotRecoverLifeOutsideLeech")]) { sml.sum(ModType::Base, c, &[pom_engine::sym!("LifeOnKill")]).floor() } else { 0.0 };
        let es_on_kill = if !sml.flag(c, &[pom_engine::sym!("CannotGainEnergyShield")]) { sml.sum(ModType::Base, c, &[pom_engine::sym!("EnergyShieldOnKill")]).floor() } else { 0.0 };
        let mana_on_kill = if !sml.flag(c, &[pom_engine::sym!("CannotGainMana")]) { sml.sum(ModType::Base, c, &[pom_engine::sym!("ManaOnKill")]).floor() } else { 0.0 };
        out.insert("LifeOnKill".to_string(), life_on_kill);
        out.insert("EnergyShieldOnKill".to_string(), es_on_kill);
        out.insert("ManaOnKill".to_string(), mana_on_kill);
    }
    out.insert("LifeOnHitRate".to_string(), get(out, "LifeOnHit") * hit_rate);
    out.insert("EnergyShieldOnHitRate".to_string(), get(out, "EnergyShieldOnHit") * hit_rate);
    out.insert("ManaOnHitRate".to_string(), get(out, "ManaOnHit") * hit_rate);

    // ---- enemy regeneration (3783-3786)
    out.insert("EnemyLifeRegen".to_string(), enemy.sum(ModType::Inc, Some(cfg), &[pom_engine::sym!("LifeRegen")]));
    out.insert("EnemyManaRegen".to_string(), enemy.sum(ModType::Inc, Some(cfg), &[pom_engine::sym!("ManaRegen")]));
    out.insert("EnemyEnergyShieldRegen".to_string(), enemy.sum(ModType::Inc, Some(cfg), &[pom_engine::sym!("EnergyShieldRegen")]));

    // ---- average damage and DPS (3788-3800)
    let cc = get(out, "CritChance");
    let average_hit = total_hit_avg * (1.0 - cc / 100.0) + total_crit_avg * cc / 100.0;
    out.insert("AverageHit".to_string(), average_hit);
    if i.skill_flags.contains("monsterExplode") {
        out.insert("AverageHitToMonsterLifePercentage".to_string(), average_hit / i.monster_life * 100.0);
        let hit_chance_is_explode_chance = matches!(i.skill_data.get("hitChanceIsExplodeChance"), Some(v) if !matches!(v, ScalarValue::Bool(false)));
        if hit_chance_is_explode_chance {
            if let Some(ec) = i.explode_chance {
                out.insert("HitChance".to_string(), ec);
            }
        }
    }
    let average_damage = average_hit * get(out, "HitChance") / 100.0;
    out.insert("AverageDamage".to_string(), average_damage);
    let burst_hits = i.average_burst_hits.unwrap_or(1.0);
    global.insert("AverageBurstHits".to_string(), burst_hits);
    let repeat_penalty = if sml.flag(None, &[pom_engine::sym!("HasSeals")]) && i.can_rapid_fire && !sml.flag(None, &[pom_engine::sym!("NoRepeatBonuses")]) { calc_lib_mod_s(sml, Some(i.skill_cfg), &[pom_engine::sym!("SealRepeatPenalty")]) } else { 1.0 };
    global.insert("AverageBurstDamage".to_string(), average_damage + average_damage * (burst_hits - 1.0) * repeat_penalty);
    if bd_on {
        bd_average(i, sml, out, global, [total_hit_min, total_hit_max, total_hit_avg], [total_crit_min, total_crit_max, total_crit_avg], average_hit, average_damage, repeat_penalty);
    }
    out.insert("TotalDPS".to_string(), average_damage * i.hit_speed.unwrap_or(i.speed) * i.dps_multiplier * i.total_dps_multiplier * i.quantity_multiplier);
}

/// CalcOffence.lua:3359-3382: `breakdown[damageType] = { damageTypes = { } }` and the "Base damage:" lines, per damage type.
fn bd_base_damage(i: &HitDmgInput, sml: &ModStore, cfg: &Cfg, out: &HashMap<String, f64>) {
    let enemy = i.enemy_db;
    for damage_type in DMG_TYPES {
        let (min_key, max_key) = (format!("{damage_type}Min"), format!("{damage_type}Max"));
        let base_min = get(out, &format!("{min_key}Base"));
        let base_max = get(out, &format!("{max_key}Base"));
        let mut tbl = serde_json::Value::Null;
        bd::set(&mut tbl, "damageTypes", serde_json::Value::Array(vec![]));
        if base_min != 0.0 && base_max != 0.0 {
            let added_min = sml.sum(ModType::Base, Some(cfg), &[Sym::new(&min_key)]) + enemy.sum(ModType::Base, Some(cfg), &[Sym::new(&format!("Self{min_key}"))]);
            let added_max = sml.sum(ModType::Base, Some(cfg), &[Sym::new(&max_key)]) + enemy.sum(ModType::Base, Some(cfg), &[Sym::new(&format!("Self{max_key}"))]);
            let added_mult = calc_lib_mod(sml, Some(cfg), &[format!("Added{damage_type}Damage").as_str(), "AddedDamage"]);
            bd::ins_s(&mut tbl, "Base damage:");
            let mut plus = "";
            let (src_min, src_max) = (i.source.get(&min_key), i.source.get(&max_key));
            if src_min != 0.0 || src_max != 0.0 {
                bd::ins_s(&mut tbl, sf!("%d to %d ^8(base damage from %s)", src_min, src_max, if i.source.weapon_type.is_some() { "weapon" } else { "skill" }));
                if i.base_multiplier != 1.0 {
                    bd::ins_s(&mut tbl, sf!("x %.2f ^8(base damage multiplier)", i.base_multiplier));
                }
                plus = "+ ";
            }
            if added_min != 0.0 || added_max != 0.0 {
                bd::ins_s(&mut tbl, sf!("%s%d to %d ^8(added damage)", plus, added_min, added_max));
                if i.damage_effectiveness != 1.0 {
                    bd::ins_s(&mut tbl, sf!("x %.2f ^8(damage effectiveness)", i.damage_effectiveness));
                }
                if added_mult != 1.0 {
                    bd::ins_s(&mut tbl, sf!("x %.2f ^8(added damage multiplier)", added_mult));
                }
            }
            bd::ins_s(&mut tbl, sf!("= %.1f to %.1f", base_min, base_max));
        }
        bd::cur(|b| bd::set(b, damage_type, tbl));
    }
}

/// CalcOffence.lua:3412-3438: the "Hit damage:" lines of one damage type (pass 2).
#[allow(clippy::too_many_arguments)]
fn bd_hit_header(i: &HitDmgInput, out: &HashMap<String, f64>, damage_type: &str, hit_min: f64, hit_max: f64, conv_mult: f64, warcry_max_hit: bool) {
    let (double_eff, triple_eff) = (get(out, "DoubleDamageEffect"), get(out, "TripleDamageEffect"));
    let (double_chance, triple_chance) = (get(out, "DoubleDamageChance"), get(out, "TripleDamageChance"));
    bd::cur(|b| {
        let t = bd::t(b, damage_type);
        bd::ins_s(t, "Hit damage:");
        bd::ins_s(t, sf!("%d to %d ^8(total damage)", hit_min, hit_max));
        if conv_mult != 1.0 {
            bd::ins_s(t, sf!("x %g ^8(%g%% converted to other damage types)", conv_mult, (1.0 - conv_mult) * 100.0));
        }
        if double_eff != 0.0 {
            if triple_eff != 0.0 {
                bd::ins_s(t, sf!("x %.2f ^8(1 + %.2f + %.2f multiplier from %.1f%% chance to deal double damage and %d%% chance to deal triple damage)", 1.0 + double_eff + triple_eff, double_eff, triple_eff, double_chance, triple_chance));
            } else {
                bd::ins_s(t, sf!("x %.2f ^8(multiplier from %d%% chance to deal double damage)", 1.0 + double_eff, double_chance));
            }
        } else if triple_eff != 0.0 {
            bd::ins_s(t, sf!("x %.2f ^8(multiplier from %d%% chance to deal triple damage)", 1.0 + triple_eff, triple_chance));
        }
        let ruthless = get(out, "RuthlessBlowHitEffect");
        if ruthless != 1.0 {
            bd::ins_s(t, sf!("x %.2f ^8(ruthless blow effect modifier)", ruthless));
        }
        let fow = get(out, "FistOfWarDamageEffect");
        if fow != 1.0 {
            bd::ins_s(t, sf!("x %.2f ^8(fist of war effect modifier)", fow));
        }
        if i.offensive_warcry_effect != 1.0 && !warcry_max_hit {
            bd::ins_s(t, sf!("x %.2f ^8(aggregated warcry exerted effect modifier)", i.offensive_warcry_effect));
        }
        if i.max_offensive_warcry_effect != 1.0 && warcry_max_hit {
            bd::ins_s(t, sf!("x %.2f ^8(aggregated max warcry exerted effect modifier)", i.max_offensive_warcry_effect));
        }
    });
}

/// CalcOffence.lua:3802-3854: `breakdown.AverageHit`, `breakdown.AverageDamage` and `globalBreakdown.AverageBurstDamage`.
#[allow(clippy::too_many_arguments)]
fn bd_average(i: &HitDmgInput, sml: &ModStore, out: &HashMap<String, f64>, global: &HashMap<String, f64>, hit: [f64; 3], crit: [f64; 3], average_hit: f64, average_damage: f64, repeat_penalty: f64) {
    let [total_hit_min, total_hit_max, total_hit_avg] = hit;
    let [total_crit_min, total_crit_max, total_crit_avg] = crit;
    let crit_chance = get(out, "CritChance");
    let hit_chance = get(out, "HitChance");
    if get(out, "CritEffect") != 1.0 {
        let mut t = serde_json::Value::Array(vec![]);
        let damage_rolls = out.get("DamageRolls").copied().unwrap_or(0.0);
        let crit_rolls = out.get("CritDamageRolls").copied().unwrap_or(0.0);
        let rolls = damage_rolls.abs() + 2.0;
        let rolls_crit = crit_rolls.abs() + 2.0;
        let crit_lucky = sml.flag(Some(i.skill_cfg), &[pom_engine::sym!("CritLucky")]);
        if damage_rolls > 0.0 {
            bd::ins_s(&mut t, sf!("(1/%d) x %d + (%d/%d) x %d = %.1f ^8(average from non-crits)", rolls, total_hit_min, rolls - 1.0, rolls, total_hit_max, total_hit_avg));
        }
        if damage_rolls < 0.0 {
            bd::ins_s(&mut t, sf!("(%d/%d) x %d + (1/%d) x %d = %.1f ^8(average from non-crits)", rolls - 1.0, rolls, total_hit_min, rolls, total_hit_max, total_hit_avg));
        }
        if damage_rolls > 0.0 || crit_rolls > 0.0 || crit_lucky {
            bd::ins_s(&mut t, sf!("(1/%d) x %d + (%d/%d) x %d = %.1f ^8(average from crits)", rolls_crit, total_crit_min, rolls_crit - 1.0, rolls_crit, total_crit_max, total_crit_avg));
            bd::ins_s(&mut t, "");
        }
        if damage_rolls < 0.0 && !crit_lucky {
            bd::ins_s(&mut t, sf!("(%d/%d) x %d + (1/%d) x %d = %.1f ^8(average from crits)", rolls - 1.0, rolls, total_crit_min, rolls, total_crit_max, total_crit_avg));
            bd::ins_s(&mut t, "");
        }
        bd::ins_s(&mut t, sf!("%.1f x (1 - %.4f) ^8(damage from non-crits)", total_hit_avg, crit_chance / 100.0));
        bd::ins_s(&mut t, sf!("+ %.1f x %.4f ^8(damage from crits)", total_crit_avg, crit_chance / 100.0));
        bd::ins_s(&mut t, sf!("= %.1f", average_hit));
        bd::cur(|b| bd::set(b, "AverageHit", t));
    }
    if hit_chance < 100.0 {
        let mut t = serde_json::Value::Array(vec![]);
        bd::ins_s(&mut t, sf!("%s:", i.pass_label));
        bd::ins_s(&mut t, sf!("%.1f ^8(average hit)", average_hit));
        bd::ins_s(&mut t, sf!("x %.2f ^8(chance to hit)", hit_chance / 100.0));
        bd::ins_s(&mut t, sf!("= %.1f", average_damage));
        bd::cur(|b| bd::set(b, "AverageDamage", t));
    }
    let burst_damage = get(global, "AverageBurstDamage");
    if burst_damage > 0.0 {
        let burst_hits = get(global, "AverageBurstHits");
        let mut t = serde_json::Value::Array(vec![]);
        bd::ins_s(&mut t, sf!("%.1f ^8(average hit)", average_hit));
        if hit_chance < 100.0 {
            bd::ins_s(&mut t, sf!("x %.2f ^8(chance to hit)", hit_chance / 100.0));
        }
        if repeat_penalty < 1.0 {
            bd::ins_s(&mut t, sf!("x %.2f ^8(number of repeats)", burst_hits - 1.0));
            bd::ins_s(&mut t, sf!("x %.2f ^8(repeat penalty)", repeat_penalty));
            bd::ins_s(&mut t, sf!("= %.1f ^8(repeat damage total)", burst_damage - average_damage));
            bd::ins_s(&mut t, "");
            bd::ins_s(&mut t, sf!("+ %.1f ^8(first hit)", average_hit));
            if hit_chance < 100.0 {
                bd::ins_s(&mut t, sf!("x %.2f ^8(chance to hit)", hit_chance / 100.0));
            }
        } else {
            bd::ins_s(&mut t, sf!("x %.2f ^8(number of hits)", burst_hits));
        }
        bd::ins_s(&mut t, sf!("= %.1f ^8(total burst damage)", burst_damage));
        bd::root(|r| bd::set(r, "AverageBurstDamage", t));
    }
}
