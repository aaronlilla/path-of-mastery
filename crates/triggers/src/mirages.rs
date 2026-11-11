//! Port of `calcs.mirages` / `calculateMirage` (Modules/CalcMirages.lua).
//!
//! `calculateMirage`'s `calcs.perform(newEnv)` call is a full nested skill calculation (offence,
//! defence, the whole pipeline) - explicitly out of this crate's scope (see crate docs). Where a
//! branch's graded output is that nested result verbatim (Mirage Archer's and Sacred Wisps'
//! `mirage.output`, Saviour's `env.player.output`), this port stops at "which skill got chosen
//! and what mods/flags were set up for it", which is this crate's own logic. Tawhoa's Chosen is
//! the one branch whose headline numbers (TriggerRateCap/SkillTriggerRate/EffectiveSourceRate)
//! are pure trigger math layered *after* the nested call, and are fully ported.

use crate::*;

#[derive(Debug, Clone, Default)]
pub struct MirageOutcome {
    /// Index into `skills` of the skill that became (or stayed) `env.player.mainSkill`.
    pub chosen_idx: Option<usize>,
    pub mirage_archer: bool,
    pub wisp: bool,
    pub mirage_count: Option<f64>,
    pub trigger_rate_cap: Option<f64>,
    pub skill_trigger_rate: Option<f64>,
    pub effective_source_rate: Option<f64>,
    pub speed: Option<f64>,
    pub disabled_no_skill_found: bool,
    pub offence_runs_on_main: bool, // calcs.mirages' return being falsy: calcs.offence still runs
    pub not_yet_ported: bool,
}

fn saviour_eligible(sk: &Skill, main_idx: usize, idx: usize) -> bool {
    idx != main_idx
        && sk.has_skill_type(ATTACK)
        // SkillType.Totem does not exist in Data/Global.lua (see engine::constants); indexing
        // with the nil key is always false in upstream, so this exclusion never fires.
        && !sk.has_skill_type(SUMMONS_TOTEM)
        && (sk.skill_cfg_flags & (MF_SWORD | MF_WEAPON1H)) == (MF_SWORD | MF_WEAPON1H)
        && !sk.used_by_mirage()
}

fn tawhoa_source_kind(sk: &Skill) -> bool {
    if pom_offence::data::pom_fixes_on() {
        // Tawhoa's Chosen only takes Slam or Strike skills. Upstream differs here.
        sk.has_skill_type(SLAM) || sk.gem_tags.get("strike").copied().unwrap_or(false)
    } else {
        sk.has_skill_type(SLAM) || sk.has_skill_type(MELEE)
    }
}

fn tawhoa_eligible(sk: &Skill, main_idx: usize, idx: usize) -> bool {
    idx != main_idx
        && !is_triggered(sk)
        && !sk.disabled()
        && tawhoa_source_kind(sk)
        && sk.has_skill_type(ATTACK)
        && !sk.has_skill_type(VAAL)
        && !sk.has_skill_type(SUMMONS_TOTEM)
        && !sk.used_by_mirage()
}

