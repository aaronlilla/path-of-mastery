//! Calcs-mode breakdown writers for CalcOffence.lua 2300-3300 (end of the speed pass loop, the hand combine, the
//! warcry / exert / pact uptime block, Fist of War). Each function writes exactly what upstream writes at that
//! point; the caller computes the numbers (inside `if bd::on()`).
use crate::bd::{self, ins_s, set};
use crate::bdbuild::{multi_chain, Chain, Link};
use crate::sf;
use serde_json::Value;

/// colorCodes.NEGATIVE (Data/Global.lua:28).
const NEGATIVE: &str = "^xDD0022";
/// colorCodes.CUSTOM (Data/Global.lua:17).
const CUSTOM: &str = "^x5CF0BB";

/// Inputs of the `if breakdown then storedSustainedTraumaBreakdown = {...}` block (CalcOffence.lua:2339-2392).
pub struct Trauma {
    pub inc_attack_speed_per_trauma: f64,
    pub attack_speed_before_inc: f64,
    pub inc: f64,
    pub trauma_per_attack: f64,
    /// `output.HitChance / 100`
    pub hit_chance: f64,
    pub duration: f64,
    pub repeats: f64,
    pub base_time: f64,
    pub more: f64,
    pub action_speed_mod: f64,
    pub trauma_rate_before_inc: f64,
    /// `traumaBreakdown`: the trauma before the cap recalculation.
    pub trauma_breakdown: f64,
    pub invalid: bool,
    pub effective_attack_rate_cap: f64,
    /// `trauma` after the recalculation and the dual-wield halving.
    pub trauma: f64,
}

pub fn trauma(out: &mut Value, t: &Trauma) {
    if t.inc_attack_speed_per_trauma == 0.0 {
        let mut c = Chain::new();
        c.label = Some("Trauma".into());
        c.base = Some(Link::n("%.2f ^8(attack speed)", t.attack_speed_before_inc * (1.0 + t.inc / 100.0)));
        c.links = vec![
            Link::n("%.2f ^8(trauma per attack)", t.trauma_per_attack),
            Link::n("%.2f ^8(chance to hit)", t.hit_chance),
            Link::n("%.2f ^8(duration)", t.duration),
        ];
        c.no_total = true;
        multi_chain(out, &c);
        if t.repeats != 1.0 {
            ins_s(out, sf!("/ %.2f ^8(repeats)", t.repeats));
        }
    } else {
        let mut c = Chain::new();
        c.label = Some("Attack Speed before increased Attack Speed".into());
        c.base = Some(Link::n("%.2f ^8(base)", 1.0 / t.base_time));
        c.links = vec![Link::n("%.2f ^8(more/less)", t.more), Link::n("%.2f ^8(action speed modifier)", t.action_speed_mod)];
        c.total = Some(sf!("= %.2f ^8attacks per second", t.attack_speed_before_inc));
        multi_chain(out, &c);
        ins_s(out, "");
        let mut c = Chain::new();
        c.label = Some("Trauma per second before increased Attack Speed".into());
        c.base = Some(Link::n("%.2f ^8(base)", t.attack_speed_before_inc));
        c.links = vec![Link::n("%.2f ^8(trauma per attack)", t.trauma_per_attack), Link::n("%.2f ^8(chance to hit)", t.hit_chance)];
        c.no_total = true;
        multi_chain(out, &c);
        if t.repeats != 1.0 {
            ins_s(out, sf!("/ %.2f ^8(repeats)", t.repeats));
        }
        ins_s(out, sf!("= %.2f ^8trauma per second", t.trauma_rate_before_inc));
        ins_s(out, "");
        ins_s(out, "Trauma");
        ins_s(out, sf!("%.2f ^8(base)", t.trauma_rate_before_inc));
        ins_s(out, sf!("x %.2f ^8(increased/reduced)", 1.0 + t.inc / 100.0));
        ins_s(out, sf!("/ %.4f ^8(1 / duration - trauma per second * increased attack speed per trauma / 100)", 1.0 / t.duration - t.trauma_rate_before_inc * t.inc_attack_speed_per_trauma / 100.0));
    }
    let fmt = format!("= {}%d ^8trauma", if t.invalid { NEGATIVE } else { "" });
    ins_s(out, sf!(&fmt, t.trauma_breakdown));
    if t.invalid {
        ins_s(out, "");
        ins_s(out, "Attack Speed exceeds cap; Recalculating");
        let mut c = Chain::new();
        c.base = Some(Link::n("%.2f ^8(base)", t.effective_attack_rate_cap));
        c.links = vec![
            Link::n("%.2f ^8(trauma per attack)", t.trauma_per_attack),
            Link::n("%.2f ^8(chance to hit)", t.hit_chance),
            Link::n("%.2f ^8(duration)", t.duration),
        ];
        c.no_total = true;
        multi_chain(out, &c);
        if t.repeats != 1.0 {
            ins_s(out, sf!("/ %.2f ^8(repeats)", t.repeats));
        }
        ins_s(out, sf!("= %d ^8trauma", t.trauma));
    }
}

