//! The damage half of `calcs.offence` for a non-attack main skill: everything in CalcOffence.lua
//! after crit/speed - HitSpeed/dpsMultiplier (2470-2500), the offensive-warcry/ruthless/fist-of-war
//! multipliers (2502-3010), double/triple damage (3271-3298), culling/reservation DPS (3300-3315),
//! the two-pass hit loop (`pom_offence::hitdmg`, 3396-3801), leech (3388-3396/3613-3756/4100-4153),
//! ailment chances and the Bleed/Poison/Ignite/Impale/TotalDot sections (4160-5914), and the
//! final combine (6106-6262).
//!
//! **Bails (leaves every key of this stage unproduced) rather than approximating** when the skill
//! needs code that is not ported: a `Data/Skills` runtime hook (`crate::skill_hooks`), an
//! exertable warcry / Pact active on the actor (the ~500-line uptime block at 2502-2975), Seals,
//! Cryogenesis added-damage redirect, Perfect Agony, or a Fist of War slam.
use crate::Env;
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::{Cfg, ScalarValue};
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_offence::ailments::{apply_ailment_mode, calc_ailment_chances, calc_average_source_damage, calc_chilling_area, calc_freeze_duration_mod, calc_non_damaging_ailment, can_deal, ChanceCtx, NonDamagingAilmentCtx};
use pom_offence::conversion::{build_conversion_table, DMG_TYPES};
use pom_offence::dot::{calc_bleed, calc_ignite, calc_poison, calc_total_dot, total_dot_dps, DotExternal, TotalDotInputs, TotalDotTailExternal};
use pom_offence::impale::calc_impale;
use pom_offence::leech::{calc_leech, DamageTypeAvg, LeechExternal, LEECH_DMG_TYPES};
use pom_skills::assemble::ComputedSkill;
use pom_skills::skill_type as st;
use pom_engine::fxhash::HashMap;
use std::sync::Arc;

fn s(n: &str) -> Sym {
    Sym::new(n)
}
fn num(m: &HashMap<String, ScalarValue>, key: &str) -> Option<f64> {
    match m.get(key) {
        Some(ScalarValue::Num(n)) => Some(*n),
        _ => None,
    }
}
fn truthy(m: &HashMap<String, ScalarValue>, key: &str) -> bool {
    match m.get(key) {
        Some(ScalarValue::Bool(b)) => *b,
        Some(_) => true,
        None => false,
    }
}


/// Why this stage cannot be produced faithfully for `main` (None = supported).
pub(crate) fn unsupported(all_skills: &[ComputedSkill], sml: &ModStore, cfg_for_guard: &Cfg) -> Option<&'static str> {
    for other in all_skills {
        if other.skill_flags.contains("disable") {
            continue;
        }
    }
    // Mod injections of the top-of-`calcs.offence` chain (CalcOffence.lua:516-1050) that
    // `crate::offence_prep` does not port (energy blade, momentum, unleash/seals, sacrificial zeal).
    for name in ["Condition:SacrificialZeal"] {
        if sml.flag(None, &[s(name)]) || sml.flag(Some(cfg_for_guard), &[s(name)]) || sml.conditions.get(&s(name)).copied().unwrap_or(false) {
            return Some(name);
        }
    }
    None
}

fn flag_mod(name: &str, source: &str) -> Mod {
    Mod { name: s(name), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (vec![]).into() }
}

pub(crate) struct Stage1<'a> {
    pub main: &'a ComputedSkill,
    pub all_skills: &'a [ComputedSkill],
    /// `skillCfg` (for an attack, each hand's own cfg is in `PassCtx::cfg`).
    pub cfg: &'a Cfg,
    pub skill_data: &'a HashMap<String, ScalarValue>,
    pub repeats: f64,
    pub grant_cast_time: f64,
    pub has_cooldown: bool,
}

/// One damage pass (`passList` entry, CalcOffence.lua:1993-2063): a hand of an attack or the single
/// "Skill" pass of everything else.
pub(crate) struct PassCtx<'a> {
    pub label: &'static str,
    pub cfg: &'a Cfg,
    pub is_attack: bool,
}

/// State shared by every pass of one `calcs.offence` call (`skillData.dpsMultiplier` is mutated by
/// the Ruthless Blow branch inside the pass loop, so it lives here, not in a pass).
pub(crate) struct Prep {
    pub dps_multiplier: f64,
    pub quantity_multiplier: f64,
    pub show_average: bool,
}

/// Per-call `skillFlags` the ailment sections set (`skillFlags.bleed`/`.poison`/`.ignite`/`.impale`/
/// `.dot`), OR-ed across passes exactly as the shared `skillFlags` table would be.
#[derive(Default, Clone, Copy)]
pub(crate) struct AilmentFlags {
    pub flag_dot: bool,
    pub flag_ignite: bool,
    pub flag_bleed: bool,
    pub flag_impale: bool,
}

/// Knockback chance/distance (CalcOffence.lua:5516-5525) and the enemy stun modifiers (5527-5562).
fn knockback_and_stun(sml: &ModStore, enemy: &ModStore, cfg: &Cfg, sd: &HashMap<String, ScalarValue>, po: &mut HashMap<String, f64>, crit_chance: f64, label: &str) {
        // Upstream's `breakdown` here is the pass's table (inside `for _, pass in ipairs(passList)`).
        pom_offence::bd::set_pass(pom_offence::bd::pass_scope(label));
        let on_hit = po.get("KnockbackChanceOnHit").copied().unwrap_or(0.0);
        let on_crit = po.get("KnockbackChanceOnCrit").copied().unwrap_or(0.0);
        let knockback = (on_hit * (1.0 - crit_chance / 100.0) + on_crit * crit_chance / 100.0 + enemy.sum(ModType::Base, None, &[pom_engine::sym!("SelfKnockbackChance")])).min(100.0);
        po.insert("KnockbackChance".into(), knockback);
        if knockback > 0.0 {
            let dist = pom_offence::area::round(4.0 * pom_offence::tools::calc_lib_mod_s(sml, Some(cfg), &[pom_engine::sym!("EnemyKnockbackDistance")]));
            po.insert("KnockbackDistance".into(), dist);
            pom_offence::bd::cur(|b| pom_offence::bd::set(b, "KnockbackDistance", pom_offence::bd::row(vec![("radius", pom_offence::bd::num(dist))])));
        }
        let red = -sml.sum(ModType::Inc, Some(cfg), &[pom_engine::sym!("EnemyStunThreshold")]);
        let threshold_mod = if red > 75.0 { 1.0 - (75.0 + (red - 75.0) * 25.0 / (red - 50.0)) / 100.0 } else { 1.0 - red / 100.0 };
        po.insert("EnemyStunThresholdMod".into(), threshold_mod);
        let base = match sd.get("baseStunDuration") {
            Some(ScalarValue::Num(n)) => *n,
            _ => 0.35,
        };
        let inc_dur = sml.sum(ModType::Inc, Some(cfg), &[pom_engine::sym!("EnemyStunDuration")]);
        let inc_dur_crit = sml.sum(ModType::Inc, Some(cfg), &[pom_engine::sym!("EnemyStunDurationOnCrit")]);
        let more_dur = sml.more(Some(cfg), &[pom_engine::sym!("EnemyStunDuration")]);
        let chance_to_double = (sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("DoubleEnemyStunDurationChance")]) + enemy.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("SelfDoubleStunDurationChance")])).min(100.0);
        let inc_recov = enemy.sum(ModType::Inc, None, &[pom_engine::sym!("StunRecovery")]);
        let mut minimum = base * more_dur / (1.0 + inc_recov / 100.0);
        let mut maximum = minimum;
        let mut stun = minimum;
        if inc_dur_crit != 0.0 && crit_chance != 0.0 {
            if crit_chance == 100.0 {
                minimum *= 1.0 + (inc_dur + inc_dur_crit) / 100.0;
                maximum = minimum;
                stun = minimum;
            } else {
                minimum *= 1.0 + inc_dur / 100.0;
                maximum *= 1.0 + (inc_dur + inc_dur_crit) / 100.0;
                stun *= 1.0 + (inc_dur + inc_dur_crit * crit_chance / 100.0) / 100.0;
            }
        } else {
            minimum *= 1.0 + inc_dur / 100.0;
            maximum = minimum;
            stun = minimum;
        }
        if chance_to_double != 0.0 {
            if chance_to_double == 100.0 {
                minimum *= 2.0;
            }
            maximum *= 2.0;
            stun *= 1.0 + chance_to_double / 100.0;
        }
        po.insert("EnemyStunDuration".into(), stun);
        if pom_offence::bd::on() && stun != base {
            // CalcOffence.lua:5563-5589
            use pom_offence::bd::{ins_s, set};
            use pom_offence::sf;
            let mut t = serde_json::Value::Array(vec![]);
            ins_s(&mut t, sf!("%.2fs ^8(base duration)", base));
            if inc_dur != 0.0 || (inc_dur_crit != 0.0 && crit_chance != 0.0) {
                ins_s(&mut t, sf!("x %.2f ^8(increased/reduced stun duration)", 1.0 + (inc_dur + inc_dur_crit * crit_chance / 100.0) / 100.0));
            }
            if more_dur != 1.0 {
                ins_s(&mut t, sf!("x %.2f ^8(more/less stun duration)", more_dur));
            }
            if chance_to_double != 0.0 {
                ins_s(&mut t, sf!("x %.2f ^8(chance to double stun duration)", 1.0 + chance_to_double / 100.0));
            }
            if inc_recov != 0.0 {
                ins_s(&mut t, sf!("/ %.2f ^8(increased/reduced enemy stun recovery)", 1.0 + inc_recov / 100.0));
            }
            ins_s(&mut t, sf!("= %.2fs", stun));
            if minimum != maximum {
                ins_s(&mut t, sf!("(minimum: %.2fs, maximum: %.2fs)", minimum, maximum));
            }
            // `calcs.actionSpeedMod(actor.enemy)` (CalcPerform.lua:1141)
            let min_action = enemy.max(None, &[pom_engine::sym!("MinimumActionSpeed")]).unwrap_or(0.0);
            let max_reduction = enemy.max(None, &[pom_engine::sym!("MaximumActionSpeedReduction")]);
            let action = pom_offence::tools::action_speed_mod(
                enemy.sum(ModType::Inc, None, &[pom_engine::sym!("TemporalChainsActionSpeed")]),
                enemy.sum(ModType::Inc, None, &[pom_engine::sym!("ActionSpeed")]),
                pom_offence::data::misc("TemporalChainsEffectCap"),
                min_action,
                max_reduction,
            );
            if action != 1.0 {
                ins_s(&mut t, sf!("/ %.2f ^8(enemy action speed)", action));
                ins_s(&mut t, sf!("= %.2fs (note that for effects that care about duration this is ignored)", stun / action));
                if minimum != maximum {
                    ins_s(&mut t, sf!("(minimum: %.2fs, maximum: %.2fs)", minimum / action, maximum / action));
                }
            }
            pom_offence::bd::cur(|b| set(b, "EnemyStunDuration", t));
        }
}

/// `output.<Ailment>Chance` (the `calcAilmentDamage` side output, 4339/5405/5430) for the non-damaging
/// ailments, set only when the ailment can be inflicted at all. Needs no damage values.
fn nd_ailment_chances(chances: &HashMap<String, f64>, po: &mut HashMap<String, f64>, crit_chance: f64) {
    let chance = |k: &str| -> f64 { chances.get(k).copied().unwrap_or(0.0) };
    for &ailment in pom_offence::ailments::NON_DAMAGING_AILMENT_TYPES.iter() {
        let (on_hit, on_crit) = (chance(&format!("{ailment}ChanceOnHit")), chance(&format!("{ailment}ChanceOnCrit")));
        if on_hit + on_crit > 0.0 {
            po.insert(format!("{ailment}Chance"), on_hit * (1.0 - crit_chance / 100.0) + on_crit * crit_chance / 100.0);
        }
    }
}

