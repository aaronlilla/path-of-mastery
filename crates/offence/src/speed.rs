// Port of "Calculate attack/cast speed" (CalcOffence.lua:2272-2470), the per-pass speed block.
// Covers the mainline (non-trigger, non-warcry, non-totem, non-trauma) path: the early
// timeOverride/fixedCastTime/triggerTime/triggerRate special cases, then the general
// attack-rate-or-cast-time combine, the Cooldown/ServerTickRate clamps, and self-cast action speed.
// Omits (named gaps, all individually rare):
//   - `HasTrauma` sustainable-trauma-stack computation (2317-2396): only feeds `output.
//     SustainableTrauma`, gated on a specific keystone.
//   - `skillFlags.warcry` cast time (2402-2403) and totem action speed (2414-2424): need
//     `output.WarcryCastTime`/other-skill cross-references this isolation layer doesn't carry.
use crate::area::round;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;

#[derive(Debug, Default, Clone, Copy)]
pub struct SpeedOutput {
    pub time: f64,
    pub speed: f64,
    pub cast_rate: f64,
    /// `output.CastRate` is only assigned by the general (non-override) branch.
    pub has_cast_rate: bool,
    /// `output.TriggerTime` (the two trigger branches).
    pub trigger_time: Option<f64>,
}

/// `baseTime` of the general speed branch (CalcOffence.lua:2299-2309): `1 / AttackRate + Sum(BASE, Speed)`
/// (scaled by `SkillAttackTime`) for an attack, the cast time for anything else. Shared by
/// `calc_speed` and the trauma pre-step (2317-2396), which needs it before the speed is final.
#[allow(clippy::too_many_arguments)]
pub fn base_time(
    skill_mod_list: &ModStore,
    cfg: Option<&Cfg>,
    skill_cfg: Option<&Cfg>,
    is_attack: bool,
    grant_cast_time: f64,
    skill_data_cast_time_override: Option<f64>,
    attack_rate: Option<f64>,
    attack_speed_inc: f64,
    skill_data_attack_speed_multiplier: Option<f64>,
    skill_data_cast_time_overrides_attack_time: bool,
) -> f64 {
    if is_attack {
        // `if skillData.attackSpeedMultiplier and source.AttackRate then source.AttackRate =
        // source.AttackRate * (1 + skillData.attackSpeedMultiplier / 100) end` (2299-2301).
        let attack_rate = attack_rate.map(|r| match skill_data_attack_speed_multiplier {
            Some(m) => r * (1.0 + m / 100.0),
            None => r,
        });
        if skill_data_cast_time_overrides_attack_time {
            grant_cast_time / (1.0 + attack_speed_inc / 100.0)
        } else {
            let skill_attack_time_mod = crate::tools::calc_lib_mod_s(skill_mod_list, skill_cfg, &[pom_engine::sym!("SkillAttackTime")]);
            let base = 1.0 / attack_rate.unwrap_or(1.0) + skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("Speed")]);
            if skill_attack_time_mod > 0.0 { base * skill_attack_time_mod } else { base }
        }
    } else {
        skill_data_cast_time_override.unwrap_or(if grant_cast_time != 0.0 { grant_cast_time } else { 1.0 })
    }
}