/// `breakdown.Speed` of the general speed branch (CalcOffence.lua:2428-2449), into the current pass table.
#[allow(clippy::too_many_arguments)]
pub fn speed(base_time: f64, inc: f64, more: f64, action_speed_link: f64, cast_rate: f64, cooldown: Option<f64>, repeats: f64, final_speed: f64) {
    bd::cur(|b| {
        let t = bd::reset(b, "Speed");
        let mut c = Chain::new();
        c.base = Some(Link::n("%.2f ^8(base)", 1.0 / base_time));
        c.links = vec![
            Link::n("%.2f ^8(increased/reduced)", 1.0 + inc / 100.0),
            Link::n("%.2f ^8(more/less)", more),
            Link::n("%.2f ^8(action speed modifier)", action_speed_link),
        ];
        c.total = Some(sf!("= %.2f ^8casts per second", cast_rate));
        multi_chain(t, &c);
        if let Some(cd) = cooldown {
            if (1.0 / cd) < cast_rate {
                ins_s(t, "\n");
                ins_s(t, sf!("1 / %.2f ^8(skill cooldown)", cd));
                if repeats > 1.0 {
                    ins_s(t, sf!("x %d ^8(repeat count)", repeats));
                }
                ins_s(t, sf!("= %.2f ^8(casts per second)", repeats / cd));
                ins_s(t, "\n");
                ins_s(t, sf!("= %.2f ^8(lower of cast rates)", final_speed));
            }
        }
    });
}

/// `breakdown.Time` (CalcOffence.lua:2452-2459), only when `SkillAttackTime` modifies the attack time.
pub fn time(speed: f64, skill_attack_time_mod: f64, time: f64) {
    bd::cur(|b| {
        let t = bd::reset(b, "Time");
        let mut c = Chain::new();
        c.base = Some(Link::n("%.2f ^8(base)", 1.0 / (speed * skill_attack_time_mod)));
        c.links = vec![Link::n("%.2f ^8(total modifier)", skill_attack_time_mod)];
        c.total = Some(sf!("= %.2f ^8seconds per attack", time));
        multi_chain(t, &c);
    });
}

/// The actor-table writes of the attack combine (CalcOffence.lua:2530-2557). `mh_speed` / `oh_speed` / `mh_hit_chance` /
/// `oh_hit_chance` are the hands' outputs.
#[allow(clippy::too_many_arguments)]
pub fn combine_attack(use_offhand_speed: bool, both: bool, weapon1_attack: bool, speed: f64, mh_speed: f64, oh_speed: f64, mh_hit_chance: f64, oh_hit_chance: f64, hit_chance: f64) {
    bd::root(|b| {
        if use_offhand_speed {
            set(b, "Speed", Value::Array(vec![bd::s("Use Offhand Weapon Attack Speed:"), bd::s(sf!("= %.2f", speed))]));
        } else if both {
            set(b, "Speed", Value::Array(vec![bd::s("Both weapons:"), bd::s(sf!("2 / (1 / %.2f + 1 / %.2f)", mh_speed, oh_speed)), bd::s(sf!("= %.2f", speed))]));
        }
        if both {
            set(
                b,
                "HitChance",
                Value::Array(vec![
                    bd::s("Both weapons:"),
                    bd::s(sf!("%.2f%% ^8(main hand)", mh_hit_chance)),
                    bd::s(sf!("%.2f%% ^8(off hand)", oh_hit_chance)),
                    bd::s(sf!("= %.2f%% ^8(average)", hit_chance)),
                ]),
            );
        } else {
            let hand = bd::get(b, if weapon1_attack { "MainHand" } else { "OffHand" }).cloned();
            if let Some(Value::Object(h)) = hand {
                let truthy = |v: Option<&Value>| v.filter(|v| !matches!(v, Value::Bool(false) | Value::Null)).cloned();
                if let Some(v) = truthy(h.get("HitChance")).or_else(|| truthy(h.get("AccuracyHitChance"))) {
                    set(b, "HitChance", v);
                }
                if bd::get(b, "Speed").is_none() {
                    if let Some(v) = truthy(h.get("Speed")) {
                        set(b, "Speed", v);
                    }
                }
            }
        }
    });
}