/// The parts of one pass of the ailment loop that need no hit damage (chance-to-inflict, `<Ailment>Chance`,
/// knockback, stun): produced even when the damage stage is unsupported for the main skill
/// (`unsupported`), where the rest of `pass_ailments` is skipped.
pub(crate) fn pass_chances_only(env: &Env, sml: &ModStore, p: &Stage1, pass: &PassCtx, po: &mut HashMap<String, f64>) {
    let cfg = pass.cfg;
    let flags = &p.main.skill_flags;
    let chance_ctx = ChanceCtx { skill_flags_attack: flags.contains("attack"), skill_flags_hit: flags.contains("hit"), mode_effective: pom_calc::setup::buff_mode().effective, env_mod_db: &env.player };
    let mut chances = calc_ailment_chances(sml, &env.enemy, Some(cfg), &chance_ctx);
    chances.remove(pom_offence::ailments::IGNITE_SCORCH_MOD_KEY);
    let ailment_mode_crit = env.config_str.get("ailmentMode").map(|x| x == "CRIT").unwrap_or(false);
    apply_ailment_mode(&mut chances, &env.player, ailment_mode_crit);
    for (k, v) in &chances {
        po.insert(k.clone(), *v);
    }
    let crit_chance = po.get("CritChance").copied().unwrap_or(0.0);
    po.insert("KnockbackChanceOnCrit".into(), knockback_on(sml, cfg, flags, true));
    po.insert("KnockbackChanceOnHit".into(), knockback_on(sml, cfg, flags, false));
    nd_ailment_chances(&chances, po, crit_chance);
    knockback_and_stun(sml, &env.enemy, cfg, p.skill_data, po, crit_chance, pass.label);
}

fn knockback_on(sml: &ModStore, cfg: &Cfg, flags: &pom_engine::fxhash::HashSet<String>, crit: bool) -> f64 {
    let mut c = cfg.clone();
    c.skill_cond.insert(Arc::from("CriticalStrike"), crit);
    if !flags.contains("hit") || sml.flag(Some(&c), &[pom_engine::sym!("CannotKnockback")]) { 0.0 } else { sml.sum(ModType::Base, Some(&c), &[pom_engine::sym!("EnemyKnockbackChance")]) }
}

