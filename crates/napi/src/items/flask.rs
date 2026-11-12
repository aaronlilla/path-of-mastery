//! The "Effective flask stats" and "Effective tincture stats" blocks of the item tooltip (`ItemsTabClass:AddItemStatDifferences`):
//! what a flask recovers, how long it lasts, how it charges, with the build's modifiers applied.
use super::*;
use pom_engine::modifier::ModType;
use pom_engine::modstore::{Cfg, ModStore};
use pom_engine::sym::Sym;

fn s(n: &str) -> Sym {
    Sym::new(n)
}

/// A line of the block: the label in the muted colour, then the figures in white (`^8label: ^7value`).
fn row(parts: &[(bool, String)]) -> Value {
    line("big", parts.iter().map(|(white, t)| seg(Some(if *white { "white" } else { "muted" }), t.clone())).collect())
}

fn m(t: &str) -> (bool, String) {
    (false, t.to_string())
}
fn w(t: impl Into<String>) -> (bool, String) {
    (true, t.into())
}

/// `%.2f`-style with upstream's `%.1f0` flask duration quirk handled by the callers.
fn f2(v: f64) -> String {
    format!("{v:.2}")
}

fn int(v: f64) -> String {
    format!("{}", v.trunc() as i64)
}

pub(super) fn lines(env: &pom_pipeline::Env, item: &Item, base: &pom_engine::data::ItemBase, empty_flask_slots: usize) -> Vec<Value> {
    let mod_db: &ModStore = &env.player;
    let out = &env.output;
    let o = |k: &str| out.get(k).copied().unwrap_or(0.0);
    let sum = |t: ModType, cfg: Option<&Cfg>, name: &str| mod_db.sum(t, cfg, &[s(name)]);
    let player = Cfg { actor_tag: Some(std::sync::Arc::from("player")), ..Cfg::default() };
    let mut stats: Vec<Value> = Vec::new();

    if let Some(flask) = base.extra.get("flask").map(|j| j.to_value()) {
        let fd = item.flask_data.clone().unwrap_or(Value::Null);
        let g = |k: &str| jf(&fd, k).unwrap_or(0.0);
        let has_life = flask.get("life").is_some();
        let has_mana = flask.get("mana").is_some();
        let dur_inc = sum(ModType::Inc, None, "FlaskDuration");
        let mut effect_inc = sum(ModType::Inc, Some(&player), "FlaskEffect");
        let mut life_dur = 0.0;
        let mut mana_dur = 0.0;
        if item.rarity == "MAGIC" && !has_life && !has_mana {
            effect_inc += sum(ModType::Inc, Some(&player), "MagicUtilityFlaskEffect");
        }
        if has_life || has_mana {
            let rate_inc = sum(ModType::Inc, None, "FlaskRecoveryRate");
            if has_life {
                let life_inc = sum(ModType::Inc, None, "FlaskLifeRecovery");
                let life_more = mod_db.more(None, &[s("FlaskLifeRecovery")]);
                let life_rate_inc = sum(ModType::Inc, None, "FlaskLifeRecoveryRate");
                // "50% less Life Flask Recovery Rate" (Master Surgeon, 3.30): a MORE on the same rate
                let life_rate_more = mod_db.more(None, &[s("FlaskLifeRecoveryRate")]);
                let instant_perc = g("instantPerc") + sum(ModType::Base, None, "LifeFlaskInstantRecovery");
                // More life recovery on low life is not affected by flask effect (verified in game), so its effect is divided out first.
                let low_more = mod_db.more(None, &[s("FlaskLifeRecoveryLowLife")]);
                let low_multi = if low_more > 1.0 { (low_more - 1.0) / (1.0 + effect_inc / 100.0) + 1.0 } else { 1.0 };
                let inst = g("lifeBase") * instant_perc / 100.0 * (1.0 + life_inc / 100.0) * life_more * (1.0 + effect_inc / 100.0) * low_multi;
                let base_amt = g("lifeBase") * (1.0 - instant_perc / 100.0) * (1.0 + life_inc / 100.0) * life_more * (1.0 + effect_inc / 100.0) * (1.0 + dur_inc / 100.0) * low_multi;
                let grad = base_amt * o("LifeRecoveryRateMod");
                let es_grad = base_amt * o("EnergyShieldRecoveryRateMod");
                life_dur = g("duration") * (1.0 + dur_inc / 100.0) / (1.0 + rate_inc / 100.0) / (1.0 + life_rate_inc / 100.0) / life_rate_more;
                let full_life = env.config_flags.get("conditionFullLife").copied().unwrap_or(false);
                if g("lifeAdditional") > 0.0 && !full_life {
                    let total_add = (g("lifeAdditional") / 100.0) * g("lifeTotal") * o("LifeRecoveryRateMod");
                    let add_grad = (life_dur / 10.0) * total_add;
                    let left_dur = 10.0 - life_dur;
                    let left_amt = total_add - add_grad;
                    if inst > 0.0 {
                        if grad > 0.0 {
                            stats.push(row(&[m("Life recovered: "), w(int(inst + grad + total_add)), m(" ("), w(int(inst)), m(" instantly, plus "), w(int(grad + add_grad)), m(" over "), w(f2(life_dur) + "s"), m(", and an additional "), w(int(left_amt)), m(" over subsequent "), w(f2(left_dur) + "s"), m(")")]));
                        } else {
                            life_dur = 0.0;
                            stats.push(row(&[m("Life recovered: "), w(int(inst + total_add)), m(" ("), w(int(inst)), m(" instantly, and an additional "), w(int(total_add)), m(" over "), w(f2(10.0) + "s"), m(")")]));
                        }
                    } else {
                        stats.push(row(&[m("Life recovered: "), w(int(grad + total_add)), m(" ("), w(int(grad + add_grad)), m(" over "), w(f2(life_dur) + "s"), m(", and an additional "), w(int(left_amt)), m(" over subsequent "), w(f2(left_dur) + "s"), m(")")]));
                    }
                } else if inst > 0.0 && grad > 0.0 {
                    stats.push(row(&[m("Life recovered: "), w(int(inst + grad)), m(" ("), w(int(inst)), m(" instantly, plus "), w(int(grad)), m(" over "), w(f2(life_dur) + "s"), m(")")]));
                } else if inst + grad != g("lifeTotal") || (inst == 0.0 && life_dur != g("duration")) {
                    if inst > 0.0 {
                        life_dur = 0.0;
                        stats.push(row(&[m("Life recovered: "), w(int(inst)), m(" instantly")]));
                    } else if grad > 0.0 {
                        stats.push(row(&[m("Life recovered: "), w(int(grad)), m(" over "), w(f2(life_dur) + "s")]));
                    }
                }
                if mod_db.flag(None, &[s("LifeFlaskAppliesToEnergyShield")]) {
                    if inst > 0.0 && es_grad > 0.0 {
                        stats.push(row(&[m("Energy Shield recovered: "), w(int(inst + es_grad)), m(" ("), w(int(inst)), m(" instantly, plus "), w(int(es_grad)), m(" over "), w(f2(life_dur) + "s"), m(")")]));
                    } else if inst > 0.0 && es_grad == 0.0 {
                        stats.push(row(&[m("Energy Shield recovered: "), w(int(inst)), m(" instantly")]));
                    } else if inst == 0.0 && es_grad > 0.0 {
                        stats.push(row(&[m("Energy Shield recovered: "), w(int(es_grad)), m(" over "), w(f2(life_dur) + "s")]));
                    }
                }
            }
            if has_mana {
                let mana_inc = sum(ModType::Inc, None, "FlaskManaRecovery");
                let mana_rate_inc = sum(ModType::Inc, None, "FlaskManaRecoveryRate");
                let instant_perc = g("instantPerc") + sum(ModType::Base, None, "ManaFlaskInstantRecovery");
                let inst = g("manaBase") * instant_perc / 100.0 * (1.0 + mana_inc / 100.0) * (1.0 + effect_inc / 100.0);
                let base_amt = g("manaBase") * (1.0 - instant_perc / 100.0) * (1.0 + mana_inc / 100.0) * (1.0 + effect_inc / 100.0) * (1.0 + dur_inc / 100.0);
                let grad = base_amt * o("ManaRecoveryRateMod");
                let life_grad = base_amt * o("LifeRecoveryRateMod");
                mana_dur = g("duration") * (1.0 + dur_inc / 100.0) / (1.0 + rate_inc / 100.0) / (1.0 + mana_rate_inc / 100.0);
                if inst > 0.0 && grad > 0.0 {
                    stats.push(row(&[m("Mana recovered: "), w(int(inst + grad)), m(" ("), w(int(inst)), m(" instantly, plus "), w(int(grad)), m(" over "), w(f2(mana_dur) + "s"), m(")")]));
                } else if inst + grad != g("manaTotal") || (inst == 0.0 && mana_dur != g("duration")) {
                    if inst > 0.0 {
                        mana_dur = 0.0;
                        stats.push(row(&[m("Mana recovered: "), w(int(inst)), m(" instantly")]));
                    } else if grad > 0.0 {
                        stats.push(row(&[m("Mana recovered: "), w(int(grad)), m(" over "), w(f2(mana_dur) + "s")]));
                    }
                }
                if mod_db.flag(None, &[s("ManaFlaskAppliesToLife")]) && life_grad > 0.0 {
                    stats.push(row(&[m("Life recovered: "), w(int(life_grad)), m(" over "), w(f2(mana_dur) + "s")]));
                }
            }
        } else if dur_inc != 0.0 {
            stats.push(row(&[m("Flask effect duration: "), w(format!("{:.1}0s", g("duration") * (1.0 + dur_inc / 100.0)))]));
        }
        let effect_mod = 1.0 + (g("effectInc") + effect_inc) / 100.0;
        if effect_mod != 1.0 {
            stats.push(row(&[m("Flask effect modifier: "), w(format!("{:+}%", (effect_mod * 100.0 - 100.0).trunc() as i64))]));
        }
        let used_inc = sum(ModType::Inc, None, "FlaskChargesUsed");
        if used_inc != 0.0 {
            let used = (g("chargesUsed") * (1.0 + used_inc / 100.0)).floor();
            stats.push(row(&[m("Charges used: "), w(int(used)), m(" of "), w(int(g("chargesMax"))), m(" ("), w(int((g("chargesMax") / used).floor())), m(" uses)")]));
        }
        let gain_mod = g("gainMod") * (1.0 + sum(ModType::Inc, None, "FlaskChargesGained") / 100.0);
        if gain_mod != 1.0 {
            stats.push(row(&[m("Charge gain modifier: "), w(format!("{:+}%", (gain_mod * 100.0 - 100.0).trunc() as i64))]));
        }
        // Charge generation.
        let mut generated = sum(ModType::Base, None, "FlaskChargesGenerated");
        if has_life {
            generated += sum(ModType::Base, None, "LifeFlaskChargesGenerated");
        }
        if has_mana {
            generated += sum(ModType::Base, None, "ManaFlaskChargesGenerated");
        }
        if !has_mana && !has_life {
            generated += sum(ModType::Base, None, "UtilityFlaskChargesGenerated");
        }
        let mut on_ward_break = 0.0;
        if item.base_name.as_deref() == Some("Iron Flask") {
            on_ward_break += sum(ModType::Base, None, "IronFlaskChargesGeneratedOnWardBreak");
        }
        let mut per_flask = sum(ModType::Base, None, "FlaskChargesGeneratedPerEmptyFlask") * empty_flask_slots as f64;
        generated *= gain_mod;
        on_ward_break *= gain_mod;
        per_flask *= gain_mod;
        let total_generated = generated + per_flask;
        if total_generated > 0.0 {
            stats.push(row(&[m("Charges generated: "), w(f2(total_generated)), m(" per second")]));
        }
        if on_ward_break > 0.0 {
            stats.push(row(&[m("Charges generated on Ward Break: "), w(f2(on_ward_break))]));
        }
        let not_consume = sum(ModType::Base, None, "FlaskChanceNotConsumeCharges").min(100.0);
        if not_consume != 0.0 {
            stats.push(row(&[m("Chance to not consume charges: "), w(format!("{}%", int(not_consume)))]));
        }
        // Uptime.
        let mut has_uptime = !has_life && !has_mana;
        let mut flask_duration = g("duration") * (1.0 + dur_inc / 100.0);
        let flag_not_removed = |name: &str| mod_db.flag(None, &[s(name)]);
        if has_life && (fd.get("lifeEffectNotRemoved").and_then(|b| b.as_bool()).unwrap_or(false) || flag_not_removed("LifeFlaskEffectNotRemoved")) {
            has_uptime = true;
            flask_duration = life_dur;
        } else if has_mana && (fd.get("manaEffectNotRemoved").and_then(|b| b.as_bool()).unwrap_or(false) || flag_not_removed("ManaFlaskEffectNotRemoved")) {
            has_uptime = true;
            flask_duration = mana_dur;
        }
        if has_uptime {
            let charges_used = g("chargesUsed") * (1.0 + used_inc / 100.0);
            if charges_used > 0.0 && flask_duration > 0.0 {
                let per3 = flask_duration - (flask_duration % 3.0);
                let per5 = flask_duration - (flask_duration % 5.0);
                let min_generated = per3 * generated + per5 * per_flask;
                let pct_min = (min_generated / charges_used * 100.0).min(100.0);
                if pct_min < 100.0 && not_consume < 100.0 {
                    let avg_generated = (generated + per_flask) * flask_duration;
                    let avg_used = charges_used * (100.0 - not_consume) / 100.0;
                    let pct_avg = (avg_generated / avg_used * 100.0).min(100.0);
                    stats.push(row(&[m("Flask uptime: "), w(format!("{}%", int(pct_avg))), m(" average, "), w(format!("{}%", int(pct_min))), m(" minimum")]));
                } else {
                    stats.push(row(&[m("Flask uptime: "), w("100%")]));
                }
            }
        }
    } else if let Some(tincture) = base.extra.get("tincture").map(|j| j.to_value()) {
        let td = item.tincture_data.clone().unwrap_or(Value::Null);
        let mut effect_inc = sum(ModType::Inc, Some(&player), "TinctureEffect");
        if item.rarity == "MAGIC" {
            effect_inc += sum(ModType::Inc, Some(&player), "MagicTinctureEffect");
        }
        let effect_mod = (1.0 + (jf(&td, "effectInc").unwrap_or(0.0) + effect_inc) / 100.0) * (1.0 + item.quality.unwrap_or(0.0) / 100.0);
        if effect_mod != 1.0 {
            stats.push(row(&[m("Tincture effect modifier: "), w(format!("{:+}%", (effect_mod * 100.0 - 100.0).trunc() as i64))]));
        }
        let burn = jf(&td, "manaBurn").unwrap_or(1.0);
        let burn_inc = sum(ModType::Inc, Some(&player), "TinctureManaBurnRate");
        let burn_more = mod_db.sum(ModType::More, Some(&player), &[s("TinctureManaBurnRate")]);
        stats.push(row(&[m("Mana Burn Inflicted Every Second: "), w(f2(1.0 / (burn / (1.0 + burn_inc / 100.0) / (1.0 + burn_more / 100.0))))]));
        let not_burn = sum(ModType::Base, None, "TincturesNotInflictManaBurn").min(100.0);
        if not_burn != 0.0 {
            stats.push(row(&[m("Chance to not inflict Mana Burn: "), w(format!("{}%", int(not_burn)))]));
        }
        let cooldown = jf(&tincture, "cooldown").unwrap_or(0.0) / (1.0 + (sum(ModType::Inc, Some(&player), "TinctureCooldownRecovery") + jf(&td, "cooldownInc").unwrap_or(0.0)) / 100.0);
        stats.push(row(&[m("Tincture Cooldown when deactivated: "), w(f2(cooldown)), m(" seconds")]));
    }
    stats
}