/// `breakdown.HitSpeed` / `breakdown.HitTime` (CalcOffence.lua:2562-2590), after the combine, into the actor's table.
#[allow(clippy::too_many_arguments)]
pub fn hit_time(hit_time_override: bool, hit_time_multiplier: Option<f64>, triggered_on_death: bool, triggered: bool, time: Option<f64>, is_attack: bool, hit_time: f64, hit_speed: f64, cooldown: Option<f64>) {
    bd::root(|b| {
        if hit_time_override && !triggered_on_death {
            let t = bd::reset(b, "HitSpeed");
            ins_s(t, sf!("1 / %.2f ^8(hit time override)", hit_time));
            ins_s(t, sf!("= %.2f", hit_speed));
        } else if let (Some(m), Some(time), false) = (hit_time_multiplier, time, triggered_on_death) {
            let t = bd::reset(b, "HitTime");
            if m.floor() != m {
                ins_s(t, sf!(&format!("{CUSTOM}NOTE: First stage has a %.2fx channel time multiplier"), m - m.floor()));
            }
            if is_attack {
                ins_s(t, sf!("%.2f ^8(attack time)", time));
            } else {
                ins_s(t, sf!("%.2f ^8(cast time)", time));
            }
            ins_s(t, sf!("x %.2f ^8(channel time multiplier)", m));
            ins_s(t, sf!("= %.2f", hit_time));
            let t = bd::reset(b, "HitSpeed");
            match cooldown {
                Some(cd) if triggered => ins_s(t, sf!("1 / min(%.2f, %.2f) ^8min(hit time, cooldown)", hit_time, cd)),
                Some(cd) => ins_s(t, sf!("1 / (%.2f + %.2f) ^8(hit time + cooldown)", hit_time, cd)),
                None => ins_s(t, sf!("1 / %.2f ^8(hit time)", hit_time)),
            }
            ins_s(t, sf!("= %.2f", hit_speed));
        }
    });
}

/// `globalBreakdown.<Cry>UpTimeRatio` of one exerting warcry (CalcOffence.lua:2640-2652 and the same block per cry).
#[allow(clippy::too_many_arguments)]
pub fn warcry_uptime(key: &str, exerts: f64, speed: f64, cast_time: f64, cooldown: f64, stored_uses: f64, uptime: f64) {
    bd::root(|b| {
        let t = bd::reset(b, key);
        ins_s(t, sf!("(%d ^8(number of exerts)", exerts));
        ins_s(t, sf!("/ %.2f) ^8(attacks per second)", speed));
        if cast_time > 0.0 {
            ins_s(t, sf!("/ (%.2f ^8(warcry cooldown)", cooldown));
            ins_s(t, sf!("+ %.2f) ^8(warcry casttime)", cast_time));
        } else {
            ins_s(t, sf!("/ %.2f ^8(average warcry cooldown)", cooldown));
        }
        ins_s(t, sf!("* %d ^8(stored uses)", stored_uses));
        ins_s(t, sf!("= %d%%", uptime));
    });
}

/// `globalBreakdown.IntimidatingAvgDmg` + `IntimidatingHitEffect` (CalcOffence.lua:2679-2700).
pub fn intimidating(dd_chance: f64, avg_dmg: f64, uptime: f64, hit_effect: f64) {
    bd::root(|b| {
        set(
            b,
            "IntimidatingAvgDmg",
            Value::Array(vec![
                bd::s("Average Intimidating Cry Damage:"),
                bd::s(sf!("%.2f%% ^8(base double damage increase to hit 100%%)", (1.0 - dd_chance / 100.0) * 100.0)),
                bd::s(sf!("x %d ^8(double damage multiplier)", 2)),
                bd::s(sf!("= %.2f", avg_dmg)),
            ]),
        );
        set(
            b,
            "IntimidatingHitEffect",
            Value::Array(vec![
                bd::s(sf!("1 + (%.2f ^8(average exerted damage)", avg_dmg)),
                bd::s(sf!("x %.2f) ^8(uptime %%)", uptime / 100.0)),
                bd::s(sf!("= %.2f", hit_effect)),
            ]),
        );
    });
}

/// `globalBreakdown.RallyingAvgDmg` + `RallyingHitEffect` (CalcOffence.lua:2733-2753).
pub fn rallying(per_ally: f64, allies: f64, avg_dmg: f64, uptime: f64, hit_effect: f64) {
    bd::root(|b| {
        set(
            b,
            "RallyingAvgDmg",
            Value::Array(vec![
                bd::s("Average Rallying Cry Damage:"),
                bd::s(sf!("%.2f ^8(average damage multiplier per ally)", per_ally)),
                bd::s(sf!("x %d ^8(number of nearby allies (max=5))", allies)),
                bd::s(sf!("= %.2f", avg_dmg)),
            ]),
        );
        set(
            b,
            "RallyingHitEffect",
            Value::Array(vec![
                bd::s(sf!("1 + (%.2f ^8(average exerted damage)", avg_dmg)),
                bd::s(sf!("x %.2f) ^8(uptime %%)", uptime / 100.0)),
                bd::s(sf!("= %.2f", hit_effect)),
            ]),
        );
    });
}