/// One pass of the ailment/DoT loop (CalcOffence.lua:4160-5914): chance-to-inflict, non-damaging
/// ailments, Bleed/Poison/Ignite, Impale, the generic TotalDot. Results land in `po`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn pass_ailments(env: &Env, sml: &mut ModStore, p: &Stage1, prep: &Prep, pass: &PassCtx, po: &mut HashMap<String, f64>, gpo: &mut HashMap<String, f64>, go: &HashMap<String, f64>) -> Option<AilmentFlags> {
    let cfg = pass.cfg;
    // "Perfect Agony" (CalcOffence.lua:4173-4192): mods injected into `skillModList` per pass.
    {
        let hand_cond: Option<Tag> = match pass.label {
            "OffHand" => Some(Tag { kind: pom_engine::sym!("Condition"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from("OffHandAttack")))] }),
            "MainHand" => Some(Tag { kind: pom_engine::sym!("Condition"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from("MainHandAttack")))] }),
            _ => None,
        };
        let crit_tag = || Tag { kind: pom_engine::sym!("Condition"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from("CriticalStrike")))] };
        const MODFLAG_AILMENT: u64 = 0x0000_0800;
        if sml.sum(ModType::Base, None, &[pom_engine::sym!("CritMultiplierAppliesToDegen")]) > 0.0 {
            let found = sml.tabulate(Some(ModType::Base), Some(cfg), &[pom_engine::sym!("CritMultiplier")]);
            let mut new_mods: Vec<Mod> = Vec::new();
            for (_v, ptr) in found {
                // SAFETY: `ptr` points into `sml`'s own storage, read before any mutation below.
                let m: &Mod = unsafe { &*ptr };
                if m.source.as_deref() == Some("Base") {
                    continue;
                }
                let Value::Num(val) = &m.value else { continue };
                let mut tags = vec![crit_tag()];
                if let Some(h) = &hand_cond {
                    tags.push(h.clone());
                    tags.extend(m.tags.iter().cloned());
                }
                // Without a hand condition (spells) `NewMod` gets a nil in the middle of its tag varargs, so `unpack(mod)`'s
                // tags land after a hole and every `ipairs(mod)` over the new mod stops before them (they never apply).
                new_mods.push(Mod { name: pom_engine::sym!("DotMultiplier"), ty: ModType::Base, value: Value::Num((val / 2.0).floor()), flags: MODFLAG_AILMENT, keyword_flags: 0, source: m.source.clone(), tags: (tags).into() });
            }
            for m in new_mods {
                sml.add_mod(m);
            }
        }
        if sml.flag(None, &[pom_engine::sym!("DotMultiplierIsCritMultiplier")]) {
            let multi_override = sml.override_(Some(cfg), &[pom_engine::sym!("CritMultiplier")]).and_then(|v| v.num()).map(|o| o - 100.0);
            let base = multi_override.unwrap_or_else(|| sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("CritMultiplier")]));
            let value = base + env.enemy.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("SelfCritMultiplier")]);
            let mut tags = vec![crit_tag()];
            if let Some(h) = &hand_cond {
                tags.push(h.clone());
            }
            sml.add_mod(Mod { name: pom_engine::sym!("DotMultiplier"), ty: ModType::Override, value: Value::Num(value), flags: MODFLAG_AILMENT, keyword_flags: 0, source: Some(Arc::from("Perfect Agony")), tags: (tags).into() });
        }
    }
    let skill_cfg = p.cfg;
    let sd = p.skill_data;
    let flags = &p.main.skill_flags;
    let enemy = &env.enemy;
    let mode_effective = pom_calc::setup::buff_mode().effective;
    let mod_db = &env.player;
    let show_average = prep.show_average;
    let dps_multiplier = prep.dps_multiplier;
    let quantity_multiplier = prep.quantity_multiplier;
    let mut out = AilmentFlags::default();

    let crit_chance = po.get("CritChance").copied().unwrap_or(0.0);
    let hit_chance = po.get("HitChance").copied().unwrap_or(0.0);
    let hit_speed_or_speed = go.get("HitSpeed").copied().or(go.get("Speed").copied()).unwrap_or(0.0);
    let ruthless_ailment_effect = po.get("RuthlessBlowAilmentEffect").copied().unwrap_or(1.0);
    let fow_effect = po.get("FistOfWarDamageEffect").copied().unwrap_or(1.0);
    let mut enemy_resist_config: HashMap<&'static str, f64> = HashMap::default();
    for (key, cfg_key) in [("Chaos", "enemyChaosResist"), ("Fire", "enemyFireResist"), ("Cold", "enemyColdResist"), ("Lightning", "enemyLightningResist"), ("Physical", "enemyPhysicalResist")] {
        if let Some(v) = env.config_input.get(cfg_key) {
            enemy_resist_config.insert(key, *v);
        }
    }

    let debuff_expire_faster = pom_offence::tools::calc_lib_mod_s(enemy, Some(skill_cfg), &[pom_engine::sym!("BuffExpireFaster")]);
    let debuff_duration_mult = if mode_effective { 1.0 / pom_offence::data::misc("BuffExpirationSlowCap").max(debuff_expire_faster) } else { 1.0 };
    // Upstream reads `output.HitTime` / `output.Time` / `output.Cooldown` of the PASS output (MainHand/OffHand table for weapon
    // attacks); only the plain "Skill" pass shares its table with `globalOutput`.
    let shares_global = pass.label == "Skill";
    let hit_time_or_time = po.get("HitTime").copied().or(po.get("Time").copied()).or(if shares_global { go.get("HitTime").copied().or(go.get("Time").copied()) } else { None }).unwrap_or(0.0);
    let dot_ext = DotExternal {
        crit_chance,
        global_crit_chance: go.get("CritChance").copied().unwrap_or(crit_chance),
        hit_chance,
        hit_speed_or_speed,
        hit_time_or_time,
        cooldown: po.get("Cooldown").copied().or(if shares_global { go.get("Cooldown").copied() } else { None }),
        ruthless_blow_ailment_effect: ruthless_ailment_effect,
        fist_of_war_damage_effect: fow_effect,
        ailment_warcry_effect: go.get("AilmentWarcryEffect").copied().unwrap_or(1.0),
        dps_multiplier,
        quantity_multiplier,
        debuff_duration_mult,
        mode_effective,
        enemy_resist_config,
        triggered_on_death: truthy(sd, "triggeredOnDeath"),
        skill_data_duration: num(sd, "duration"),
        bleed_duration_is_skill_duration: truthy(sd, "bleedDurationIsSkillDuration"),
        bleed_is_skill_effect: truthy(sd, "bleedIsSkillEffect"),
        poison_duration_is_skill_duration: truthy(sd, "poisonDurationIsSkillDuration"),
        poison_is_skill_effect: truthy(sd, "poisonIsSkillEffect"),
        ailment_mode_crit: env.config_str.get("ailmentMode").map(|x| x == "CRIT").unwrap_or(false),
    };

    let chance_ctx = ChanceCtx { skill_flags_attack: flags.contains("attack"), skill_flags_hit: flags.contains("hit"), mode_effective, env_mod_db: mod_db };
    let mut chances = calc_ailment_chances(sml, enemy, Some(cfg), &chance_ctx);
    if let Some(v) = chances.remove(pom_offence::ailments::IGNITE_SCORCH_MOD_KEY) {
        sml.add_mod(Mod { name: pom_engine::sym!("EnemyScorchChance"), ty: ModType::Base, value: Value::Num(v), flags: 0, keyword_flags: 0, source: Some(Arc::from("Ignite Chance")), tags: (vec![]).into() });
    }
    let ailment_mode_crit = env.config_str.get("ailmentMode").map(|x| x == "CRIT").unwrap_or(false);
    if pom_offence::bd::on() {
        // What the breakdown writers of the Poison / Ignite / non-damaging ailment sections read from the pass.
        let g_time = go.get("HitTime").copied().or(po.get("Time").copied()).or(if shares_global { go.get("Time").copied() } else { None });
        let bonechill = if shares_global { go.get("HasBonechill") } else { po.get("HasBonechill") }.map(|v| *v != 0.0).unwrap_or(false);
        pom_offence::bdg::set_ctx(pom_offence::bdg::Ctx {
            is_attack: pass.is_attack,
            pass_label: match pass.label {
                "MainHand" => "Main Hand",
                "OffHand" => "Off Hand",
                _ => "Skill",
            },
            ailment_mode_crit,
            g_hit_time_or_time: g_time,
            has_bonechill: bonechill,
        });
    }
    apply_ailment_mode(&mut chances, mod_db, ailment_mode_crit);
    for (k, v) in &chances {
        po.insert(k.clone(), *v);
    }
    let chance = |k: &str| -> f64 { chances.get(k).copied().unwrap_or(0.0) };
    // CalcOffence.lua:4263-4267
    // The OnCrit query (4212-4216) runs with `skillCond["CriticalStrike"] = true`, the OnHit one (4263-4267) with false.
    po.insert("KnockbackChanceOnCrit".into(), knockback_on(sml, cfg, flags, true));
    po.insert("KnockbackChanceOnHit".into(), knockback_on(sml, cfg, flags, false));

    let mut hit_avg: HashMap<&str, f64> = HashMap::default();
    let mut crit_avg: HashMap<&str, f64> = HashMap::default();
    for dt in DMG_TYPES {
        hit_avg.insert(dt, po.get(&format!("{dt}HitAverage")).copied().unwrap_or(0.0));
        crit_avg.insert(dt, po.get(&format!("{dt}CritAverage")).copied().unwrap_or(0.0));
    }
    let (hit_avg, crit_avg) = (&hit_avg, &crit_avg);

    // Non-damaging ailments (5332-5513)
    if p.main.skill_types.contains(&68) || p.main.skill_types.contains(&67) {
        let ca = calc_chilling_area(sml, enemy, Some(cfg));
        po.insert("ChillEffectMod".into(), ca.chill_effect_mod);
        po.insert("ChillDurationMod".into(), ca.chill_duration_mod);
        po.insert("ChillSourceEffect".into(), ca.chill_source_effect);
        if pom_offence::bd::on() {
            pom_offence::bdg::dot_chill(sml, cfg, ca.chill_source_effect);
        }
    }
    let freeze_cfg = pom_offence::ailments::with_crit_cond(Some(cfg), false);
    if chance("FreezeChanceOnHit") + chance("FreezeChanceOnCrit") > 0.0 {
        let (fh, fc) = calc_average_source_damage(sml, freeze_cfg.as_ref(), "Freeze", hit_avg, crit_avg);
        let freeze_mod = calc_freeze_duration_mod(sml, enemy, freeze_cfg.as_ref(), chance("FreezeChanceOnHit"), chance("FreezeChanceOnCrit"), crit_chance, fh, fc);
        if let Some(v) = freeze_mod {
            po.insert("FreezeDurationMod".into(), v);
        }
        if pom_offence::bd::on() {
            // `baseVal` of CalcOffence.lua:5404: calcAilmentDamage("Freeze", ...) * FreezeAsThoughDealing.
            let (cfh, cfc) = (chance("FreezeChanceOnHit") * (1.0 - crit_chance / 100.0), chance("FreezeChanceOnCrit") * crit_chance / 100.0);
            let base_val = (fh * cfh / (cfh + cfc) + fc * cfc / (cfh + cfc)) * sml.more(freeze_cfg.as_ref(), &[pom_engine::sym!("FreezeAsThoughDealing")]);
            let src_mult = sml.more(freeze_cfg.as_ref(), &[pom_engine::sym!("FreezeAsThoughDealing")]);
            pom_offence::bdail::ailment_damage("Freeze", chance("FreezeChanceOnHit"), chance("FreezeChanceOnCrit"), crit_chance, fh, fc, false, crit_chance, src_mult);
            pom_offence::bdg::freeze(base_val, freeze_mod);
        }
    }
    let ailments_never_from_crit = mod_db.flag(None, &[pom_engine::sym!("AilmentsAreNeverFromCrit")]);
    let nd_cfg = pom_offence::ailments::with_crit_cond(Some(cfg), ailment_mode_crit && !ailments_never_from_crit);
    let bd_threshold = if pom_offence::bd::on() { Some(pom_offence::bdg::enemy_threshold(enemy, env.enemy_level, env.config_str.get("enemyIsBoss").map(|b| b != "None").unwrap_or(true))) } else { None };
    for &ailment in pom_offence::ailments::NON_DAMAGING_AILMENT_TYPES.iter() {
        if ailment == "Freeze" {
            continue;
        }
        let (sh, sc) = calc_average_source_damage(sml, nd_cfg.as_ref(), ailment, hit_avg, crit_avg);
        let ctx = NonDamagingAilmentCtx { chance_on_hit: chance(&format!("{ailment}ChanceOnHit")), chance_on_crit: chance(&format!("{ailment}ChanceOnCrit")), crit_chance, source_hit_dmg: sh, source_crit_dmg: sc, debuff_duration_mult };
        if pom_offence::bd::on() && ctx.chance_on_hit + ctx.chance_on_crit > 0.0 {
            pom_offence::bdg::nd_mode(ailment);
            let source_mult = sml.more(nd_cfg.as_ref(), &[Sym::new(&format!("{ailment}AsThoughDealing"))]);
            pom_offence::bdail::ailment_damage(ailment, ctx.chance_on_hit, ctx.chance_on_crit, crit_chance, sh, sc, false, crit_chance, source_mult);
        }
        let res = calc_non_damaging_ailment(sml, enemy, nd_cfg.as_ref(), ailment, &ctx);
        if res.damage > 0.0 {
            if let (true, Some(threshold), Some(duration), Some(effect_mod), Some(ncfg)) = (pom_offence::bd::on(), bd_threshold, res.duration, res.effect_mod, nd_cfg.as_ref()) {
                pom_offence::bdg::nd_ailment(ailment, &pom_offence::bdg::NdInputs {
                    skill_mod_list: sml,
                    enemy_db: enemy,
                    cfg: ncfg,
                    damage: res.damage,
                    effect_mod,
                    duration,
                    debuff_duration_mult,
                    enemy_threshold: threshold,
                    g_maximum: go.get(&format!("Maximum{ailment}")).copied(),
                    g_current: go.get(&format!("Current{ailment}")).copied(),
                    is_boss_config: env.config_str.get("enemyIsBoss").cloned().unwrap_or_default(),
                });
            }
            if let Some(d) = res.duration {
                po.insert(format!("{ailment}Duration"), d);
            }
            if let Some(e) = res.effect_mod {
                po.insert(format!("{ailment}EffectMod"), e);
            }
        }
    }

    nd_ailment_chances(&chances, po, crit_chance);
    // The ailment dotCfgs carry no `conversionTable`, so `calcDamage` falls back to `activeSkill.conversionTable`,
    // built from `skillCfg` (CalcOffence.lua:1989), not from the weapon pass cfg.
    let ct = build_conversion_table(sml, Some(skill_cfg));
    let can_phys = can_deal(sml, Some(skill_cfg), "Physical");
    let bleed = calc_bleed(sml, enemy, mod_db, mod_db, cfg, po, &ct, can_phys, chance("BleedChanceOnHit"), chance("BleedChanceOnCrit"), flags.contains("totem"), &dot_ext);
    if chance("BleedChanceOnHit") + chance("BleedChanceOnCrit") > 0.0 && can_phys {
        po.insert("BleedPhysicalMin".into(), bleed.bleed_physical_min);
        po.insert("BleedPhysicalMax".into(), bleed.bleed_physical_max);
        if let Some(v) = bleed.bleed_dps {
            po.insert("BleedDPS".into(), v);
        }
        if let Some(v) = bleed.base_bleed_dps {
            po.insert("BaseBleedDPS".into(), v);
        }
        for (k, v) in [("BleedDotMulti", bleed.bleed_dot_multi), ("CritBleedDotMulti", bleed.crit_bleed_dot_multi)] {
            if let Some(v) = v {
                po.insert(k.into(), v);
            }
        }
        for (k, v) in [
            ("BleedStacksMax", bleed.g_bleed_stacks_max),
            ("BleedDuration", bleed.g_bleed_duration),
            ("BleedStackPotential", bleed.g_bleed_stack_potential),
            ("BleedRollAverage", bleed.g_bleed_roll_average),
            ("BleedEffMult", bleed.g_bleed_eff_mult),
            ("BleedStacks", bleed.g_bleed_stacks),
            ("BleedDamage", bleed.g_bleed_damage),
        ] {
            if let Some(v) = v {
                gpo.insert(k.into(), v);
            }
        }
    }
    out.flag_bleed = bleed.bleed_dps.is_some();
    if let Some(c) = bleed.bleed_chance {
        po.insert("BleedChance".into(), c);
    }

    let multiplier_poison_on_enemy = env.config_input.get("multiplierPoisonOnEnemy").copied().unwrap_or(0.0);
    let run_poison = |sml: &ModStore| calc_poison(sml, enemy, mod_db, cfg, po, &ct, chance("PoisonChanceOnHit"), chance("PoisonChanceOnCrit"), chance("ChaosPoisonChance"), hit_avg, show_average, num(sd, "stackMultiplier").unwrap_or(1.0), multiplier_poison_on_enemy, &dot_ext);
    let bd_snapshot = pom_offence::bd::snapshot();
    let mut poison = run_poison(sml);
    // CalcOffence.lua:4744-4746: `Condition:NonPoisonedOnly` is added to the skill mod list before the source damage is
    // computed (it gates "Poisons you inflict on non-poisoned enemies deal N% increased Damage") and stays there.
    if poison.non_poisoned_only && !sml.flag(None, &[pom_engine::sym!("Condition:NonPoisonedOnly")]) {
        sml.add_mod(Mod { name: pom_engine::sym!("Condition:NonPoisonedOnly"), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(Arc::from("Calculation")), tags: (vec![]).into() });
        // Upstream runs the Poison section once, with the flag already set: drop the first run's breakdown writes.
        pom_offence::bd::restore(bd_snapshot);
        poison = run_poison(sml);
    }
    if can_deal(sml, Some(skill_cfg), "Chaos") && chance("PoisonChanceOnHit") + chance("PoisonChanceOnCrit") + chance("ChaosPoisonChance") > 0.0 {
        for (k, v) in [("PoisonDPS", poison.poison_dps), ("PoisonDamage", poison.poison_damage), ("TotalPoisonDPS", poison.total_poison_dps), ("TotalPoisonAverageDamage", poison.total_poison_average_damage), ("CausticGroundDPS", poison.caustic_ground_dps)] {
            if let Some(v) = v {
                po.insert(k.into(), v);
            }
        }
        for (k, v) in [
            ("PoisonChaosMin", Some(poison.poison_chaos_min)),
            ("PoisonChaosMax", Some(poison.poison_chaos_max)),
            ("PoisonLightningMin", poison.poison_lightning_min),
            ("PoisonLightningMax", poison.poison_lightning_max),
            ("PoisonColdMin", poison.poison_cold_min),
            ("PoisonColdMax", poison.poison_cold_max),
            ("PoisonFireMin", poison.poison_fire_min),
            ("PoisonFireMax", poison.poison_fire_max),
            ("PoisonPhysicalMin", poison.poison_physical_min),
            ("PoisonPhysicalMax", poison.poison_physical_max),
            ("PoisonDotMulti", poison.poison_dot_multi),
            ("CritPoisonDotMulti", poison.crit_poison_dot_multi),
        ] {
            if let Some(v) = v {
                po.insert(k.into(), v);
            }
        }
        for (k, v) in [("PoisonDuration", poison.g_poison_duration), ("PoisonEffMult", poison.g_poison_eff_mult), ("PoisonStacks", poison.g_poison_stacks)] {
            if let Some(v) = v {
                gpo.insert(k.into(), v);
            }
        }
        if poison.caustic_ground_dps.is_some() {
            // globalOutput.CausticGroundFromPoison = true (CalcOffence.lua:4879)
            gpo.insert("CausticGroundFromPoison".into(), 1.0);
        }
    }

    if let Some(c) = poison.chance_on_hit_final {
        po.insert("PoisonChanceOnHit".into(), c);
    }
    if let Some(c) = poison.chance_on_crit_final {
        po.insert("PoisonChanceOnCrit".into(), c);
    }
    if let Some(c) = poison.poison_chance {
        po.insert("PoisonChance".into(), c);
    }
    let ignite_to_chaos = sml.flag(Some(skill_cfg), &[pom_engine::sym!("IgniteToChaos")]);
    let ignite = calc_ignite(sml, enemy, mod_db, cfg, po, &ct, chance("IgniteChanceOnHit"), chance("IgniteChanceOnCrit"), ignite_to_chaos, &dot_ext);
    if can_deal(sml, Some(skill_cfg), "Fire") && chance("IgniteChanceOnHit") + chance("IgniteChanceOnCrit") > 0.0 {
        po.insert("IgniteTotalMin".into(), ignite.ignite_total_min);
        po.insert("IgniteTotalMax".into(), ignite.ignite_total_max);
        // `output.*` (this pass) vs `globalOutput.*` (the actor's output; `gpo`), see CalcOffence.lua:5014-5290.
        for (k, v) in [
            ("IgniteDPS", ignite.ignite_dps),
            ("IgniteDamage", if sml.flag(Some(cfg), &[pom_engine::sym!("IgniteCanStack")]) { ignite.ignite_damage } else { None }),
            ("TotalIgniteDPS", ignite.total_ignite_dps),
            ("IgniteStacksMax", ignite.ignite_stacks_max),
            ("IgnitePhysicalMin", ignite.ignite_physical_min),
            ("IgnitePhysicalMax", ignite.ignite_physical_max),
            ("IgniteLightningMin", ignite.ignite_lightning_min),
            ("IgniteLightningMax", ignite.ignite_lightning_max),
            ("IgniteColdMin", ignite.ignite_cold_min),
            ("IgniteColdMax", ignite.ignite_cold_max),
            ("IgniteFireMin", ignite.ignite_fire_min),
            ("IgniteFireMax", ignite.ignite_fire_max),
            ("IgniteChaosMin", ignite.ignite_chaos_min),
            ("IgniteChaosMax", ignite.ignite_chaos_max),
            ("IgniteDotMulti", ignite.ignite_dot_multi),
            ("CritIgniteDotMulti", ignite.crit_ignite_dot_multi),
        ] {
            if let Some(v) = v {
                po.insert(k.into(), v);
            }
        }
        for (k, v) in [
            ("IgniteChancePerHit", ignite.g_ignite_chance_per_hit),
            ("IgniteStacksMax", ignite.g_ignite_stacks_max),
            ("IgniteDuration", ignite.g_ignite_duration),
            ("IgniteStackPotential", ignite.g_ignite_stack_potential),
            ("IgniteRollAverage", ignite.g_ignite_roll_average),
            ("IgniteEffMult", ignite.g_ignite_eff_mult),
            ("IgniteDamage", ignite.ignite_damage),
            ("BurningGroundDPS", ignite.g_burning_ground_dps),
            ("BurningGroundFromIgnite", ignite.g_burning_ground_dps.map(|_| 1.0)),
        ] {
            if let Some(v) = v {
                gpo.insert(k.into(), v);
            }
        }
    }
    out.flag_ignite = ignite.ignite_dps.is_some();
    if let Some(c) = ignite.ignite_chance {
        po.insert("IgniteChance".into(), c);
    }

    knockback_and_stun(sml, enemy, cfg, sd, po, crit_chance, pass.label);

    let impale = calc_impale(sml, enemy, Some(cfg), can_phys, chance("ImpaleChance"), chance("ImpaleChanceOnCrit"), crit_chance, po.get("impaleStoredHitAvg").copied().unwrap_or(0.0));
    if let Some(imp) = impale {
        out.flag_impale = true;
        po.insert("ImpaleStoredDamage".into(), imp.impale_stored_damage);
        po.insert("ImpaleModifier".into(), imp.impale_modifier);
        gpo.insert("ImpaleStacksMax".into(), imp.impale_stacks_max);
        gpo.insert("ImpaleStacks".into(), imp.impale_stacks);
    }

    let _ = pass;
    Some(out)
}