pub fn calcs_mirages(skills: &[Skill], call: &MirageCall) -> MirageOutcome {
    let mut out = MirageOutcome::default();
    if call.used_by_mirage || call.disabled { return out; }
    let main_skill_idx = match call.main_skill_idx { Some(i) => i, None => return out };
    let main = &skills[main_skill_idx];

    if call.skill_data_flags.triggered_by_mirage_archer {
        out.chosen_idx = Some(main_skill_idx);
        out.mirage_archer = true;
        out.mirage_count = Some(call.mirage_archer.max_count);
        out.offence_runs_on_main = false; // calcMainSkillOffence = true -> calcs.offence(main) is skipped by the caller
    } else if main.ge.name.as_deref() == Some("Reflection") {
        let mut best: Option<(usize, f64)> = None;
        for (i, sk) in skills.iter().enumerate() {
            if !saviour_eligible(sk, main_skill_idx, i) { continue; }
            let entry = sk.uuid.as_deref().and_then(|u| call.global_cache.get(u));
            let crit = entry.and_then(|e| e.crit_chance);
            if let Some(crit) = crit {
                if crit > 0.0 {
                    let dps = entry.and_then(|e| e.total_dps).unwrap_or(0.0);
                    if best.is_none() || dps > best.unwrap().1 { best = Some((i, dps)); }
                }
            }
        }
        match best {
            Some((idx, _)) => { out.chosen_idx = Some(idx); out.offence_runs_on_main = true; }
            None => { out.disabled_no_skill_found = true; }
        }
    } else if main.ge.name.as_deref() == Some("Tawhoa's Chosen") {
        let mut best: Option<(usize, f64, f64)> = None; // (idx, dps, effectiveSourceRate=Speed)
        for (i, sk) in skills.iter().enumerate() {
            if !tawhoa_eligible(sk, main_skill_idx, i) { continue; }
            let entry = sk.uuid.as_deref().and_then(|u| call.global_cache.get(u));
            if let Some(entry) = entry {
                let dps = entry.total_dps.unwrap_or(0.0);
                if best.is_none() || dps > best.unwrap().1 {
                    best = Some((i, dps, entry.speed.unwrap_or(0.0)));
                }
            }
        }
        match best {
            Some((idx, _, effective_source_rate)) => {
                out.chosen_idx = Some(idx);
                let chosen = &skills[idx];
                let icdr = chosen.core_calc.icdr;
                let triggered_cd = num_or(&chosen.skill_data, "cooldown", 0.0);
                let triggered_cd_adjusted = triggered_cd / icdr;
                let triggered_cd_tick_rounded = ceil_b(triggered_cd_adjusted, SERVER_TICK_TIME);
                let trigger_cd = num_or(&main.skill_data, "cooldown", 0.0);
                let trigger_cd_adjusted = trigger_cd / icdr;
                let trigger_cd_tick_rounded = ceil_b(trigger_cd_adjusted, SERVER_TICK_TIME);
                let action_cooldown = triggered_cd_tick_rounded.max(trigger_cd_tick_rounded);
                let trigger_rate_cap = if action_cooldown != 0.0 { 1.0 / action_cooldown } else { f64::INFINITY };
                let skill_trigger_rate = if effective_source_rate != 0.0 {
                    let rotation = vec![SimSkill { uuid: main.uuid.clone().unwrap_or_default(), cd: triggered_cd, cd_override: None, adds_cast_time: None, icdr, added_cooldown: 0.0 }];
                    let (rate, _) = calc_multi_spell_rotation_impact(&rotation, effective_source_rate, trigger_cd, None, main.uuid.as_deref().unwrap_or(""));
                    rate
                } else { 0.0 };
                out.trigger_rate_cap = Some(trigger_rate_cap);
                out.skill_trigger_rate = Some(skill_trigger_rate);
                out.effective_source_rate = Some(effective_source_rate);
                out.speed = Some(skill_trigger_rate);
                out.offence_runs_on_main = true;
            }
            None => { out.disabled_no_skill_found = true; }
        }
    } else if call.skill_data_flags.triggered_by_sacred_wisps {
        out.chosen_idx = Some(main_skill_idx);
        out.wisp = true;
        out.mirage_count = call.sacred_wisps.wisps_max_count;
        out.offence_runs_on_main = false;
    } else if call.skill_data_flags.triggered_by_generals_cry {
        // calcSkillCooldown + the exert/quantity Tabulate scaling (CalcMirages.lua:346-424) is
        // not yet ported. Structurally, config stays nil in upstream for
        // this branch, so calculateMirage no-ops and calcs.offence runs on the (mutated) main
        // skill; that part is captured correctly.
        out.not_yet_ported = true;
        out.chosen_idx = Some(main_skill_idx);
        out.offence_runs_on_main = true;
    } else {
        // No matching mirage config: calculateMirage(env, nil) is a no-op, so
        // env.player.mainSkill (and its activeEffect name) is unchanged.
        out.chosen_idx = Some(main_skill_idx);
        out.offence_runs_on_main = true;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atk(types: &[i64], tags: &[&str]) -> Skill {
        let mut s = Skill::default();
        for t in types.iter().chain(&[ATTACK]) { s.skill_types.insert(t.to_string(), true); }
        for t in tags { s.gem_tags.insert(t.to_string(), true); }
        s
    }

    #[test]
    fn tawhoa_needs_slam_or_strike() {
        assert!(!tawhoa_eligible(&atk(&[MELEE], &[]), 0, 1), "Cyclone: melee attack, no slam type, no strike tag");
        assert!(tawhoa_eligible(&atk(&[MELEE], &["strike"]), 0, 1), "Heavy Strike: strike tag");
        assert!(tawhoa_eligible(&atk(&[MELEE, SLAM], &[]), 0, 1), "Earthquake: slam type");
    }
}
