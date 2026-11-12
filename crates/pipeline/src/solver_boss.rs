//! Bossing score: damage against one Pinnacle enemy and the bossing defence term.
//! Pure functions over engine outputs, keyed on stat names, never on item or skill names. The caller supplies the
//! outputs (`o`); nothing here reads a build.

pub const DMG_TYPES: [&str; 5] = ["Physical", "Fire", "Cold", "Lightning", "Chaos"];

type Out<'a> = &'a dyn Fn(&str) -> Option<f64>;

/// Single-target damage per second: `CombinedDPS` without the cull part (culling kills normal and magic enemies, or rares
/// at the end of a fight, so no boss takes it).
pub fn single_dps(o: Out) -> f64 {
    let combined = o("CombinedDPS").unwrap_or(0.0);
    // CombinedDPS = hit * cull multiplier * reservation multiplier; CullingDPS = hit * (cull multiplier - 1).
    let rm = o("ReservationDpsMultiplier").filter(|r| *r > 0.0).unwrap_or(1.0);
    let cull = (o("CullingDPS").unwrap_or(0.0) * rm).clamp(0.0, combined.max(0.0));
    // Damage that needs the player to keep moving (a ground effect dropped as he walks, `MovingGroundDPS`, solver.rs
    // solver_stat) is not damage on a boss that stands still.
    let ground = o("MovingGroundDPS").unwrap_or(0.0).clamp(0.0, combined - cull);
    let base = (combined - cull - ground).max(0.0);
    // A skill whose cost the build cannot pay at the scored use rate is scored at the rate it can pay: the part that
    // needs every cast (the hit, the poison, ignite and bleed those hits apply) scales with it; the skill's own
    // damage over time (one application lasts) stays.
    let f = sustain_rate(o);
    let spam = (o("TotalDPS").unwrap_or(0.0) + o("TotalPoisonDPS").unwrap_or(0.0) + o("TotalIgniteDPS").or(o("IgniteDPS")).unwrap_or(0.0) + o("BleedDPS").unwrap_or(0.0)).clamp(0.0, base);
    base - spam * (1.0 - f)
}

/// The share of the scored use rate the build can pay for, 1 when every cost is covered: for each resource the skill
/// spends per second (mana, life, energy shield), what recovers per second (regeneration, leech, recharge) over that
/// cost. Life reads the regeneration net of the build's own degeneration (solver.rs `life_regen_net`).
pub fn sustain_rate(o: Out) -> f64 {
    let mut f = 1.0f64;
    let mut take = |cost: Option<f64>, rec: f64| {
        if let Some(c) = cost.filter(|c| *c > 1e-9) {
            f = f.min((rec / c).clamp(0.0, 1.0));
        }
    };
    let g = |k: &str| o(k).unwrap_or(0.0);
    take(o("ManaPerSecondCost"), g("ManaRegenRecovery") + g("ManaLeechGainRate"));
    take(o("ESPerSecondCost"), g("EnergyShieldRecharge") + g("EnergyShieldRegenRecovery") + g("EnergyShieldLeechGainRate"));
    take(o("LifePerSecondCost"), crate::solver::life_regen_net(&o).unwrap_or(0.0) + g("LifeLeechGainRate"));
    f
}

/// Hit damage per second against the boss. Targets = 1, and explode, herald and on-kill terms are not read at all:
/// only the hit is, with no culling credit.
pub fn boss_dps(o: Out, attack_time_share: f64) -> f64 {
    single_dps(o) * attack_time_share
}

/// The boss's configured hit of one damage type, as the engine reads it for the build: the config input when set,
/// else the placeholder the enemy preset (Pinnacle, Uber or a boss skill preset) filled in. Never a constant here.
pub fn boss_hit_of<S: std::hash::BuildHasher>(input: &std::collections::HashMap<String, f64, S>, placeholder: &std::collections::HashMap<String, f64, S>, ty: &str) -> f64 {
    let k = format!("enemy{ty}Damage");
    input.get(&k).or_else(|| placeholder.get(&k)).copied().unwrap_or(0.0)
}