/// `globalBreakdown.ExertedAttackUptimeRatio` (CalcOffence.lua:2840-2851). `ratios` = the six `<Cry>UpTimeRatio` outputs in
/// warcryList order with their key (the label is the key up to "Up").
pub fn exerted_uptime(ratios: &[(&str, Option<f64>)], total: f64) {
    bd::root(|b| {
        let t = bd::reset(b, "ExertedAttackUptimeRatio");
        ins_s(t, "Maximum of:");
        for (key, v) in ratios {
            if let Some(v) = v {
                let label = key.split("Up").next().unwrap_or(key);
                ins_s(t, sf!("%d%% ^8(%s Cry Uptime)", *v, label));
            }
        }
        ins_s(t, sf!("= %d%%", total));
    });
}

/// `globalBreakdown.ExertedAttackHitEffect` (CalcOffence.lua:2879-2885).
pub fn exerted_hit_effect(avg_dmg: f64, uptime: f64, hit_effect: f64) {
    bd::root(|b| {
        set(
            b,
            "ExertedAttackHitEffect",
            Value::Array(vec![
                bd::s(sf!("(%.2f ^8(average exerted damage)", avg_dmg)),
                bd::s(sf!("x %.2f) ^8(uptime %%)", uptime / 100.0)),
                bd::s(sf!("= %.2f", hit_effect)),
            ]),
        );
    });
}

/// `globalBreakdown[pactKey.."UpTimeRatio"]` (CalcOffence.lua:2921-2930).
pub fn pact_uptime(key: &str, count: f64, speed: f64, cooldown: f64, cast_time: f64, stored_uses: f64, uptime: f64) {
    bd::root(|b| {
        set(
            b,
            &format!("{key}UpTimeRatio"),
            Value::Array(vec![
                bd::s(sf!("(%.2f ^8(number of Empowered)", count)),
                bd::s(sf!("/ %.2f) ^8(casts per second)", speed)),
                bd::s(sf!("/ (%.2f ^8(pact cooldown)", cooldown)),
                bd::s(sf!("+ %.2f) ^8(pact cast time)", cast_time)),
                bd::s(sf!("* %.2f ^8(stored uses)", stored_uses)),
                bd::s(sf!("= %.2f%%", uptime)),
            ]),
        );
    });
}

/// `globalBreakdown.SoulGainPreventionDuration` (CalcOffence.lua:2959-2964).
pub fn soul_gain_prevention(before: f64, duration_mod: f64, after: f64) {
    bd::root(|b| {
        set(
            b,
            "SoulGainPreventionDuration",
            Value::Array(vec![
                bd::s(sf!("%.3fs ^8(before Pact of K'Tash)", before)),
                bd::s(sf!("x %.4f ^8(average Pact modifier)", duration_mod)),
                bd::s("rounded up to nearest server tick"),
                bd::s(sf!("= %.3fs", after)),
            ]),
        );
    });
}

/// `globalBreakdown.FistOfWarUptimeRatio` (CalcOffence.lua:2989-2995).
pub fn fist_of_war_uptime(speed: f64, cooldown: f64, uptime: f64) {
    bd::root(|b| {
        set(
            b,
            "FistOfWarUptimeRatio",
            Value::Array(vec![
                bd::s(sf!("min( (1 / %.2f) ^8(second per attack)", speed)),
                bd::s(sf!("/ %.2f, 1) ^8(fist of war cooldown)", cooldown)),
                bd::s(sf!("= %d%%", uptime)),
            ]),
        );
    });
}

/// `globalBreakdown.AvgFistOfWarDamageEffect` (CalcOffence.lua:2998-3004).
pub fn fist_of_war_effect(multiplier: f64, uptime: f64, effect: f64) {
    bd::root(|b| {
        set(
            b,
            "AvgFistOfWarDamageEffect",
            Value::Array(vec![
                bd::s(sf!("1 + (%.2f ^8(fist of war damage multiplier)", multiplier)),
                bd::s(sf!("x %.2f) ^8(fist of war uptime ratio)", uptime / 100.0)),
                bd::s(sf!("= %.2f", effect)),
            ]),
        );
    });
}
