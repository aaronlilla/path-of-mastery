//! The handful of ConfigOptions.lua handlers that read `build`/`build.configTab` state instead of
//! just `val`: `enemyIsBoss`, `presetBossSkills`, `enemySizePreset` (all three also write
//! `configTab.placeholder`, read back by later options in the same `BuildModList` pass — see
//! `ctx::ConfigCtx`), plus the 8 `MapPrefix*`/`MapSuffix*` options that dispatch into
//! `mapmods::apply_affix` via `mapAffixDropDownFunction`.
use crate::ctx::ConfigCtx;
use crate::helpers::{b, n, new_mod, s, tag};
use crate::mapmods;
use crate::types::OwnedOptionValue;
use crate::HandlerMap;
use pom_engine::modifier::ModType;
use serde_json::Value as J;

fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}

fn jnum(v: &J) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn monster_table(ctx: &ConfigCtx, name: &str, level: i64) -> f64 {
    let idx = (level - 1).max(0) as usize;
    ctx.game
        .extra
        .get(name)
        .ok()
        .flatten()
        .and_then(|v| v.as_array().and_then(|a| a.get(idx)).map(|j| j.to_value()))
        .map(|v| jnum(&v))
        .unwrap_or(0.0)
}

fn misc(ctx: &ConfigCtx, key: &str) -> f64 {
    ctx.game.misc.get(key).unwrap_or(0.0)
}

fn boss_stats(ctx: &ConfigCtx, key: &str) -> f64 {
    ctx.game.extra.get("bossStats").ok().flatten().and_then(|v| v.get(key).map(|j| j.to_value())).map(|v| jnum(&v)).unwrap_or(0.0)
}

fn monster_constants(ctx: &ConfigCtx, key: &str) -> f64 {
    ctx.game.extra.get("monsterConstants").ok().flatten().and_then(|v| v.get(key).map(|j| j.to_value())).map(|v| jnum(&v)).unwrap_or(0.0)
}