/// The type whose maximum hit is closest to (or furthest under) the boss's hit of that type.
/// `MaximumHitTaken` is in the units of the config's `enemy<Type>Damage` (the engine divides out the enemy damage
/// multiplier) and already counts the boss's penetration, so the two compare directly. Same numbers as upstream's own
/// maximum-hit lines; `TotalNumberOfHits` mixes the five types into one average and cannot name the weak one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Worst {
    pub ratio: f64,
    pub ty: usize,
    pub boss_hit: f64,
    pub max_hit: f64,
}

/// Lowest max-hit / boss-hit over the types the boss hits for; None when it hits for nothing (a degen preset).
pub fn worst_hit(o: Out, hit: &dyn Fn(&str) -> f64) -> Option<Worst> {
    DMG_TYPES
        .iter()
        .enumerate()
        .filter_map(|(ty, t)| {
            let (h, m) = (hit(t), o(&format!("{t}MaximumHitTaken"))?);
            (h > 0.0 && m.is_finite()).then_some(Worst { ratio: m / h, ty, boss_hit: h, max_hit: m })
        })
        .min_by(|a, b| a.ratio.partial_cmp(&b.ratio).unwrap_or(std::cmp::Ordering::Equal))
}

/// One boss skill preset's hit per damage type (the engine's own preset path, 70% roll) and its penetration.
#[derive(Debug, Clone, PartialEq)]
pub struct PresetHit {
    pub name: String,
    pub hit: [f64; 5],
    pub pen: [f64; 5],
}

static PRESETS: std::sync::Mutex<Option<std::sync::Arc<Vec<PresetHit>>>> = std::sync::Mutex::new(None);

/// The presets the search compares every candidate with (set once per solve; the Pinnacle table does not depend on the build).
pub fn set_presets(v: Vec<PresetHit>) {
    *PRESETS.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::sync::Arc::new(v));
}

pub fn presets() -> std::sync::Arc<Vec<PresetHit>> {
    PRESETS.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default()
}

/// Each preset's hit and penetration, read from the config the engine fills in when `presetBossSkills` is set on
/// `base` (one evaluation per preset, once per solve). Never recomputed here.
pub fn preset_table(base: &str) -> Vec<PresetHit> {
    let mut session = crate::session::Session::new(base.to_string(), pom_calc::data::game_data());
    preset_names()
        .into_iter()
        .filter_map(|name| {
            let x = crate::edit::set_config_input(base, "presetBossSkills", Some(&crate::edit::ConfigValue::Str(name.clone()))).ok()?;
            let (hit, pen) = session
                .eval_xml(&x, false, |env| {
                    let g = |k: String| env.config_input.get(&k).or_else(|| env.config_placeholder.get(&k)).copied().unwrap_or(0.0);
                    (DMG_TYPES.map(|t| g(format!("enemy{t}Damage"))), DMG_TYPES.map(|t| g(format!("enemy{t}Pen"))))
                })
                .ok()?;
            Some(PresetHit { name, hit, pen })
        })
        .collect()
}

/// The build's weakest type against one preset, from the outputs of the Pinnacle evaluation. The max hit is moved
/// to the preset's penetration: the engine takes `1 - (resist - pen) / 100` of a hit, so the hit that kills scales by
/// the ratio of that factor at the evaluated pen to the preset's (first order: flat reductions are not rescaled).
/// None when the preset hits for nothing.
pub fn preset_worst(p: &PresetHit, o: Out) -> Option<Worst> {
    DMG_TYPES
        .iter()
        .enumerate()
        .filter(|(ty, _)| p.hit[*ty] > 0.0)
        .filter_map(|(ty, t)| {
            let m = o(&format!("{t}MaximumHitTaken"))?;
            let res = o(&format!("{t}ResistWhenHit")).or_else(|| o(&format!("{t}Resist"))).unwrap_or(0.0);
            let now = o(&format!("{t}EnemyPen")).unwrap_or(0.0);
            let adj = (1.0 - (res - now) / 100.0).max(0.01) / (1.0 - (res - p.pen[ty]) / 100.0).max(0.01);
            let max_hit = m * adj;
            Some(Worst { ratio: max_hit / p.hit[ty], ty, boss_hit: p.hit[ty], max_hit })
        })
        .min_by(|a, b| a.ratio.partial_cmp(&b.ratio).unwrap_or(std::cmp::Ordering::Equal))
}