/// The `sourceRes` label of the DoT effective-DPS breakdowns (CalcOffence.lua:5725, 5821).
fn bd_source_res(env: &Env, ty: &str) -> String {
    let flag = format!("Enemy{ty}ResistEqualToYours");
    if env.player.flag(None, &[Sym::new(&flag)]) {
        format!("Your {ty} Resistance")
    } else if crate::party::current().member_flag(&flag) {
        format!("Party Member {ty} Resistance")
    } else {
        ty.to_string()
    }
}

/// The generic damage-over-time section (CalcOffence.lua:5771-5914): runs once per `calcs.offence`
/// call on the actor's own (hand-combined, for an attack) output, not per hand. Writes
/// `TotalDotInstance/TotalDot/TotalDotCalcSection`, the per-type `<Type>Dot`/`<Type>DotEffMult` and the
/// ground/corrupting-blood DPS into `go`; returns `skillFlags.dot`.
pub(crate) fn total_dot_global(env: &Env, sml: &ModStore, p: &Stage1, prep: &Prep, go: &mut HashMap<String, f64>) -> bool {
    let skill_cfg = p.cfg;
    let sd = p.skill_data;
    let enemy = &env.enemy;
    let mode_effective = pom_calc::setup::buff_mode().effective;
    let dps_multiplier = prep.dps_multiplier;
    let quantity_multiplier = prep.quantity_multiplier;
    let mut flag_dot = false;
    // After the pass loop, `breakdown` is the actor's own table again.
    pom_offence::bd::set_pass(None);
    // Essence of Delirium's Decay DPS (CalcOffence.lua:5698-5735).
    if p.main.skill_flags.contains("hit") && num(sd, "decay").is_some() && can_deal(sml, Some(skill_cfg), "Chaos") {
        const MODFLAG_DOT: u64 = 0x0000_0008;
        const KEYWORDFLAG_HIT: u64 = 0x0004_0000;
        const KEYWORDFLAG_CHAOS_DOT: u64 = 0x1000_0000;
        let decay_cfg = Cfg {
            flags: MODFLAG_DOT,
            keyword_flags: (skill_cfg.keyword_flags & !KEYWORDFLAG_HIT) | KEYWORDFLAG_CHAOS_DOT,
            skill_name: skill_cfg.skill_name.clone(),
            summon_skill_name: skill_cfg.summon_skill_name.clone(),
            skill_types: skill_cfg.skill_types.clone(),
            slot_name: skill_cfg.slot_name.clone(),
            skill_part: skill_cfg.skill_part,
            ..Cfg::default()
        };
        // `if env.mode_effective then ... effMult ...` (CalcOffence.lua:5712): the enemy's resistance and damage taken
        // only count in the effective mode.
        let (resist, taken_inc, taken_more, eff_mult) = if mode_effective {
            let taken = [pom_engine::sym!("DamageTaken"), pom_engine::sym!("DamageTakenOverTime"), pom_engine::sym!("ChaosDamageTaken"), pom_engine::sym!("ChaosDamageTakenOverTime")];
            let resist = pom_offence::dot::calc_resist_for_type(enemy, Some(&decay_cfg), "Chaos", env.config_input.get("enemyChaosResist").copied());
            let taken_inc = enemy.sum(ModType::Inc, None, &taken);
            let taken_more = enemy.more(None, &taken);
            let eff_mult = (1.0 - resist / 100.0) * (1.0 + taken_inc / 100.0) * taken_more;
            go.insert("DecayEffMult".into(), eff_mult);
            (resist, taken_inc, taken_more, eff_mult)
        } else {
            (0.0, 0.0, 1.0, 1.0)
        };
        let names = [pom_engine::sym!("Damage"), pom_engine::sym!("ChaosDamage")];
        let inc = sml.sum(ModType::Inc, Some(&decay_cfg), &names);
        let more = sml.more(Some(&decay_cfg), &names);
        let mult = match sml.override_(Some(&decay_cfg), &[pom_engine::sym!("DotMultiplier")]).and_then(|v| v.num()) {
            Some(o) => o,
            None => sml.sum(ModType::Base, Some(&decay_cfg), &[pom_engine::sym!("DotMultiplier")]) + sml.sum(ModType::Base, Some(&decay_cfg), &[pom_engine::sym!("ChaosDotMultiplier")]),
        };
        let decay_dps = num(sd, "decay").unwrap_or(0.0) * (1.0 + inc / 100.0) * more * (1.0 + mult / 100.0) * eff_mult;
        go.insert("DecayDPS".into(), decay_dps);
        let debuff_expire_faster = pom_offence::tools::calc_lib_mod_s(enemy, Some(skill_cfg), &[pom_engine::sym!("BuffExpireFaster")]);
        let debuff_duration_mult = if mode_effective { 1.0 / pom_offence::data::misc("BuffExpirationSlowCap").max(debuff_expire_faster) } else { 1.0 };
        let decay_duration = 8.0 * debuff_duration_mult;
        go.insert("DecayDuration".into(), decay_duration);
        if pom_offence::bd::on() {
            use pom_offence::bd::{ins_s, set};
            use pom_offence::sf;
            if eff_mult != 1.0 {
                let v = pom_offence::bdbuild::eff_mult("Chaos", resist, 0.0, taken_inc, eff_mult, taken_more, Some(bd_source_res(env, "Chaos").as_str()), true, None, None);
                pom_offence::bd::cur(|b| set(b, "DecayEffMult", v));
            }
            let mut t = serde_json::Value::Array(vec![]);
            pom_offence::bdbuild::dot(&mut t, num(sd, "decay").unwrap_or(0.0), inc, more, Some(mult), 1.0, 1.0, eff_mult, decay_dps);
            pom_offence::bd::cur(|b| set(b, "DecayDPS", t));
            if decay_duration != 8.0 {
                let mut t = serde_json::Value::Array(vec![]);
                ins_s(&mut t, sf!("%.2fs ^8(base duration)", 8.0));
                if debuff_duration_mult != 1.0 {
                    ins_s(&mut t, sf!("/ %.2f ^8(debuff expires slower/faster)", 1.0 / debuff_duration_mult));
                }
                ins_s(&mut t, sf!("= %.2fs", decay_duration));
                pom_offence::bd::cur(|b| set(b, "DecayDuration", t));
            }
        }
    }
    let (po, poison_caustic_pre) = (&mut *go, ());
    let _ = poison_caustic_pre;
    let ignite_dps_is_some = po.contains_key("IgniteDPS");
    let caustic_pre = po.get("CausticGroundDPS").copied();
    let mut drops_bg_false = false;
    if let Some(v) = pom_offence::dot::calc_drops_burning_ground(&env.player, enemy, can_deal(sml, Some(skill_cfg), "Fire"), mode_effective, po.get("BurningGroundDPS").copied()) {
        po.insert("BurningGroundDPS".into(), v);
        drops_bg_false = true;
    }
    let _ = ignite_dps_is_some;
    // Generic TotalDot (5771-5914)
    let mut skill_data_dot: HashMap<&'static str, f64> = HashMap::default();
    for dt in DMG_TYPES {
        skill_data_dot.insert(dt, num(sd, &format!("{dt}Dot")).unwrap_or(0.0));
    }
    let td_inputs = TotalDotInputs {
        skill_data_dot,
        burning_ground_dps_pre: po.get("BurningGroundDPS").copied(),
        caustic_ground_dps_pre: caustic_pre,
        skill_types: p.main.skill_types.clone(),
        skill_data_dot_is_area: truthy(sd, "dotIsArea"),
        skill_data_dot_is_projectile: truthy(sd, "dotIsProjectile"),
        skill_data_dot_is_spell: truthy(sd, "dotIsSpell"),
        skill_data_dot_is_attack: truthy(sd, "dotIsAttack"),
        skill_data_dot_is_hit: truthy(sd, "dotIsHit"),
        skill_data_counts_attached_brands_in_damage: truthy(sd, "countsAttachedBrandsInDamage"),
        mode_effective,
    };
    let td_ext = TotalDotTailExternal {
        speed: po.get("Speed").copied().unwrap_or(0.0),
        mine_laying_speed: po.get("MineLayingSpeed").copied().unwrap_or(0.0),
        trap_throwing_speed: po.get("TrapThrowingSpeed").copied().unwrap_or(0.0),
        duration: po.get("Duration").copied().unwrap_or(0.0),
        attached_brand_count: po.get("AttachedBrandCount").copied().unwrap_or(1.0),
        dps_multiplier,
        quantity_multiplier,
    };
    let td = calc_total_dot(sml, enemy, skill_cfg, &td_inputs, &td_ext);
    po.insert("TotalDotInstance".into(), td.total_dot_instance);
    po.insert("TotalDot".into(), td.total_dot);
    po.insert("TotalDotCalcSection".into(), td.total_dot_calc_section);
    for (name, r) in [("Physical", td.physical), ("Lightning", td.lightning), ("Cold", td.cold), ("Fire", td.fire), ("Chaos", td.chaos)] {
        if let Some(e) = r.dot_eff_mult {
            flag_dot = true;
            po.insert(format!("{name}Dot"), r.dot);
            if mode_effective {
                po.insert(format!("{name}DotEffMult"), e);
            }
            if let Some(b) = r.bd {
                // CalcOffence.lua:5826-5827, 5857-5860
                if mode_effective && e != 1.0 {
                    let v = pom_offence::bdbuild::eff_mult(name, b.resist, 0.0, b.taken_inc, e, b.taken_more, Some(bd_source_res(env, name).as_str()), true, None, None);
                    pom_offence::bd::cur(|t| pom_offence::bd::set(t, &format!("{name}DotEffMult"), v));
                }
                let mut t = serde_json::Value::Array(vec![]);
                pom_offence::bdbuild::dot(&mut t, b.base_val, b.inc, b.more, Some(b.mult), 1.0, b.aura, e, r.dot);
                pom_offence::bd::cur(|tb| pom_offence::bd::set(tb, &format!("{name}Dot"), t));
            }
        }
    }
    if drops_bg_false || td.burning_ground_from_ignite_false {
        po.insert("BurningGroundFromIgnite".into(), 0.0);
    }
    if td.caustic_ground_from_poison_false {
        po.insert("CausticGroundFromPoison".into(), 0.0);
    }
    for (k, v) in [("BurningGroundDPS", td.burning_ground_dps), ("CausticGroundDPS", td.caustic_ground_dps), ("CorruptingBloodDPS", td.corrupting_blood_dps)] {
        if let Some(v) = v {
            po.insert(k.into(), v);
        }
    }
    flag_dot
}