/// Port of the `enemyIsBoss` apply (ConfigOptions.lua ~2086). `val` is one of
/// "None"/"Boss"/"Pinnacle"/"Uber". Tracks the resolved value on `ctx.enemy_is_boss` so
/// `presetBossSkills` (which reads `varControls['enemyIsBoss'].list[selIndex].val`) can see it.
fn enemy_is_boss(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let val = val.as_str();
    ctx.enemy_is_boss = Some(val.clone());
    ctx.set_placeholder_num("enemySpeed", Some(700.0));
    ctx.set_placeholder_num("enemyCritChance", Some(5.0));
    ctx.set_placeholder_num("enemyCritDamage", Some(monster_constants(ctx, "base_critical_strike_multiplier") - 100.0));

    match val.as_ref() {
        "None" => {
            for v in ["enemyLightningResist", "enemyColdResist", "enemyFireResist", "enemyChaosResist"] {
                ctx.set_placeholder_num(v, None);
            }
            ctx.set_placeholder_num("enemyLevel", None);
            ctx.update_level();
            let default_level = ctx.enemy_level;
            let default_damage = round(monster_table(ctx, "monsterDamageTable", default_level) * 1.5);
            ctx.set_placeholder_num("enemyPhysicalDamage", Some(default_damage));
            for v in ["enemyLightningDamage", "enemyColdDamage", "enemyFireDamage", "enemyChaosDamage"] {
                ctx.set_placeholder_num(v, None);
            }
            for v in ["enemyPhysicalOverwhelm", "enemyLightningPen", "enemyColdPen", "enemyFirePen"] {
                ctx.set_placeholder_num(v, None);
            }
            ctx.set_placeholder_num("enemyArmour", Some(monster_table(ctx, "monsterArmourTable", default_level)));
            ctx.set_placeholder_num("enemyEvasion", Some(monster_table(ctx, "monsterEvasionTable", default_level)));
        }
        "Boss" => {
            ctx.enemy.push(new_mod("Condition:RareOrUnique", ModType::Flag, b(true), "Config", vec![tag("Condition", &[("var", s("Effective"))])]));
            ctx.enemy.push(new_mod("AilmentThreshold", ModType::More, n(488.0), "Boss", vec![]));
            ctx.mods.push(new_mod("WarcryPower", ModType::Base, n(20.0), "Boss", vec![]));
            ctx.mods.push(new_mod("Multiplier:EnemyPower", ModType::Base, n(20.0), "Boss", vec![]));

            ctx.set_placeholder_num("enemyLightningResist", Some(40.0));
            ctx.set_placeholder_num("enemyColdResist", Some(40.0));
            ctx.set_placeholder_num("enemyFireResist", Some(40.0));
            ctx.set_placeholder_num("enemyChaosResist", Some(25.0));

            ctx.set_placeholder_num("enemyLevel", None);
            ctx.update_level();
            let default_level = ctx.enemy_level;
            let default_damage = round(monster_table(ctx, "monsterDamageTable", default_level) * 1.5 * misc(ctx, "stdBossDPSMult"));
            ctx.set_placeholder_num("enemyPhysicalDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyLightningDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyColdDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyFireDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyChaosDamage", Some(round(default_damage / 2.5)));

            for v in ["enemyPhysicalOverwhelm", "enemyLightningPen", "enemyColdPen", "enemyFirePen"] {
                ctx.set_placeholder_num(v, None);
            }
            ctx.set_placeholder_num("enemyArmour", Some(monster_table(ctx, "monsterArmourTable", default_level)));
            ctx.set_placeholder_num("enemyEvasion", Some(monster_table(ctx, "monsterEvasionTable", default_level)));
        }
        "Pinnacle" => {
            ctx.enemy.push(new_mod("Condition:RareOrUnique", ModType::Flag, b(true), "Config", vec![tag("Condition", &[("var", s("Effective"))])]));
            ctx.enemy.push(new_mod("Condition:PinnacleBoss", ModType::Flag, b(true), "Config", vec![tag("Condition", &[("var", s("Effective"))])]));
            ctx.enemy.push(new_mod("AilmentThreshold", ModType::More, n(404.0), "Boss", vec![]));
            ctx.mods.push(new_mod("WarcryPower", ModType::Base, n(20.0), "Boss", vec![]));
            ctx.mods.push(new_mod("Multiplier:EnemyPower", ModType::Base, n(20.0), "Boss", vec![]));

            ctx.set_placeholder_num("enemyLightningResist", Some(50.0));
            ctx.set_placeholder_num("enemyColdResist", Some(50.0));
            ctx.set_placeholder_num("enemyFireResist", Some(50.0));
            ctx.set_placeholder_num("enemyChaosResist", Some(30.0));

            ctx.set_placeholder_num("enemyLevel", Some(84.0));
            ctx.update_level();
            let default_level = ctx.enemy_level.max(84);
            let default_damage = round(monster_table(ctx, "monsterDamageTable", default_level) * 1.5 * misc(ctx, "pinnacleBossDPSMult"));
            ctx.set_placeholder_num("enemyPhysicalDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyLightningDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyColdDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyFireDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyChaosDamage", Some(round(default_damage / 2.5)));

            let pen = misc(ctx, "pinnacleBossPen");
            ctx.set_placeholder_num("enemyLightningPen", Some(pen));
            ctx.set_placeholder_num("enemyColdPen", Some(pen));
            ctx.set_placeholder_num("enemyFirePen", Some(pen));

            ctx.set_placeholder_num("enemyArmour", Some(round(monster_table(ctx, "monsterArmourTable", default_level) * (boss_stats(ctx, "PinnacleArmourMean") / 100.0))));
            ctx.set_placeholder_num("enemyEvasion", Some(round(monster_table(ctx, "monsterEvasionTable", default_level) * (boss_stats(ctx, "PinnacleEvasionMean") / 100.0))));
        }
        "Uber" => {
            ctx.enemy.push(new_mod("Condition:RareOrUnique", ModType::Flag, b(true), "Config", vec![tag("Condition", &[("var", s("Effective"))])]));
            ctx.enemy.push(new_mod("Condition:PinnacleBoss", ModType::Flag, b(true), "Config", vec![tag("Condition", &[("var", s("Effective"))])]));
            ctx.enemy.push(new_mod("DamageTaken", ModType::More, n(-70.0), "Boss", vec![]));
            ctx.enemy.push(new_mod("AilmentThreshold", ModType::More, n(404.0), "Boss", vec![]));
            ctx.mods.push(new_mod("WarcryPower", ModType::Base, n(20.0), "Boss", vec![]));
            ctx.mods.push(new_mod("Multiplier:EnemyPower", ModType::Base, n(20.0), "Boss", vec![]));

            ctx.set_placeholder_num("enemyLightningResist", Some(50.0));
            ctx.set_placeholder_num("enemyColdResist", Some(50.0));
            ctx.set_placeholder_num("enemyFireResist", Some(50.0));
            ctx.set_placeholder_num("enemyChaosResist", Some(30.0));

            ctx.set_placeholder_num("enemyLevel", Some(85.0));
            ctx.update_level();
            let default_level = ctx.enemy_level.max(85);
            let default_damage = round(monster_table(ctx, "monsterDamageTable", default_level) * 1.5 * misc(ctx, "uberBossDPSMult"));
            ctx.set_placeholder_num("enemyPhysicalDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyLightningDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyColdDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyFireDamage", Some(default_damage));
            ctx.set_placeholder_num("enemyChaosDamage", Some(round(default_damage / 4.0)));

            let pen = misc(ctx, "uberBossPen");
            ctx.set_placeholder_num("enemyLightningPen", Some(pen));
            ctx.set_placeholder_num("enemyColdPen", Some(pen));
            ctx.set_placeholder_num("enemyFirePen", Some(pen));

            ctx.set_placeholder_num("enemyArmour", Some(round(monster_table(ctx, "monsterArmourTable", default_level) * (boss_stats(ctx, "UberArmourMean") / 100.0))));
            ctx.set_placeholder_num("enemyEvasion", Some(round(monster_table(ctx, "monsterEvasionTable", default_level) * (boss_stats(ctx, "UberEvasionMean") / 100.0))));
        }
        _ => {}
    }
}