/// Sum over the presets of how far short the build is (0 = survives, 0.6 = the hit is 60% over its max hit).
/// Relative, so +1k on a 13k hit costs little and +18k on a 31k hit costs a lot. A build that survives all gets 0.
/// A long wind-up preset (`long_windup`) is left out: a player walks out of it.
pub fn preset_shortfall(presets: &[PresetHit], o: Out) -> f64 {
    presets.iter().filter(|p| !long_windup(&p.name)).filter_map(|p| preset_worst(p, o)).map(|w| (1.0 - w.ratio).max(0.0)).sum()
}

/// The lowest max-hit / preset-hit ratio over the counted presets (`NO_HIT_RATIO` when none hits): how many times over
/// the build survives its worst boss skill. The bossing EHP knee reads it.
pub fn preset_min_ratio(presets: &[PresetHit], o: Out) -> f64 {
    presets.iter().filter(|p| !long_windup(&p.name)).filter_map(|p| preset_worst(p, o)).map(|w| w.ratio).fold(NO_HIT_RATIO, f64::min)
}

/// A wind-up this many times the median of every preset's (data `bossSkills` `speed`, ms) is long: Atziri Flameblast's
/// 25 s against a 2.07 s median (cutoff 8.3 s; Maven Memory Game's 7.5 s and the rest, 1-3.5 s, count).
const LONG_WINDUP: f64 = 4.0;

/// A boss skill preset whose wind-up is long enough to walk out of: its one-shot chip still shows,
/// but it does not count against "Survives every boss skill" or the score.
pub fn long_windup(name: &str) -> bool {
    static SPEEDS: std::sync::OnceLock<(Vec<(String, f64)>, f64)> = std::sync::OnceLock::new();
    let (speeds, median) = SPEEDS.get_or_init(|| {
        let Ok(Some(all)) = pom_skills::data::game_data().extra.get("bossSkills") else { return (Vec::new(), 0.0) };
        let all = all.to_value();
        let v: Vec<(String, f64)> = preset_names().into_iter().filter_map(|n| all.get(&n).and_then(|b| b.get("speed")).and_then(|s| s.as_f64()).map(|s| (n, s))).collect();
        let mut s: Vec<f64> = v.iter().map(|x| x.1).collect();
        s.sort_by(f64::total_cmp);
        let m = match s.len() {
            0 => 0.0,
            n if n % 2 == 1 => s[n / 2],
            n => (s[n / 2 - 1] + s[n / 2]) / 2.0,
        };
        (v, m)
    });
    *median > 0.0 && speeds.iter().any(|(n, s)| n == name && *s > LONG_WINDUP * median)
}

/// What a Pinnacle-less hit reads as in the score: far above any ratio that matters.
pub const NO_HIT_RATIO: f64 = 100.0;

/// The ratio the score takes half a log of (held to 0.25..2 in `boss_score`).
pub fn defence_ratio(w: Option<Worst>) -> f64 {
    w.map_or(NO_HIT_RATIO, |w| w.ratio).clamp(0.25, 2.0)
}

/// Pieces of the score, for result text.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BossBreakdown {
    pub dps: f64,
    pub ehp: f64,
    pub worst: Option<Worst>,
    pub score: f64,
}

impl BossBreakdown {
    /// From a result's stored numbers (the solver keeps BossDPS, EHP and the worst type's hit and max hit).
    pub fn from_parts(dps: f64, ehp: f64, worst: Option<Worst>) -> Self {
        BossBreakdown { dps, ehp, worst, score: dps.max(1e-3).ln() + ehp.max(1e-3).ln() + 0.5 * defence_ratio(worst).ln() }
    }

    pub fn text(&self) -> String {
        let w = self.worst.map_or("the boss hits for nothing".to_string(), |w| format!("weakest {} max hit {:.0} against a boss hit of {:.0} (x{:.2})", DMG_TYPES[w.ty], w.max_hit, w.boss_hit, w.ratio));
        format!("Boss DPS {:.0}, EHP {:.0}, {w}, boss score {:.3}", self.dps, self.ehp, self.score)
    }
}

/// `ln(BossDPS) + ln(EHP) + 0.5 * ln(defence ratio)`. `ehp` is the caller's (knee-held) EHP.
pub fn boss_breakdown(o: Out, hit: &dyn Fn(&str) -> f64, ehp: f64, attack_time_share: f64) -> BossBreakdown {
    BossBreakdown::from_parts(boss_dps(o, attack_time_share), ehp, worst_hit(o, hit))
}

