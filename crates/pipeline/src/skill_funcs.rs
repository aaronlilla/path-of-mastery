//! Ports of the per-skill runtime hooks in `Data/Skills/*.lua` that `calcs.offence` calls through
//! `runSkillFunc` (CalcOffence.lua:509-514): `preDamageFunc` (line 1908) and the few `initialFunc`/
//! `preSkillTypeFunc`. A hook may rewrite `skillData` (`dpsMultiplier`, `hitTimeOverride`, added
//! damage, ...) and add mods to `skillModList`, so a skill whose hook is *not* ported here cannot be
//! given damage/DPS keys at all (`crate::skill_hooks::has_hook` + `apply`'s `Err`).
//!
//! Hooks that read outputs this pipeline does not produce yet (`ProjectileCount`,
//! `ProjectileSpeedMod`, `TotemLife`, `AreaOfEffectRadiusTertiaryOccurrences`, ...) return `Err` for
//! the skill parts that need them; the rest of that skill's parts are ported.
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::{Cfg, ScalarValue};
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_engine::fxhash::HashMap;
use std::sync::Arc;

type Sd = HashMap<String, ScalarValue>;

pub(crate) struct HookCtx<'a> {
    pub id: &'a str,
    pub skill_part: i64,
    pub is_totem: bool,
    /// The actor's output at the time `calcs.offence` reaches the hook (CalcOffence.lua:1908).
    pub out: &'a HashMap<String, f64>,
    pub cfg: &'a Cfg,
    pub skill_types: &'a pom_engine::fxhash::HashSet<i64>,
    pub skill_flags: &'a pom_engine::fxhash::HashSet<String>,
    /// `actor.weaponData1/2` and the per-hand cfgs of an attack (`activeSkill.weapon1Cfg/weapon2Cfg`).
    pub weapon1: &'a pom_offence::weapon::WeaponSource,
    pub weapon2: &'a pom_offence::weapon::WeaponSource,
    pub weapon1_cfg: Option<Cfg>,
    pub weapon2_cfg: Option<Cfg>,
    /// `activeEffect.srcInstance.explodeSource.modSource or "Tree:"..id` (EnemyExplode only).
    pub explode_source: Option<&'a str>,
    /// `actor.enemy.modDB`.
    pub enemy: &'a ModStore,
    pub tertiary_occ: &'a [(f64, f64)],
    /// The summoning player's output while a minion's skill runs (`activeSkill.summonSkill`).
    pub parent_out: Option<&'a HashMap<String, f64>>,
}

fn n(sd: &Sd, k: &str) -> Option<f64> {
    match sd.get(k) {
        Some(ScalarValue::Num(v)) => Some(*v),
        _ => None,
    }
}
fn set(sd: &mut Sd, k: &str, v: f64) {
    sd.insert(k.to_string(), ScalarValue::Num(v));
}
fn sum(sml: &ModStore, ty: ModType, cfg: Option<&Cfg>, names: &[&str]) -> f64 {
    let s: Vec<Sym> = names.iter().map(|x| Sym::new(x)).collect();
    sml.sum(ty, cfg, &s)
}
fn more(sml: &ModStore, cfg: Option<&Cfg>, names: &[&str]) -> f64 {
    let s: Vec<Sym> = names.iter().map(|x| Sym::new(x)).collect();
    sml.more(cfg, &s)
}
fn out(c: &HookCtx, k: &str) -> f64 {
    c.out.get(k).copied().unwrap_or(0.0)
}
fn mk(name: &str, ty: ModType, value: f64, source: &str, flags: u64, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value: Value::Num(value), flags, keyword_flags: 0, source: Some(Arc::from(source)), tags: (tags).into() }
}