/// Port of `presetBossSkills` (ConfigOptions.lua ~2272). Reads `data.bossSkills[val]`.
fn preset_boss_skills(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let val = val.as_str();
    if val.as_ref() == "None" {
        // The "else" branch's varControls['enemyDamageType'].enabled bookkeeping is UI-only and
        // does not add a mod (enemyDamageType has no `apply`), so nothing to port here beyond
        // the input override, which IS observable (enemyDamageType has no apply, but other tabs
        // read configTab.input.enemyDamageType directly - out of this crate's modList scope).
        return;
    }
    let Ok(Some(boss_skills)) = ctx.game.extra.get("bossSkills") else { return };
    let Some(boss_data) = boss_skills.get(val.as_ref()).map(|j| j.to_value()) else { return };

    let is_uber_base = ctx.enemy_is_boss.as_deref() == Some("Uber");
    let earlier_uber = boss_data.get("earlierUber").and_then(J::as_bool).unwrap_or(false);
    let is_uber = is_uber_base || (earlier_uber && ctx.enemy_is_boss.as_deref() == Some("Pinnacle"));

    for v in ["enemyPhysicalDamage", "enemyLightningDamage", "enemyColdDamage", "enemyFireDamage", "enemyChaosDamage"] {
        ctx.set_placeholder_num(v, None);
    }

    let roll_range_input = ctx.get_input("enemyDamageRollRange").map(|v| v.as_f64());
    let roll_range_placeholder = ctx.placeholder.get("enemyDamageRollRange").map(|v| v.as_f64()).unwrap_or(70.0);
    let roll_range_mult = roll_range_input.unwrap_or(roll_range_placeholder).clamp(0.0, 100.0);

    if let Some(mults) = boss_data.get("DamageMultipliers").and_then(J::as_object) {
        let uber_mult = boss_data.get("UberDamageMultiplier").and_then(J::as_f64);
        for (damage_type, dm) in mults {
            let dm = dm.as_array().map(|a| (jnum(&a[0]), jnum(&a[1]))).unwrap_or((0.0, 0.0));
            let base = monster_table(ctx, "monsterDamageTable", ctx.enemy_level) * (dm.0 + roll_range_mult * dm.1);
            let value = if is_uber { uber_mult.map(|m| base * m).unwrap_or(base) } else { base };
            ctx.set_placeholder_num(&format!("enemy{damage_type}Damage"), Some(round(value)));
        }
    }

    for v in ["enemyPhysicalOverwhelm", "enemyLightningPen", "enemyColdPen", "enemyFirePen"] {
        ctx.set_placeholder_num(v, None);
    }
    if let Some(pens) = boss_data.get("DamagePenetrations").and_then(J::as_object) {
        let uber_pens = boss_data.get("UberDamagePenetrations").and_then(J::as_object);
        for (pen_type, pen) in pens {
            let value = if is_uber { uber_pens.and_then(|u| u.get(pen_type)).map(jnum).unwrap_or_else(|| jnum(pen)) } else { jnum(pen) };
            ctx.set_placeholder_num(&format!("enemy{pen_type}"), Some(value));
        }
    }

    if let Some(damage_type) = boss_data.get("DamageType").and_then(J::as_str) {
        ctx.set_input_str("enemyDamageType", damage_type);
    }

    if is_uber {
        if let Some(uber_speed) = boss_data.get("UberSpeed").and_then(J::as_f64) {
            ctx.set_placeholder_num("enemySpeed", Some(uber_speed));
        } else if let Some(speed) = boss_data.get("speed").and_then(J::as_f64) {
            ctx.set_placeholder_num("enemySpeed", Some(speed));
        }
    } else if let Some(speed) = boss_data.get("speed").and_then(J::as_f64) {
        ctx.set_placeholder_num("enemySpeed", Some(speed));
    }
    if let Some(crit) = boss_data.get("critChance").and_then(J::as_f64) {
        ctx.set_placeholder_num("enemyCritChance", Some(crit));
    }

    ctx.mods.push(new_mod("BossSkillActive", ModType::Flag, b(true), "Config", vec![]));

    if val.as_ref() == "Atziri Flameblast" && is_uber {
        ctx.enemy.push(new_mod("Damage", ModType::Inc, n(60.0), "Alluring Abyss Map Mod", vec![]));
    }
    if let Some(additional) = boss_data.get("additionalStats") {
        let stats = if is_uber { additional.get("uber") } else { additional.get("base") };
        if let Some(stats) = stats.and_then(J::as_object) {
            for (k, v) in stats {
                if v.as_str() == Some("flag") {
                    ctx.enemy.push(new_mod(k, ModType::Flag, b(true), "BossSkillAdditionalData", vec![]));
                } else {
                    ctx.enemy.push(new_mod(k, ModType::Base, n(jnum(v)), "BossSkillAdditionalData", vec![]));
                }
            }
        }
    }
}