pub fn boss_score(o: Out, hit: &dyn Fn(&str) -> f64, ehp: f64, attack_time_share: f64) -> f64 {
    boss_breakdown(o, hit, ehp, attack_time_share).score
}

/// The boss skill presets of the config's dropdown (data `bossSkillsList`), "None" left out: a patch that adds a boss
/// adds it here with no code change.
pub fn preset_names() -> Vec<String> {
    let Ok(Some(list)) = pom_skills::data::game_data().extra.get("bossSkillsList") else { return Vec::new() };
    let list = list.to_value();
    list.as_array().into_iter().flatten().filter_map(|e| e.get("val").and_then(|v| v.as_str())).filter(|v| *v != "None").map(String::from).collect()
}

/// A chip per preset whose hit one-shots the build ("needs +8k Cold max hit"). `eval` evaluates the build under a
/// preset and returns its weakest type; None (a degen preset, nothing evaluated) makes no chip. Info only: the score
/// reads the Pinnacle hit.
pub fn boss_chips(presets: &[String], eval: &dyn Fn(&str) -> Option<Worst>) -> Vec<String> {
    presets
        .iter()
        .filter_map(|p| {
            let w = eval(p)?;
            (w.ratio < 1.0).then(|| format!("One-shot by {p} (needs +{:.0}k {} max hit)", (w.boss_hit - w.max_hit) / 1000.0, DMG_TYPES[w.ty]))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn outs(extra: &[(&str, f64)]) -> HashMap<String, f64> {
        let mut m: HashMap<String, f64> = [("CombinedDPS", 1_000_000.0), ("CullingDPS", 0.0)].iter().map(|(k, v)| (k.to_string(), *v)).collect();
        for t in DMG_TYPES {
            m.insert(format!("{t}MaximumHitTaken"), 40_000.0);
        }
        m.extend(extra.iter().map(|(k, v)| (k.to_string(), *v)));
        m
    }

    /// Atziri Flameblast (25 s wind-up in the data) shows its chip but does not count against the
    /// survive limit; the other presets (Maven Memory Game 7.5 s, the rest 1-3.5 s) still do.
    #[test]
    fn long_windup_preset_does_not_count() {
        assert!(long_windup("Atziri Flameblast"));
        for p in preset_names().iter().filter(|p| *p != "Atziri Flameblast") {
            assert!(!long_windup(p), "{p} counted as a long wind-up");
        }
        let m = outs(&[]);
        let fb = [PresetHit { name: "Atziri Flameblast".into(), hit: [0.0, 80_000.0, 0.0, 0.0, 0.0], pen: [0.0; 5] }];
        assert_eq!(preset_shortfall(&fb, &|k| m.get(k).copied()), 0.0, "Flameblast still counts against the limit");
        let w = Worst { ratio: 0.5, ty: 1, boss_hit: 80_000.0, max_hit: 40_000.0 };
        assert_eq!(boss_chips(&["Atziri Flameblast".to_string()], &|_| Some(w)).len(), 1, "the chip still shows");
    }

    #[test]
    fn on_kill_effects_give_no_boss_credit() {
        let plain = outs(&[]);
        let kill = outs(&[("ExplodeAverageDamage", 5e6), ("ExplodeChance", 1.0), ("LifeOnKill", 100.0), ("HeraldDPS", 9e5)]);
        let (a, b) = (boss_dps(&|k| plain.get(k).copied(), 1.0), boss_dps(&|k| kill.get(k).copied(), 1.0));
        assert_eq!(a, b);
    }

    #[test]
    fn single_target_dps_has_no_cull() {
        // CombinedDPS 1.5M holds 0.5M of cull on a 1.0M base: a boss is not culled.
        let m = outs(&[("CombinedDPS", 1_500_000.0), ("CullingDPS", 500_000.0)]);
        let d = boss_dps(&|k| m.get(k).copied(), 1.0);
        assert!((d - 1_000_000.0).abs() < 1.0, "{d}");
        assert!((single_dps(&|k| m.get(k).copied()) - 1_000_000.0).abs() < 1.0);
    }

    /// Boots that drop Burning Ground while moving: the boss does not stand on the trail.
    #[test]
    fn ground_that_needs_moving_is_no_single_target_damage() {
        let m = outs(&[("CombinedDPS", 80_000.0), ("TotalDPS", 42_000.0), ("MovingGroundDPS", 38_000.0)]);
        let d = single_dps(&|k| m.get(k).copied());
        assert!((d - 42_000.0).abs() < 1.0, "{d}");
    }

    /// Essence Drain's spam. 2.96 casts a second at 107 ES each is 317/s against 161/s of recharge: half the casts.
    /// The skill's own DoT stays (one application lasts); the hit and the poison from hits go to the paid rate.
    #[test]
    fn cost_that_cannot_be_paid_is_scored_at_the_paid_rate() {
        let m = outs(&[("CombinedDPS", 900_000.0), ("TotalDPS", 136_000.0), ("TotalPoisonDPS", 216_000.0), ("TotalDot", 548_000.0), ("ESPerSecondCost", 322.0), ("EnergyShieldRecharge", 161.0), ("ManaPerSecondCost", 0.0)]);
        let d = single_dps(&|k| m.get(k).copied());
        assert!((d - (900_000.0 - 0.5 * 352_000.0)).abs() < 1.0, "{d}");
        let paid = outs(&[("CombinedDPS", 900_000.0), ("TotalDPS", 136_000.0), ("ESPerSecondCost", 100.0), ("EnergyShieldRecharge", 161.0)]);
        assert!((single_dps(&|k| paid.get(k).copied()) - 900_000.0).abs() < 1.0, "a paid cost changes nothing");
        assert!((sustain_rate(&|k| m.get(k).copied()) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn cull_split_holds_with_a_reservation_multiplier() {
        // hit 1.0M, cull x1.5, reservation x1.2: Combined 1.8M, Culling 0.5M. Hit part 1.2M, no cull.
        let m = outs(&[("CombinedDPS", 1_800_000.0), ("CullingDPS", 500_000.0), ("ReservationDpsMultiplier", 1.2)]);
        let d = boss_dps(&|k| m.get(k).copied(), 1.0);
        assert!((d - 1_200_000.0).abs() < 1.0, "{d}");
    }

    #[test]
    fn weak_damage_type_scores_lower() {
        let even = outs(&[]);
        let weak = outs(&[("ChaosMaximumHitTaken", 9_000.0)]);
        let hit = |_: &str| 30_000.0;
        let s = |m: &HashMap<String, f64>| boss_score(&|k| m.get(k).copied(), &hit, 1e6, 1.0);
        assert!(s(&weak) < s(&even), "{} vs {}", s(&weak), s(&even));
        let w = worst_hit(&|k| weak.get(k).copied(), &hit).unwrap();
        assert_eq!((w.ty, w.max_hit), (4, 9_000.0));
    }

    /// A hand-made poison build, named by `POM_HAND_BUILD_XML`; the tests that read it skip when it is not set.
    fn hand_build() -> Option<String> {
        std::fs::read_to_string(std::env::var("POM_HAND_BUILD_XML").ok()?).ok()
    }

    /// The boss hit per type is the engine's own configured enemy damage: its five types add up to the
    /// `totalEnemyDamageIn` the build's calc (and pom-cli) prints for enemyIsBoss = Pinnacle.
    #[test]
    fn boss_hit_per_type_is_the_engines_enemy_damage() {
        let Some(xml) = hand_build() else { return };
        let xml = crate::edit::set_config_input(&xml, "enemyIsBoss", Some(&crate::edit::ConfigValue::Str("Pinnacle".into()))).unwrap();
        let mut s = crate::session::Session::new(xml.clone(), pom_calc::data::game_data());
        let (hits, total, worst) = s
            .eval_xml(&xml, false, |env| {
                let hits: Vec<f64> = DMG_TYPES.iter().map(|t| boss_hit_of(&env.config_input, &env.config_placeholder, t)).collect();
                let o = |k: &str| env.output.get(k).copied();
                (hits, o("totalEnemyDamageIn").unwrap_or(0.0), worst_hit(&o, &|t| boss_hit_of(&env.config_input, &env.config_placeholder, t)))
            })
            .unwrap();
        println!("boss hit per type {hits:?}, totalEnemyDamageIn {total}, worst {worst:?}");
        assert!(hits.iter().all(|h| *h > 0.0));
        assert!((hits.iter().sum::<f64>() - total).abs() < 1e-6, "{hits:?} vs {total}");
        assert!(worst.is_some_and(|w| w.ratio > 0.0));
    }

    /// One-shot chips come from the presets list; a preset with no hit makes none, a safe one makes none.
    #[test]
    fn chips_name_one_shots_with_the_gap() {
        let eval = |p: &str| match p {
            "Sirus Meteor" => Some(Worst { ratio: 0.6, ty: 2, boss_hit: 20_000.0, max_hit: 12_000.0 }),
            "Shaper Beam" => None,
            _ => Some(Worst { ratio: 1.4, ty: 0, boss_hit: 10_000.0, max_hit: 14_000.0 }),
        };
        let chips = boss_chips(&["Sirus Meteor".into(), "Shaper Beam".into(), "Maven Fireball".into()], &eval);
        assert_eq!(chips, vec!["One-shot by Sirus Meteor (needs +8k Cold max hit)".to_string()]);
    }

    /// By hand: the poison-claws hand build under a Pinnacle: what BossDPS reads against FullDPS.
    #[test]
    #[ignore]
    fn hand_build_boss_dps() {
        let xml = hand_build().expect("POM_HAND_BUILD_XML: the hand build to run");
        let xml = crate::edit::set_config_input(&xml, "enemyIsBoss", Some(&crate::edit::ConfigValue::Str("Pinnacle".into()))).unwrap();
        let mut s = crate::session::Session::new(xml.clone(), pom_calc::data::game_data());
        let names = ["FullDPS", "CombinedDPS", "TotalDPS", "TotalDotDPS", "CullingDPS", "Solver.BossDPS", "Solver.AttackTimeShare", "TotalEHP", "Solver.BossHitRatio"];
        let v: Vec<Option<f64>> = s.eval_xml(&xml, true, |env| names.iter().map(|n| crate::stat_value(env, n)).collect()).unwrap();
        for (n, x) in names.iter().zip(&v) {
            println!("{n} = {x:?}");
        }
        let s_eval = |x: &str| -> Option<Worst> {
            let mut s = crate::session::Session::new(x.to_string(), pom_calc::data::game_data());
            s.eval_xml(x, false, |env| {
                let o = |k: &str| env.output.get(k).copied();
                worst_hit(&o, &|t| boss_hit_of(&env.config_input, &env.config_placeholder, t))
            })
            .unwrap()
        };
        let eval = |preset: &str| {
            let x = crate::edit::set_config_input(&xml, "presetBossSkills", Some(&crate::edit::ConfigValue::Str(preset.into()))).unwrap();
            let w = s_eval(&x);
            println!("{preset}: {w:?}");
            w
        };
        let table = preset_table(&xml);
        let mut base = crate::session::Session::new(xml.clone(), pom_calc::data::game_data());
        for p in &table {
            let w = base.eval_xml(&xml, false, |env| preset_worst(p, &|k| env.output.get(k).copied())).unwrap();
            println!("analytic {}: {w:?}", p.name);
        }
        println!("presets {:?}", preset_names());
        println!("chips {:?}", boss_chips(&preset_names(), &eval));
    }

    /// By hand: a 240 s Templar Flicker Strike mid-league bossing solve; prints the score and each target's value.
    #[test]
    #[ignore]
    fn bossing_flicker_solve() {
        let goal = r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"combined"},{"name":"EHP","metric":"ehp"}],"limits":{"resists":75,"pool":3000,"attributes":true,"reservation":true,"warnings":true,"cost":true},"wealth":"mid-league","assume":{"flasks":true,"flaskUptime":"bossing","playMode":"bossing","ailments":true,"charges":true}}"#;
        let mut h = crate::solver::start(crate::solver::blank_build_xml(90), goal, &std::env::var("POM_SOLVE_OPTS").unwrap_or_else(|_| r#"{"timeBudgetMs":240000,"threads":2}"#.into())).unwrap();
        h.join();
        let (snap, _) = h.step(0, 0);
        assert!(snap.get("error").is_none(), "{snap}");
        for r in snap["results"].as_array().unwrap().iter().take(3) {
            println!("{} / {} score {} targets {}", r["className"], r["ascendancy"], r["score"], r["targets"]);
            println!("  breakdown {} chips {} items {}", r["bossBreakdown"], r["bossChips"], r["items"]);
        }
        println!("evals {} elapsed {}", snap["evaluations"], snap["elapsedMs"]);
    }
}