#[allow(clippy::too_many_arguments)]
pub fn calc_speed(
    skill_mod_list: &ModStore,
    cfg: Option<&Cfg>,
    skill_cfg: Option<&Cfg>,
    is_attack: bool,
    is_channel: bool,
    self_cast: bool,
    grant_cast_time: f64,
    skill_data_cast_time_override: Option<f64>,
    skill_data_triggered: bool,
    skill_data_time_override: Option<f64>,
    skill_data_fixed_cast_time: bool,
    skill_data_trigger_time: Option<f64>,
    skill_data_trigger_rate: Option<f64>,
    attack_rate: Option<f64>,
    attack_speed_inc: f64,
    skill_data_attack_speed_multiplier: Option<f64>,
    skill_data_cast_time_overrides_attack_time: bool,
    action_speed_mod: f64,
    cooldown: Option<f64>,
    repeats: f64,
    server_tick_rate: f64,
    // `1 + modDB:Sum("INC", nil, "TotemActionSpeed") / 100` for a totem skill (CalcOffence.lua:2414-2418), None otherwise.
    totem_action_speed: Option<f64>,
    // `output.WarcryCastTime` for a warcry skill (CalcOffence.lua:2402-2403), None otherwise.
    warcry_cast_time: Option<f64>,
) -> SpeedOutput {
    if grant_cast_time == 0.0 && skill_data_cast_time_override.is_none() && !skill_data_triggered {
        return SpeedOutput { time: 0.0, speed: 0.0, cast_rate: 0.0, has_cast_rate: false, trigger_time: None };
    }
    if let Some(t) = skill_data_time_override {
        return SpeedOutput { time: t, speed: 1.0 / t, cast_rate: 0.0, has_cast_rate: false, trigger_time: None };
    }
    if skill_data_fixed_cast_time {
        let t = grant_cast_time;
        return SpeedOutput { time: t, speed: 1.0 / t, cast_rate: 0.0, has_cast_rate: false, trigger_time: None };
    }
    if let (Some(trigger_time), true) = (skill_data_trigger_time, skill_data_triggered) {
        let active_skills_linked = skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("ActiveSkillsLinkedToTrigger")]);
        let cdr_inc = skill_mod_list.sum(ModType::Inc, cfg, &[pom_engine::sym!("CooldownRecovery")]);
        let t = if active_skills_linked > 0.0 { trigger_time / (1.0 + cdr_inc / 100.0) * active_skills_linked } else { trigger_time / (1.0 + cdr_inc / 100.0) };
        return SpeedOutput { time: t, speed: 1.0 / t, cast_rate: 0.0, has_cast_rate: false, trigger_time: Some(t) };
    }
    if let (Some(trigger_rate), true) = (skill_data_trigger_rate, skill_data_triggered) {
        let t = 1.0 / trigger_rate;
        return SpeedOutput { time: t, speed: trigger_rate, cast_rate: 0.0, has_cast_rate: false, trigger_time: Some(t) };
    }

    let base_time = base_time(skill_mod_list, cfg, skill_cfg, is_attack, grant_cast_time, skill_data_cast_time_override, attack_rate, attack_speed_inc, skill_data_attack_speed_multiplier, skill_data_cast_time_overrides_attack_time);
    let more = skill_mod_list.more(cfg, &[pom_engine::sym!("Speed")]);
    let inc = skill_mod_list.sum(ModType::Inc, cfg, &[pom_engine::sym!("Speed")]);

    let total_attack_time = skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("TotalAttackTime")]);
    let total_cast_time = skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("TotalCastTime")]);
    // `round((1 + inc/100) * more, 2)` (CalcOffence.lua:2405).
    let inc_more_rounded = round(((1.0 + inc / 100.0) * more) * 100.0) / 100.0;
    let mut speed = match warcry_cast_time {
        Some(w) => 1.0 / w,
        None => 1.0 / (base_time / inc_more_rounded + total_attack_time + total_cast_time),
    };
    let mut cast_rate = speed;
    if self_cast {
        speed *= action_speed_mod;
        cast_rate = speed;
    }
    if let Some(t) = totem_action_speed {
        speed *= t;
        cast_rate = speed;
    }
    if let Some(cd) = cooldown {
        speed = speed.min(1.0 / cd * repeats);
    }
    if !is_channel {
        speed = speed.min(server_tick_rate * repeats);
    }
    let time = if speed == 0.0 { 0.0 } else { 1.0 / speed };
    SpeedOutput { time, speed, cast_rate, has_cast_rate: true, trigger_time: None }
}
