//! Play focus: what the player is optimising for, asked every time. Decides the enemy, the flask uptime and how a
//! mapping score and a bossing score combine. Nothing here is keyed to item, skill or node names.
use super::{Assume, ConfigValue, FlaskUptime};
use crate::edit::set_config_input;
use serde::Deserialize;

/// Prefix of a stat name that is read from the text on the mapping enemy (Both mode's clear side).
pub const MAP: &str = "Map:";

/// The text on the mapping enemy: a plain map monster in a pack of `clear::PACK`. Kill-based switches stay as the text has
/// them (off, as for bossing): Both holds the clear side to the stricter profile.
pub fn mapping_text(x: &str) -> String {
    let p = PlayMode::Mapping.profile();
    let set = |t: String, k: &str, v: ConfigValue| set_config_input(&t, k, Some(&v)).unwrap_or(t);
    let t = set(x.to_string(), "enemyIsBoss", ConfigValue::Str(p.enemy_boss.into()));
    set(t, "multiplierNearbyEnemies", ConfigValue::Num(super::clear::PACK))
}

pub const NEED_MODE: &str = "Pick what the build is for to run: mapping, bossing or both.";

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PlayMode {
    Mapping,
    Bossing,
    Both,
}

/// What a mode sets, in one place.
pub struct ModeProfile {
    /// `enemyIsBoss` config value: set explicitly for every mode (Mapping: a plain map enemy, never Pinnacle).
    pub enemy_boss: &'static str,
    /// Kills refill flasks only when mapping; Bossing and Both count only charges the build generates.
    pub flask_uptime: FlaskUptime,
    /// Kill-based config switches count (mapping only; Both holds the build to the stricter side).
    pub kill_effects: bool,
}

impl PlayMode {
    pub fn profile(self) -> ModeProfile {
        match self {
            PlayMode::Mapping => ModeProfile { enemy_boss: "None", flask_uptime: FlaskUptime::Mapping, kill_effects: true },
            PlayMode::Bossing | PlayMode::Both => ModeProfile { enemy_boss: "Pinnacle", flask_uptime: FlaskUptime::Bossing, kill_effects: false },
        }
    }

    /// The enemy is a pinnacle boss (the "in your Presence" lines need one).
    pub fn pinnacle(self) -> bool {
        self.profile().enemy_boss == "Pinnacle"
    }

    /// The result-text line naming the mode and the enemy.
    pub fn assumption(self) -> &'static str {
        match self {
            PlayMode::Mapping => "Play focus: mapping. Enemy is a normal map monster, not a boss; kill-based effects count",
            PlayMode::Bossing => "Play focus: bossing. Enemy is a pinnacle boss; no kill-based effects",
            PlayMode::Both => "Play focus: both. Clear is scored on a normal map monster in a pack of five, boss on a pinnacle boss (no kill-based effects on either); the score is the weaker of the two, each compared with what typical builds of this skill reach",
        }
    }
}

impl Assume {
    /// The play focus. `Solver::new` refuses a goal without one, so past that gate this never falls back.
    pub fn mode(&self) -> PlayMode {
        self.play_mode.unwrap_or(PlayMode::Mapping)
    }

    /// Flask uptime in force: the mode's, unless the goal only sets the old `flaskUptime` while mapping.
    pub fn uptime(&self) -> FlaskUptime {
        match self.play_mode {
            None | Some(PlayMode::Mapping) => self.flask_uptime,
            Some(m) => m.profile().flask_uptime,
        }
    }
}

/// One score for the goal: Both is the weaker of the two once each is divided by its own bar, so neither side is
/// sacrificed. The result is in bar units (1.0 = both bars met) for Both; Mapping and Bossing return their raw score.
pub fn combine(mode: PlayMode, clear: f64, boss: f64, clear_bar: f64, boss_bar: f64) -> f64 {
    match mode {
        PlayMode::Mapping => clear,
        PlayMode::Bossing => boss,
        PlayMode::Both => (clear / clear_bar.max(f64::MIN_POSITIVE)).min(boss / boss_bar.max(f64::MIN_POSITIVE)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solver::Goal;

    fn mode_of(j: &str) -> Option<PlayMode> {
        serde_json::from_str::<Goal>(j).unwrap().assume.play_mode
    }

    #[test]
    fn parses_all_three_modes() {
        assert_eq!(mode_of(r#"{"skill":"Cleave","assume":{"playMode":"both"}}"#), Some(PlayMode::Both));
        assert_eq!(mode_of(r#"{"skill":"Cleave","assume":{"play_mode":"bossing"}}"#), Some(PlayMode::Bossing));
        // no default: flaskUptime alone never picks a mode
        assert_eq!(mode_of(r#"{"skill":"Cleave"}"#), None);
        assert_eq!(mode_of(r#"{"skill":"Cleave","assume":{"flaskUptime":"bossing"}}"#), None);
        // old field: flaskUptime still parses and applies while mapping
        let g: Goal = serde_json::from_str(r#"{"skill":"Cleave","assume":{"flaskUptime":"bossing"}}"#).unwrap();
        assert_eq!(g.assume.uptime(), FlaskUptime::Bossing);
        let g: Goal = serde_json::from_str(r#"{"skill":"Cleave","assume":{"playMode":"both","flaskUptime":"mapping"}}"#).unwrap();
        assert_eq!(g.assume.uptime(), FlaskUptime::Bossing);
    }

    #[test]
    fn enemy_follows_mode() {
        assert_eq!(PlayMode::Mapping.profile().enemy_boss, "None");
        assert_eq!(PlayMode::Bossing.profile().enemy_boss, "Pinnacle");
        assert_eq!(PlayMode::Both.profile().enemy_boss, "Pinnacle");
        assert!(!PlayMode::Mapping.pinnacle() && PlayMode::Bossing.pinnacle() && PlayMode::Both.pinnacle());
    }

    #[test]
    fn both_is_the_weaker_normalised_score() {
        assert_eq!(combine(PlayMode::Both, 200.0, 50.0, 100.0, 100.0), 0.5);
        assert_eq!(combine(PlayMode::Both, 60.0, 500.0, 100.0, 100.0), 0.6);
        assert_eq!(combine(PlayMode::Mapping, 7.0, 9.0, 1.0, 1.0), 7.0);
        assert_eq!(combine(PlayMode::Bossing, 7.0, 9.0, 1.0, 1.0), 9.0);
    }

    #[test]
    fn solver_refuses_a_goal_without_a_play_mode() {
        let err = crate::solver::start(String::new(), r#"{"skill":"Cleave","assume":{"flaskUptime":"mapping"}}"#, "").err().unwrap();
        assert_eq!(err, NEED_MODE);
    }
}
