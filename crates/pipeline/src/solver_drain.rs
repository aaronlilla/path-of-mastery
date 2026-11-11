//! Flask charges a skill spends as it is used (game data: the skill's `flask_throw_charges_used_per_projectile` stat, on
//! the part that turns the worn life flask into damage). The part is on only as long as the worn life flasks hold charges:
//! charges spent a second = throws a second x projectiles x charges per projectile; charges gained = what each worn
//! life flask gains (`flask_gen`: generation, critical strikes, kills while mapping); stored = the flasks' capacity.
//! Keyed on the stat and the part, never on a skill or item name.

use crate::solver::{flask_gen, MAPPING_KILL_CHARGES};
use pom_skills::data as gd;

/// A pinnacle fight in seconds: the flasks start full and are not refilled by kills. Long enough for a full clear of a
/// boss's phases (Sirus, Maven and Uber Elder run 2 to 4 minutes), short enough that stored charges still matter.
pub(crate) const FIGHT_SECS: f64 = 120.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Drain {
    pub spent: f64,
    pub gained: f64,
    pub stored: f64,
}

impl Drain {
    /// The share of the fight the spending part is fed. Gaining at least what is spent: always. Otherwise the stored
    /// charges feed it for stored / (spent - gained) seconds, then only the gained share of the throws are fed.
    /// `fight` None: a long run (mapping), where storage does not matter.
    pub fn uptime(&self, fight: Option<f64>) -> f64 {
        if self.spent <= 0.0 || self.gained >= self.spent {
            return 1.0;
        }
        let r = self.gained / self.spent;
        let Some(t) = fight else { return r };
        let fed = self.stored / (self.spent - self.gained);
        if fed >= t { 1.0 } else { (fed + (t - fed) * r) / t }
    }
}

/// The charges the main skill spends and the life flasks worn can hold and gain; `None` when its current part spends none.
/// `kills`: charges a second each flask gets from kills.
pub(crate) fn drain(env: &crate::Env, kills: f64) -> Option<Drain> {
    let main = crate::offence::select_main_skill(&env.xml_text, &env.active_skills)?;
    if main.gem_skill_part.unwrap_or(1) <= 1 {
        return None;
    }
    let ge = gd::granted_effect_by_skill_id(&main.granted_effect_id)?;
    let per = gd::stat_value(ge, main.level, 0.0, "flask_throw_charges_used_per_projectile");
    if per <= 0.0 {
        return None;
    }
    let o = |k: &str| env.output.get(k).copied().filter(|v| v.is_finite());
    // The build's "reduced Flask Charges used" and "chance for Flasks you use to not consume Charges" (the engine's own
    // mods). shortcut: assumed to cover charges a skill spends too; the game text says "Flasks you use".
    let sum = |t: pom_engine::modifier::ModType, n: &str| env.player.sum(t, None, &[pom_engine::sym::Sym::new(n)]);
    let used = (1.0 + sum(pom_engine::modifier::ModType::Inc, "FlaskChargesUsed") / 100.0).max(0.0) * (1.0 - sum(pom_engine::modifier::ModType::Base, "FlaskChanceNotConsumeCharges").clamp(0.0, 100.0) / 100.0);
    let spent = o("Speed").unwrap_or(0.0) * o("ProjectileCount").unwrap_or(1.0).max(1.0) * per * used;
    let (mut gained, mut stored) = (0.0, 0.0);
    for n in 1..=5 {
        let Some(item) = env.slot_items.get(&format!("Flask {n}")).and_then(|id| env.items.get(id)) else { continue };
        if !item.base_name.as_deref().and_then(pom_calc::data::flask_base_info).is_some_and(|i| i.is_life) {
            continue;
        }
        stored += item.flask_data.as_ref().and_then(|f| f.get("chargesMax")).and_then(|v| v.as_f64()).unwrap_or(0.0);
        gained += flask_gen(env, n, kills).unwrap_or(0.0);
    }
    Some(Drain { spent, gained, stored })
}

/// `Solver.FlaskDrainUptime` (a pinnacle fight, no kills) and `FlaskDrainUptimeMap` (kills refill): 1 when the main skill
/// spends no flask charges.
pub(crate) fn uptime_stat(env: &crate::Env, mapping: bool) -> f64 {
    drain(env, if mapping { MAPPING_KILL_CHARGES } else { 0.0 }).map_or(1.0, |d| d.uptime(if mapping { None } else { Some(FIGHT_SECS) }))
}

/// Engine outputs for the build's sustain report (diagnoseBuild): only when the main skill spends flask charges.
pub(crate) fn outputs(env: &mut crate::Env) {
    let (Some(b), Some(m)) = (drain(env, 0.0), drain(env, MAPPING_KILL_CHARGES)) else { return };
    for (k, v) in [("FlaskDrainSpent", b.spent), ("FlaskDrainGained", b.gained), ("FlaskDrainStored", b.stored), ("FlaskDrainFightSecs", FIGHT_SECS), ("FlaskDrainUptime", b.uptime(Some(FIGHT_SECS))), ("FlaskDrainUptimeMap", m.uptime(None))] {
        env.output_extra.insert(k.to_string(), serde_json::json!(v));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uptime_formula() {
        let d = |gained, stored| Drain { spent: 10.0, gained, stored };
        assert_eq!(d(10.0, 0.0).uptime(Some(120.0)), 1.0);
        // no gain: the stored 600 charges feed 60 s of a 120 s fight
        assert!((d(0.0, 600.0).uptime(Some(120.0)) - 0.5).abs() < 1e-9);
        assert!((d(0.0, 1200.0).uptime(Some(120.0)) - 1.0).abs() < 1e-9);
        // gaining half of what is spent: half of the throws are fed after the stock runs out
        assert!((d(5.0, 0.0).uptime(Some(120.0)) - 0.5).abs() < 1e-9);
        assert!((d(5.0, 0.0).uptime(None) - 0.5).abs() < 1e-9);
    }
}
