//! Overlapping explosions (not in upstream). A skill whose projectiles are thrown from the player and only explode in an
//! area where they land (Poisonous/Explosive Concoction, Forbidden Rite) shotguns: every bottle of a volley lands on
//! the target and each explosion is its own hit, so it applies its own poison, bleed and ignite. Upstream has no option for
//! it and counts one explosion per throw. The option `projectileOverlap` ("# of Overlapping Projectiles") multiplies
//! `skillData.dpsMultiplier` the way upstream's Shrapnel Ballista option does (Data/Skills/act_dex.lua:13781), which scales
//! hit DPS and the poison, bleed and ignite stack counts (CalcOffence.lua 3801, 4446, 4727, 5032).
//!
//! The class is read from game data, never a skill name: the gem stat of the registry class `projectile-explode-only`
//! (`engine-data/mechanic_classes.json`), skill types Projectile + Area + ProjectilesFromUser, and not Chains (the
//! Bouncing variant throws one bottle that bounces). Projectiles fired from a mine, an orb or the sky (Pyroclast Mine,
//! Winter Orb, Cremation) are not thrown at the target, so they are out.
//!
//! Default: every projectile overlaps. The bottles are thrown at the cursor and land in a tight spread inside their
//! own explosion radius, so on one boss all of them hit; upstream defaults its Shrapnel Ballista overlap to max the same way
//! for Rain skills, whose projectiles all land on the target spot, and to 1 only for a cone of single-target bolts.
//! `POM_STRICT_COMPAT=1` makes an unset option mean 1 (upstream's numbers), for comparing with upstream.
use pom_engine::fxhash::{HashMap, HashSet};
use pom_skills::skill_type as st;

/// The config var.
pub const VAR: &str = "projectileOverlap";

/// Is `ge_id` (with its live skill types) of the overlap class?
pub fn is_class(ge_id: &str, types: &HashSet<i64>) -> bool {
    if !(types.contains(&st::PROJECTILE) && types.contains(&st::AREA) && types.contains(&st::PROJECTILES_FROM_USER)) || types.contains(&st::CHAINS) {
        return false;
    }
    let Some(class) = crate::solver::clear::registry().class("projectile-explode-only") else { return false };
    pom_skills::data::granted_effect_by_skill_id(ge_id).is_some_and(|ge| ge.stats.iter().any(|s| class.stat_ids.contains(s)))
}