/// The "combined DPS estimate" tail of `calcs.offence` (CalcOffence.lua:6106-6262), reading the
/// (already combined, for an attack) global output `go`. `attack_dual_double_hits` selects the
/// separate main/off-hand impale combine of 6154-6158 (`mh`/`oh` are those hands' outputs).
#[allow(clippy::too_many_arguments)]
pub(crate) fn finish(env: &Env, sml: &ModStore, p: &Stage1, prep: &Prep, go: &mut HashMap<String, f64>, flags: AilmentFlags, hands: Option<(&HashMap<String, f64>, &HashMap<String, f64>)>) {
    let cfg = p.cfg;
    let show_average = prep.show_average;
    let dps_multiplier = prep.dps_multiplier;
    let quantity_multiplier = prep.quantity_multiplier;
    let hit_chance = go.get("HitChance").copied().unwrap_or(0.0);
    let hit_speed_or_speed = go.get("HitSpeed").copied().or(go.get("Speed").copied()).unwrap_or(0.0);
    let average_damage = go.get("AverageDamage").copied().unwrap_or(0.0);
    let total_dps = go.get("TotalDPS").copied().unwrap_or(0.0);
    let cull_mult = go.get("CullMultiplier").copied().unwrap_or(1.0);
    let _ = env;

    let base_dps = if show_average { average_damage } else { total_dps };
    let mut combined_dps = base_dps;
    let mut combined_avg = base_dps;
    if flags.flag_dot {
        go.insert("WithDotDPS".into(), base_dps + go.get("TotalDot").copied().unwrap_or(0.0));
    }
    if quantity_multiplier > 1.0 {
        if let Some(v) = go.get("TotalPoisonDPS").copied() {
            go.insert("TotalPoisonDPS".into(), (v * quantity_multiplier).min(pom_offence::data::misc("DotDpsCap")));
        }
    }
    if show_average {
        combined_avg += go.get("TotalPoisonAverageDamage").copied().unwrap_or(0.0);
        go.insert("WithPoisonDPS".into(), base_dps + go.get("TotalPoisonAverageDamage").copied().unwrap_or(0.0));
    } else {
        go.insert("WithPoisonDPS".into(), base_dps + go.get("TotalPoisonDPS").copied().unwrap_or(0.0));
    }
    if flags.flag_ignite {
        let ignite_can_stack = sml.flag(Some(cfg), &[pom_engine::sym!("IgniteCanStack")]);
        if ignite_can_stack {
            if show_average {
                combined_avg = combined_dps + go.get("IgniteDamage").copied().unwrap_or(0.0);
            } else {
                go.insert("WithIgniteDPS".into(), base_dps + go.get("TotalIgniteDPS").copied().unwrap_or(0.0));
            }
        } else if show_average {
            go.insert("WithIgniteDPS".into(), base_dps + go.get("IgniteDamage").copied().unwrap_or(0.0));
            combined_avg += go.get("IgniteDamage").copied().unwrap_or(0.0);
        } else {
            go.insert("WithIgniteDPS".into(), base_dps + go.get("IgniteDPS").copied().unwrap_or(0.0));
        }
    } else {
        go.insert("WithIgniteDPS".into(), base_dps);
    }
    if p.main.skill_flags.contains("monsterExplode") {
        let monster_life = match p.skill_data.get("corpseLife") {
            Some(ScalarValue::Num(v)) => *v,
            _ => if env.enemy_level > 0.0 { pom_offence::data::monster_life_table(env.enemy_level as i64) } else { 100.0 },
        };
        go.insert("CombinedAvgToMonsterLife".into(), combined_avg / monster_life * 100.0);
    }
    if flags.flag_bleed {
        if show_average {
            go.insert("WithBleedDPS".into(), base_dps + go.get("BleedDamage").copied().unwrap_or(0.0));
            combined_avg += go.get("BleedDamage").copied().unwrap_or(0.0);
        } else {
            go.insert("WithBleedDPS".into(), base_dps + go.get("BleedDPS").copied().unwrap_or(0.0));
        }
    } else {
        go.insert("WithBleedDPS".into(), base_dps);
    }
    if flags.flag_impale {
        let imp_dur = go.get("ImpaleDuration").copied().unwrap_or(0.0);
        let double_hits = truthy(p.skill_data, "doubleHitsWhenDualWielding");
        let both = p.main.skill_flags.contains("bothWeaponAttack");
        let mut impale_dps = if let (true, true, true, Some((mh, oh))) = (p.main.skill_flags.contains("attack"), double_hits, both, hands) {
            let one = |h: &HashMap<String, f64>| h.get("impaleStoredHitAvg").copied().unwrap_or(0.0) * (h.get("ImpaleModifier").copied().unwrap_or(1.0) - 1.0) * h.get("HitChance").copied().unwrap_or(0.0) / 100.0 * dps_multiplier;
            one(mh) + one(oh)
        } else {
            go.get("impaleStoredHitAvg").copied().unwrap_or(0.0) * (go.get("ImpaleModifier").copied().unwrap_or(1.0) - 1.0) * hit_chance / 100.0 * dps_multiplier
        };
        if imp_dur <= 0.0 {
            impale_dps = 0.0;
        }
        if show_average {
            go.insert("WithImpaleDPS".into(), average_damage + impale_dps);
            combined_avg += impale_dps;
        } else {
            impale_dps *= hit_speed_or_speed;
            go.insert("WithImpaleDPS".into(), total_dps + impale_dps);
        }
        if quantity_multiplier > 1.0 {
            impale_dps *= quantity_multiplier;
        }
        go.insert("ImpaleDPS".into(), impale_dps);
        combined_dps += impale_dps;
        if pom_offence::bd::on() {
            // CalcOffence.lua:6176-6210 (the actor's own table, after the pass loop)
            use pom_offence::bd::{ins_s, set};
            use pom_offence::sf;
            pom_offence::bd::set_pass(None);
            let mut t = serde_json::Value::Array(vec![]);
            let g = |h: &HashMap<String, f64>, k: &str| h.get(k).copied();
            if let (true, true, true, Some((mh, oh))) = (p.main.skill_flags.contains("attack"), double_hits, both, hands) {
                let one = |h: &HashMap<String, f64>| g(h, "impaleStoredHitAvg").unwrap_or(0.0) * (g(h, "ImpaleModifier").unwrap_or(1.0) - 1.0) * g(h, "HitChance").unwrap_or(0.0) / 100.0 * dps_multiplier;
                ins_s(&mut t, "Main Hand:");
                ins_s(&mut t, sf!("%.2f ^8(MH average physical hit before mitigation)", g(mh, "impaleStoredHitAvg").unwrap_or(0.0)));
                ins_s(&mut t, sf!("x %.2f ^8(MH chance to hit)", g(mh, "HitChance").unwrap_or(0.0) / 100.0));
                ins_s(&mut t, sf!("x %.2f ^8(MH impale damage multiplier)
", g(mh, "ImpaleModifier").unwrap_or(1.0) - 1.0));
                ins_s(&mut t, sf!("= %.2f", one(mh)));
                ins_s(&mut t, "Off Hand:");
                ins_s(&mut t, sf!("%.2f ^8(OH average physical hit before mitigation)", g(oh, "impaleStoredHitAvg").unwrap_or(0.0)));
                ins_s(&mut t, sf!("x %.2f ^8(OH chance to hit)", g(oh, "HitChance").unwrap_or(0.0) / 100.0));
                ins_s(&mut t, sf!("x %.2f ^8(OH impale damage multiplier)", g(oh, "ImpaleModifier").unwrap_or(1.0) - 1.0));
                ins_s(&mut t, sf!("= %.2f", one(oh)));
                ins_s(&mut t, "Combined total:");
                ins_s(&mut t, sf!("%.2f + %.2f", one(mh), one(oh)));
            } else {
                ins_s(&mut t, sf!("%.2f ^8(average physical hit before mitigation)", go.get("impaleStoredHitAvg").copied().unwrap_or(0.0)));
                ins_s(&mut t, sf!("x %.2f ^8(chance to hit)", hit_chance / 100.0));
                ins_s(&mut t, sf!("x %.2f ^8(impale damage multiplier)", go.get("ImpaleModifier").copied().unwrap_or(1.0) - 1.0));
            }
            if !show_average {
                match go.get("HitSpeed").copied() {
                    Some(hs) => ins_s(&mut t, sf!("x %.2f ^8(hit rate)", hs)),
                    None => ins_s(&mut t, sf!("x %.2f ^8(%s rate)", go.get("Speed").copied().unwrap_or(0.0), if p.main.skill_flags.contains("attack") { "attack" } else { "cast" })),
                }
            }
            if dps_multiplier != 1.0 {
                ins_s(&mut t, sf!("x %g ^8(dps multiplier for this skill)", dps_multiplier));
            }
            if quantity_multiplier > 1.0 {
                ins_s(&mut t, sf!("x %g ^8(quantity multiplier for this skill)", quantity_multiplier));
            }
            if imp_dur <= 0.0 {
                ins_s(&mut t, "x 0 ^8(no Impale Duration)");
            }
            ins_s(&mut t, sf!("= %.1f", impale_dps));
            pom_offence::bd::cur(|b| set(b, "ImpaleDPS", t));
        }
    }
    let dot_dps_cap = pom_offence::data::misc("DotDpsCap");
    // CalcOffence.lua:6212-6248: `activeSkill.mirage.output` rolled into CombinedDPS / MirageDPS.
    let mut best_cull_mirage = 1.0f64;
    let in_mirage_run = crate::offence::MIRAGE_RUN.with(|m| m.borrow().is_some());
    if !in_mirage_run {
        crate::offence::MIRAGE_RESULT.with(|m| {
            let m = m.borrow();
            let Some(r) = m.as_ref() else { return };
            let Some(total) = r.output.get("TotalDPS").copied() else { return };
            let mo = &r.output;
            let count = r.count;
            let mut mirage_dps = total * count;
            combined_dps += total * count;
            if let Some(v) = mo.get("BurningGroundDPS") { go.insert("MirageBurningGroundDPS".into(), *v); }
            if let Some(v) = mo.get("CausticGroundDPS") { go.insert("MirageCausticGroundDPS".into(), *v); }
            if let Some(v) = mo.get("IgniteDPS").copied().filter(|v| *v > go.get("IgniteDPS").copied().unwrap_or(0.0)) {
                mirage_dps += v;
                go.insert("IgniteDPS".into(), 0.0);
            }
            if let Some(v) = mo.get("BleedDPS").copied().filter(|v| *v > go.get("BleedDPS").copied().unwrap_or(0.0)) {
                mirage_dps += v;
                go.insert("BleedDPS".into(), 0.0);
            }
            if let Some(v) = mo.get("PoisonDPS") { mirage_dps += v * count; combined_dps += v * count; }
            if let Some(v) = mo.get("ImpaleDPS") { mirage_dps += v * count; combined_dps += v * count; }
            if let Some(v) = mo.get("DecayDPS") { mirage_dps += v; combined_dps += v; }
            if let Some(v) = mo.get("TotalDot") {
                let can_stack = sml.flag(None, &[pom_engine::sym!("DotCanStack")]);
                if can_stack || go.get("TotalDot").copied().unwrap_or(0.0) == 0.0 {
                    let mult = if can_stack { count } else { 1.0 };
                    mirage_dps += v * mult;
                    combined_dps += v * mult;
                }
            }
            if mo.get("CullMultiplier").copied().unwrap_or(0.0) > 1.0 {
                best_cull_mirage = mo["CullMultiplier"];
            }
            go.insert("MirageDPS".into(), mirage_dps);
        });
    }
    let g = |k: &str| go.get(k).copied();
    let tdd_raw = g("TotalDot").unwrap_or(0.0)
        + g("TotalPoisonDPS").unwrap_or(0.0)
        + g("CausticGroundDPS").unwrap_or(0.0).max(g("MirageCausticGroundDPS").unwrap_or(0.0))
        + g("TotalIgniteDPS").or(g("IgniteDPS")).unwrap_or(0.0)
        + g("BurningGroundDPS").unwrap_or(0.0).max(g("MirageBurningGroundDPS").unwrap_or(0.0))
        + g("BleedDPS").unwrap_or(0.0)
        + g("CorruptingBloodDPS").unwrap_or(0.0)
        + g("DecayDPS").unwrap_or(0.0);
    let tdd = tdd_raw.min(dot_dps_cap);
    go.insert("TotalDotDPS".into(), tdd);
    if tdd != tdd_raw {
        go.insert("showTotalDotDPS".into(), 1.0);
    }
    if !show_average {
        combined_dps += tdd;
    }
    let best_cull = best_cull_mirage.max(cull_mult);
    let reservation_mult = go.get("ReservationDpsMultiplier").copied().unwrap_or(1.0);
    go.insert("CombinedAvg".into(), combined_avg);
    go.insert("CullingDPS".into(), combined_dps * (best_cull - 1.0));
    go.insert("ReservationDPS".into(), combined_dps * (reservation_mult - 1.0));
    go.insert("CombinedDPS".into(), combined_dps * best_cull * reservation_mult);
}

/// `skillData.showAverage` after every in-place mutation earlier in the same `calcs.offence` call
/// (CalcOffence.lua:1252-1256, 2291-2295, 2429-2433, 2831-2834), replayed from queryable inputs.
pub(crate) fn show_average(sml: &ModStore, p: &Stage1, oa: &HashMap<String, f64>, sd: &HashMap<String, ScalarValue>) -> bool {
    show_average_for(sml, p, oa, sd, false)
}

/// `skillFlags.showAverage` (the Calcs tab's flag): the trigger-rate speed branch clears only `skillData.showAverage`
/// (CalcOffence.lua:2295), not the flag, so `for_flag` leaves that branch out.
pub(crate) fn show_average_for(sml: &ModStore, p: &Stage1, oa: &HashMap<String, f64>, sd: &HashMap<String, ScalarValue>, for_flag: bool) -> bool {
    let flags = &p.main.skill_flags;
    let mut sa = truthy(sd, "showAverage");
    let no_trap_mine_cooldown = !(truthy(sd, "trapCooldown") || truthy(sd, "cooldown"));
    if (flags.contains("trap") || flags.contains("mine")) && no_trap_mine_cooldown {
        sa = false;
    }
    let entered_zero = p.grant_cast_time == 0.0 && num(sd, "castTimeOverride").is_none() && !truthy(sd, "triggered");
    let entered_time_override = num(sd, "timeOverride").is_some();
    let entered_fixed = truthy(sd, "fixedCastTime");
    let entered_trigger_time = num(sd, "triggerTime").is_some() && truthy(sd, "triggered");
    let entered_trigger_rate = num(sd, "triggerRate").is_some() && truthy(sd, "triggered");
    if !entered_zero && !entered_time_override && !entered_fixed {
        if entered_trigger_time {
        } else if entered_trigger_rate {
            if !for_flag {
                sa = false;
            }
        } else if oa.contains_key("Cooldown") && flags.contains("selfCast") {
            sa = false;
        }
    }
    if sml.flag(None, &[pom_engine::sym!("Condition:WarcryMaxHit")]) {
        sa = true;
    }
    sa
}

/// One row of `fullDPS.skills` (`player.output.SkillDPS`). `trigger` is never produced: `calcs.triggers`
/// (which sets `activeSkill.infoTrigger`) is not ported.
#[derive(Clone, Debug)]
pub struct SkillDpsRow {
    pub name: String,
    pub dps: f64,
    pub count: f64,
    pub skill_part: Option<String>,
    pub source: Option<String>,
    /// `activeSkill.infoTrigger` (`calcs.triggers`).
    pub trigger: Option<String>,
}

/// `calcs.buildOutput`'s FullDPS roll-up (Calcs.lua:385-397, `calcs.calcFullDPS` 142-353).
///
/// With no socket group of the active skill set marked `includeInFullDPS` the loop never runs and
/// `fullDPS` keeps its initial zeros / empty `skills`. With included groups, each included skill is
/// run through `calcs.offence` as the main skill (here: `compute_offence_for` on the state before the
/// main offence run, not a full `calcs.perform` per skill).
/// Skills with a minion/mirage part are not modelled: the keys are then left unproduced.
thread_local! {
    /// While set, `select_main_skill` returns `active_skills[i]`: a whole-pipeline re-run with another main skill (the FullDPS minion rows).
    pub(crate) static PART_OVERRIDE: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
    pub(crate) static MAIN_OVERRIDE: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

thread_local! {
    pub(crate) static FD_ENEMY_MULTS_WIPED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

thread_local! {
    /// Set by a caller that wants the main skill's stats first (a tree click): `full_dps` does nothing, and
    /// the FullDPS stats are filled by a second, complete run.
    pub static SKIP_FULL_DPS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub(crate) fn full_dps(env: &mut Env) {
    if SKIP_FULL_DPS.with(|c| c.get()) {
        return;
    }
    FD_ENEMY_MULTS_WIPED.with(|c| c.set(false));
    if MAIN_OVERRIDE.with(|c| c.get()).is_some() {
        return;
    }
    let xml_text = env.xml_text.clone();
    // Only `<Skills>` is read, so only it is parsed (setup has already parsed the whole document once).
    let Some(skills_text) = pom_skills::xmlskills::xml_section(&xml_text, "Skills") else {
        set_full_dps_zero(env);
        return;
    };
    let Ok(doc) = roxmltree::Document::parse(skills_text) else { return };
    let skills_el = doc.root_element();
    let sets: Vec<_> = skills_el.children().filter(|c| c.is_element() && c.tag_name().name() == "SkillSet").collect();
    let container = if sets.is_empty() {
        skills_el
    } else {
        let active_id = skills_el.attribute("activeSkillSet").and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
        match sets.iter().find(|s| s.attribute("id").and_then(|s| s.parse::<i64>().ok()) == Some(active_id)).or_else(|| sets.first()) {
            Some(c) => *c,
            None => {
                set_full_dps_zero(env);
                return;
            }
        }
    };
    let group_els: Vec<_> = container.children().filter(|c| c.is_element() && c.tag_name().name() == "Skill").collect();
    let included: Vec<bool> = group_els.iter().map(|c| c.attribute("includeInFullDPS") == Some("true")).collect();
    if !included.iter().any(|b| *b) {
        set_full_dps_zero(env);
        return;
    }
    let Ok(groups) = pom_skills::xmlskills::socket_groups_shared(&xml_text) else { return };
    if groups.len() != group_els.len() {
        return;
    }
    let cap = pom_offence::data::misc("DotDpsCap");

    // Candidates in `activeSkillList` order: (skill index, group index, gem index).
    let skills = std::mem::take(&mut env.active_skills);
    let mut cands: Vec<(usize, usize, usize)> = Vec::new();
    for (si, sk) in skills.iter().enumerate() {
        'g: for (gi, g) in groups.iter().enumerate() {
            // `activeSkill.socketGroup` is the group the skill was built from.
            if let Some(xi) = sk.group_xml_index {
                if xi != gi {
                    continue;
                }
            } else if sk.group_source.as_deref().is_some_and(|s| s.starts_with("Item:")) {
                // An item-granted skill is built from the saved `source="Item:..."` group (CalcSetup.lua:1466-1490).
                if sk.group_source != g.source || sk.group_slot != g.slot {
                    continue;
                }
            } else {
                let slot = if let Some(s) = &g.slot { Some(s.replace(" Swap", "")) } else if g.source.as_ref().is_some_and(|s| s.to_lowercase().contains("tree")) { Some("Passive Tree".to_string()) } else { None };
                if sk.slot_name != slot {
                    continue;
                }
            }
            if !included[gi] {
                continue;
            }
            // `getActiveSkillCount` (Calcs.lua:116-138): the first gem of the group whose primary (or, for a
            // non-Vaal gem, secondary) effect is this skill supplies the count.
            for (ji, gem) in g.gem_list.iter().enumerate() {
                let primary = gem.gem_data.and_then(pom_skills::data::gem_primary_effect).and_then(|ge| ge.id.clone());
                let secondary = gem.gem_data.and_then(pom_skills::data::gem_secondary_effect).and_then(|ge| ge.id.clone());
                let item_granted = gem.granted_effect.and_then(|ge| ge.id.clone());
                let is_id = |o: &Option<String>| o.as_deref() == Some(sk.granted_effect_id.as_str());
                let vaal = gem.gem_data.is_some_and(|gd| gd.vaal_gem);
                let hit = if vaal {
                    if is_id(&primary) {
                        Some(gem.enable_global[0])
                    } else if is_id(&secondary) {
                        Some(gem.enable_global[1])
                    } else {
                        None
                    }
                } else if is_id(&primary) || is_id(&secondary) || is_id(&item_granted) {
                    Some(true)
                } else {
                    None
                };
                if let Some(enabled) = hit {
                    if enabled {
                        cands.push((si, gi, ji));
                    }
                    break 'g;
                }
            }
        }
    }
    let main_output = env.output.clone();
    let baseline = env.stage_snapshots.iter().find(|(n, _)| *n == "defence_estimations").map(|(_, m)| m.clone()).unwrap_or_else(|| main_output.clone());

    #[derive(Default)]
    struct Fd {
        combined: f64,
        total_dot_dps: f64,
        total_poison: f64,
        caustic: f64,
        impale: f64,
        ignite: f64,
        burning: f64,
        bleed: f64,
        corrupting: f64,
        decay: f64,
        dot: f64,
        culling_multi: f64,
    }
    let mut fd = Fd::default();
    let mut rows: Vec<SkillDpsRow> = Vec::new();
    let parent_level = std::sync::Arc::new(env.parent_level_mods.clone());
    let (mut bleed_src, mut corrupting_src, mut ignite_src, mut burning_src, mut caustic_src) = (String::new(), String::new(), String::new(), String::new(), String::new());
    let mut fd_row_no = 0usize;
    for (si, gi, ji) in cands {
        // calcFullDPS re-runs `initEnv` with `accelerate.skills` after every performed skill (Calcs.lua:295-301): the
        // env's enemy multipliers are wiped and createActiveSkill (the only setter of `ActiveMineCount`) is skipped, so
        // only the first performed row still sees the mines' enemy-side multiplier.
        FD_ENEMY_MULTS_WIPED.with(|c| c.set(fd_row_no > 0));
        fd_row_no += 1;
        let sk = &skills[si];
        let gem = &groups[gi].gem_list[ji];
        let group_count = group_els[gi].attribute("groupCount").and_then(|s| s.parse::<f64>().ok());
        let count = group_count.unwrap_or(gem.count as f64);
        let part = sk.gem_index.and_then(|i| groups[gi].gem_list.get(i)).and_then(|g| g.skill_part).unwrap_or(1).max(1);
        let mut minion_run: Option<(String, String, HashMap<String, f64>)> = None;
        let mut row_trigger: Option<String> = None;
        let has_minion = pom_engine::env::var("POM_FD_OLD").is_err() || crate::minion::select(env, sk).is_some_and(|(ty, _, _)| !pom_calc::data::minion_data(&ty).hostile);
        let o: HashMap<String, f64> = if has_minion {
            // `calcs.perform` with this skill as the main skill: re-run the whole pipeline on a fresh env.
            let mut e2 = match &env.pristine {
                Some(p) => (**p).clone(),
                None => match crate::build_env(&xml_text, env.game) { Ok(e) => e, Err(_) => continue },
            };
            MAIN_OVERRIDE.with(|c| c.set(Some(si)));
            PART_OVERRIDE.with(|c| c.set(Some(part)));
            crate::buffs::FULLDPS_PARENT.with(|p| *p.borrow_mut() = Some((&e2.player as *const _ as usize, parent_level.clone())));
            let stale = crate::offence::MIRAGE_ARCHER_SEEN.with(|m| m.borrow().iter().any(|(g, a, b)| *g == sk.granted_effect_id && *a == sk.group_xml_index && *b == sk.gem_index));
            pom_triggers::SELF_CACHE_STALE.with(|c| c.set(stale));
            crate::run(&mut e2);
            pom_triggers::SELF_CACHE_STALE.with(|c| c.set(false));
            crate::buffs::FULLDPS_PARENT.with(|p| *p.borrow_mut() = None);
            MAIN_OVERRIDE.with(|c| c.set(None));
            PART_OVERRIDE.with(|c| c.set(None));
            minion_run = e2.minion_info.take();
            row_trigger = e2.trigger_apply.as_ref().and_then(|a| a.result.info_trigger.clone());
            e2.output
        } else {
            env.output = baseline.clone();
            env.trigger_apply = crate::triggers_wire::run_for(env, &xml_text, &skills, si);
            env.output = baseline.clone();
            crate::buffs::FULLDPS_PARENT.with(|p| *p.borrow_mut() = Some((&env.player as *const _ as usize, parent_level.clone())));
            let bd_was = pom_offence::bd::set_active(false);
            crate::offence::compute_offence_for(env, &xml_text, sk, &skills, part);
            pom_offence::bd::set_active(bd_was);
            crate::buffs::FULLDPS_PARENT.with(|p| *p.borrow_mut() = None);
            // Undo the one persistent side effect of an attack pass on the shared player modDB.
            if let pom_engine::modstore::store::Backing::List(v) = &mut env.player.backing {
                pom_engine::modstore::store::retain_mods(v, |m| !(m.name.as_str() == "Condition:OneSecondAttackTime" && m.source.is_none()));
            }
            row_trigger = env.trigger_apply.as_ref().and_then(|a| a.result.info_trigger.clone());
            env.output.clone()
        };
        let o = &o;
        let g = |k: &str| o.get(k).copied();
        // `activeSkill.activeEffect.grantedEffect.name` (`sk.name` has the "Vaal " prefix stripped, it is the skillCfg name).
        let name = pom_skills::data::all_skills().get(&sk.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| sk.name.clone());
        // CalcPerform.lua:1484-1488: The Saviour's Reflection carries `infoTrigger = "Saviour"`.
        if row_trigger.is_none() && (name == "Reflection" || truthy(&crate::offence::skill_data_map(&env.player, sk), "triggeredBySaviour")) {
            row_trigger = Some("Saviour".to_string());
        }
        let skill_part = pom_skills::data::all_skills().get(&sk.granted_effect_id).and_then(pom_skills::data::parts).filter(|p| p.len() > 1).and_then(|p| p.get((part as usize).min(p.len()) - 1)).and_then(|v| v.get("name")).and_then(|v| v.as_str()).map(|s| s.to_string());
        let mut count = count;
        let mut info_message2: Option<&str> = None;
        let minion_named = minion_run.is_some();
        if let Some((mname, mpart, mo)) = &minion_run {
            let mg = |k: &str| mo.get(k).copied();
            if let Some(dps) = mg("TotalDPS").filter(|d| *d > 0.0) {
                rows.push(SkillDpsRow { name: name.clone(), dps, count, skill_part: Some(format!("{mname}: {mpart}")), source: None, trigger: row_trigger.clone() });
                fd.combined += dps * count;
            }
            if let Some(v) = mg("BleedDPS").filter(|v| *v > fd.bleed) {
                fd.bleed = v;
                bleed_src = name.clone();
            }
            if let Some(v) = mg("IgniteDPS").filter(|v| *v > fd.ignite) {
                fd.ignite = v;
                ignite_src = name.clone();
            }
            if mg("PoisonDPS").is_some_and(|v| v > 0.0) {
                fd.total_poison += mg("TotalPoisonDPS").unwrap_or(0.0) * count;
            }
            if let Some(v) = mg("ImpaleDPS").filter(|v| *v > 0.0) {
                fd.impale += v * count;
            }
            if let Some(v) = mg("DecayDPS").filter(|v| *v > 0.0) {
                fd.decay += v;
            }
            if let Some(v) = mg("TotalDot").filter(|v| *v > 0.0) {
                fd.dot += v;
            }
            if let Some(v) = mg("CullMultiplier").filter(|v| *v > 1.0 && *v > fd.culling_multi) {
                fd.culling_multi = v;
            }
            let once = |flag: &str| env.player.flag(None, &[s(flag)]);
            if (name.contains("Absolution") && once("Condition:AbsolutionSkillDamageCountedOnce"))
                || (name.contains("Dominating Blow") && once("Condition:DominatingBlowSkillDamageCountedOnce"))
                || (name.contains("Holy Strike") && once("Condition:HolyStrikeSkillDamageCountedOnce"))
            {
                count = 1.0;
                info_message2 = Some("Skill Damage");
            }
        }
        // Calcs.lua:214-250: the `(Mirage)` row and its roll-ups, inserted before the main skill's own row.
        let mirage_res = crate::offence::MIRAGE_RESULT.with(|m| m.borrow_mut().take());
        if let Some(mr) = mirage_res {
            let mo = &mr.output;
            let mg = |k: &str| mo.get(k).copied();
            let mirage_count = mr.count * count;
            let mname = format!("{} (Mirage)", name);
            if let Some(dps) = mg("TotalDPS").filter(|d| *d > 0.0) {
                rows.push(SkillDpsRow { name: format!("{} (Mirage)", mr.name), dps, count: mirage_count, skill_part: mr.skill_part.clone(), source: None, trigger: None });
                fd.combined += dps * mirage_count;
            }
            if let Some(v) = mg("BleedDPS").filter(|v| *v > fd.bleed) {
                fd.bleed = v;
                bleed_src = mname.clone();
            }
            if let Some(v) = mg("IgniteDPS").filter(|v| *v > fd.ignite) {
                fd.ignite = v;
                ignite_src = mname.clone();
            }
            if mg("PoisonDPS").is_some_and(|v| v > 0.0) {
                fd.total_poison += mg("TotalPoisonDPS").unwrap_or(0.0) * mirage_count;
            }
            if let Some(v) = mg("ImpaleDPS").filter(|v| *v > 0.0) {
                fd.impale += v * mirage_count;
            }
            if let Some(v) = mg("DecayDPS").filter(|v| *v > 0.0) {
                fd.decay += v;
            }
            let can_stack = sk.skill_mod_list.iter().any(|m| m.name.as_str() == "DotCanStack" && m.ty == ModType::Flag);
            if let Some(v) = mg("TotalDot").filter(|v| *v > 0.0) {
                if can_stack || o.get("TotalDot").copied().unwrap_or(0.0) == 0.0 {
                    fd.dot += v * if can_stack { mirage_count } else { 1.0 };
                }
            }
            if let Some(v) = mg("CullMultiplier").filter(|v| *v > 1.0 && *v > fd.culling_multi) {
                fd.culling_multi = v;
            }
            if let Some(v) = mg("BurningGroundDPS").filter(|v| *v > fd.burning) {
                fd.burning = v;
                burning_src = mname.clone();
            }
            if let Some(v) = mg("CausticGroundDPS").filter(|v| *v > fd.caustic) {
                fd.caustic = v;
                caustic_src = mname.clone();
            }
        }
        // `minionName and activeSkill.infoMessage2 or activeSkill.skillPartName`: a nil infoMessage2 falls through.
        // (`activeSkill.skillPartName` of a skill with a minion is the minion's main skill name, CalcPerform.lua:1301.)
        let skill_part = if let Some((_, mpart, mo)) = &minion_run {
            let named = mo.get("TotalDPS").is_some_and(|d| *d > 0.0);
            if named { info_message2.map(|s| s.to_string()).or(Some(mpart.clone())) } else { Some(mpart.clone()) }
        } else {
            skill_part
        };
        if let Some(dps) = g("TotalDPS").filter(|d| *d > 0.0) {
            rows.push(SkillDpsRow { name: name.clone(), dps, count, skill_part, source: None, trigger: row_trigger.clone() });
            fd.combined += dps * count;
        }
        if let Some(v) = g("BleedDPS").filter(|v| *v > fd.bleed) {
            fd.bleed = v;
            bleed_src = name.clone();
        }
        if let Some(v) = g("CorruptingBloodDPS").filter(|v| *v > fd.corrupting) {
            fd.corrupting = v;
            corrupting_src = name.clone();
        }
        if let Some(v) = g("IgniteDPS").filter(|v| *v > fd.ignite) {
            fd.ignite = v;
            ignite_src = name.clone();
        }
        if let Some(v) = g("BurningGroundDPS").filter(|v| *v > fd.burning) {
            fd.burning = v;
            burning_src = name.clone();
        }
        if g("PoisonDPS").is_some_and(|v| v > 0.0) {
            fd.total_poison += g("TotalPoisonDPS").unwrap_or(0.0) * count;
        }
        if let Some(v) = g("CausticGroundDPS").filter(|v| *v > fd.caustic) {
            fd.caustic = v;
            caustic_src = name.clone();
        }
        if let Some(v) = g("ImpaleDPS").filter(|v| *v > 0.0) {
            fd.impale += v * count;
        }
        if let Some(v) = g("DecayDPS").filter(|v| *v > 0.0) {
            fd.decay += v;
        }
        if let Some(v) = g("TotalDot").filter(|v| *v > 0.0) {
            // `activeSkill.skillFlags.DotCanStack` is set by the DoT section when the skill's mod list
            // carries the `DotCanStack` flag (CalcOffence.lua:5857-5860).
            let can_stack = sk.skill_mod_list.iter().any(|m| m.name.as_str() == "DotCanStack" && m.ty == ModType::Flag);
            fd.dot += v * if can_stack { count } else { 1.0 };
        }
        if let Some(v) = g("CullMultiplier").filter(|v| *v > 1.0 && *v > fd.culling_multi) {
            fd.culling_multi = v;
        }
    }
    env.output = main_output;
    env.trigger_apply = None;
    env.active_skills = skills;

    let mut push = |rows: &mut Vec<SkillDpsRow>, name: &str, dps: f64, source: Option<&str>| rows.push(SkillDpsRow { name: name.to_string(), dps, count: 1.0, skill_part: None, source: source.map(|s| s.to_string()), trigger: None });
    if fd.bleed > 0.0 {
        push(&mut rows, "Best Bleed DPS", fd.bleed, Some(&bleed_src));
        fd.total_dot_dps += fd.bleed;
    }
    if fd.corrupting > 0.0 {
        push(&mut rows, "Corrupting Blood DPS", fd.corrupting, Some(&corrupting_src));
        fd.total_dot_dps += fd.corrupting;
    }
    if fd.ignite > 0.0 {
        push(&mut rows, "Best Ignite DPS", fd.ignite, Some(&ignite_src));
        fd.total_dot_dps += fd.ignite;
    }
    if fd.burning > 0.0 {
        push(&mut rows, "Best Burning Ground DPS", fd.burning, Some(&burning_src));
        fd.total_dot_dps += fd.burning;
    }
    if fd.total_poison > 0.0 {
        fd.total_poison = fd.total_poison.min(cap);
        push(&mut rows, "Full Poison DPS", fd.total_poison, None);
        fd.total_dot_dps += fd.total_poison;
    }
    if fd.caustic > 0.0 {
        push(&mut rows, "Best Caustic Ground DPS", fd.caustic, Some(&caustic_src));
        fd.total_dot_dps += fd.caustic;
    }
    if fd.impale > 0.0 {
        push(&mut rows, "Full Impale DPS", fd.impale, None);
        fd.combined += fd.impale;
    }
    if fd.decay > 0.0 {
        push(&mut rows, "Full Decay DPS", fd.decay, None);
        fd.total_dot_dps += fd.decay;
    }
    if fd.dot > 0.0 {
        push(&mut rows, "Full DoT DPS", fd.dot, None);
        fd.total_dot_dps += fd.dot;
    }
    fd.total_dot_dps = fd.total_dot_dps.min(cap);
    fd.combined += fd.total_dot_dps;
    if fd.culling_multi > 0.0 {
        let culling = fd.combined * (fd.culling_multi - 1.0);
        push(&mut rows, "Full Culling DPS", culling, None);
        fd.combined += culling;
    }
    // Build.lua:1934 sorts the shared `SkillDPS` table in place before the recorder reads it:
    // `table.sort(SkillDPS, function(a, b) return (a.dps * a.count) > (b.dps * b.count) end)`.
    // LuaJIT's sort is unstable: rows with equal dps*count keep the quicksort's order, not insertion order.
    crate::lua_sort::lua_table_sort(&mut rows, &|a, b| (a.dps * a.count) > (b.dps * b.count));
    env.output.insert("FullDPS".into(), fd.combined);
    env.output.insert("FullDotDPS".into(), fd.total_dot_dps);
    env.output.insert("SkillDPS".into(), 0.0);
    env.skill_dps = rows;
}

fn set_full_dps_zero(env: &mut Env) {
    env.output.insert("FullDPS".into(), 0.0);
    env.output.insert("FullDotDPS".into(), 0.0);
    env.output.insert("SkillDPS".into(), 0.0); // emitted as `{}` (see `EMPTY_TABLE_KEYS`)
}

// ---- Attack hand combining (`combineStat`, CalcOffence.lua:2130-2170)

#[derive(Clone, Copy)]
pub(crate) enum CombineMode {
    Or,
    Average,
    HarmonicMean,
    Dps,
    /// `CHANCE`, weighted by `<hand>[chanceStat] * <hand>.HitChance`.
    Chance(&'static str),
    /// `CHANCE_AILMENT` (same weighting keys as `Chance`, then the stack-based max/min blend).
    ChanceAilment(&'static str),
}

pub(crate) struct Hands<'a> {
    pub mh: Option<&'a HashMap<String, f64>>,
    pub oh: Option<&'a HashMap<String, f64>>,
    pub both: bool,
    pub double_hits: bool,
}

pub(crate) fn combine_stat(go: &mut HashMap<String, f64>, h: &Hands, stat: &str, mode: CombineMode) {
    let m = h.mh.and_then(|m| m.get(stat)).copied();
    let o = h.oh.and_then(|m| m.get(stat)).copied();
    let mut set = |v: Option<f64>| {
        if let Some(v) = v {
            go.insert(stat.to_string(), v);
        }
    };
    if matches!(mode, CombineMode::Or) || !h.both {
        set(m.or(o));
        return;
    }
    match mode {
        CombineMode::Or => unreachable!(),
        CombineMode::Average => set(Some((m.unwrap_or(0.0) + o.unwrap_or(0.0)) / 2.0)),
        CombineMode::HarmonicMean => {
            let (mv, ov) = (m.unwrap_or(f64::NAN), o.unwrap_or(f64::NAN));
            set(Some(if mv == 0.0 || ov == 0.0 { 0.0 } else { 2.0 / (1.0 / mv + 1.0 / ov) }));
        }
        CombineMode::Dps => {
            let mut v = m.unwrap_or(0.0) + o.unwrap_or(0.0);
            if !h.double_hits {
                v /= 2.0;
            }
            set(Some(v));
        }
        CombineMode::Chance(chance_stat) => {
            if let (Some(mv), Some(ov)) = (m, o) {
                let mc = h.mh.unwrap().get(chance_stat).copied().unwrap_or(0.0) * h.mh.unwrap().get("HitChance").copied().unwrap_or(0.0);
                let oc = h.oh.unwrap().get(chance_stat).copied().unwrap_or(0.0) * h.oh.unwrap().get("HitChance").copied().unwrap_or(0.0);
                if h.double_hits {
                    set(Some(mv * (mc / 10000.0) + ov * (oc / 10000.0)));
                    if pom_offence::bd::on() {
                        pom_offence::bd_c::combine_chance(stat, true, mv, ov, mc / 10000.0, oc / 10000.0, mv * (mc / 10000.0) + ov * (oc / 10000.0));
                    }
                } else {
                    let mp = mc / (mc + oc);
                    let op = oc / (mc + oc);
                    set(Some(mv * mp + ov * op));
                    if pom_offence::bd::on() {
                        pom_offence::bd_c::combine_chance(stat, false, mv, ov, mp, op, mv * mp + ov * op);
                    }
                }
            } else {
                set(m.or(o));
            }
        }
        CombineMode::ChanceAilment(_) => unreachable!("handled by combine_ailment_stat"),
    }
}

/// `CHANCE_AILMENT` needs the actor-level `<Ailment>Stacks`/`Max` outputs.
pub(crate) fn combine_ailment_stat(go: &mut HashMap<String, f64>, h: &Hands, stat: &str) {
    let m = h.mh.and_then(|m| m.get(stat)).copied();
    let o = h.oh.and_then(|m| m.get(stat)).copied();
    if !h.both {
        if let Some(v) = m.or(o) {
            go.insert(stat.to_string(), v);
        }
        return;
    }
    if let (Some(mv), Some(ov)) = (m, o) {
        let max_instance = mv.max(ov);
        let min_instance = mv.min(ov);
        let stack_name = format!("{}Stacks", stat.replace("DPS", ""));
        let stacks = go.get(&stack_name).copied().unwrap_or(1.0);
        let stacks_max = go.get(&format!("{stack_name}Max")).copied().unwrap_or(1.0);
        let max_stacks = (stacks / stacks_max).min(1.0);
        go.insert(stat.to_string(), max_instance * max_stacks + min_instance * (1.0 - max_stacks));
        if pom_offence::bd::on() {
            pom_offence::bd_c::combine_ailment(stat, mv, ov, max_instance, min_instance, max_stacks, max_instance * max_stacks + min_instance * (1.0 - max_stacks));
        }
    } else if let Some(v) = m.or(o) {
        go.insert(stat.to_string(), v);
        if pom_offence::bd::on() {
            pom_offence::bd_c::combine_ailment_single(stat, m.is_some());
        }
    } else if pom_offence::bd::on() {
        // neither hand has the stat: upstream still writes the note (`MainHand[stat] and .. or "Off Hand"`).
        pom_offence::bd_c::combine_ailment_single(stat, false);
    }
}

/// "Combine secondary effect stats" (CalcOffence.lua:5646-5695).
pub(crate) fn combine_attack_ailment_stats(go: &mut HashMap<String, f64>, h: &Hands, show_average: bool, ignite_can_stack: bool) {
    use CombineMode::*;
    combine_stat(go, h, "BleedChance", Average);
    combine_ailment_stat(go, h, "BleedDPS");
    combine_stat(go, h, "PoisonChance", Average);
    combine_stat(go, h, "PoisonDPS", Chance("PoisonChance"));
    combine_stat(go, h, "CausticGroundDPS", Chance("PoisonChance"));
    combine_stat(go, h, "TotalPoisonDPS", Dps);
    combine_stat(go, h, "PoisonDamage", Chance("PoisonChance"));
    if show_average {
        combine_stat(go, h, "TotalPoisonAverageDamage", Dps);
    } else {
        combine_stat(go, h, "TotalPoisonStacks", Dps);
    }
    combine_stat(go, h, "IgniteChance", Average);
    combine_ailment_stat(go, h, "IgniteDPS");
    if ignite_can_stack {
        combine_stat(go, h, "IgniteDamage", Chance("IgniteChance"));
        if show_average {
            combine_stat(go, h, "TotalIgniteAverageDamage", Dps);
        }
        combine_stat(go, h, "IgniteStacksMax", Dps);
        combine_stat(go, h, "TotalIgniteDPS", Dps);
    }
    for stat in [
        "ChillEffectMod", "ChillDuration", "ShockChance", "ShockDuration", "ShockEffectMod", "FreezeChance", "FreezeDurationMod", "ScorchChance", "ScorchEffectMod", "ScorchDuration", "BrittleChance", "BrittleEffectMod",
        "BrittleDuration", "SapChance", "SapEffectMod", "SapDuration", "ImpaleChance", "ImpaleStoredDamage",
    ] {
        combine_stat(go, h, stat, Average);
    }
    combine_stat(go, h, "ImpaleModifier", Chance("ImpaleChance"));
}