/// Lua `round(x)` (Common.lua) followed by `floor`.
fn calc_lib_mod_of(sml: &ModStore, cfg: Option<&Cfg>, name: &str) -> f64 {
    pom_offence::tools::calc_lib_mod(sml, cfg, &[name])
}
fn round0(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Cyclone's `initialFunc` (Data/Skills/act_dex.lua:4703, run at CalcOffence.lua:516, i.e. before `calcAreaOfEffect`):
/// melee range from the weapons -> `Multiplier:AdditionalMeleeRange`.
/// `breakdown.OverlapChance` of Molten Strike and its Zenith variant (Data/Skills/act_str.lua:7855-7863, 8034-8042).
fn molten_strike_overlap_table(enemy_radius: f64, ball_radius: f64, inner: f64, outer: f64, overlap: f64) {
    if !pom_offence::bd::on() {
        return;
    }
    use pom_offence::bd::{ins_s, set};
    use pom_offence::sf;
    let mut t = serde_json::Value::Array(vec![]);
    ins_s(&mut t, "Chance for individual balls to land on the enemy:");
    ins_s(&mut t, "^8= (area where a ball can land on enemy) / (total area)");
    ins_s(&mut t, "^8= (enemy radius + ball radius - min travel) / (max travel - min travel)");
    ins_s(&mut t, sf!("^8= (^7%d^8 + ^7%d^8 - ^7%d) / (^7%d^8 - ^7%d)", enemy_radius, ball_radius, inner, outer, inner));
    ins_s(&mut t, sf!("^8=^7 %.2f^8%%", overlap * 100.0));
    pom_offence::bd::root(|b| set(b, "OverlapChance", t));
}

/// `breakdown.SkillDPSMultiplier` of the plain balls DPS multiplier (Data/Skills/act_str.lua:7869-7876, 8052-8059).
fn molten_strike_dps_table(num_projectiles: f64, overlap: f64, dps_mult: f64) {
    if !pom_offence::bd::on() {
        return;
    }
    use pom_offence::bd::{ins_s, set};
    use pom_offence::sf;
    let mut t = serde_json::Value::Array(vec![]);
    ins_s(&mut t, "DPS multiplier");
    ins_s(&mut t, "^8= number of projectiles * overlap chance");
    ins_s(&mut t, sf!("^8=^7 %d^8 *^7 %.3f^8", num_projectiles, overlap));
    ins_s(&mut t, sf!("^8=^7 %.3f", dps_mult));
    pom_offence::bd::root(|b| set(b, "SkillDPSMultiplier", t));
}

pub(crate) fn cyclone_initial(c: &HookCtx, sml: &mut ModStore) {
    let cfg = Some(c.cfg);
    let range_of = |cfg: Option<&Cfg>, bonus: f64| sum(sml, ModType::Base, cfg, &["MeleeWeaponRange"]) + 10.0 * sum(sml, ModType::Base, cfg, &["MeleeWeaponRangeMetre"]) + bonus;
    let range = if c.skill_flags.contains("weapon1Attack") && c.weapon1.get_opt("range").is_some() {
        let w1 = range_of(c.weapon1_cfg.as_ref(), c.weapon1.get("rangeBonus"));
        if c.skill_flags.contains("weapon2Attack") && c.weapon2.get_opt("range").is_some() {
            (w1 + range_of(c.weapon2_cfg.as_ref(), c.weapon2.get("rangeBonus"))) / 2.0
        } else {
            w1
        }
    } else {
        sum(sml, ModType::Base, cfg, &["UnarmedRange"]) + 10.0 * sum(sml, ModType::Base, cfg, &["UnarmedRangeMetre"])
    };
    let source = format!("Skill:{}", c.id);
    sml.add_mod(mk("Multiplier:AdditionalMeleeRange", ModType::Base, range, &source, 0, vec![]));
}

/// Runs `id`'s `preDamageFunc` (or `initialFunc`/`preSkillTypeFunc`); `Err(())` when the hook exists
/// but cannot be reproduced faithfully with the outputs available here.
pub(crate) fn apply(c: &HookCtx, sml: &mut ModStore, sd: &mut Sd, global_out: &mut HashMap<String, f64>) -> Result<(), ()> {
    let cfg = Some(c.cfg);
    match c.id {
        // ---- hitTimeOverride / dpsMultiplier families -------------------------------------
        "BladeBlast" | "BladeBlastAltX" => {
            let base = n(sd, "dpsMultiplier").unwrap_or(1.0) * n(sd, "dpsBaseMultiplier").ok_or(())?;
            set(sd, "dpsMultiplier", base);
            if c.skill_part == 2 {
                set(sd, "hitTimeOverride", 1.0);
            }
        }
        "BladeFlurry" | "BladeFlurryAltX" => {
            if c.skill_part == 2 && n(sd, "numStages").ok_or(())? > 0.0 {
                let num_stages = n(sd, "numStages").ok_or(())?;
                let mut channel_multi = 0.0;
                let mut i = 1.0;
                while i <= num_stages {
                    channel_multi += 0.8 + 0.2 * i;
                    i += 1.0;
                }
                channel_multi /= 0.8 + 0.2 * num_stages;
                set(sd, "dpsMultiplier", channel_multi / num_stages + 1.0);
            }
        }
        "BladeVortex" => {
            let hf = n(sd, "hitFrequency").ok_or(())?;
            let per = n(sd, "hitFrequencyPerBlade").ok_or(())?;
            set(sd, "hitTimeOverride", hf / (1.0 + sum(sml, ModType::Base, cfg, &["Multiplier:BladeVortexBlade"]) * per));
        }
        "VaalBladeVortex" => {
            let hf = n(sd, "hitFrequency").ok_or(())?;
            let blades = n(sd, "VaalBladeVortexBlade").ok_or(())?;
            set(sd, "hitTimeOverride", hf / (1.0 + blades * n(sd, "hitFrequencyPerBlade").unwrap_or(0.0)));
        }
        "BladefallAltZ" => {
            let hf = n(sd, "hitFrequency").ok_or(())?;
            set(sd, "hitTimeOverride", hf / (1.0 + n(sd, "incVolleyFrequency").ok_or(())? / 100.0));
        }
        "Cremation" | "CremationAltX" => {
            if c.skill_part == 1 {
                let r = n(sd, "cremationFireRate").ok_or(())?;
                set(sd, "hitTimeOverride", r / (1.0 + n(sd, "cremationFireRateIncrease").unwrap_or(0.0)));
            }
        }
        "CremationAltY" => {
            let r = n(sd, "cremationFireRate").ok_or(())?;
            set(sd, "hitTimeOverride", r / (1.0 + n(sd, "cremationFireRateIncrease").unwrap_or(0.0)));
        }
        "Hydrosphere" => {
            if (1..=3).contains(&c.skill_part) {
                let rf = n(sd, "repeatFrequency").ok_or(())?;
                set(sd, "hitTimeOverride", rf / (1.0 + sum(sml, ModType::Inc, cfg, &["HydroSphereFrequency"]) / 100.0));
            }
        }
        "OrbOfStorms" => {
            let hf = n(sd, "hitFrequency").ok_or(())?;
            let m = (1.0 + sum(sml, ModType::Inc, cfg, &["Speed"]) / 100.0) * more(sml, cfg, &["Speed"]);
            set(sd, "hitTimeOverride", hf / m);
        }
        "PenanceBrand" => {
            let rf = n(sd, "repeatFrequency").ok_or(())?;
            set(
                sd,
                "hitTimeOverride",
                rf * sum(sml, ModType::Base, cfg, &["Multiplier:PenanceBrandMaxEnergy"]) / (1.0 + sum(sml, ModType::Inc, cfg, &["Speed", "BrandActivationFrequency"]) / 100.0) / more(sml, cfg, &["BrandActivationFrequency"]),
            );
        }
        "PenanceBrandAltX" | "PenanceBrandAltY" | "ArmageddonBrandAltY" => {
            let rf = n(sd, "repeatFrequency").ok_or(())?;
            set(sd, "hitTimeOverride", rf / (1.0 + sum(sml, ModType::Inc, cfg, &["Speed", "BrandActivationFrequency"]) / 100.0) / more(sml, cfg, &["BrandActivationFrequency"]));
        }
        "HeraldOfThunder" => {
            let rf = n(sd, "repeatFrequency").ok_or(())?;
            set(sd, "hitTimeOverride", rf / (1.0 + sum(sml, ModType::Inc, cfg, &["HeraldStormFrequency"]) / 100.0));
        }
        "FreezingPulse" => {
            let psm = out(c, "ProjectileSpeedMod");
            let ramp = |pts: [(f64, f64); 2]| Tag {
                kind: pom_engine::sym!("DistanceRamp"),
                fields: vec![(pom_engine::sym!("ramp"), Value::List(Arc::new(pts.iter().map(|(x, y)| Value::List(Arc::new(vec![Value::Num(*x), Value::Num(*y)]))).collect())))],
            };
            sml.add_mod(mk("Damage", ModType::More, -50.0, "Skill:FreezingPulse", 0, vec![ramp([(0.0, 0.0), (60.0 * psm, 1.0)])]));
            sml.add_mod(mk("EnemyFreezeChance", ModType::Base, 25.0, "Skill:FreezingPulse", 0, vec![ramp([(0.0, 1.0), (15.0 * psm, 0.0)])]));
        }
        "BallLightning" | "BallLightningAltX" | "BallLightningAltY" => {
            let strike_interval = n(sd, "strikeInterval").ok_or(())?;
            let duration = n(sd, "duration").ok_or(())?;
            let dps_multiplier = match c.id {
                "BallLightning" => match c.skill_part {
                    1 => 1.0,
                    2 => {
                        let max_strikes = (duration / strike_interval).floor();
                        let ball_dist_per_sec = n(sd, "projectileSpeed").ok_or(())? * (1.0 + sum(sml, ModType::Inc, cfg, &["ProjectileSpeed"]) / 100.0) * more(sml, cfg, &["ProjectileSpeed"]);
                        let ball_dist_per_strike = ball_dist_per_sec * strike_interval;
                        let enemy_radius = sml.override_(cfg, &[pom_engine::sym!("EnemyRadius")]).and_then(|v| v.num()).unwrap_or_else(|| sum(sml, ModType::Base, cfg, &["EnemyRadius"]));
                        let base_strike_radius = out(c, "AreaOfEffectRadius");
                        let strike_radius = base_strike_radius + enemy_radius;
                        let cast_dist = if let Some(d) = c.cfg.skill_dist {
                            d
                        } else if c.skill_flags.contains("triggered") {
                            (base_strike_radius / 2.0).floor()
                        } else {
                            base_strike_radius
                        };
                        let first = ((cast_dist - strike_radius) / ball_dist_per_strike).ceil().max(1.0);
                        let last = (pom_offence::data::misc("ProjectileDistanceCap").min(cast_dist + strike_radius) / ball_dist_per_strike).floor();
                        let num_strikes = 0.0f64.max(max_strikes.min(last + 1.0 - first));
                        num_strikes
                    }
                    _ => 0.0,
                },
                "BallLightningAltX" => {
                    if c.skill_part == 2 || c.skill_part == 3 {
                        (duration / strike_interval).floor()
                    } else {
                        1.0
                    }
                }
                _ => (duration / strike_interval).floor(),
            };
            if dps_multiplier != 1.0 {
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * dps_multiplier);
                let prev = c.out.get("SkillDPSMultiplier").copied().unwrap_or(1.0);
                global_out.insert("SkillDPSMultiplier".to_string(), prev * dps_multiplier);
            }
            // `output.NormalHitsPerCast = numStrikes` (act_int.lua:1159 under `if breakdown`, 1267, 1384); the
            // reference runs with breakdowns on.
            let reports_hits = match c.id {
                "BallLightning" => c.skill_part == 2,
                "BallLightningAltX" => c.skill_part == 2 || c.skill_part == 3,
                _ => true,
            };
            if reports_hits {
                global_out.insert("NormalHitsPerCast".to_string(), dps_multiplier);
            }
        }
        // Rage Vortex's `preSkillTypeFunc` (CalcOffence.lua:1054) runs before `calcAreaOfEffect`: see offence.rs.
        "RageVortex" => {}
        "ArmageddonBrand" => {
            let rf = n(sd, "repeatFrequency").ok_or(())?;
            set(sd, "hitTimeOverride", rf / (1.0 + sum(sml, ModType::Inc, cfg, &["Speed", "BrandActivationFrequency"]) / 100.0) / more(sml, cfg, &["BrandActivationFrequency"]));
        }
        "StaticStrike" => {
            if c.skill_part == 2 {
                let rf = n(sd, "repeatFrequency").ok_or(())?;
                set(sd, "hitTimeOverride", rf / (1.0 + sum(sml, ModType::Inc, cfg, &["StaticStrikeFrequency"]) / 100.0));
            }
        }
        "StormRain" => {
            if c.skill_part == 2 {
                let hf = n(sd, "hitFrequency").ok_or(())?;
                set(sd, "hitTimeOverride", hf / (1.0 + sum(sml, ModType::Inc, cfg, &["StormRainBeamFrequency"]) / 100.0));
                set(sd, "dpsMultiplier", n(sd, "beamOverlapMultiplier").unwrap_or(1.0));
            }
        }
        "WinterOrb" => {
            let rate_mod = 1.0 + sum(sml, ModType::Inc, cfg, &["HitRate", "Speed"]) / 100.0;
            let mult = more(sml, cfg, &["HitRate"]);
            let rf = n(sd, "repeatFrequency").ok_or(())?;
            set(sd, "hitTimeOverride", rf / rate_mod / mult);
        }
        "Tornado" => {
            set(sd, "hitTimeOverride", n(sd, "damageInterval").ok_or(())?);
        }
        "TornadoAltY" => {
            set(sd, "hitTimeOverride", n(sd, "damageInterval").ok_or(())?);
            set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * sum(sml, ModType::Base, cfg, &["Multiplier:TornadoofElementalTurbulenceStage"]));
        }
        "ScourgeArrow" => {
            // `cfg` is an unassigned global in upstream's function body -> nil.
            let stage = sum(sml, ModType::Base, None, &["Multiplier:ScourgeArrowStage"]);
            set(sd, "hitTimeMultiplier", (stage - 0.5).max(0.5));
        }
        "Spark" | "SparkAltX" | "SparkAltY" => {
            if c.skill_part == 2 {
                let m = n(sd, "dpsMultiplier").unwrap_or(1.0) * (1.0 + (out(c, "Duration") / 0.66).floor());
                set(sd, "dpsMultiplier", m);
                global_out.insert("SkillDPSMultiplier".to_string(), m);
            }
        }
        "StormBurst" => {
            if c.skill_part == 2 {
                let duration = n(sd, "duration").ok_or(())? * out(c, "DurationMod");
                let jump_period = n(sd, "repeatFrequency").ok_or(())? * 10.0;
                let m = n(sd, "dpsMultiplier").unwrap_or(1.0) * (1.0 + (duration * 10.0 / jump_period).floor());
                set(sd, "dpsMultiplier", m);
            } else if c.skill_part == 3 {
                let remaining = ((n(sd, "duration").ok_or(())? * out(c, "DurationMod") + 0.001) / n(sd, "repeatFrequency").ok_or(())?).floor();
                let v = (n(sd, "remainingDurationDamage").ok_or(())? * remaining - 100.0).max(0.0);
                sml.add_mod(mk("Damage", ModType::More, v, "Skill:StormBurst", 0, vec![]));
            }
        }
        "StormBurstAltX" => {
            if c.skill_part == 2 {
                let remaining = ((n(sd, "duration").ok_or(())? * out(c, "DurationMod") + 0.001) / n(sd, "repeatFrequency").ok_or(())?).floor();
                let v = (n(sd, "remainingDurationDamage").ok_or(())? * remaining - 100.0).max(0.0);
                sml.add_mod(mk("Damage", ModType::More, v, "Skill:StormBurst", 0, vec![]));
            }
        }
        "VoltaxicBurst" => {
            let duration = (n(sd, "duration").ok_or(())? * out(c, "DurationMod") * 10.0).floor();
            let v = sum(sml, ModType::Inc, cfg, &["VoltaxicDurationIncDamage"]) * duration;
            sml.add_mod(mk("Damage", ModType::Inc, v, "Skill:VoltaxicBurst", 0, vec![]));
        }
        "WaveOfConviction" | "WaveOfConvictionAltY" => {
            if let Some(dur) = n(sd, "duration") {
                let tick = pom_offence::data::misc("ServerTickRate");
                let duration = ((dur * tick).ceil() / tick * out(c, "DurationMod") * 10.0).floor();
                let v = sum(sml, ModType::Inc, cfg, &["WaveOfConvictionDurationDotMulti"]) * duration / 100.0;
                let tag = Tag { kind: pom_engine::sym!("Multiplier"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from("WoCDurationExpired")))] };
                sml.add_mod(mk("DotMultiplier", ModType::Base, v, &format!("Skill:{}", c.id), 0, vec![tag]));
            }
        }
        // ---- added-damage families ---------------------------------------------------------
        "DarkPact" => {
            let life = if c.skill_part == 1 {
                if c.is_totem {
                    return Err(()); // needs TotemLife
                }
                out(c, "Life")
            } else {
                n(sd, "skeletonLife").unwrap_or(0.0)
            };
            let add = life * n(sd, "lifeDealtAsChaos").ok_or(())? / 100.0;
            set(sd, "ChaosMin", n(sd, "ChaosMin").ok_or(())? + add);
            set(sd, "ChaosMax", n(sd, "ChaosMax").ok_or(())? + add);
        }
        "PoisonousConcoction" | "PoisonousConcoctionAltX" => {
            let multiplier = sum(sml, ModType::Base, cfg, &["ChaosPerLifeFlaskPercent"]);
            let added = out(c, "LifeFlaskRecovery") * (multiplier / 100.0);
            sml.add_mod(mk("ChaosMin", ModType::Base, added, "Life Flask charges consumed", 0, vec![]));
            sml.add_mod(mk("ChaosMax", ModType::Base, added, "Life Flask charges consumed", 0, vec![]));
        }
        // ---- Seismic Trap (Data/Skills/act_dex.lua:13381-13460) ----------------------------------
        "SeismicTrap" | "SeismicTrapAltX" => {
            let mut average_active_traps = 0.0;
            if c.id == "SeismicTrap" {
                let base_interval = n(sd, "repeatInterval").ok_or(())?;
                let inc_freq = 1.0 + sum(sml, ModType::Inc, cfg, &["TrapThrowingSpeed", "SeismicPulseFrequency"]) / 100.0;
                let more_freq = more(sml, cfg, &["TrapThrowingSpeed", "SeismicPulseFrequency"]);
                let rate = inc_freq * more_freq / base_interval;
                set(sd, "hitTimeOverride", 1.0 / rate);
                global_out.insert("WavePulseRate".to_string(), rate);
                let inc_dur = 1.0 + sum(sml, ModType::Inc, cfg, &["Duration"]) / 100.0;
                let more_dur = more(sml, cfg, &["Duration"]);
                let duration = n(sd, "duration").ok_or(())? * inc_dur * more_dur;
                let pulses = (duration * rate).floor();
                global_out.insert("PulsesPerTrap".to_string(), pulses);
                let cooldown = c.out.get("TrapCooldown").copied().ok_or(())?;
                average_active_traps = pulses / rate / cooldown;
                global_out.insert("AverageActiveTraps".to_string(), average_active_traps);
            }
            let enemy_radius = sml.override_(cfg, &[pom_engine::sym!("EnemyRadius")]).and_then(|v| v.num()).unwrap_or_else(|| sum(sml, ModType::Base, cfg, &["EnemyRadius"]));
            let wave_radius = c.out.get("AreaOfEffectRadiusSecondary").copied().ok_or(())?;
            let full_radius = c.out.get("AreaOfEffectRadius").copied().ok_or(())?;
            let damaging = wave_radius + enemy_radius - 1.0;
            let overlap = (damaging * damaging / (full_radius * full_radius)).min(1.0);
            global_out.insert("OverlapChance".to_string(), overlap * 100.0);
            let max_waves = sum(sml, ModType::Base, cfg, &["MaximumWaves"]);
            let dps_mult = match c.skill_part {
                2 => max_waves * overlap,
                3 => max_waves,
                4 if c.id == "SeismicTrap" => average_active_traps,
                _ => 1.0,
            };
            if dps_mult != 1.0 {
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * dps_mult);
                let prev = c.out.get("SkillDPSMultiplier").copied().unwrap_or(1.0);
                global_out.insert("SkillDPSMultiplier".to_string(), prev * dps_mult);
            }
        }
        // Blood Sacrament's `initialFunc` reads `skillData.LifeReservedBase/Percent`, written by the reservation loop
        // (CalcPerform.lua:2048-2065, with the channel-stage multiplier), which is not threaded to offence: stays unsupported.
        "ForbiddenRite" | "ForbiddenRiteAltX" => {
            let names = ["DamageTaken", "ChaosDamageTaken", "DamageTakenWhenHit", "ChaosDamageTakenWhenHit"];
            let base_taken_flat = sum(sml, ModType::Base, None, &names);
            let base_taken_inc = sum(sml, ModType::Inc, None, &names);
            let base_taken_more = more(sml, None, &names);
            let chaos_damage_taken = ((1.0 + base_taken_inc / 100.0) * base_taken_more).max(0.0);
            let chaos_flat = round0(base_taken_flat * chaos_damage_taken).floor();
            let (life, es, chaos_res) = if c.is_totem {
                (c.out.get("TotemLife").copied().ok_or(())?, c.out.get("TotemEnergyShield").copied().ok_or(())?, c.out.get("TotemChaosResist").copied().ok_or(())?)
            } else {
                (out(c, "Life"), out(c, "EnergyShield"), out(c, "ChaosResist"))
            };
            let alt_x = c.id == "ForbiddenRiteAltX";
            let add = if alt_x { es * n(sd, "energyShieldDealtAsChaos").ok_or(())? } else { life * n(sd, "lifeDealtAsChaos").ok_or(())? + es * n(sd, "energyShieldDealtAsChaos").ok_or(())? };
            let self_es = (round0(es * n(sd, "SelfDamageTakenES").ok_or(())?) * (100.0 - chaos_res) / 100.0 * chaos_damage_taken).floor();
            let self_life = if alt_x { 0.0 } else { (round0(life * n(sd, "SelfDamageTakenLife").ok_or(())?) * (100.0 - chaos_res) / 100.0 * chaos_damage_taken).floor() };
            set(sd, "ChaosMin", n(sd, "ChaosMin").ok_or(())? + add);
            set(sd, "ChaosMax", n(sd, "ChaosMax").ok_or(())? + add);
            if c.skill_part == 2 {
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * (out(c, "ProjectileCount") + 1.0));
            }
            global_out.insert("FRDamageTaken".to_string(), self_life + self_es + chaos_flat);
            if pom_offence::bd::on() {
                // Data/Skills/act_int.lua:7419-7432 (Forbidden Rite) and 7573-7587 (the Soulfeast variant): `breakdown.FRDamageTaken`.
                use pom_offence::bd::{ins_s, set};
                use pom_offence::sf;
                let (sdl, sde) = (n(sd, "SelfDamageTakenLife").unwrap_or(0.0), n(sd, "SelfDamageTakenES").unwrap_or(0.0));
                let mut t = serde_json::Value::Array(vec![]);
                ins_s(&mut t, sf!("Damage Taken per cast from Forbidden Rite: %d", self_life + self_es + chaos_flat));
                if !alt_x {
                    ins_s(&mut t, sf!("^8=^7 %d^8 (Life) *^7 %d%%^8 (of Life taken as Chaos Damage)", life, sdl * 100.0));
                }
                if es != 0.0 {
                    ins_s(&mut t, sf!("^8+^7 %d^8 (ES) *^7 %d%%^8 (of ES taken as Chaos Damage)", es, sde * 100.0));
                }
                let chaos_dmg = if alt_x { es * sde } else { life * sdl + es * sde };
                ins_s(&mut t, sf!("^8=^7 %d^8 (Chaos Damage) *^7 %d%%^8 (Chaos Resistance)", chaos_dmg, chaos_res));
                if chaos_flat != 0.0 {
                    ins_s(&mut t, sf!("^8 -^7 %d^8 (Flat Damage reduction)", -base_taken_flat));
                }
                if chaos_damage_taken != 1.0 {
                    ins_s(&mut t, sf!("^8 *^7 %.2f^8 (Damage taken Multiplier)", chaos_damage_taken));
                }
                pom_offence::bd::root(|b| set(b, "FRDamageTaken", t));
            }
        }
        // ---- Righteous Fire: FireDot is a runtime percentage of Life/ES --------------------
        "RighteousFire" => {
            if c.is_totem {
                return Err(()); // TotemLife
            }
            if out(c, "LifeUnreserved") > 1.0 {
                let fd = out(c, "Life") * n(sd, "RFLifeMultiplier").ok_or(())? + out(c, "EnergyShield") * n(sd, "RFESMultiplier").ok_or(())?;
                set(sd, "FireDot", fd);
            }
        }
        "RighteousFireAltX" => {
            if out(c, "LifeUnreserved") > 1.0 {
                set(sd, "FireDot", out(c, "Mana") * n(sd, "RFManaMultiplier").ok_or(())?);
            }
        }
        "VaalRighteousFire" => {
            if c.is_totem {
                return Err(());
            }
            let fd = (out(c, "Life") + out(c, "EnergyShield")) * n(sd, "percentSacrificed").ok_or(())? * n(sd, "RFMultiplier").ok_or(())?;
            set(sd, "FireDot", fd);
        }
        // ---- projectile-count families (`output.ProjectileCount` from `crate::skillgeo`) ----------
        "Barrage" | "BarrageAltX" | "BlastRain" => {
            if c.skill_part == 2 {
                set(sd, "dpsMultiplier", out(c, "ProjectileCount"));
            }
        }
        "AzmeriHydraBarrage" => set(sd, "dpsMultiplier", out(c, "ProjectileCount")),
        "IceSpear" => {
            if c.skill_part == 3 || c.skill_part == 4 {
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * out(c, "ProjectileCount"));
            }
        }
        "BlazingSalvo" => {
            if c.skill_part == 2 {
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * out(c, "ProjectileCount"));
            }
        }
        "ToxicRain" | "ToxicRainAltX" => {
            set(sd, "dpsMultiplier", n(sd, "podOverlapMultiplier").unwrap_or(1.0).min(out(c, "ProjectileCount")));
        }
        "LancingSteel" => {
            if c.skill_part == 2 {
                let pc = out(c, "ProjectileCount");
                let percent_reduced = (pc - 1.0) / pc;
                let mult = (more(sml, cfg, &["LancingSteelSubsequentDamage"]) - 1.0) * 100.0 * percent_reduced;
                set(sd, "dpsMultiplier", pc);
                sml.add_mod(mk("Damage", ModType::More, mult, "Skill:LancingSteel", 0, vec![]));
            }
        }
        "TornadoShot" => {
            if c.skill_part == 2 && out(c, "ReturnChance") == 0.0 {
                let mut avg_secondary = out(c, "ProjectileCount") + out(c, "SplitCount");
                let f = |n: &str| sml.flag(None, &[Sym::new(n)]);
                if f("SequentialProjectiles") && !f("OneShotProj") && !f("NoAdditionalProjectiles") && !f("SingleProjectile") && !f("TriggeredBySnipe") {
                    avg_secondary = 1.0 + out(c, "SplitCount");
                }
                let chance = ((n(sd, "tornadoShotSecondaryHitChance").unwrap_or(20.0 * sum(sml, ModType::Base, cfg, &["tornadoShotSecondaryProjectiles"]))) / 100.0).min(1.0);
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * (1.0 + chance * avg_secondary));
            }
        }
        "ShrapnelBallista" => {
            if !sml.flag(None, &[pom_engine::sym!("SequentialProjectiles")]) {
                let pc = out(c, "ProjectileCount");
                let overlap = n(sd, "ShrapnelBallistaProjectileOverlap").unwrap_or(if c.skill_types.contains(&pom_skills::skill_type::RAIN) { pc } else { 1.0 });
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * overlap.min(pc));
            }
            let split = out(c, "SplitCount");
            if split > 0.0 {
                let tag = Tag { kind: pom_engine::sym!("Condition"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from("ReturningProjectile")))] };
                sml.add_mod(mk("DPS", ModType::More, split * 100.0, "Split Return", 0, vec![tag]));
            }
        }
        // ---- stage / time multipliers ---------------------------------------------------------
        "DivineIre" => {
            if c.skill_part == 2 {
                set(sd, "hitTimeMultiplier", sum(sml, ModType::Base, cfg, &["Multiplier:DivineIreStage"]));
            }
        }
        "DivineIreAltX" => {
            if c.skill_part == 2 {
                set(sd, "hitTimeMultiplier", sum(sml, ModType::Base, cfg, &["Multiplier:DivineIreofHolyLightningStage"]));
            }
        }
        "Flameblast" | "FlameblastAltX" | "FlameblastAltY" => {
            let stage = match c.id { "FlameblastAltX" => "Multiplier:FlameblastofCelerityStage", "FlameblastAltY" => "Multiplier:FlameblastofContractionStage", _ => "Multiplier:FlameblastStage" };
            let v = sum(sml, ModType::Base, cfg, &[stage]) - sum(sml, ModType::Base, cfg, &["Multiplier:FlameblastMinimumStage"]);
            set(sd, "hitTimeMultiplier", v.max(1.0));
        }
        "Incinerate" => {
            if c.skill_part == 2 {
                let v = sum(sml, ModType::Base, cfg, &["Multiplier:IncinerateStage"]) - sum(sml, ModType::Base, cfg, &["Multiplier:IncinerateMinimumStage"]) - 0.4175;
                set(sd, "hitTimeMultiplier", v.max(0.5825));
            }
        }
        "MoltenShell" | "VaalMoltenShell" => {
            let key = if c.id == "MoltenShell" { "MoltenShellDamageMitigated" } else { "VaalMoltenShellDamageMitigated" };
            let add = n(sd, key).unwrap_or(0.0) * n(sd, "moltenShellReflect").ok_or(())? / 100.0;
            set(sd, "FireMin", add);
            set(sd, "FireMax", add);
        }
        "LightningTendrilsAltX" => {
            // DPS multiplier applied to the skills to reflect the DPS from each skill part.
            let interval = n(sd, "pulseInterval").ok_or(())?;
            let part_tag = |p: f64| Tag { kind: pom_engine::sym!("SkillPart"), fields: vec![(pom_engine::sym!("skillPart"), Value::Num(p))] };
            if c.skill_part == 2 {
                sml.add_mod(mk("DPS", ModType::More, -(1.0 / interval) * 100.0, "Normal pulse", 0, vec![part_tag(2.0)]));
            } else if c.skill_part == 3 {
                sml.add_mod(mk("DPS", ModType::More, -(interval - 1.0) / interval * 100.0, "Stronger pulse", 0, vec![part_tag(3.0)]));
            }
        }
        "GalvanicField" => set(sd, "hitTimeOverride", n(sd, "repeatFrequency").ok_or(())?),
        "WintertideBrand" => {
            let rf = n(sd, "repeatFrequency").ok_or(())?;
            sd.insert("countsAttachedBrandsInDamage".to_string(), ScalarValue::Bool(c.skill_part == 1));
            let hto = rf / (1.0 + sum(sml, ModType::Inc, cfg, &["Speed", "BrandActivationFrequency"]) / 100.0) / more(sml, cfg, &["BrandActivationFrequency"]);
            set(sd, "hitTimeOverride", hto);
            if c.skill_part == 1 {
                let tick = pom_offence::data::misc("ServerTickRate");
                let max_stages_cap = sum(sml, ModType::Base, cfg, &["Multiplier:WintertideBrandMaxStages"]);
                let debuff_mult = 1.0 / pom_offence::data::misc("BuffExpirationSlowCap").max(calc_lib_mod_of(c.enemy, cfg, "BuffExpireFaster"));
                // calcSkillDuration(skillModList, skillCfg, skillData, {}): env.mode_effective is nil, so no debuff scaling inside.
                let names: &[&str] = if matches!(sd.get("mineDurationAppliesToSkill"), Some(ScalarValue::Bool(true))) { &["Duration", "PrimaryDuration", "MineDuration"] } else { &["Duration", "PrimaryDuration"] };
                let dur_mod = pom_offence::tools::calc_lib_mod(sml, cfg, names).max(0.0);
                let dur_base = n(sd, "duration").unwrap_or(0.0) + sum(sml, ModType::Base, cfg, &["Duration", "PrimaryDuration"]);
                let mut duration = dur_base * dur_mod;
                if matches!(sd.get("debuff"), Some(ScalarValue::Bool(true))) {
                    // debuffDurationMult is 1 here (env.mode_effective nil)
                    duration *= 1.0;
                }
                duration *= debuff_mult;
                let max_stages = (duration / hto).floor().min(max_stages_cap);
                let time_to_max = max_stages * hto;
                let time_at_max = (duration - time_to_max).max(0.0);
                let per_stage = sum(sml, ModType::Base, cfg, &["Multiplier:WintertideBrandDamagePerStage"]);
                let avg_stages = (max_stages * (max_stages - 1.0) / 2.0 * hto + max_stages * time_at_max) / duration;
                let avg_mult = avg_stages * per_stage;
                let end_base = n(sd, "durationTertiary").unwrap_or(0.0) + sum(sml, ModType::Base, cfg, &["Duration", "TertiaryDuration"]);
                let end_mod = pom_offence::tools::calc_lib_mod_s(sml, cfg, &[pom_engine::sym!("Duration"), pom_engine::sym!("TertiaryDuration")]).max(0.0);
                let end_duration = (end_base * end_mod * debuff_mult * tick).ceil() / tick;
                let end_uptime = (end_duration / duration).min(1.0);
                let attached = n(sd, "attachedBrandCount").ok_or(())?;
                let end_mult = max_stages * per_stage;
                let dps_mult = attached * (100.0 + avg_mult) + end_uptime * (100.0 + end_mult) - 100.0;
                sml.add_mod(mk("Damage", ModType::More, dps_mult, "Wintertide Brand Average Multiplier", 0, vec![]));
            }
        }
        "ExplosiveTrap" | "ExplosiveTrapAltX" => {
            let enemy_radius = match sml.override_(cfg, &[pom_engine::sym!("EnemyRadius")]).and_then(|v| v.num()) {
                Some(v) => v,
                None => sum(sml, ModType::Base, cfg, &["EnemyRadius"]),
            };
            let full_radius = out(c, "AreaOfEffectRadiusSecondary");
            let margin_width = n(sd, "radiusTertiaryBaseMargin").ok_or(())? * 2.0 + 1.0;
            let hit_chance = |area_damage_radius: f64, area_spread_radius: f64| {
                let damaging = area_damage_radius + enemy_radius - 1.0;
                (damaging * damaging / (area_spread_radius * area_spread_radius)).min(1.0)
            };
            let mut overlap_chance = 0.0;
            for (small_radius, occurrence_count) in c.tertiary_occ {
                overlap_chance += hit_chance(*small_radius, full_radius) * occurrence_count / margin_width;
            }
            global_out.insert("OverlapChance".to_string(), overlap_chance * 100.0);
            let small = sum(sml, ModType::Base, cfg, &["SmallExplosions"]);
            global_out.insert("SmallExplosionsPerTrap".to_string(), small);
            let dps_multiplier = match c.skill_part {
                2 => 1.0 + small * overlap_chance,
                3 => 1.0 + small,
                _ => 1.0,
            };
            if dps_multiplier != 1.0 {
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * dps_multiplier);
                global_out.insert("SkillDPSMultiplier".to_string(), c.out.get("SkillDPSMultiplier").copied().unwrap_or(1.0) * dps_multiplier);
            }
        }
        "FlamethrowerTrap" => {
            let duration = c.out.get("Duration").copied().ok_or(())?;
            let cooldown = c.out.get("TrapCooldown").copied().ok_or(())?;
            let average_active_traps = duration / cooldown;
            global_out.insert("AverageActiveTraps".to_string(), average_active_traps);
            set(sd, "hitTimeOverride", if c.skill_part == 2 || c.skill_part == 4 { 0.3 } else { 0.1 });
            if c.skill_part == 3 || c.skill_part == 4 {
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * average_active_traps);
            }
        }
        "IncinerateAltY" => {
            if c.skill_part == 2 {
                let v = sum(sml, ModType::Base, cfg, &["Multiplier:IncinerateofVentingStage"]) - sum(sml, ModType::Base, cfg, &["Multiplier:IncinerateMinimumStage"]) - 0.4175;
                set(sd, "hitTimeMultiplier", v.max(0.5825));
            }
        }
        "VaalLightningArrow" => {
            if c.skill_part == 2 {
                set(sd, "dpsMultiplier", c.out.get("ProjectileCount").copied().ok_or(())?);
            }
        }
        "LightningSpireTrap" | "LightningSpireTrapAltX" | "LightningSpireTrapAltY" => {
            let id = c.id;
            let alt_x = id == "LightningSpireTrapAltX";
            let radius = n(sd, "radius").ok_or(())?;
            global_out.insert("AreaOfEffectRadius".to_string(), radius);
            let base_interval = n(sd, "repeatInterval").ok_or(())?;
            let wave_pulse_rate = if id == "LightningSpireTrap" {
                let inc_freq = 1.0 + sum(sml, ModType::Inc, cfg, &["TrapThrowingSpeed"]) / 100.0;
                let more_freq = more(sml, cfg, &["TrapThrowingSpeed"]);
                let r = inc_freq * more_freq / base_interval;
                global_out.insert("WavePulseRate".to_string(), r);
                r
            } else {
                1.0 / base_interval
            };
            set(sd, "hitTimeOverride", 1.0 / wave_pulse_rate);
            let inc_duration = 1.0 + sum(sml, ModType::Inc, cfg, &["Duration"]) / 100.0;
            let more_duration = more(sml, cfg, &["Duration"]);
            let duration = n(sd, "duration").ok_or(())? * inc_duration * more_duration;
            let pulses = (duration * wave_pulse_rate).floor();
            global_out.insert("PulsesPerTrap".to_string(), pulses);
            let effective_duration = pulses / wave_pulse_rate;
            let average_active_traps = if alt_x {
                let action_speed_mod = 1.0 + sum(sml, ModType::Inc, cfg, &["ActionSpeed"]) / 100.0;
                let base_speed = 1.0 / sum(sml, ModType::Base, cfg, &["TrapThrowingTime"]);
                let throw_speed = (base_speed * calc_lib_mod_of(sml, cfg, "TrapThrowingSpeed") * action_speed_mod).min(pom_offence::data::misc("ServerTickRate"));
                let throw_time = 1.0 / throw_speed;
                effective_duration / throw_time
            } else {
                effective_duration / c.out.get("TrapCooldown").copied().ok_or(())?
            };
            global_out.insert("AverageActiveTraps".to_string(), average_active_traps);
            let enemy_radius = sml.override_(cfg, &[pom_engine::sym!("EnemyRadius")]).and_then(|v| v.num()).unwrap_or_else(|| sum(sml, ModType::Base, cfg, &["EnemyRadius"]));
            let wave_radius = c.out.get("AreaOfEffectRadiusSecondary").copied().ok_or(())?;
            let damaging = wave_radius + enemy_radius - 1.0;
            let overlap = (damaging * damaging / (radius * radius)).min(1.0);
            global_out.insert("OverlapChance".to_string(), overlap * 100.0);
            let max_waves = sum(sml, ModType::Base, cfg, &["MaximumWaves"]);
            let dps_mult = match c.skill_part {
                2 => max_waves * overlap,
                3 => max_waves,
                4 => average_active_traps,
                5 => average_active_traps * max_waves * overlap,
                6 => average_active_traps * max_waves,
                _ => 1.0,
            };
            if dps_mult != 1.0 {
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * dps_mult);
                global_out.insert("SkillDPSMultiplier".to_string(), c.out.get("SkillDPSMultiplier").copied().unwrap_or(1.0) * dps_mult);
            }
        }
        "StormBrand" => {
            let rf = n(sd, "repeatFrequency").ok_or(())?;
            set(sd, "hitTimeOverride", rf / (1.0 + sum(sml, ModType::Inc, cfg, &["Speed", "BrandActivationFrequency"]) / 100.0) / more(sml, cfg, &["BrandActivationFrequency"]));
        }
        "VoidSphere" | "VoidSphereAltX" => {
            let rf = n(sd, "repeatFrequency").ok_or(())?;
            set(sd, "hitTimeOverride", rf / (1.0 + sum(sml, ModType::Inc, cfg, &["VoidSphereFrequency"]) / 100.0));
        }
        "HeraldOfTheBreach" => {
            let rf = n(sd, "repeatFrequency").ok_or(())?;
            set(sd, "hitTimeOverride", rf / (1.0 + sum(sml, ModType::Inc, cfg, &["PulseFrequencyPerPressure"]) / 100.0));
        }
        "LightningBolt" | "Vortex" | "VortexAltX" => {
            // `hitTimeOverride = output.Cooldown` (nil when the skill has no cooldown).
            match c.out.get("Cooldown") {
                Some(cd) => set(sd, "hitTimeOverride", *cd),
                None => {
                    sd.remove("hitTimeOverride");
                }
            }
        }
        "MinionInstability" => {
            // `1 / (activeSkill.summonSkill.skillData.summonSpeed or 1)`; the summon skill is the player's main skill.
            set(sd, "hitTimeOverride", 1.0 / crate::offence::SUMMON_SPEED.with(|c| c.get()).unwrap_or(1.0));
        }
        "Earthquake" => {
            let duration = (n(sd, "duration").ok_or(())? * out(c, "DurationMod") * 10.0).floor();
            let v = sum(sml, ModType::Inc, cfg, &["EarthquakeDurationIncDamage"]) * duration;
            sml.add_mod(mk("Damage", ModType::Inc, v, "Skill:Earthquake", 0, vec![]));
        }
        "Perforate" => set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0).max(1.0)),
        "Manabond" => {
            let missing = n(sd, "ManabondMissingUnreservedManaPercentage").unwrap_or(100.0);
            let gained = ((n(sd, "ManabondMissingManaGainPercent").ok_or(())? / 100.0) * (missing / 100.0) * out(c, "ManaUnreserved")).floor();
            if pom_offence::data::pom_fixes_on() {
                // The missing-mana lightning is base damage (BonusMin/Max, like corpse explosion), not added damage scaled by the 1.6 effectiveness (differs from upstream).
                set(sd, "LightningBonusMin", gained);
                set(sd, "LightningBonusMax", gained);
            } else {
                sml.add_mod(mk("LightningMin", ModType::Base, gained, "Manabond gain % missing unreserved mana as base lightning damage", 0, vec![]));
                sml.add_mod(mk("LightningMax", ModType::Base, gained, "Manabond gain % missing unreserved mana as base lightning damage", 0, vec![]));
            }
        }
        "DeathWish" => {
            if c.skill_part == 2 {
                let v = out(c, "Life") * n(sd, "selfFireExplosionLifeMultiplier").ok_or(())?;
                set(sd, "FireBonusMin", v);
                set(sd, "FireBonusMax", v);
            }
        }
        "Bodyswap" | "BodyswapAltX" => {
            if c.skill_part == 1 {
                let v = out(c, if c.is_totem { "TotemLife" } else { "Life" }) * n(sd, "selfFireExplosionLifeMultiplier").ok_or(())?;
                set(sd, "FireBonusMin", v);
                set(sd, "FireBonusMax", v);
            }
        }
        "InfernalBlow" | "InfernalBlowAltX" => {
            let effect = sum(sml, ModType::Base, cfg, &["DebuffEffect"]);
            if c.skill_part == 2 || c.skill_part == 3 {
                let tag = Tag { kind: pom_engine::sym!("Multiplier"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from("DebuffStack"))), (pom_engine::sym!("base"), Value::Num(-100.0 + effect))] };
                sml.add_mod(mk("Damage", ModType::More, effect, &format!("Skill:{}", c.id), 0, vec![tag]));
            }
            if c.skill_part == 3 {
                set(sd, "dpsMultiplier", 1.0 / 6.0);
            }
        }
        "EyeOfWinter" | "EyeOfWinterAltX" | "EyeOfWinterAltY" => {
            let psm = out(c, "ProjectileSpeedMod");
            let ramp = Tag {
                kind: pom_engine::sym!("DistanceRamp"),
                fields: vec![(pom_engine::sym!("ramp"), Value::List(Arc::new([(0.0, 0.0), (60.0 * psm, 1.0)].iter().map(|(x, y)| Value::List(Arc::new(vec![Value::Num(*x), Value::Num(*y)]))).collect())))],
            };
            let ramp_sum = sum(sml, ModType::Base, cfg, &["EyeOfWinterRamp"]);
            sml.add_mod(mk("Damage", ModType::More, ramp_sum, &format!("Skill:{}", c.id), 0, vec![ramp]));
        }
        "KineticFusillade" | "KineticFusilladeAltX" => {
            if c.skill_part == 1 {
                let count = out(c, "ProjectileCount");
                set(sd, "dpsMultiplier", count);
                let per = n(sd, "damagePerProjectile").unwrap_or(0.0);
                if per != 0.0 && count > 1.0 {
                    let avg = per * (count - 1.0) / 2.0;
                    sml.add_mod(mk("Damage", ModType::More, avg, &format!("Skill:{}", c.id), 0, vec![]));
                    global_out.insert("KineticFusilladeAvgMoreMult".to_string(), avg);
                    if pom_offence::bd::on() {
                        // Data/Skills/act_int.lua:11029-11041 (KineticFusillade) and 11247-11259 (KineticFusilladeAltX).
                        use pom_offence::bd::{ins_s, set};
                        use pom_offence::sf;
                        let mut t = serde_json::Value::Array(vec![]);
                        ins_s(&mut t, sf!("^8Each projectile deals^7 %d%%^8 more damage per previous projectile", per));
                        ins_s(&mut t, sf!("^8With^7 %d^8 projectiles, damage progression is:^7", count));
                        let mut i = 1.0;
                        while i <= count {
                            ins_s(&mut t, sf!("  ^8Projectile %d:^7 %d%%^8 more damage", i, per * (i - 1.0)));
                            i += 1.0;
                        }
                        ins_s(&mut t, sf!("^8Average more multiplier:^7 %.1f%%", avg));
                        let max = sml.override_(cfg, &[pom_engine::sym!("ProjectileCountMaximum")]).and_then(|v| v.num()).unwrap_or(0.0);
                        pom_offence::bd::root(|b| {
                            set(b, "KineticFusilladeSequentialBreakdown", t);
                            ins_s(pom_offence::bd::t(b, "ProjectileCount"), sf!("^8Maximum number of Kinetic Fusilade projectiles:^7 %d", max));
                        });
                    }
                }
            }
            // Its `postCritFunc` (max effective attack rate) is applied by `kinetic_post_crit` after the crit stage.
        }
        "MoltenStrikeAltX" => {
            if c.skill_part != 1 {
                let enemy_radius = sml.override_(cfg, &[pom_engine::sym!("EnemyRadius")]).and_then(|v| v.num()).unwrap_or_else(|| sum(sml, ModType::Base, cfg, &["EnemyRadius"]));
                let ball_radius = out(c, "AreaOfEffectRadius");
                let inner = out(c, "AreaOfEffectRadiusSecondary");
                let outer = out(c, "AreaOfEffectRadiusTertiary");
                let hit_range = enemy_radius + ball_radius - inner;
                let landing_range = outer - inner;
                let overlap = (hit_range / landing_range).min(1.0);
                global_out.insert("OverlapChance".to_string(), overlap * 100.0);
                molten_strike_overlap_table(enemy_radius, ball_radius, inner, outer, overlap);
                let num_projectiles = out(c, "ProjectileCount");
                let mut dps_mult = 1.0;
                if c.skill_part == 3 || c.skill_part == 5 || c.skill_part == 6 {
                    dps_mult = overlap * num_projectiles;
                    if c.skill_part != 6 {
                        molten_strike_dps_table(num_projectiles, overlap, dps_mult);
                    } else {
                        // zenith: weighted average of normal and 5th attack balls
                        let fifth_multi = 1.0 + n(sd, "FifthStrikeDamage").ok_or(())? / 100.0;
                        let fifth_projectiles = n(sd, "FifthStrikeProjectiles").ok_or(())?;
                        let fifth_overall = fifth_multi * overlap * (num_projectiles + fifth_projectiles);
                        dps_mult = 0.8 * dps_mult + 0.2 * fifth_overall;
                        if pom_offence::bd::on() {
                            use pom_offence::bd::{ins_s, set};
                            use pom_offence::sf;
                            let mut t = serde_json::Value::Array(vec![]);
                            ins_s(&mut t, "Weighted average DPS multiplier for balls");
                            ins_s(&mut t, "^8= (0.8 * balls dps) + (0.2 * 5th attack balls dps)");
                            ins_s(&mut t, sf!("^8= (0.8 * normal ball hit * overlap chance * number of projectiles) + (0.2 * ball hit * 5th attack multiplier * overlap chance * (number of projectiles + %d))", fifth_projectiles));
                            ins_s(&mut t, sf!("^8= ball hit * overlap chance * (0.8 * number of projectiles + 0.2 * 5th attack multiplier * (number of projectiles + %d))", fifth_projectiles));
                            ins_s(&mut t, sf!("^8= ball hit * ^7%.3f ^8* (0.8 * ^7%d ^8+ 0.2 * ^7%.1f ^8* ^7%d^8)", overlap, num_projectiles, fifth_multi, num_projectiles + fifth_projectiles));
                            ins_s(&mut t, sf!("^8= ball hit * ^7 %.3f", dps_mult));
                            pom_offence::bd::root(|b| set(b, "SkillDPSMultiplier", t));
                        }
                    }
                }
                if dps_mult != 1.0 {
                    set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * dps_mult);
                    let prev = c.out.get("SkillDPSMultiplier").copied().unwrap_or(1.0);
                    global_out.insert("SkillDPSMultiplier".to_string(), prev * dps_mult);
                }
            }
        }
        "MoltenStrike" => {
            if c.skill_part != 1 {
                let enemy_radius = sml.override_(cfg, &[pom_engine::sym!("EnemyRadius")]).and_then(|v| v.num()).unwrap_or_else(|| sum(sml, ModType::Base, cfg, &["EnemyRadius"]));
                let ball_radius = out(c, "AreaOfEffectRadius");
                let inner = out(c, "AreaOfEffectRadiusSecondary");
                let outer = out(c, "AreaOfEffectRadiusTertiary");
                let hit_range = enemy_radius + ball_radius - inner;
                let landing_range = outer - inner;
                let overlap = (hit_range / landing_range).min(1.0);
                global_out.insert("OverlapChance".to_string(), overlap * 100.0);
                molten_strike_overlap_table(enemy_radius, ball_radius, inner, outer, overlap);
                let dps_mult = if c.skill_part == 3 { overlap * out(c, "ProjectileCount") } else { 1.0 };
                if c.skill_part == 3 {
                    molten_strike_dps_table(out(c, "ProjectileCount"), overlap, dps_mult);
                }
                if dps_mult != 1.0 {
                    set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * dps_mult);
                    let prev = c.out.get("SkillDPSMultiplier").copied().unwrap_or(1.0);
                    global_out.insert("SkillDPSMultiplier".to_string(), prev * dps_mult);
                }
            }
        }
        // ---- "On Kill Monster Explosion" (Data/Skills/other.lua:6187 preDamageFunc)
        "EnemyExplode" => {
            global_out.insert("ExplodeChance".to_string(), 0.0);
            let fld = |v: &Value, k: &str| v.get(Sym::new(k)).clone();
            let ty_of = |v: &Value| match fld(v, "type") { Value::Str(t) => Some(t.to_string()), _ => None };
            let mut assign = |sd: &mut Sd, ty: &str, amount: f64, add: bool| {
                let targets: Vec<&str> = if ty == "RandomElement" { vec!["Fire", "Cold", "Lightning"] } else { vec![] };
                let amt = if ty == "RandomElement" { amount / 3.0 } else { amount };
                let keys: Vec<String> = if targets.is_empty() { vec![format!("{ty}EffectiveExplodePercentage")] } else { targets.iter().map(|t| format!("{t}EffectiveExplodePercentage")).collect() };
                for k in keys {
                    let prev = if add { n(sd, &k).unwrap_or(0.0) } else { 0.0 };
                    set(sd, &k, prev + amt);
                }
            };
            if c.skill_part != 3 {
                let src = c.explode_source.ok_or(())?;
                for (v, m) in sml.tabulate(Some(ModType::List), cfg, &[pom_engine::sym!("ExplodeMod")]) {
                    let msrc = unsafe { (*m).source.clone() };
                    if msrc.as_deref() == Some(src) {
                        let ty = ty_of(&v).ok_or(())?;
                        let amount = fld(&v, "amount").num().ok_or(())?;
                        assign(sd, &ty, amount, false);
                        let chance = fld(&v, "chance").num().ok_or(())?;
                        global_out.insert("ExplodeChance".to_string(), if c.skill_part == 2 { 1.0 } else { chance });
                    }
                }
            } else {
                let mut type_amount_chances: Vec<(String, Vec<(f64, f64)>)> = Vec::new();
                for v in sml.list(cfg, &[pom_engine::sym!("ExplodeMod")]) {
                    let ty = ty_of(&v).ok_or(())?;
                    let amount = fld(&v, "amount").num().ok_or(())?;
                    let chance = fld(&v, "chance").num().ok_or(())?;
                    let ti = match type_amount_chances.iter().position(|(t, _)| *t == ty) {
                        Some(i) => i,
                        None => {
                            type_amount_chances.push((ty.clone(), Vec::new()));
                            type_amount_chances.len() - 1
                        }
                    };
                    let list = &mut type_amount_chances[ti].1;
                    match list.iter_mut().find(|(a, _)| *a == amount) {
                        Some(e) => e.1 += chance,
                        None => list.push((amount, chance)),
                    }
                }
                let mut explode_chance = 0.0f64;
                for (ty, list) in &type_amount_chances {
                    let mut phys_explode_chance = 0.0f64;
                    for (amount, chance) in list {
                        assign(sd, ty, amount * chance, true);
                        if ty == "Physical" {
                            phys_explode_chance = 1.0 - ((1.0 - phys_explode_chance) * (1.0 - chance));
                        }
                        explode_chance = 1.0 - ((1.0 - explode_chance) * (1.0 - chance));
                    }
                    if ty == "Physical" && phys_explode_chance != 0.0 {
                        sml.add_mod(mk("CalcArmourAsThoughDealing", ModType::More, 100.0 / phys_explode_chance.min(1.0) - 100.0, "", 0, vec![]));
                    }
                }
                global_out.insert("ExplodeChance".to_string(), explode_chance);
            }
            let ec = global_out.get("ExplodeChance").copied().unwrap_or(0.0);
            global_out.insert("ExplodeChance".to_string(), (ec * 100.0).min(100.0));
        }
        // ---- Cyclone's `initialFunc` runs before `calcAreaOfEffect`: see `cyclone_initial`, called from offence.rs.
        // Bane's only hook is a `preSkillTypeFunc`, run in offence.rs.
        "Bane" | "BaneAltX" => {}
        // `summonSpeed` (CalcOffence.lua:4097) of the parent (MinionInstability uses the SUMMON_SPEED hook above, which includes dpsMultiplier).
        "GAZombieCorpseGroundImpact" => {
            let p = c.parent_out.ok_or(())?;
            let per_cast = p.get("SummonedMinionsPerCast").copied().ok_or(())?;
            let speed = p.get("HitSpeed").or_else(|| p.get("Speed")).copied().ok_or(())?;
            set(sd, "hitTimeOverride", 1.0 / (per_cast * speed));
        }
        // Blood Sacrament's initialFunc is run in offence.rs (before calcAreaOfEffect).
        "BloodSacramentUnique" => {}
        // ---- r6_hooks: alt-quality variants of ported hooks (bodies identical unless noted) ----
        "ToxicRainAltY" => {
            set(sd, "dpsMultiplier", n(sd, "podOverlapMultiplier").unwrap_or(1.0).min(out(c, "ProjectileCount")));
        }
        "StormRainAltX" => {
            if c.skill_part == 2 {
                let hf = n(sd, "hitFrequency").ok_or(())?;
                set(sd, "hitTimeOverride", hf / (1.0 + sum(sml, ModType::Inc, cfg, &["StormRainBeamFrequency"]) / 100.0));
                set(sd, "dpsMultiplier", n(sd, "activeArrowMultiplier").unwrap_or(1.0).min(sum(sml, ModType::Base, cfg, &["StormRainAllowedStormArrows"])));
            }
        }
        "StormRainAltY" => {
            if c.skill_part == 2 {
                let hf = n(sd, "hitFrequency").ok_or(())?;
                set(sd, "hitTimeOverride", hf / (1.0 + sum(sml, ModType::Inc, cfg, &["StormRainBeamFrequency"]) / 100.0));
                set(sd, "dpsMultiplier", sum(sml, ModType::Base, cfg, &["StormRainAllowedStormArrows"]));
            }
        }
        "DivineIreAltY" => {
            set(sd, "hitTimeMultiplier", sum(sml, ModType::Base, cfg, &["Multiplier:DivineIreofDisintegrationStage"]));
        }
        "IncinerateAltX" => {
            if c.skill_part == 2 {
                let v = sum(sml, ModType::Base, cfg, &["Multiplier:IncinerateofExpanseStage"]) - sum(sml, ModType::Base, cfg, &["Multiplier:IncinerateMinimumStage"]) - 0.4175;
                set(sd, "hitTimeMultiplier", v.max(0.5825));
            }
        }
        "IceSpearAltX" => {
            if c.skill_part == 3 || c.skill_part == 4 {
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * out(c, "ProjectileCount"));
            }
        }
        "PerforateAltX" | "PerforateAltY" => set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0).max(1.0)),
        "GalvanicFieldAltX" => set(sd, "hitTimeOverride", n(sd, "repeatFrequency").ok_or(())?),
        "StormBrandAltX" | "BrandSupport" => {
            let rf = n(sd, "repeatFrequency").ok_or(())?;
            set(sd, "hitTimeOverride", rf / (1.0 + sum(sml, ModType::Inc, cfg, &["Speed", "BrandActivationFrequency"]) / 100.0) / more(sml, cfg, &["BrandActivationFrequency"]));
        }
        "LancingSteelAltX" => {
            if c.skill_part == 2 {
                let pc = out(c, "ProjectileCount");
                let percent_reduced = (pc - 1.0) / pc;
                let mult = (more(sml, cfg, &["LancingSteelSubsequentDamage"]) - 1.0) * 100.0 * percent_reduced;
                set(sd, "dpsMultiplier", pc);
                sml.add_mod(mk("Damage", ModType::More, mult, "Skill:LancingSteelAltX", 0, vec![]));
            }
        }
        "ShrapnelBallistaAltX" => {
            if !sml.flag(None, &[pom_engine::sym!("SequentialProjectiles")]) {
                let pc = out(c, "ProjectileCount");
                let overlap = n(sd, "ShrapnelBallistaProjectileOverlap").unwrap_or(if c.skill_types.contains(&pom_skills::skill_type::RAIN) { pc } else { 1.0 });
                set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * overlap.min(pc));
            }
            let split = out(c, "SplitCount");
            if split > 0.0 {
                let tag = Tag { kind: pom_engine::sym!("Condition"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from("ReturningProjectile")))] };
                sml.add_mod(mk("DPS", ModType::More, split * 100.0, "Split Return", 0, vec![tag]));
            }
        }
        "FlamethrowerTrapAltX" => {
            let duration = c.out.get("Duration").copied().ok_or(())?;
            let cooldown = c.out.get("TrapCooldown").copied().ok_or(())?;
            let average_active_traps = duration / cooldown;
            global_out.insert("AverageActiveTraps".to_string(), average_active_traps);
            set(sd, "hitTimeOverride", 0.1);
            set(sd, "dpsMultiplier", n(sd, "dpsMultiplier").unwrap_or(1.0) * average_active_traps);
        }
        "HeraldOfAsh" => {
            let overkill = n(sd, "hoaOverkill").unwrap_or(0.0);
            let more_burn = n(sd, "hoaMoreBurn").ok_or(())?;
            let pct = n(sd, "hoaOverkillPercent").ok_or(())?;
            set(sd, "FireDot", overkill * (1.0 + more_burn / 100.0) * pct);
        }
        "FrostBombAltY" => {
            let d = n(sd, "duration").ok_or(())?;
            let dm = c.out.get("DurationMod").copied().ok_or(())?;
            sml.add_mod(mk("Multiplier:100msFrostBombDuration", ModType::Base, (d * dm * 10.0).floor(), "Skill:FrostBombAltY", 0, vec![]));
        }
        // ---- Avenging Flame (Data/Skills/sup_str.lua:2543)
        "AvengingFlame" => {
            let total_life = n(sd, "triggerSourceTotemLife").unwrap_or(0.0);
            let add = total_life * n(sd, "lifeDealtAsFire").ok_or(())? / 100.0;
            let (fmax, fmin) = (n(sd, "FireMax").unwrap_or(0.0), n(sd, "FireMin").unwrap_or(0.0));
            set(sd, "FireMax", fmax + add);
            set(sd, "FireMin", fmin + add);
        }
        "DarkPactAltX" => {
            if c.is_totem {
                return Err(()); // needs TotemLife
            }
            let life = out(c, "Life");
            let add = life * n(sd, "percentageLifeSacrificed").ok_or(())? / 100.0 * (n(sd, "percentageSacrificedDealtAsChaos").ok_or(())? / 100.0);
            let (cmin, cmax) = (n(sd, "ChaosMin").ok_or(())?, n(sd, "ChaosMax").ok_or(())?);
            let a = if c.skill_part == 2 {
                add.floor()
            } else {
                let avg_casts = 7.0 / (1.0 + n(sd, "additionalRuinChance").unwrap_or(0.0).min(100.0) / 100.0);
                (add / avg_casts).floor()
            };
            set(sd, "ChaosMin", cmin + a);
            set(sd, "ChaosMax", cmax + a);
        }
        "ChargedDash" | "ChargedDashAltX" if c.skill_part == 3 => {
            // skill_part == 3 (the other parts are matched below)
            let m = sum(sml, ModType::Inc, cfg, &["chargedDashFinalDamageModifier"]);
            let tag = Tag { kind: pom_engine::sym!("Release Damage"), fields: vec![(pom_engine::sym!("skillPart"), Value::Num(3.0))] };
            let src = format!("Skill:{}", c.id);
            sml.add_mod(mk("Damage", ModType::More, m, &src, 1u64, vec![tag]));
        }
        "Cyclone"| "CycloneAltX" | "VaalCyclone" => {}
        // Explosive Arrow only defines `explosiveArrowFunc`, run in the pass loop (offence.rs).
        "ExplosiveArrow" => {}
        // ---- parts that need no work ----------------------------------------------------------
        "ChargedDash" | "ChargedDashAltX" if c.skill_part != 3 => {}
        _ => return Err(()),
    }
    Ok(())
}