/// Port of `enemySizePreset` (ConfigOptions.lua ~787).
fn enemy_size_preset(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let radius: f64 = match val.as_str().as_ref() {
        "Small" => 2.0,
        "Medium" => 3.0,
        "Large" => 5.0,
        "Huge" => 11.0,
        _ => return,
    };
    // Upstream also does `varControls['enemyRadius']:SetPlaceholder(radius, false)` here, but
    // `notify=false` means EditClass:SetPlaceholder never calls `changeFunc`, so
    // `configTab.placeholder['enemyRadius']` is NOT updated (only the control's own display
    // value is, which is UI-only and irrelevant to BuildModList). Deliberately not replicated.
    ctx.mods.push(new_mod("EnemyRadius", ModType::Base, n(radius), "Config", vec![]));
}

/// Port of the local `mapAffixDropDownFunction` (ConfigOptions.lua, top of file), the shared
/// `apply` for all 8 `MapPrefix*`/`MapSuffix*` options. All 8 register to this one dispatcher
/// since `Handler` is a plain `fn` pointer (no per-option closures needed: it re-derives
/// everything from `ctx` and the option's own `val`, exactly like upstream shared function).
fn map_affix_dispatch(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let val_str = val.as_str();
    if val_str.as_ref() == "NONE" {
        return;
    }
    let tier_idx = match ctx.get_input("multiplierMapModTier").map(|v| v.as_str()) {
        Some(s) if s.as_ref() == "MED" => 2.0,
        Some(s) if s.as_ref() == "LOW" => 3.0,
        _ => 1.0,
    };
    let mod_effect = 1.0 + ctx.get_input("multiplierMapModEffect").map(|v| v.as_f64()).unwrap_or(0.0) / 100.0;
    // Upstream passes a hardcoded 100 as the roll range for every "count"-type affix (not
    // `enemyDamageRollRange`, unlike presetBossSkills):
    // `affixData.apply(4 - selIndex, 100, mapModEffect, values, modList, enemyModList)`.
    let roll_range = 100.0;
    let list_val = 4.0 - tier_idx;
    mapmods::apply_affix(&val_str, list_val, roll_range, mod_effect, ctx);
}

pub fn register(map: &mut HandlerMap) {
    map.insert("enemyIsBoss", enemy_is_boss);
    map.insert("presetBossSkills", preset_boss_skills);
    map.insert("enemySizePreset", enemy_size_preset);
    for var in ["MapPrefix1", "MapPrefix2", "MapPrefix3", "MapPrefix4", "MapSuffix1", "MapSuffix2", "MapSuffix3", "MapSuffix4"] {
        map.insert(var, map_affix_dispatch);
    }
}