/// The overlap count the engine applies, or None when the skill is not of the class or fires its projectiles one after
/// another (`SequentialProjectiles`: upstream already counts each one, CalcOffence.lua:803). The player's value, at least 1
/// and at most the projectile count; unset (or 0) = every projectile.
pub fn overlap(ge_id: &str, types: &HashSet<i64>, sequential: bool, projectile_count: f64, input: &HashMap<String, f64>) -> Option<f64> {
    if sequential || !is_class(ge_id, types) {
        return None;
    }
    let pc = projectile_count.max(1.0);
    let set = input.get(VAR).copied().filter(|v| *v > 0.0);
    let parity = pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1");
    Some(set.unwrap_or(if parity { 1.0 } else { pc }).clamp(1.0, pc))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types(ge: &str) -> HashSet<i64> {
        pom_skills::data::skill_types(pom_skills::data::granted_effect_by_skill_id(ge).unwrap())
    }

    #[test]
    fn class_from_game_data() {
        for ge in ["PoisonousConcoction", "ExplosiveConcoction", "ForbiddenRite"] {
            assert!(is_class(ge, &types(ge)), "{ge}");
        }
        // bouncing (Chains), mine/orb/corpse projectiles, ordinary projectiles
        for ge in ["PoisonousConcoctionAltX", "PyroclastMine", "WinterOrb", "Cremation", "ShrapnelBallista", "Spark"] {
            assert!(!is_class(ge, &types(ge)), "{ge}");
        }
    }

    #[test]
    fn overlap_default_and_player_value() {
        let t = types("PoisonousConcoction");
        let mut input = HashMap::default();
        assert_eq!(overlap("PoisonousConcoction", &t, false, 8.0, &input), Some(8.0));
        assert_eq!(overlap("PoisonousConcoction", &t, true, 8.0, &input), None);
        input.insert(VAR.to_string(), 3.0);
        assert_eq!(overlap("PoisonousConcoction", &t, false, 8.0, &input), Some(3.0));
        input.insert(VAR.to_string(), 20.0);
        assert_eq!(overlap("PoisonousConcoction", &t, false, 8.0, &input), Some(8.0));
    }

    /// A pconc build with Greater Volley + GMP (6 projectiles): hit DPS and poison DPS are 6x one bottle's by
    /// default, and upstream's 1x with the option at 1.
    #[test]
    fn pconc_volley_build_overlaps() {
        let xml = std::fs::read_to_string(format!("{}/testdata/pconc-gmp.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let mut s = crate::session::Session::new(xml, pom_calc::data::game_data());
        let p = |st: &crate::session::Stats, k: &str| st.stats["player"][k].as_f64().unwrap_or(0.0);
        let def = s.calc().unwrap();
        let one = s.set_config(VAR, Some(crate::edit::ConfigValue::Num(1.0))).unwrap();
        let pc = p(&def, "ProjectileCount");
        assert_eq!(pc, 6.0);
        for k in ["TotalDPS", "TotalPoisonDPS"] {
            assert!(p(&one, k) > 0.0, "{k}");
            assert!((p(&def, k) / p(&one, k) - pc).abs() < 1e-6, "{k}: default {} vs at 1 {}", p(&def, k), p(&one, k));
        }
    }

    /// What the solver sees when it tries Greater Multiple Projectiles (group 8, gem 4 of the fixture): with overlap it
    /// raises single-target DPS; at upstream's 1 its less damage makes it a loss.
    #[test]
    fn gmp_gains_value_through_overlap() {
        let xml = std::fs::read_to_string(format!("{}/testdata/pconc-gmp.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let mut s = crate::session::Session::new(xml, pom_calc::data::game_data());
        let p = |st: &crate::session::Stats| st.stats["player"]["CombinedDPS"].as_f64().unwrap_or(0.0);
        let with = p(&s.calc().unwrap());
        let without = p(&s.set_gem(8, 4, "enabled", Some("false")).unwrap());
        s.set_config(VAR, Some(crate::edit::ConfigValue::Num(1.0))).unwrap();
        let without_1 = p(&s.calc().unwrap());
        let with_1 = p(&s.set_gem(8, 4, "enabled", None).unwrap());
        assert!(with > without * 1.5, "GMP gains through overlap");
        assert!(with_1 < without_1, "at 1 GMP is a loss, as upstream sees it");
    }

    /// The Config tab shows the option on the pconc build, its empty field reading the projectile count, and hides it on
    /// a build of another skill.
    #[test]
    fn config_tab_shows_it_for_the_class_only() {
        let state = |file: &str| {
            let xml = std::fs::read_to_string(format!("{}/testdata/{file}", env!("CARGO_MANIFEST_DIR"))).unwrap();
            let mut s = crate::session::Session::new(xml.clone(), pom_calc::data::game_data());
            let stats = s.calc().unwrap().stats["player"].as_object().cloned().unwrap_or_default();
            s.inspect_main(|env, main| crate::tabdata_config::config_state(&xml, env, main, &stats)).unwrap().unwrap()
        };
        let p = state("pconc-gmp.xml");
        assert_eq!(p["shown"][VAR], serde_json::json!(true));
        assert_eq!(p["placeholders"][VAR], serde_json::json!(6));
        let o = state("legal3-spark.xml");
        assert_eq!(o["shown"][VAR], serde_json::json!(false));
        assert!(crate::tabdata_config::config_catalog()["options"].as_array().unwrap().iter().any(|o| o["var"] == VAR));
    }
}
