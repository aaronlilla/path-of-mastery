//! Port of `calcs.buildDefenceEstimations(env, actor)` (Modules/CalcDefence.lua lines 1674-3874):
//! chance to not be hit, enemy damage input/conversion, damage-taken-as, damage-taken
//! multipliers/degens, armour/resist mitigation, stun, recoverable life pools, ES/ward/mana/MoM
//! bypass, guard/aegis/ally-pool redirects, EHP + time-to-die (`pools::number_of_hits_to_die`),
//! recoup, petrified blood, pvp, max hit taken (the quadratic-solve reverse calculation), DoT EHP,
//! and build/comprehensive degen. `build_defence_estimations` is the entry point, running every
//! section in Lua source order.
//!
//! `env.configPlaceholder` is the per-build default every enemy-damage/crit config field falls
//! back to when a build has not set it. The recorded answer keys never captured it, so it is
//! supplied per build by a probe of upstream at `CalcDefence.lua:1675` and joined onto the
//! recorded stores by build name. It is a per-build constant (set once when the config tab
//! initialises, Modules/CalcSetup.lua:497), not per-event, so one value per build is enough.
//!
//! Provisional fields are graded against section probes, not the final `postOutput`. Several
//! `output.X` names are reused for a different purpose later in the function (`TakenHitMult` is
//! set once per damage type in `taken_mult_degen`, then reassigned to a different meaning in
//! `incoming_hit_mult`), so comparing such a field against the final recorded `postOutput` would
//! silently grade the wrong section's formula. The section probes capture each section's own
//! `output.X` snapshot at its first and last Lua line, so a section is graded against the value it
//! actually produced, not a later overwrite.
use crate::data::{misc, monster_phys_conversion_multi};
use crate::pools::{is_elemental, DMG_TYPES};
use crate::tools::round;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_engine::fxhash::HashMap;

fn s(name: &str) -> Sym {
    Sym::new(name)
}
fn g(output: &HashMap<String, f64>, key: &str) -> f64 {
    output.get(key).copied().unwrap_or(0.0)
}
/// `output[a] or output[b]`: Lua falls back only on nil (a missing key), not on a present zero.
fn g_or(output: &HashMap<String, f64>, a: &str, b: &str) -> f64 {
    output.get(a).copied().unwrap_or_else(|| g(output, b))
}
/// `KeywordFlag.MatchAll`'s 32-bit `bit.bnot` (LuaJIT's `bit` library is 32-bit two's complement) -
/// see `pom_engine::modstore::store`'s own copy of this constant (private there).
const MATCH_ALL: u64 = 0x4000_0000;
const NOT_MATCH_ALL_32: u64 = (!MATCH_ALL) & 0xFFFF_FFFF;

/// `env.configInput[key] or env.configPlaceholder[key]`, `tonumber`'d (both maps are already
/// numeric-only in the recorded data, so presence already implies a valid number).
fn cfg_num(config_input: &HashMap<String, f64>, config_placeholder: &HashMap<String, f64>, key: &str) -> Option<f64> {
    config_input.get(key).or_else(|| config_placeholder.get(key)).copied()
}

/// `env.configInput.enemyDamageType or "Average"` (Lua line 1684).
pub fn damage_category_config(config_str: &HashMap<String, String>) -> String {
    config_str.get("enemyDamageType").cloned().unwrap_or_else(|| "Average".to_string())
}

/// "chance to not be hit calculations" (Lua lines 1686-1707). Skipped entirely (all nine fields
/// left untouched) when `damageCategoryConfig == "DamageOverTime"`, matching the Lua's own guard.
pub fn not_hit_chance(output: &mut HashMap<String, f64>, config_input: &HashMap<String, f64>, damage_category_config: &str, specific_type_avoidance: bool) {
    if damage_category_config == "DamageOverTime" {
        return;
    }
    let worst_of = config_input.get("EHPUnluckyWorstOf").copied().unwrap_or(1.0);
    let melee_evade = g(output, "MeleeEvadeChance");
    let proj_evade = g(output, "ProjectileEvadeChance");
    let eff_dodge = g(output, "EffectiveAttackDodgeChance");
    let avoid_all = g(output, "AvoidAllDamageFromHitsChance");
    let spell_dodge = g(output, "EffectiveSpellDodgeChance");
    let avoid_proj = if specific_type_avoidance { 0.0 } else { g(output, "AvoidProjectilesChance") };

    let melee_not_hit = 100.0 - (1.0 - melee_evade / 100.0) * (1.0 - eff_dodge / 100.0) * (1.0 - avoid_all / 100.0) * 100.0;
    output.insert("MeleeNotHitChance".into(), melee_not_hit);
    let proj_not_hit = 100.0 - (1.0 - proj_evade / 100.0) * (1.0 - eff_dodge / 100.0) * (1.0 - avoid_all / 100.0) * (1.0 - avoid_proj / 100.0) * 100.0;
    output.insert("ProjectileNotHitChance".into(), proj_not_hit);
    let spell_not_hit = 100.0 - (1.0 - spell_dodge / 100.0) * (1.0 - avoid_all / 100.0) * 100.0;
    output.insert("SpellNotHitChance".into(), spell_not_hit);
    let spell_proj_not_hit = 100.0 - (1.0 - spell_dodge / 100.0) * (1.0 - avoid_all / 100.0) * (1.0 - avoid_proj / 100.0) * 100.0;
    output.insert("SpellProjectileNotHitChance".into(), spell_proj_not_hit);
    let untyped_not_hit = 100.0 - (1.0 - avoid_all / 100.0) * 100.0;
    output.insert("UntypedNotHitChance".into(), untyped_not_hit);
    output.insert("AverageNotHitChance".into(), (melee_not_hit + proj_not_hit + spell_not_hit + spell_proj_not_hit) / 4.0);
    output.insert("AverageEvadeChance".into(), (melee_evade + proj_evade) / 4.0);

    let mut configured_not_hit = g(output, &format!("{damage_category_config}NotHitChance"));
    let mut configured_evade = output.get(&format!("{damage_category_config}EvadeChance")).copied().unwrap_or(0.0);
    if worst_of > 1.0 {
        configured_not_hit = configured_not_hit / 100.0 * configured_not_hit;
        configured_evade = configured_evade / 100.0 * configured_evade;
        if worst_of == 4.0 {
            configured_not_hit = configured_not_hit / 100.0 * configured_not_hit;
            configured_evade = configured_evade / 100.0 * configured_evade;
        }
    }
    output.insert("ConfiguredNotHitChance".into(), configured_not_hit);
    output.insert("ConfiguredEvadeChance".into(), configured_evade);
}

/// "Enemy damage input and modifications" (Lua lines 1709-1844). The `DamageOverTime` branch
/// (1712-1718) is trivial; the main branch (1719-1844) computes conversion/gain-as and enemy
/// crit multipliers. `enemy_level` is `env.enemyLevel`.
#[allow(clippy::too_many_arguments)]
pub fn enemy_damage(
    output: &mut HashMap<String, f64>,
    store: &ModStore,
    enemy: &ModStore,
    config_input: &HashMap<String, f64>,
    config_placeholder: &HashMap<String, f64>,
    damage_category_config: &str,
    enemy_level: f64,
) {
    output.insert("totalEnemyDamage".into(), 0.0);
    output.insert("totalEnemyDamageIn".into(), 0.0);

    if damage_category_config == "DamageOverTime" {
        for &dt in DMG_TYPES {
            output.insert(format!("{dt}EnemyPen"), 0.0);
            let mut names = vec![pom_engine::sym!("Damage"), s(&format!("{dt}Damage"))];
            if is_elemental(dt) {
                names.push(pom_engine::sym!("ElementalDamage"));
            }
            output.insert(format!("{dt}EnemyDamageMult"), crate::tools::mod_(enemy, None, &names));
            output.insert(format!("{dt}EnemyOverwhelm"), 0.0);
            output.insert(format!("{dt}EnemyDamage"), 0.0);
        }
        return;
    }

    crate::bd_est::total_enemy_damage_init();
    let enemy_cfg = Cfg { keyword_flags: NOT_MATCH_ALL_32, ..Default::default() };
    let enemy_crit_chance = if enemy.flag(None, &[pom_engine::sym!("NeverCrit")]) {
        0.0
    } else if enemy.flag(None, &[pom_engine::sym!("AlwaysCrit")]) {
        100.0
    } else {
        let base = store.override_(None, &[pom_engine::sym!("enemyCritChance")]).and_then(|v| v.num()).or_else(|| cfg_num(config_input, config_placeholder, "enemyCritChance")).unwrap_or(0.0);
        let mult = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("EnemyCritChance")]) / 100.0 + enemy.sum(ModType::Inc, None, &[pom_engine::sym!("CritChance")]) / 100.0;
        (base * mult * (1.0 - g(output, "ConfiguredEvadeChance") / 100.0)).min(100.0).max(0.0)
    };
    output.insert("EnemyCritChance".into(), enemy_crit_chance);
    let enemy_crit_damage = (cfg_num(config_input, config_placeholder, "enemyCritDamage").unwrap_or(0.0) + enemy.sum(ModType::Base, None, &[pom_engine::sym!("CritMultiplier")])).max(0.0);
    let enemy_crit_effect = 1.0 + enemy_crit_chance / 100.0 * (enemy_crit_damage / 100.0) * (1.0 - g(output, "CritExtraDamageReduction") / 100.0);
    output.insert("EnemyCritEffect".into(), enemy_crit_effect);

    // `local enemyDamageConversion = {}` lives outside the per-type loop (CalcDefence.lua:1740): Physical fills
    // it, the later types read it.
    let mut enemy_damage_conversion: HashMap<&str, HashMap<&str, f64>> = HashMap::default();
    for &damage_type in DMG_TYPES {
        let mut names = vec![pom_engine::sym!("Damage"), s(&format!("{damage_type}Damage"))];
        if is_elemental(damage_type) {
            names.push(pom_engine::sym!("ElementalDamage"));
        }
        let enemy_damage_mult = crate::tools::mod_(enemy, None, &names);

        let mut enemy_damage = config_input.get(&format!("enemy{damage_type}Damage")).copied();
        let mut enemy_pen = config_input.get(&format!("enemy{damage_type}Pen")).copied();
        let mut enemy_overwhelm = config_input.get(&format!("enemy{damage_type}Overwhelm")).copied();
        let bd_source = if enemy_damage.is_none() { "Default" } else { "Config" };
        if enemy_damage.is_none() {
            enemy_damage = Some(config_placeholder.get(&format!("enemy{damage_type}Damage")).copied().unwrap_or(0.0));
        }
        if enemy_pen.is_none() {
            enemy_pen = Some(config_placeholder.get(&format!("enemy{damage_type}Pen")).copied().unwrap_or(0.0));
        }
        if enemy_overwhelm.is_none() {
            // Lua reads `env.configPlaceholder["enemy"..damageType.."enemyOverwhelm"]` here - a
            // literal, uncorrected typo in upstream (doubled "enemy...enemyOverwhelm"), so
            // this placeholder key never actually exists and the fallback is always 0. Ported
            // faithfully, including the typo (a genuine bug in upstream).
            enemy_overwhelm = Some(config_placeholder.get(&format!("enemy{damage_type}enemyOverwhelm")).copied().unwrap_or(0.0));
        }
        let mut enemy_damage = enemy_damage.unwrap();
        let enemy_pen = enemy_pen.unwrap();
        let mut enemy_overwhelm = enemy_overwhelm.unwrap();

        enemy_damage += (enemy.sum(ModType::Base, Some(&enemy_cfg), &[s(&format!("{damage_type}Min"))]) + enemy.sum(ModType::Base, Some(&enemy_cfg), &[s(&format!("{damage_type}Max"))])) / 2.0;

        let mut conversion_total = 0.0;
        if damage_type == "Physical" {
            let mut conv: HashMap<&str, f64> = HashMap::default();
            let mut conv_skill: HashMap<&str, f64> = HashMap::default();
            let mut total_skill = 0.0;
            let mut total = 0.0;
            for &to in DMG_TYPES {
                let v_skill = enemy.sum(ModType::Base, Some(&enemy_cfg), &[s(&format!("{damage_type}DamageSkillConvertTo{to}"))]);
                let v = enemy.sum(ModType::Base, Some(&enemy_cfg), &[s(&format!("{damage_type}DamageConvertTo{to}"))]);
                conv_skill.insert(to, v_skill);
                conv.insert(to, v);
                total_skill += v_skill;
                total += v;
            }
            if total_skill > 100.0 {
                let mult = 100.0 / total_skill;
                total_skill *= mult;
                total = 0.0;
                for &to in DMG_TYPES {
                    *conv_skill.get_mut(to).unwrap() *= mult;
                    conv.insert(to, 0.0);
                }
            } else if total + total_skill > 100.0 {
                let mult = (100.0 - total_skill) / total;
                total *= mult;
                for &to in DMG_TYPES {
                    *conv.get_mut(to).unwrap() *= mult;
                }
            }
            conversion_total = total + total_skill;
            for &to in DMG_TYPES {
                let gain_as_percent = enemy.sum(ModType::Base, Some(&enemy_cfg), &[s(&format!("{damage_type}DamageGainAs{to}"))]) / 100.0;
                let mut conversion_percent = conv[to] / 100.0;
                let skill_conversion_percent = conv_skill[to] / 100.0;
                if skill_conversion_percent > 0.0 {
                    let mut skill_conversion_percent = skill_conversion_percent;
                    if damage_type == "Physical" && to != "Chaos" {
                        let phys_bonus = 1.0 + monster_phys_conversion_multi(enemy_level) / 100.0;
                        skill_conversion_percent *= phys_bonus;
                    }
                    conversion_percent += skill_conversion_percent;
                }
                if gain_as_percent > 0.0 || conversion_percent > 0.0 {
                    enemy_damage_conversion.entry(to).or_default().insert(damage_type, enemy_damage * gain_as_percent + enemy_damage * conversion_percent);
                }
            }
        }

        // Overwhelm is Physical-only in game; upstream applies it to every damage type. POM_STRICT_COMPAT=1 keeps the upstream behaviour.
        if damage_type == "Physical" || !pom_offence::data::pom_fixes_on() {
            enemy_overwhelm += enemy.sum(ModType::Base, None, &[pom_engine::sym!("PhysicalOverwhelm")]) + store.sum(ModType::Base, None, &[pom_engine::sym!("EnemyPhysicalOverwhelm")]);
        }

        output.insert(format!("{damage_type}EnemyPen"), enemy_pen);
        output.insert(format!("{damage_type}EnemyDamageMult"), enemy_damage_mult);
        output.insert(format!("{damage_type}EnemyOverwhelm"), enemy_overwhelm);
        output.insert("totalEnemyDamageIn".into(), g(output, "totalEnemyDamageIn") + enemy_damage);
        let mut type_enemy_damage = enemy_damage * (1.0 - conversion_total / 100.0) * enemy_damage_mult * enemy_crit_effect;
        let mut bd_conversion_extra = -enemy_damage * enemy_damage_mult * enemy_crit_effect + type_enemy_damage;
        if let Some(from_map) = enemy_damage_conversion.get(damage_type) {
            for (&damage_type_from, &conv_damage) in from_map {
                let mut names = vec![pom_engine::sym!("Damage"), s(&format!("{damage_type}Damage")), s(&format!("{damage_type_from}Damage"))];
                if is_elemental(damage_type) {
                    names.push(pom_engine::sym!("ElementalDamage"));
                }
                if is_elemental(damage_type_from) {
                    names.push(pom_engine::sym!("ElementalDamage"));
                }
                let mult = crate::tools::mod_(enemy, None, &names);
                type_enemy_damage += conv_damage * mult * enemy_crit_effect;
                bd_conversion_extra += conv_damage * mult * enemy_crit_effect;
            }
        }
        output.insert(format!("{damage_type}EnemyDamage"), type_enemy_damage);
        output.insert("totalEnemyDamage".into(), g(output, "totalEnemyDamage") + type_enemy_damage);
        crate::bd_est::enemy_damage_type(damage_type, bd_source, enemy_damage, enemy_damage_mult, enemy_crit_effect, bd_conversion_extra, type_enemy_damage);
    }
}

pub struct ShiftTables {
    /// `actor.damageShiftTable[damageType][destType]`: percent of `damageType` hit damage taken as
    /// `destType` (includes the "from hits" component; used by the DoT-only table below too).
    pub damage_shift_table: HashMap<String, HashMap<String, f64>>,
    /// `actor.damageOverTimeShiftTable[damageType][destType]`: percent of `damageType` DoT damage
    /// taken as `destType` (used by `build_degen`/`comprehensive_degen`).
    pub damage_over_time_shift_table: HashMap<String, HashMap<String, f64>>,
}

/// "Damage Taken as" (Lua lines 1846-1922).
pub fn damage_taken_as(output: &mut HashMap<String, f64>, store: &ModStore) -> ShiftTables {
    let mut damage_shift_table: HashMap<String, HashMap<String, f64>> = HashMap::default();
    let mut damage_over_time_shift_table: HashMap<String, HashMap<String, f64>> = HashMap::default();

    for &damage_type in DMG_TYPES {
        let mut shift_table: HashMap<String, f64> = HashMap::default();
        let mut dot_shift_table: HashMap<String, f64> = HashMap::default();
        let mut dest_total = 0.0;
        let mut dot_destination_total = 0.0;
        for &dest_type in DMG_TYPES {
            if dest_type == damage_type {
                continue;
            }
            let mut dot_names = vec![s(&format!("{damage_type}DamageTakenAs{dest_type}"))];
            if is_elemental(damage_type) {
                dot_names.push(s(&format!("ElementalDamageTakenAs{dest_type}")));
            }
            let dot_val = store.sum(ModType::Base, None, &dot_names);
            dot_shift_table.insert(dest_type.to_string(), dot_val);
            dot_destination_total += dot_val;

            let mut hit_names = vec![s(&format!("{damage_type}DamageFromHitsTakenAs{dest_type}"))];
            if is_elemental(damage_type) {
                hit_names.push(s(&format!("ElementalDamageFromHitsTakenAs{dest_type}")));
            }
            let hit_extra = store.sum(ModType::Base, None, &hit_names);
            let shift_val = dot_val + hit_extra;
            shift_table.insert(dest_type.to_string(), shift_val);
            dest_total += shift_val;
        }
        dot_shift_table.insert(damage_type.to_string(), (100.0 - dot_destination_total).max(0.0));
        shift_table.insert(damage_type.to_string(), (100.0 - dest_total).max(0.0));

        let taken = g(output, &format!("{damage_type}EnemyDamage")) * shift_table[damage_type] / 100.0;
        output.insert(format!("{damage_type}TakenDamage"), taken);
        crate::bd_est::taken_damage_same(damage_type, taken);

        damage_over_time_shift_table.insert(damage_type.to_string(), dot_shift_table);
        damage_shift_table.insert(damage_type.to_string(), shift_table);
    }

    for &damage_type in DMG_TYPES {
        for &damage_converted_type in DMG_TYPES {
            if damage_type == damage_converted_type {
                continue;
            }
            let conv = damage_shift_table[damage_type][damage_converted_type];
            let damage = g(output, &format!("{damage_type}EnemyDamage")) * conv / 100.0;
            let key = format!("{damage_converted_type}TakenDamage");
            let cur = g(output, &key);
            output.insert(key, cur + damage);
            crate::bd_est::taken_damage_converted(damage_converted_type, damage_type, damage);
        }
    }

    let mut total = 0.0;
    for &damage_type in DMG_TYPES {
        total += g(output, &format!("{damage_type}TakenDamage"));
    }
    output.insert("totalTakenDamage".into(), total);
    if pom_offence::bd::on() {
        let vals: Vec<(&str, f64)> = DMG_TYPES.iter().map(|d| (*d, g(output, &format!("{d}TakenDamage")))).collect();
        crate::bd_est::total_taken_damage(&vals);
    }

    ShiftTables { damage_shift_table, damage_over_time_shift_table }
}

const HIT_SOURCE_LIST: &[&str] = &["Attack", "Spell"];

/// "Damage taken multipliers/Degen calculations" (Lua lines 1924-1984). `output.AnyTakenReflect`
/// is unconditionally left `false` - the Lua sets it inside a condition but the `true` branch is
/// commented out (`--true --this needs a rework as well`), a genuine, intentional-looking bug in
/// upstream (ported faithfully, not fixed).
pub fn taken_mult_degen(output: &mut HashMap<String, f64>, store: &ModStore) {
    output.insert("AnyTakenReflect".into(), 0.0);
    for &damage_type in DMG_TYPES {
        let elemental = is_elemental(damage_type);
        let mut base_taken_inc = store.sum(ModType::Inc, None, &[pom_engine::sym!("DamageTaken"), s(&format!("{damage_type}DamageTaken"))]);
        let mut base_taken_more = store.more(None, &[pom_engine::sym!("DamageTaken"), s(&format!("{damage_type}DamageTaken"))]);
        if elemental {
            base_taken_inc += store.sum(ModType::Inc, None, &[pom_engine::sym!("ElementalDamageTaken")]);
            base_taken_more *= store.more(None, &[pom_engine::sym!("ElementalDamageTaken")]);
        }
        // Hit
        {
            let mut taken_inc = base_taken_inc + store.sum(ModType::Inc, None, &[pom_engine::sym!("DamageTakenWhenHit"), s(&format!("{damage_type}DamageTakenWhenHit"))]);
            let mut taken_more = base_taken_more * store.more(None, &[pom_engine::sym!("DamageTakenWhenHit"), s(&format!("{damage_type}DamageTakenWhenHit"))]);
            if elemental {
                taken_inc += store.sum(ModType::Inc, None, &[pom_engine::sym!("ElementalDamageTakenWhenHit")]);
                taken_more *= store.more(None, &[pom_engine::sym!("ElementalDamageTakenWhenHit")]);
            }
            output.insert(format!("{damage_type}TakenHitMult"), ((1.0 + taken_inc / 100.0) * taken_more).max(0.0));

            for &hit_type in HIT_SOURCE_LIST {
                let base_taken_inc_type = taken_inc + store.sum(ModType::Inc, None, &[s(&format!("{hit_type}DamageTaken"))]);
                let base_taken_more_type = taken_more * store.more(None, &[s(&format!("{hit_type}DamageTaken"))]);
                let v = ((1.0 + base_taken_inc_type / 100.0) * base_taken_more_type).max(0.0);
                output.insert(format!("{hit_type}TakenHitMult"), v);
                output.insert(format!("{damage_type}{hit_type}TakenHitMult"), v);
            }
            // Reflect
            taken_inc += store.sum(ModType::Inc, None, &[pom_engine::sym!("ReflectedDamageTaken"), s(&format!("{damage_type}ReflectedDamageTaken"))]);
            taken_more *= store.more(None, &[pom_engine::sym!("ReflectedDamageTaken"), s(&format!("{damage_type}ReflectedDamageTaken"))]);
            if elemental {
                taken_inc += store.sum(ModType::Inc, None, &[pom_engine::sym!("ElementalReflectedDamageTaken")]);
                taken_more *= store.more(None, &[pom_engine::sym!("ElementalReflectedDamageTaken")]);
            }
            output.insert(format!("{damage_type}TakenReflect"), ((1.0 + taken_inc / 100.0) * taken_more).max(0.0));
        }
        // Dot
        {
            let mut taken_inc = base_taken_inc + store.sum(ModType::Inc, None, &[pom_engine::sym!("DamageTakenOverTime"), s(&format!("{damage_type}DamageTakenOverTime"))]);
            let mut taken_more = base_taken_more * store.more(None, &[pom_engine::sym!("DamageTakenOverTime"), s(&format!("{damage_type}DamageTakenOverTime"))]);
            if elemental {
                taken_inc += store.sum(ModType::Inc, None, &[pom_engine::sym!("ElementalDamageTakenOverTime")]);
                taken_more *= store.more(None, &[pom_engine::sym!("ElementalDamageTakenOverTime")]);
            }
            let resist = if store.flag(None, &[s(&format!("SelfIgnore{damage_type}Resistance"))]) { 0.0 } else { g_or(output, &format!("{damage_type}ResistOverTime"), &format!("{damage_type}Resist")) };
            let reduction = if store.flag(None, &[s(&format!("SelfIgnoreBase{damage_type}DamageReduction"))]) { 0.0 } else { g(output, &format!("Base{damage_type}DamageReduction")) };
            output.insert(format!("{damage_type}TakenDotMult"), ((1.0 - resist / 100.0) * (1.0 - reduction / 100.0) * (1.0 + taken_inc / 100.0) * taken_more).max(0.0));
            crate::bd_est::taken_dot_mult(damage_type, resist, reduction, taken_inc, taken_more, g(output, &format!("{damage_type}TakenDotMult")));
        }
    }
}

/// "Incoming hit damage multipliers" (Lua lines 1986-2151).
pub fn incoming_hit_mult(output: &mut HashMap<String, f64>, store: &ModStore, enemy: &ModStore, damage_category_config: &str) {
    output.insert("totalTakenHit".into(), 0.0);
    crate::bd_est::total_taken_hit_init();
    let impale_flags = if matches!(damage_category_config, "Melee" | "Projectile" | "Average") { pom_engine::modparser::flags::mod_flag::Attack } else { 0 };
    let impale_cfg = Cfg { flags: impale_flags, keyword_flags: 0, ..Default::default() };
    let enemy_impale_chance = enemy.sum(ModType::Base, Some(&impale_cfg), &[pom_engine::sym!("ImpaleChance")]) * (if damage_category_config == "Average" { 0.5 } else { 1.0 }) * (1.0 - output.get("ImpaleAvoidChance").copied().unwrap_or(0.0));

    let damage_reduction_max = g(output, "DamageReductionMax");
    for &damage_type in DMG_TYPES {
        let resist = if store.flag(None, &[s(&format!("SelfIgnore{damage_type}Resistance"))]) { 0.0 } else { g_or(output, &format!("{damage_type}ResistWhenHit"), &format!("{damage_type}Resist")) };
        let reduction = if store.flag(None, &[s(&format!("SelfIgnoreBase{damage_type}DamageReduction"))]) { 0.0 } else { g_or(output, &format!("Base{damage_type}DamageReductionWhenHit"), &format!("Base{damage_type}DamageReduction")) };
        let enemy_pen = if store.flag(None, &[s(&format!("SelfIgnore{damage_type}Resistance")), s(&format!("EnemyCannotPen{damage_type}Resistance"))]) { 0.0 } else { g(output, &format!("{damage_type}EnemyPen")) };
        let enemy_overwhelm = if store.flag(None, &[s(&format!("SelfIgnore{damage_type}DamageReduction"))]) { 0.0 } else { g(output, &format!("{damage_type}EnemyOverwhelm")) };
        let damage = g(output, &format!("{damage_type}TakenDamage"));
        let mut impale_damage = if enemy_impale_chance > 0.0 && damage_type == "Physical" { damage * misc("ImpaleStoredDamageBase") } else { 0.0 };
        let mut armour_reduct = 0.0;
        let mut impale_armour_reduct = 0.0;
        let percent_of_armour_applies = (if !store.flag(None, &[s(&format!("ArmourDoesNotApplyTo{damage_type}DamageTaken"))]) { store.sum(ModType::Base, None, &[s(&format!("ArmourAppliesTo{damage_type}DamageTaken"))]) } else { 0.0 }).min(100.0);
        let mut effective_applied_armour = (g(output, "Armour") * percent_of_armour_applies / 100.0) * (1.0 + g(output, "ArmourDefense"));
        let physical_reduction_based_on_ward = damage_type == "Physical" && store.flag(None, &[pom_engine::sym!("PhysicalReductionBasedOnWard")]);
        if physical_reduction_based_on_ward {
            let multiplier = store.override_(None, &[pom_engine::sym!("PhysicalReductionBasedOnWardPercent")]).and_then(|v| v.num()).unwrap_or(0.0) / 100.0;
            effective_applied_armour = g(output, "Ward") * multiplier;
        }
        let res_mult = 1.0 - (resist - enemy_pen) / 100.0;
        let mut taken_flat = store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTaken"), s(&format!("{damage_type}DamageTaken")), pom_engine::sym!("DamageTakenWhenHit"), s(&format!("{damage_type}DamageTakenWhenHit"))]);
        match damage_category_config {
            "Melee" | "Projectile" => {
                taken_flat += store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTakenFromAttacks"), s(&format!("{damage_type}DamageTakenFromAttacks")), s(&format!("{damage_type}DamageTakenFrom{damage_category_config}Attacks"))]);
            }
            "Spell" | "SpellProjectile" => {
                taken_flat += store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTakenFromSpells"), s(&format!("{damage_type}DamageTakenFromSpells")), s(&format!("{damage_type}DamageTakenFromSpellProjectiles"))]);
            }
            "Average" => {
                taken_flat += store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTakenFromAttacks"), s(&format!("{damage_type}DamageTakenFromAttacks"))]) / 2.0
                    + store.sum(ModType::Base, None, &[s(&format!("{damage_type}DamageTakenFromProjectileAttacks"))]) / 4.0
                    + store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTakenFromSpells"), s(&format!("{damage_type}DamageTakenFromSpells"))]) / 2.0
                    + store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTakenFromSpellProjectiles"), s(&format!("{damage_type}DamageTakenFromSpellProjectiles"))]) / 4.0;
            }
            _ => {}
        }
        output.insert(format!("{damage_type}takenFlat"), taken_flat);
        if percent_of_armour_applies > 0.0 || physical_reduction_based_on_ward {
            armour_reduct = crate::defence::armour_reduction(effective_applied_armour, damage * res_mult);
            armour_reduct = damage_reduction_max.min(armour_reduct);
            if impale_damage > 0.0 {
                impale_armour_reduct = damage_reduction_max.min(crate::defence::armour_reduction(effective_applied_armour, impale_damage * res_mult));
            }
        }
        let total_reduct = damage_reduction_max.min(armour_reduct + reduction);
        let reduct_mult = 1.0 - damage_reduction_max.min(total_reduct - enemy_overwhelm).max(0.0) / 100.0;
        output.insert(format!("{damage_type}DamageReduction"), 100.0 - reduct_mult * 100.0);
        let bd_reduct_mult = reduct_mult;
        if impale_damage > 0.0 {
            impale_damage *= res_mult * (1.0 - damage_reduction_max.min(damage_reduction_max.min(impale_armour_reduct + reduction) - enemy_overwhelm).max(0.0) / 100.0);
            impale_damage = impale_damage * enemy_impale_chance / 100.0 * 5.0 * g(output, &format!("{damage_type}TakenReflect"));
        }
        let (taken_mult, spell_suppress_mult) = match damage_category_config {
            "Melee" | "Projectile" => (g(output, &format!("{damage_type}AttackTakenHitMult")), 1.0),
            "Spell" | "SpellProjectile" => {
                let m = if g(output, "EffectiveSpellSuppressionChance") == 100.0 { 1.0 - g(output, "SpellSuppressionEffect") / 100.0 } else { 1.0 };
                (g(output, &format!("{damage_type}SpellTakenHitMult")), m)
            }
            "Average" => {
                let m = if g(output, "EffectiveSpellSuppressionChance") == 100.0 { 1.0 - g(output, "SpellSuppressionEffect") / 100.0 / 2.0 } else { 1.0 };
                ((g(output, &format!("{damage_type}SpellTakenHitMult")) + g(output, &format!("{damage_type}AttackTakenHitMult"))) / 2.0, m)
            }
            _ => (g(output, &format!("{damage_type}TakenHitMult")), 1.0),
        };
        output.insert(format!("{damage_type}EffectiveAppliedArmour"), effective_applied_armour);
        output.insert(format!("{damage_type}ResistTakenHitMulti"), res_mult);
        let after_reduction_multi = taken_mult * spell_suppress_mult;
        output.insert(format!("{damage_type}AfterReductionTakenHitMulti"), after_reduction_multi);
        let base_mult = res_mult * reduct_mult;
        output.insert(format!("{damage_type}BaseTakenHitMult"), base_mult * after_reduction_multi);
        let taken_hit = (damage * base_mult + taken_flat).max(0.0) * taken_mult * spell_suppress_mult + impale_damage;
        output.insert(format!("{damage_type}TakenHit"), taken_hit);
        output.insert(format!("{damage_type}TakenHitMult"), if damage > 0.0 { taken_hit / damage } else { 0.0 });
        output.insert("totalTakenHit".into(), g(output, "totalTakenHit") + taken_hit);
        if pom_offence::bd::on() {
            crate::bd_est::incoming_hit(&crate::bd_est::HitMult {
                damage_type,
                damage,
                resist,
                reduction,
                enemy_pen,
                enemy_overwhelm,
                armour_reduct,
                percent_of_armour_applies,
                physical_reduction_based_on_ward,
                res_mult,
                reduct_mult: bd_reduct_mult,
                base_mult,
                taken_flat,
                taken_mult,
                spell_suppress_mult,
                impale_damage,
                final_hit_mult: g(output, &format!("{damage_type}TakenHitMult")),
            });
        }
    }
}

/// "stun" (Lua lines 2153-2256). `env.modDB:Flag(nil, "EnergyShieldProtectsMana")` (line 2181) is
/// read from the *player's* modDB, not the acting actor's (`env.modDB` is always the player's -
/// Modules/CalcSetup.lua:506) - identical to `store` for a player-actor call, which is every call
/// this crate grades; a minion-actor call would need the player's own store too, same out-of-scope
/// cross-actor category as the other minion gaps, so `store` is used for both.
pub fn stun(output: &mut HashMap<String, f64>, store: &ModStore, damage_category_config: &str, env_es_protects_mana: Option<bool>) {
    let stun_threshold_base = if store.flag(None, &[pom_engine::sym!("StunThresholdBasedOnEnergyShieldInsteadOfLife")]) {
        g(output, "EnergyShield") * store.sum(ModType::Base, None, &[pom_engine::sym!("StunThresholdEnergyShieldPercent")]) / 100.0
    } else if store.flag(None, &[pom_engine::sym!("StunThresholdBasedOnManaInsteadOfLife")]) {
        g(output, "Mana") * store.sum(ModType::Base, None, &[pom_engine::sym!("StunThresholdManaPercent")]) / 100.0
    } else if store.flag(None, &[pom_engine::sym!("ChaosInoculation")]) {
        store.sum(ModType::Base, None, &[pom_engine::sym!("Life")])
    } else {
        g(output, "Life")
    };
    let bd_stun_source = if pom_offence::bd::on() {
        let mut src = if store.flag(None, &[pom_engine::sym!("StunThresholdBasedOnEnergyShieldInsteadOfLife")]) {
            format!("{}% of Energy Shield", pom_offence::bd::tostr(store.sum(ModType::Base, None, &[pom_engine::sym!("StunThresholdEnergyShieldPercent")])))
        } else if store.flag(None, &[pom_engine::sym!("StunThresholdBasedOnManaInsteadOfLife")]) {
            format!("{}% of Mana", pom_offence::bd::tostr(store.sum(ModType::Base, None, &[pom_engine::sym!("StunThresholdManaPercent")])))
        } else if store.flag(None, &[pom_engine::sym!("ChaosInoculation")]) {
            "Life before Chaos Inoculation".to_string()
        } else {
            "Life".to_string()
        };
        if store.flag(None, &[pom_engine::sym!("AddESToStunThreshold")]) {
            src = format!("{} and {}% of Energy Shield", src, pom_offence::bd::tostr(store.sum(ModType::Base, None, &[pom_engine::sym!("ESToStunThresholdPercent")])));
        }
        src
    } else {
        String::new()
    };
    let mut stun_threshold_base = stun_threshold_base;
    if store.flag(None, &[pom_engine::sym!("AddESToStunThreshold")]) {
        let es_mult = store.sum(ModType::Base, None, &[pom_engine::sym!("ESToStunThresholdPercent")]);
        stun_threshold_base += g(output, "EnergyShield") * es_mult / 100.0;
    }
    let stun_threshold_mod = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("StunThreshold")]) / 100.0;
    let stun_threshold = stun_threshold_base * stun_threshold_mod;
    output.insert("StunThreshold".into(), stun_threshold);
    crate::bd_est2::stun_threshold(&bd_stun_source, stun_threshold_base, stun_threshold_mod, stun_threshold);

    let mut not_avoid_chance = if store.flag(None, &[pom_engine::sym!("StunImmune")]) { 0.0 } else { 100.0 - store.sum(ModType::Base, None, &[pom_engine::sym!("AvoidStun")]).min(100.0) };
    if g(output, "EnergyShield") > g(output, "totalTakenHit") && !env_es_protects_mana.unwrap_or_else(|| store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")])) {
        not_avoid_chance *= 0.5;
    }
    let stun_avoid_chance = 100.0 - not_avoid_chance;
    output.insert("StunAvoidChance".into(), stun_avoid_chance);

    if stun_avoid_chance >= 100.0 {
        output.insert("StunDuration".into(), 0.0);
        output.insert("BlockDuration".into(), 0.0);
        crate::bd_est2::stun_duration(true, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    } else {
        let stun_duration = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("StunDuration")]) / 100.0;
        let base_stun_duration = misc("StunBaseDuration");
        let stun_recovery = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("StunRecovery")]) / 100.0;
        let stun_and_block_recovery = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("StunRecovery"), pom_engine::sym!("BlockRecovery")]) / 100.0;
        let tick_rate = misc("ServerTickRate");
        output.insert("StunDuration".into(), (base_stun_duration * stun_duration / stun_recovery * tick_rate).ceil() / tick_rate);
        output.insert("BlockDuration".into(), (base_stun_duration * stun_duration / stun_and_block_recovery * tick_rate).ceil() / tick_rate);
        crate::bd_est2::stun_duration(false, base_stun_duration, stun_duration, stun_recovery, stun_and_block_recovery, output["StunDuration"], output["BlockDuration"]);
    }
    output.insert("InterruptStunAvoidChance".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("AvoidInterruptStun")]).min(100.0));
    let mut effective_enemy_damage = g(output, "totalTakenHit") + g(output, "PhysicalTakenHit") * 0.25;
    if damage_category_config != "Average" {
        effective_enemy_damage = effective_enemy_damage * (1.0 + misc("StunNotMeleeDamageMult") * 3.0) / 4.0;
    } else {
        effective_enemy_damage *= misc("StunNotMeleeDamageMult");
    }
    let base_stun_chance = (misc("StunBaseMult") * effective_enemy_damage / stun_threshold).min(100.0);
    let self_stun_chance = (if base_stun_chance > misc("MinStunChanceNeeded") { base_stun_chance } else { 0.0 }) * not_avoid_chance / 100.0;
    output.insert("SelfStunChance".into(), self_stun_chance);
    crate::bd_est2::self_stun(misc("StunBaseMult"), effective_enemy_damage, stun_threshold, base_stun_chance, misc("MinStunChanceNeeded"), not_avoid_chance, self_stun_chance);
}

/// "Life Recoverable" + "Dissolution of the flesh" (Lua lines 2258-2272). `conditionLowLife` is a
/// checkbox config option (`config_flags`, not the numeric `config_input`).
pub fn life_recoverable(output: &mut HashMap<String, f64>, store: &ModStore, config_flags: &HashMap<String, bool>) {
    let mut life_recoverable = g(output, "LifeUnreserved");
    if config_flags.get("conditionLowLife").copied().unwrap_or(false) {
        let low_life_percentage = output.get("LowLifePercentage").copied().unwrap_or_else(|| misc("LowPoolThreshold"));
        life_recoverable = (g(output, "Life") * low_life_percentage / 100.0).min(g(output, "LifeUnreserved"));
        if life_recoverable < g(output, "LifeUnreserved") {
            output.insert("CappingLife".into(), 1.0);
        }
    }
    if store.flag(None, &[pom_engine::sym!("DamageInsteadReservesLife")]) {
        life_recoverable = (g(output, "LifeCancellableReservation") / 100.0) * g(output, "Life");
    }
    life_recoverable = life_recoverable.max(1.0);
    output.insert("LifeRecoverable".into(), life_recoverable);
}

/// "Prevented life loss taken over 4 seconds (and Petrified Blood)" (Lua lines 2274-2320).
pub fn life_loss_prevention(output: &mut HashMap<String, f64>, store: &ModStore, config_flags: &HashMap<String, bool>) {
    let recoverable = g(output, "LifeRecoverable");
    let prevented_life_loss = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeLossPrevented")]).min(100.0);
    output.insert("preventedLifeLoss".into(), prevented_life_loss);
    let initial_life_loss_below_half_prevented = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeLossBelowHalfPrevented")]);
    let prevented_life_loss_below_half = (1.0 - prevented_life_loss / 100.0) * initial_life_loss_below_half_prevented;
    output.insert("preventedLifeLossBelowHalf".into(), prevented_life_loss_below_half);
    let mut bd_portion_life = 1.0;
    let prevented_life_loss_total = if !config_flags.get("conditionLowLife").copied().unwrap_or(false) {
        let portion_life = (g(output, "Life") * 0.5 / recoverable).min(1.0);
        bd_portion_life = portion_life;
        prevented_life_loss + prevented_life_loss_below_half * portion_life
    } else {
        prevented_life_loss + prevented_life_loss_below_half
    };
    output.insert("preventedLifeLossTotal".into(), prevented_life_loss_total);
    crate::bd_est2::prevented_life_loss(prevented_life_loss, prevented_life_loss_below_half, initial_life_loss_below_half_prevented, bd_portion_life, prevented_life_loss_total);
    let life_hit_pool = crate::pools::calc_life_hit_pool_with_loss_prevention(recoverable, g(output, "Life"), prevented_life_loss, initial_life_loss_below_half_prevented);
    output.insert("LifeHitPool".into(), life_hit_pool);
}

fn calc_mom_eb_pool(output: &HashMap<String, f64>, store: &ModStore, life_pool: f64, mom_effect: f64, es_bypass: f64) -> f64 {
    let mana = g(output, "ManaUnreserved").max(0.0);
    let max_mom_pool = if mom_effect < 1.0 { life_pool / (1.0 - mom_effect) - life_pool } else { f64::INFINITY };
    let max_mana_usable = mana.min(max_mom_pool).floor();
    let max_es_usable = if store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]) && es_bypass < 1.0 {
        g(output, "EnergyShieldRecoveryCap")
            .min(max_mom_pool * (1.0 - es_bypass))
            .min((life_pool + max_mana_usable) / (1.0 - (1.0 - es_bypass) * mom_effect) - (life_pool + max_mana_usable))
            .floor()
    } else {
        0.0
    };
    let mana_used = (max_mom_pool - max_es_usable).min(max_mana_usable).floor();
    life_pool + mana_used + max_es_usable
}

/// "Energy Shield bypass" + "Mind over Matter" (Lua lines 2322-2421). Every boolean bookkeeping
/// field (`AnyBypass`, `ehpSectionAnySpecificTypes`, `OnlySharedMindOverMatter`,
/// `AnySpecificMindOverMatter`) is written but never read anywhere in this file - not modeled,
/// same precedent as every other boolean-only field in this crate.
pub fn bypass_and_mom(output: &mut HashMap<String, f64>, store: &ModStore) {
    let mut minimum_bypass: f64 = 100.0;
    let mut any_bypass = false;
    output.insert("ehpSectionAnySpecificTypes".into(), 0.0);
    output.insert("OnlySharedMindOverMatter".into(), 0.0);
    output.insert("AnySpecificMindOverMatter".into(), 0.0);
    for &dt in DMG_TYPES {
        let mut bypass = if store.flag(None, &[pom_engine::sym!("UnblockedDamageDoesBypassES")]) {
            any_bypass = true;
            100.0
        } else {
            let mut b = store
                .override_(None, &[s(&format!("{dt}EnergyShieldBypass"))])
                .and_then(|v| v.num())
                .unwrap_or_else(|| store.sum(ModType::Base, None, &[s(&format!("{dt}EnergyShieldBypass"))]));
            if b != 0.0 {
                any_bypass = true;
            }
            if dt == "Chaos" {
                if !store.flag(None, &[pom_engine::sym!("ChaosNotBypassEnergyShield")]) {
                    b += 100.0;
                } else {
                    any_bypass = true;
                }
            }
            b
        };
        bypass = bypass.min(100.0).max(0.0);
        output.insert(format!("{dt}EnergyShieldBypass"), bypass);
        minimum_bypass = minimum_bypass.min(bypass);
    }
    output.insert("MinimumBypass".into(), minimum_bypass);
    output.insert("AnyBypass".into(), any_bypass as u8 as f64);

    let shared_mom = store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTakenFromManaBeforeLife")]).min(100.0);
    output.insert("sharedMindOverMatter".into(), shared_mom);

    if shared_mom > 0.0 {
        let mom_effect = shared_mom / 100.0;
        let es_bypass = minimum_bypass / 100.0;
        output.insert("sharedManaEffectiveLife".into(), calc_mom_eb_pool(output, store, g(output, "LifeRecoverable"), mom_effect, es_bypass));
        let hit_pool = calc_mom_eb_pool(output, store, g(output, "LifeHitPool"), mom_effect, es_bypass);
        output.insert("sharedMoMHitPool".into(), hit_pool);
        if pom_offence::bd::on() {
            crate::bd_est2::mind_over_matter("sharedMindOverMatter", output, store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]), mom_effect, es_bypass);
        }
    } else {
        output.insert("sharedManaEffectiveLife".into(), g(output, "LifeRecoverable"));
        output.insert("sharedMoMHitPool".into(), g(output, "LifeHitPool"));
    }

    for &dt in DMG_TYPES {
        let mind_over_matter = store.sum(ModType::Base, None, &[s(&format!("{dt}DamageTakenFromManaBeforeLife"))]).min(100.0 - shared_mom);
        output.insert(format!("{dt}MindOverMatter"), mind_over_matter);
        let es_bypass_dt = g(output, &format!("{dt}EnergyShieldBypass"));
        if mind_over_matter > 0.0 || (es_bypass_dt > minimum_bypass && shared_mom > 0.0) {
            output.insert("ehpSectionAnySpecificTypes".into(), 1.0);
            output.insert("AnySpecificMindOverMatter".into(), 1.0);
            output.insert("OnlySharedMindOverMatter".into(), 0.0);
            let mom_effect = (mind_over_matter + shared_mom) / 100.0;
            let es_bypass = es_bypass_dt / 100.0;
            output.insert(format!("{dt}ManaEffectiveLife"), calc_mom_eb_pool(output, store, g(output, "LifeRecoverable"), mom_effect, es_bypass));
            output.insert(format!("{dt}MoMHitPool"), calc_mom_eb_pool(output, store, g(output, "LifeHitPool"), mom_effect, es_bypass));
            if pom_offence::bd::on() {
                crate::bd_est2::mind_over_matter(&format!("{dt}MindOverMatter"), output, store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]), mom_effect, es_bypass);
            }
        } else {
            output.insert(format!("{dt}ManaEffectiveLife"), g(output, "sharedManaEffectiveLife"));
            output.insert(format!("{dt}MoMHitPool"), g(output, "sharedMoMHitPool"));
        }
    }
}

/// "Guard" + "aegis" (Lua lines 2423-2483). `sharedGuardAbsorb`/per-type `GuardAbsorb` are left
/// absent (read back as 0 via `g()`) when their rate is 0, matching the Lua's own missing `else`.
pub fn guard_and_aegis(output: &mut HashMap<String, f64>, store: &ModStore) {
    output.insert("AnyGuard".into(), 0.0);
    let shared_rate = store.sum(ModType::Base, None, &[pom_engine::sym!("GuardAbsorbRate")]).min(100.0);
    output.insert("sharedGuardAbsorbRate".into(), shared_rate);
    if shared_rate > 0.0 {
        output.insert("OnlySharedGuard".into(), 1.0);
        output.insert("sharedGuardAbsorb".into(), crate::tools::val(store, pom_engine::sym!("GuardAbsorbLimit"), None));
        if pom_offence::bd::on() {
            crate::bd_est2::absorb("sharedGuardAbsorb", "guard limit", "portion taken from guard", g(output, "sharedGuardAbsorb"), shared_rate);
        }
    }
    for &dt in DMG_TYPES {
        let rate = store.sum(ModType::Base, None, &[s(&format!("{dt}GuardAbsorbRate"))]).min(100.0);
        output.insert(format!("{dt}GuardAbsorbRate"), rate);
        if rate > 0.0 {
            output.insert("ehpSectionAnySpecificTypes".into(), 1.0);
            output.insert("AnyGuard".into(), 1.0);
            output.insert("OnlySharedGuard".into(), 0.0);
            output.insert(format!("{dt}GuardAbsorb"), crate::tools::val(store, s(&format!("{dt}GuardAbsorbLimit")), None));
            if pom_offence::bd::on() {
                crate::bd_est2::absorb(&format!("{dt}GuardAbsorb"), "guard limit", "portion taken from guard", g(output, &format!("{dt}GuardAbsorb")), rate);
            }
        }
    }

    let mut any_aegis = false;
    let shared_aegis = store.max(None, &[pom_engine::sym!("AegisValue")]).unwrap_or(0.0);
    output.insert("sharedAegis".into(), shared_aegis);
    let shared_elemental_aegis = store.max(None, &[pom_engine::sym!("ElementalAegisValue")]).unwrap_or(0.0);
    output.insert("sharedElementalAegis".into(), shared_elemental_aegis);
    if shared_aegis > 0.0 {
        any_aegis = true;
    }
    if shared_elemental_aegis > 0.0 {
        output.insert("ehpSectionAnySpecificTypes".into(), 1.0);
        any_aegis = true;
    }
    for &dt in DMG_TYPES {
        let aegis_value = store.max(None, &[s(&format!("{dt}AegisValue"))]).unwrap_or(0.0);
        let aegis = if aegis_value > 0.0 { aegis_value } else { 0.0 };
        if aegis_value > 0.0 {
            output.insert("ehpSectionAnySpecificTypes".into(), 1.0);
            any_aegis = true;
        }
        output.insert(format!("{dt}Aegis"), aegis);
        if is_elemental(dt) {
            output.insert(format!("{dt}AegisDisplay"), aegis + shared_elemental_aegis);
        }
    }
    output.insert("AnyAegis".into(), any_aegis as u8 as f64);
}

/// "taken from allies before you" (frost shield, per-ally redirects, Companionship merge, Vaal
/// Rejuvenation merge, Soul Link) + "Vaal Arctic Armour" (Lua lines 2485-2577). `AlliedEnergyShield`
/// (lines 2564/2568) needs `actor.parent.output`/`actor.partyMembers.output` - cross-actor state
/// this crate does not have access to (same named-gap category as the other
/// `actor.parent`/`actor.partyMembers` gaps in `calcs.defence` itself) - left unset, so the
/// "soulLink" ally pool entry in `pools::ALLY_LIFE_POOL_LIST` never activates here.
pub fn allies_and_shields(output: &mut HashMap<String, f64>, store: &ModStore, damage_category_config: &str) {
    output.insert("FrostShieldLife".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("FrostGlobeHealth")]));
    output.insert("FrostShieldDamageMitigation".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("FrostGlobeDamageMitigation")]));
    crate::bd_est2::absorb("FrostShieldLife", "frost shield limit", "portion taken from frost shield", g(output, "FrostShieldLife"), g(output, "FrostShieldDamageMitigation"));

    for ally in crate::pools::ALLY_LIFE_POOL_LIST {
        if let Some(redirect) = ally.redirect {
            let mut mitigation = store.sum(ModType::Base, None, &[s(redirect)]);
            if ally.melee_only {
                mitigation = if damage_category_config == "Melee" {
                    mitigation
                } else if damage_category_config == "Average" {
                    mitigation / 4.0
                } else {
                    0.0
                };
            }
            output.insert(ally.mitigation.to_string(), mitigation);
            if mitigation != 0.0 {
                let mut life = store.sum(ModType::Base, None, &[s(ally.life)]);
                if life == 0.0 {
                    if let Some(fallback) = ally.fallback {
                        life = store.sum(ModType::Base, None, &[s(fallback)]);
                    }
                }
                let life = store.override_(None, &[s(ally.life)]).and_then(|v| v.num()).unwrap_or(life);
                output.insert(ally.life.to_string(), life);
            }
        }
    }

    // Companionship and an ally-specific redirect can both spend the same minion's Life.
    let mut minion_ally_damage_mitigation = g(output, "MinionAllyDamageMitigation");
    let mut bd_shared_minion_life_override = false;
    for ally in crate::pools::ALLY_LIFE_POOL_LIST {
        if store.flag(None, &[s(&format!("MinionLifeShares{}", ally.life))]) {
            let specific_override = store.override_(None, &[s(ally.life)]).and_then(|v| v.num());
            if store.override_(None, &[pom_engine::sym!("TotalMinionLife")]).is_none() && specific_override.is_some() {
                output.insert("TotalMinionLife".into(), specific_override.unwrap());
                bd_shared_minion_life_override = true;
            } else if g(output, "TotalMinionLife") == 0.0 {
                output.insert("TotalMinionLife".into(), g(output, ally.life));
            }
            minion_ally_damage_mitigation += output.get(ally.mitigation).copied().unwrap_or(0.0);
            output.insert(ally.mitigation.to_string(), 0.0);
            output.remove(ally.life);
        }
    }
    output.insert("MinionAllyDamageMitigation".into(), minion_ally_damage_mitigation);

    // When Vaal Rejuvenation is treated as the nearest Totem, both redirects use its Life.
    if g(output, "TotemAllyDamageMitigation") > 0.0 && g(output, "TotalTotemLife") == 0.0 && g(output, "TotalVaalRejuvenationTotemLife") > 0.0 {
        let v = g(output, "VaalRejuvenationTotemAllyDamageMitigation") + g(output, "TotemAllyDamageMitigation");
        output.insert("VaalRejuvenationTotemAllyDamageMitigation".into(), v);
        output.insert("TotemAllyDamageMitigation".into(), 0.0);
        output.remove("TotalTotemLife");
    }
    crate::bd_est2::ally_life_tables(output, store, bd_shared_minion_life_override);

    output.insert("SoulLinkMitigation".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("TakenFromParentESBeforeYou")]));
    if g(output, "SoulLinkMitigation") == 0.0 {
        output.insert("SoulLinkMitigation".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("TakenFromPartyMemberESBeforeYou")]));
    }

    output.insert("VaalArcticArmourLife".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("VaalArcticArmourMaxHits")]));
    output.insert("VaalArcticArmourMitigation".into(), (-store.sum(ModType::More, None, &[pom_engine::sym!("VaalArcticArmourMitigation")]) / 100.0).min(1.0));
}

/// "total pool" (Lua lines 2579-2610).
pub fn total_pool(output: &mut HashMap<String, f64>, store: &ModStore) {
    for &dt in DMG_TYPES {
        let mut total_pool = g(output, &format!("{dt}ManaEffectiveLife"));
        let mut total_hit_pool = g(output, &format!("{dt}MoMHitPool"));
        let bypass = g(output, &format!("{dt}EnergyShieldBypass"));
        let bd_mana_text = if bypass < 100.0 && store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]) { "Mana and non-bypassed Energy Shield" } else { "Mana" };
        if bypass < 100.0 {
            if !store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]) {
                if bypass > 0.0 {
                    let pool_protected = g(output, "EnergyShieldRecoveryCap") / (1.0 - bypass / 100.0) * (bypass / 100.0);
                    total_pool = (total_pool - pool_protected).max(0.0) + total_pool.min(pool_protected) / (bypass / 100.0);
                    total_hit_pool = (total_hit_pool - pool_protected).max(0.0) + total_hit_pool.min(pool_protected) / (bypass / 100.0);
                } else {
                    total_pool += g(output, "EnergyShieldRecoveryCap");
                    total_hit_pool += g(output, "EnergyShieldRecoveryCap");
                }
            }
        }
        output.insert(format!("{dt}TotalPool"), total_pool);
        output.insert(format!("{dt}TotalHitPool"), total_hit_pool);
        if pom_offence::bd::on() {
            crate::bd_est2::total_pool(dt, output, store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]), bd_mana_text);
        }
    }
}

/// "number of damaging hits needed to be taken to die" + the block/suppress/avoid-adjusted
/// mitigated version + "chance to not be hit breakdown" + "effective hit pool" (Lua lines
/// 2779-2960). Only runs when `damage_category_config != "DamageOverTime"` (Lua's own guard,
/// checked by the caller in `estimations::hits_to_die_ehp`). "survival time" (lines 2961-2975,
/// `enemySkillTime`/`EHPSurvivalTime`) needs `calcs.actionSpeedMod(actor.enemy)` -
/// `CalcPerform.lua`, owned by the calc crate, not this one - same permanent, named cross-module
/// gap as `ActionSpeedMod`/`EffectiveMovementSpeedMod` in `defence.rs`; left
/// untouched here, so `NetLifeRegen`/recoup/petrified-blood fields that divide by
/// `EHPSurvivalTime` inherit the gap downstream too.
pub fn hits_to_die_ehp(output: &mut HashMap<String, f64>, store: &ModStore, enemy: &ModStore, config_input: &HashMap<String, f64>, config_flags: &HashMap<String, bool>, pre_output_bool: &HashMap<String, bool>, damage_category_config: &str) {
    let mut iterations = 0.0;

    let mut damage_in: HashMap<String, f64> = HashMap::default();
    for &dt in DMG_TYPES {
        damage_in.insert(dt.to_string(), g(output, &format!("{dt}TakenHit")));
    }
    let mut input = crate::pools::HitsToDieInput::new(damage_in);
    input.limit_ehp_speedup = g(output, "preventedLifeLossTotal") > 0.0;
    let number_of_damaging_hits = crate::pools::number_of_hits_to_die(&input, &mut iterations, store, output);
    output.insert("NumberOfDamagingHits".into(), number_of_damaging_hits);

    let mut block_chance = g(output, "EffectiveBlockChance") / 100.0;
    if damage_category_config != "Melee" && damage_category_config != "Untyped" {
        block_chance = g(output, &format!("Effective{damage_category_config}BlockChance")) / 100.0;
    }
    if enemy.flag(None, &[pom_engine::sym!("CannotBeBlocked")]) {
        block_chance = 0.0;
    }
    let block_effect = 1.0 - block_chance * g(output, "BlockEffect") / 100.0;
    let mut suppress_chance = 0.0;
    let suppression_effect;
    let mut extra_avoid_chance = 0.0;
    let mut average_avoid_chance = 0.0;

    let disable_gain_on_block = config_flags.get("DisableEHPGainOnBlock").copied().unwrap_or(false);
    let mut life_when_hit = 0.0;
    let mut mana_when_hit = 0.0;
    let mut energy_shield_when_hit = 0.0;
    if !disable_gain_on_block && number_of_damaging_hits > 1.0 {
        life_when_hit = g(output, "LifeOnBlock") * block_chance;
        mana_when_hit = g(output, "ManaOnBlock") * block_chance;
        energy_shield_when_hit = g(output, "EnergyShieldOnBlock") * block_chance;
        match damage_category_config {
            "Spell" | "SpellProjectile" => energy_shield_when_hit += g(output, "EnergyShieldOnSpellBlock") * block_chance,
            "Average" => energy_shield_when_hit += g(output, "EnergyShieldOnSpellBlock") / 2.0 * block_chance,
            _ => {}
        }
    }
    if matches!(damage_category_config, "Spell" | "SpellProjectile" | "Average") {
        suppress_chance = g(output, "EffectiveSpellSuppressionChance") / 100.0;
    }
    if suppress_chance < 1.0 {
        if damage_category_config == "Average" {
            suppress_chance /= 2.0;
        }
        energy_shield_when_hit += g(output, "EnergyShieldOnSuppress") * suppress_chance;
        life_when_hit += g(output, "LifeOnSuppress") * suppress_chance;
        suppression_effect = 1.0 - suppress_chance * g(output, "SpellSuppressionEffect") / 100.0;
    } else {
        let mult = if damage_category_config == "Average" { 0.5 } else { 1.0 };
        energy_shield_when_hit += g(output, "EnergyShieldOnSuppress") * mult;
        life_when_hit += g(output, "LifeOnSuppress") * mult;
        suppression_effect = 1.0;
    }
    match damage_category_config {
        "Projectile" | "SpellProjectile" => extra_avoid_chance += g(output, "AvoidProjectilesChance"),
        "Average" => extra_avoid_chance += g(output, "AvoidProjectilesChance") / 2.0,
        _ => {}
    }

    let mut missing_life_before_enemy_hit = None;
    let mut missing_mana_before_enemy_hit = None;
    let mut gain_when_hit = false;
    if !disable_gain_on_block && number_of_damaging_hits > 1.0 {
        let mlb = store.sum(ModType::Base, None, &[pom_engine::sym!("MissingLifeBeforeEnemyHit")]);
        let mmb = store.sum(ModType::Base, None, &[pom_engine::sym!("MissingManaBeforeEnemyHit")]);
        missing_life_before_enemy_hit = Some(mlb);
        missing_mana_before_enemy_hit = Some(mmb);
        if life_when_hit != 0.0 || mana_when_hit != 0.0 || energy_shield_when_hit != 0.0 || mlb != 0.0 || mmb != 0.0 {
            gain_when_hit = true;
        }
    } else {
        life_when_hit = 0.0;
        mana_when_hit = 0.0;
        energy_shield_when_hit = 0.0;
    }

    let mut damage_in2: HashMap<String, f64> = HashMap::default();
    let specific_type_avoidance = pre_output_bool.get("specificTypeAvoidance").copied().unwrap_or(false);
    let worst_of = config_input.get("EHPUnluckyWorstOf").copied().unwrap_or(1.0);
    for &dt in DMG_TYPES {
        let mut avoid_chance = 0.0;
        if specific_type_avoidance {
            avoid_chance = (g(output, &format!("Avoid{dt}DamageChance")) + extra_avoid_chance).min(misc("AvoidChanceCap"));
            if worst_of > 1.0 {
                avoid_chance = avoid_chance / 100.0 * avoid_chance;
                if worst_of == 4.0 {
                    avoid_chance = avoid_chance / 100.0 * avoid_chance;
                }
            }
            average_avoid_chance += avoid_chance;
        }
        damage_in2.insert(dt.to_string(), g(output, &format!("{dt}TakenHit")) * (block_effect * suppression_effect * (1.0 - avoid_chance / 100.0)));
    }

    // Lua builds a fresh `DamageIn` table for the second call, so `iterations` restarts at 0.
    iterations = 0.0;
    let mut input2 = crate::pools::HitsToDieInput::new(damage_in2);
    input2.life_when_hit = life_when_hit;
    input2.mana_when_hit = mana_when_hit;
    input2.energy_shield_when_hit = energy_shield_when_hit;
    input2.gain_when_hit = gain_when_hit;
    input2.missing_life_before_enemy_hit = missing_life_before_enemy_hit;
    input2.missing_mana_before_enemy_hit = missing_mana_before_enemy_hit;

    if g(output, "anyRecoup") > 0.0 {
        input2.track_recoupable = true;
        for &dt in DMG_TYPES {
            output.insert(format!("{dt}RecoupableDamageTaken"), 0.0);
        }
    }
    if g(output, "preventedLifeLossTotal") > 0.0 {
        input2.track_life_loss_over_time = true;
        output.insert("LifeLossLostOverTime".into(), 0.0);
        output.insert("LifeBelowHalfLossLostOverTime".into(), 0.0);
    }
    input2.limit_ehp_speedup = input2.track_recoupable || input2.track_life_loss_over_time || gain_when_hit;
    average_avoid_chance /= 5.0;
    let configured_damage_chance = 100.0 * (block_effect * suppression_effect * (1.0 - average_avoid_chance / 100.0));
    output.insert("ConfiguredDamageChance".into(), configured_damage_chance);
    let number_of_mitigated_damaging_hits = if configured_damage_chance != 100.0 || input2.track_recoupable || input2.track_life_loss_over_time || gain_when_hit {
        crate::pools::number_of_hits_to_die(&input2, &mut iterations, store, output)
    } else {
        number_of_damaging_hits
    };
    output.insert("NumberOfMitigatedDamagingHits".into(), number_of_mitigated_damaging_hits);
    crate::bd_est2::configured_damage_chance(block_chance, output.contains_key("ShowBlockEffect"), g(output, "BlockEffect"), suppression_effect, average_avoid_chance, configured_damage_chance, damage_category_config);

    let total_number_of_hits = number_of_mitigated_damaging_hits / (1.0 - g(output, "ConfiguredNotHitChance") / 100.0);
    output.insert("TotalNumberOfHits".into(), total_number_of_hits);
    output.insert("TotalEHP".into(), total_number_of_hits * g(output, "totalEnemyDamageIn"));
    crate::bd_est2::not_hit_chance_tables(output, damage_category_config, specific_type_avoidance, worst_of);
}

/// "survival time" (Lua lines 2961-2975): `calcs.actionSpeedMod(actor.enemy)` is CalcPerform.lua:1141-1150.
pub fn survival_time(output: &mut HashMap<String, f64>, enemy: &ModStore, config_input: &HashMap<String, f64>, config_placeholder: &HashMap<String, f64>) {
    let mut skill_time = config_input.get("enemySpeed").or_else(|| config_placeholder.get("enemySpeed")).copied().unwrap_or(700.0)
        / (1.0 + enemy.sum(ModType::Inc, None, &[pom_engine::sym!("Speed")]) / 100.0);
    let minimum_action_speed = enemy.max(None, &[pom_engine::sym!("MinimumActionSpeed")]).unwrap_or(0.0);
    let maximum_reduction = enemy.max(None, &[pom_engine::sym!("MaximumActionSpeedReduction")]);
    let action_speed = pom_offence::tools::action_speed_mod(
        enemy.sum(ModType::Inc, None, &[pom_engine::sym!("TemporalChainsActionSpeed")]),
        enemy.sum(ModType::Inc, None, &[pom_engine::sym!("ActionSpeed")]),
        misc("TemporalChainsEffectCap"),
        minimum_action_speed,
        maximum_reduction,
    );
    if pom_engine::env::var_os("POM_DEBUG_ENEMY").is_some() { eprintln!("EAS as={} tc={} act={} min={} maxred={:?}", action_speed, enemy.sum(ModType::Inc, None, &[pom_engine::sym!("TemporalChainsActionSpeed")]), enemy.sum(ModType::Inc, None, &[pom_engine::sym!("ActionSpeed")]), minimum_action_speed, maximum_reduction); }
    skill_time = skill_time / 1000.0 / action_speed;
    output.insert("enemySkillTime".into(), skill_time);
    output.insert("EHPSurvivalTime".into(), g(output, "TotalNumberOfHits") * skill_time);
    crate::bd_est2::survival_time(output);
}

const RECOUP_TYPE_LIST: &[&str] = &["Life", "Mana", "EnergyShield"];

/// "recoup" (Lua lines 2977-3064). Guarded by `output.anyRecoup > 0` - since `calcs.defence`
/// already computes `anyRecoup`, this reads it straight from `output` (this crate's own
/// `defence()` port already sets it faithfully).
/// `Total<Type>RecoupRecoveryAvg`/`Max` divide by `output.EHPSurvivalTime` - left at its
/// pre-buildDefenceEstimations value by the permanent `actionSpeedMod` gap (see
/// `hits_to_die_ehp`), so this section's `*Avg` fields inherit that gap too; `*Max` does not
/// depend on it and is unaffected.
pub fn recoup(output: &mut HashMap<String, f64>, store: &ModStore, damage_category_config: &str) {
    if !(g(output, "anyRecoup") > 0.0) || damage_category_config == "DamageOverTime" {
        return;
    }
    let mut total_damage = 0.0;
    let mut total_elemental_damage = 0.0;
    let total_physical_damage_mitigated = g(output, "NumberOfMitigatedDamagingHits") * (g(output, "PhysicalTakenDamage") - g(output, "PhysicalTakenHit"));
    for &dt in DMG_TYPES {
        let v = g(output, &format!("{dt}RecoupableDamageTaken"));
        total_damage += v;
        if is_elemental(dt) {
            total_elemental_damage += v;
        }
    }
    let mut extra_pseudo_recoup: HashMap<&str, (f64, f64)> = HashMap::default();
    for (i, &recoup_type) in RECOUP_TYPE_LIST.iter().enumerate() {
        let recoup_time = if store.flag(None, &[s(&format!("3Second{recoup_type}Recoup")), pom_engine::sym!("3SecondRecoup")]) { 3.0 } else { 4.0 };
        let mut total_recoup_recovery = g(output, &format!("{recoup_type}Recoup")) / 100.0 * total_damage;
        let elemental_recoup = g(output, &format!("Elemental{recoup_type}Recoup"));
        if elemental_recoup > 0.0 && total_elemental_damage > 0.0 {
            total_recoup_recovery += elemental_recoup / 100.0 * total_elemental_damage;
        }
        for &dt in DMG_TYPES {
            let per_type_recoup = g(output, &format!("{dt}{recoup_type}Recoup"));
            let recoupable = g(output, &format!("{dt}RecoupableDamageTaken"));
            if per_type_recoup > 0.0 && recoupable > 0.0 {
                total_recoup_recovery += per_type_recoup / 100.0 * recoupable;
            }
        }
        output.insert(format!("Total{recoup_type}RecoupRecovery"), total_recoup_recovery);

        let mut total_pseudo_recoup = g(output, &format!("PhysicalDamageMitigated{recoup_type}PseudoRecoup")) / 100.0 * total_physical_damage_mitigated;
        let pseudo_recoup_duration = output.get(&format!("PhysicalDamageMitigated{recoup_type}PseudoRecoupDuration")).copied().unwrap_or(4.0);
        if total_pseudo_recoup != 0.0 {
            for &later_type in &RECOUP_TYPE_LIST[i + 1..] {
                if store.flag(None, &[s(&format!("{recoup_type}RegenerationRecovers{later_type}"))])
                    && !store.flag(None, &[s(&format!("UnaffectedBy{later_type}Regen"))])
                    && !store.flag(None, &[s(&format!("No{later_type}Regen"))])
                    && !store.flag(None, &[s(&format!("CannotGain{later_type}"))])
                {
                    let v = total_pseudo_recoup * g(output, &format!("{later_type}RecoveryRateMod")) / g(output, &format!("{recoup_type}RecoveryRateMod"));
                    extra_pseudo_recoup.insert(later_type, (v, pseudo_recoup_duration));
                }
            }
        }
        if store.flag(None, &[s(&format!("UnaffectedBy{recoup_type}Regen"))]) {
            total_pseudo_recoup = 0.0;
        }
        output.insert(format!("Total{recoup_type}PseudoRecoup"), total_pseudo_recoup);

        let extra = extra_pseudo_recoup.get(recoup_type).copied();
        let recovery_max = total_recoup_recovery / recoup_time + total_pseudo_recoup / pseudo_recoup_duration + extra.map(|(v, d)| v / d).unwrap_or(0.0);
        output.insert(format!("{recoup_type}RecoupRecoveryMax"), recovery_max);
        let survival_time = g(output, "EHPSurvivalTime");
        let recovery_avg = total_recoup_recovery / (survival_time + recoup_time) + total_pseudo_recoup / (survival_time + pseudo_recoup_duration) + extra.map(|(v, d)| v / (survival_time + d)).unwrap_or(0.0);
        output.insert(format!("{recoup_type}RecoupRecoveryAvg"), recovery_avg);
        crate::bd_est2::recoup_recovery(output, recoup_type, total_damage, total_elemental_damage, recoup_time, total_pseudo_recoup, pseudo_recoup_duration, extra);
    }
}

/// "petrified blood 'degen'" + "net recovery over time from enemy hits" (Lua lines 3066-3114).
/// `*Avg` fields divide by `output.EHPSurvivalTime` - see `recoup`'s note on the same gap.
pub fn petrified_and_net_recovery(output: &mut HashMap<String, f64>, store: &ModStore) {
    let life_loss_lost_over_time = output.get("LifeLossLostOverTime").copied();
    let life_below_half_loss_lost_over_time = output.get("LifeBelowHalfLossLostOverTime").copied();
    // `output["LifeLossLostOverTime"] and output["LifeBelowHalfLossLostOverTime"]`: Lua truthiness
    // on a number is always true (even 0) - this is a presence check, not a nonzero check.
    if g(output, "preventedLifeLossTotal") > 0.0 && life_loss_lost_over_time.is_some() && life_below_half_loss_lost_over_time.is_some() {
        let life_loss_below_half_lost = store.sum(ModType::Base, None, &[pom_engine::sym!("LifeLossBelowHalfLost")]) / 100.0;
        let a = life_loss_lost_over_time.unwrap() + life_below_half_loss_lost_over_time.unwrap() * life_loss_below_half_lost;
        output.insert("LifeLossLostMax".into(), a / 4.0);
        output.insert("LifeLossLostAvg".into(), a / (g(output, "EHPSurvivalTime") + 4.0));
        crate::bd_est2::life_loss_lost(output, life_loss_below_half_lost);
    }
    if g(output, "LifeRecoupRecoveryAvg") > 0.0 || g(output, "preventedLifeLossTotal") > 0.0 {
        output.insert("netLifeRecoupAndLossLostOverTimeMax".into(), g(output, "LifeRecoupRecoveryMax") - g(output, "LifeLossLostMax"));
        output.insert("netLifeRecoupAndLossLostOverTimeAvg".into(), g(output, "LifeRecoupRecoveryAvg") - g(output, "LifeLossLostAvg"));
        if g(output, "LifeRecoupRecoveryAvg") > 0.0 && g(output, "preventedLifeLossTotal") > 0.0 {
            output.insert("showNetRecoup".into(), 1.0);
            crate::bd_est2::net_recoup(output);
        }
    }
}

/// "pvp" (Lua lines 3116-3162). Only runs when `configInput.PvpScaling` is set (a checkbox).
pub fn pvp(output: &mut HashMap<String, f64>, config_input: &HashMap<String, f64>, config_flags: &HashMap<String, bool>) {
    if !config_flags.get("PvpScaling").copied().unwrap_or(false) {
        return;
    }
    let pvp_t_value = output.get("enemySkillTime").copied().unwrap_or(1.0);
    let pvp_multiplier = config_input.get("enemyMultiplierPvpDamage").copied().unwrap_or(100.0) / 100.0;
    let pvp_non_elemental_1 = misc("PvpNonElemental1");
    let pvp_non_elemental_2 = misc("PvpNonElemental2");
    let pvp_elemental_1 = misc("PvpElemental1");
    let pvp_elemental_2 = misc("PvpElemental2");
    let total_taken_hit = g(output, "totalTakenHit");
    let percentage_non_elemental = (g(output, "PhysicalTakenHit") + g(output, "ChaosTakenHit")) / total_taken_hit;
    let percentage_elemental = 1.0 - percentage_non_elemental;
    let portion_non_elemental = (total_taken_hit / pvp_t_value / pvp_non_elemental_2).powf(pvp_non_elemental_1) * pvp_t_value * pvp_non_elemental_2 * percentage_non_elemental;
    let portion_elemental = (total_taken_hit / pvp_t_value / pvp_elemental_2).powf(pvp_elemental_1) * pvp_t_value * pvp_elemental_2 * percentage_elemental;
    let non_elemental = if portion_non_elemental.is_nan() { 0.0 } else { portion_non_elemental };
    let elemental = if portion_elemental.is_nan() { 0.0 } else { portion_elemental };
    output.insert("PvPTotalTakenHit".into(), (non_elemental + elemental) * pvp_multiplier);
    crate::bd_est2::pvp(output, pvp_t_value, pvp_multiplier, pvp_non_elemental_1, pvp_non_elemental_2, pvp_elemental_1, pvp_elemental_2, percentage_non_elemental, percentage_elemental, portion_non_elemental, portion_elemental);
}

/// "maximum hit taken" (Lua lines 3164-3369) + "effective health pool vs dots" (lines 3371-3381).
pub fn max_hit_and_dot_ehp(output: &mut HashMap<String, f64>, store: &ModStore, shift: &ShiftTables) {
    let ward_bypass = store.sum(ModType::Base, None, &[pom_engine::sym!("WardBypass")]);
    for &dt in DMG_TYPES {
        let mut total_hit_pool = g(output, &format!("{dt}TotalHitPool"));
        if ward_bypass > 0.0 {
            let pool_protected = g(output, "Ward") / (1.0 - ward_bypass / 100.0) * (ward_bypass / 100.0);
            total_hit_pool = (total_hit_pool - pool_protected).max(0.0) + total_hit_pool.min(pool_protected) / (ward_bypass / 100.0);
        } else {
            total_hit_pool += g(output, "Ward");
        }
        let aegis_display = if is_elemental(dt) { g(output, &format!("{dt}AegisDisplay")) } else { 0.0 };
        total_hit_pool += g(output, &format!("{dt}Aegis")).max(g(output, "sharedAegis")).max(aegis_display);

        // `local GuardAbsorbRate = output["sharedGuardAbsorbRate"] or 0 + output[damageType.."GuardAbsorbRate"] or 0`
        // (Lua line 3181): `+` binds tighter than `or`, and `sharedGuardAbsorbRate` is always a set
        // number (never nil), so this always short-circuits to just `sharedGuardAbsorbRate` - the
        // per-type `GuardAbsorbRate` addition is unreachable dead code, a genuine bug in the
        // original (ported faithfully, not fixed). Same for `GuardAbsorb` below.
        let guard_absorb_rate = g(output, "sharedGuardAbsorbRate");
        if guard_absorb_rate > 0.0 {
            let guard_absorb = g(output, "sharedGuardAbsorb");
            if guard_absorb_rate >= 100.0 {
                total_hit_pool += guard_absorb;
            } else {
                let pool_protected = guard_absorb / (guard_absorb_rate / 100.0) * (1.0 - guard_absorb_rate / 100.0);
                total_hit_pool = (total_hit_pool - pool_protected).max(0.0) + total_hit_pool.min(pool_protected) / (1.0 - guard_absorb_rate / 100.0);
            }
        }
        for ally in crate::pools::ALLY_LIFE_POOL_LIST.iter().rev() {
            if let (Some(&life), Some(&mitigation)) = (output.get(ally.life), output.get(ally.mitigation)) {
                if life > 0.0 && mitigation > 0.0 {
                    let mitigation = mitigation.min(100.0);
                    if mitigation == 100.0 {
                        total_hit_pool += life;
                    } else {
                        let pool_protected = life / (mitigation / 100.0) * (1.0 - mitigation / 100.0);
                        total_hit_pool = (total_hit_pool - pool_protected).max(0.0) + total_hit_pool.min(pool_protected) / (1.0 - mitigation / 100.0);
                    }
                }
            }
        }
        output.insert(format!("{dt}TotalHitPool"), total_hit_pool);
    }

    for &damage_type in DMG_TYPES {
        let mut part_min = f64::INFINITY;
        let mut use_conversion_smoothing = false;
        for &damage_converted_type in DMG_TYPES {
            let convert_percent = shift.damage_shift_table[damage_type][damage_converted_type];
            let taken_flat = g(output, &format!("{damage_converted_type}takenFlat"));
            if convert_percent > 0.0 || taken_flat != 0.0 {
                let hit_taken;
                let effective_applied_armour = g(output, &format!("{damage_converted_type}EffectiveAppliedArmour"));
                let damage_converted_multi = convert_percent / 100.0;
                let total_hit_pool = g(output, &format!("{damage_converted_type}TotalHitPool"));
                let total_taken_multi = g(output, &format!("{damage_converted_type}AfterReductionTakenHitMulti")) * (1.0 - g(output, "VaalArcticArmourMitigation"));
                if damage_converted_multi <= 0.0 {
                    let taken_without_incoming = taken_flat.max(0.0) * total_taken_multi;
                    hit_taken = if taken_without_incoming >= total_hit_pool { 0.0 } else { f64::INFINITY };
                } else if effective_applied_armour == 0.0 && convert_percent == 100.0 {
                    let total_resist_mult = g(output, &format!("{damage_converted_type}ResistTakenHitMulti"));
                    let dr_multi = total_resist_mult * (1.0 - g(output, &format!("{damage_converted_type}DamageReduction")) / 100.0);
                    hit_taken = (total_hit_pool / damage_converted_multi / dr_multi - taken_flat).max(0.0) / total_taken_multi;
                } else {
                    let total_resist_mult = g(output, &format!("{damage_converted_type}ResistTakenHitMulti"));
                    let reduction_percent = if store.flag(None, &[s(&format!("SelfIgnoreBase{damage_converted_type}DamageReduction"))]) { 0.0 } else { g_or(output, &format!("Base{damage_converted_type}DamageReductionWhenHit"), &format!("Base{damage_converted_type}DamageReduction")) };
                    let flat_dr = reduction_percent / 100.0;
                    let enemy_overwhelm_percent = if store.flag(None, &[s(&format!("SelfIgnore{damage_converted_type}DamageReduction"))]) { 0.0 } else { g(output, &format!("{damage_converted_type}EnemyOverwhelm")) };

                    let resist_x_convert = total_resist_mult * damage_converted_multi;
                    let a = 5.0 * (1.0 - flat_dr + enemy_overwhelm_percent / 100.0) * total_taken_multi * resist_x_convert * resist_x_convert;
                    let b = ((enemy_overwhelm_percent / 100.0 - flat_dr) * effective_applied_armour * total_taken_multi - 5.0 * (total_hit_pool - taken_flat * total_taken_multi)) * resist_x_convert;
                    let c = -effective_applied_armour * (total_hit_pool - taken_flat * total_taken_multi);
                    let raw = if a != 0.0 { ((b * b - 4.0 * a * c).max(0.0).sqrt() - b) / (2.0 * a) } else { f64::INFINITY };

                    let no_dr_max_hit = total_hit_pool / damage_converted_multi / total_resist_mult / total_taken_multi * (1.0 - taken_flat * total_taken_multi / total_hit_pool);
                    let max_dr_max_hit = no_dr_max_hit / (1.0 - (g(output, "DamageReductionMax") - enemy_overwhelm_percent) / 100.0);
                    hit_taken = raw.min(max_dr_max_hit).max(no_dr_max_hit).floor();
                    use_conversion_smoothing = use_conversion_smoothing || convert_percent != 100.0;
                }
                part_min = part_min.min(hit_taken);
            }
        }

        let enemy_damage_mult = g(output, &format!("{damage_type}EnemyDamageMult"));
        let final_max_hit;
        if part_min == f64::INFINITY {
            final_max_hit = f64::INFINITY;
        } else if use_conversion_smoothing {
            let mut pass_incoming_damage = part_min;
            let mut previous_overkill: Option<f64> = None;
            for n in 1..=(misc("maxHitSmoothingPasses") as i64) {
                let shift_table = &shift.damage_shift_table[damage_type];
                let (_, mut pass_damages) = crate::pools::taken_hit_from_damage(pass_incoming_damage, damage_type, shift_table, store, output);
                let pass_pools = crate::pools::reduce_pools_by_damage(None, &pass_damages, store, output);
                // reducePoolsByDamage rewrites its damage table in place (`damage > 0 and ceil(damage) or nil`),
                // so the ratio loop below only sees the non-zero parts
                pass_damages.retain(|_, d| *d > 0.0);
                for d in pass_damages.values_mut() { *d = d.ceil(); }
                let pass_overkill = pass_pools.overkill_damage - pass_pools.hit_pool_remaining;
                let mut pass_ratio: f64 = 0.0;
                for part_type in pass_damages.keys() {
                    let part_pool = g(output, &format!("{part_type}TotalHitPool"));
                    if part_pool > 0.0 {
                        pass_ratio = pass_ratio.max((pass_overkill + part_pool) / part_pool);
                    }
                }
                if pass_ratio <= 0.0 {
                    pass_ratio = 1.0;
                }
                let mut step_size = 1.0;
                if n > 1 {
                    if let Some(prev) = previous_overkill {
                        if prev != 0.0 && !prev.is_nan() {
                            step_size = ((pass_overkill - prev) / prev).abs().min(2.0);
                        }
                    }
                }
                let step_adjust = if step_size > 1.0 { -pass_overkill / step_size } else if n > 1 { -pass_overkill * step_size } else { 0.0 };
                previous_overkill = Some(pass_overkill);
                pass_incoming_damage = (pass_incoming_damage + step_adjust) / pass_ratio.sqrt();
                if pass_overkill < 1.0 && pass_overkill > -1.0 {
                    break;
                }
            }
            final_max_hit = round(pass_incoming_damage / enemy_damage_mult);
        } else {
            final_max_hit = round(part_min / enemy_damage_mult);
        }
        output.insert(format!("{damage_type}MaximumHitTaken"), final_max_hit);
        if pom_offence::bd::on() {
            crate::bd_est2::max_hit(damage_type, final_max_hit, enemy_damage_mult, use_conversion_smoothing, &shift.damage_shift_table[damage_type], store, &*output);
        }
    }

    let mut minimum = f64::INFINITY;
    let mut second_minimum = f64::INFINITY;
    for &dt in DMG_TYPES {
        let v = g(output, &format!("{dt}MaximumHitTaken"));
        if v < minimum {
            second_minimum = minimum;
            minimum = v;
        } else if v < second_minimum {
            second_minimum = v;
        }
    }
    output.insert("SecondMinimalMaximumHitTaken".into(), second_minimum);

    for &dt in DMG_TYPES {
        output.insert(format!("{dt}DotEHP"), g(output, &format!("{dt}TotalPool")) / g(output, &format!("{dt}TakenDotMult")));
        crate::bd_est2::dot_ehp(dt, output);
    }
}

/// "degens": `TotalBuildDegen` (Lua lines 3384-3436) + its net-regen fields (3438-3530). Sets
/// `output.NetLifeRegen`/`NetManaRegen`/`NetEnergyShieldRegen`/`TotalNetRegen` only when there is
/// any build-sourced degen at all (matching `output.TotalBuildDegen = nil` when it stayed 0 - both
/// left absent, read back as 0 via `g()`, same as every other Lua-nil field in this crate).
pub fn build_degen(output: &mut HashMap<String, f64>, store: &ModStore, shift: &ShiftTables) {
    if pom_offence::bd::on() {
        // the `TotalBuildDegen` / `<type>BuildDegen` tables, in upstream's `pairs` order (the other types, then the same type)
        for &damage_type in DMG_TYPES {
            let base_val = store.sum(ModType::Base, None, &[s(&format!("{damage_type}Degen"))]);
            if base_val > 0.0 {
                let mut order: Vec<&str> = DMG_TYPES.iter().copied().filter(|&d| d != damage_type).collect();
                order.push(damage_type);
                for dest in order {
                    let convert_percent = shift.damage_over_time_shift_table[damage_type][dest];
                    if convert_percent > 0.0 {
                        let mult = g(output, &format!("{dest}TakenDotMult"));
                        crate::bd_est2::degen_row("TotalBuildDegen", &format!("{dest}BuildDegen"), None, damage_type, dest, base_val, convert_percent, mult, base_val * (convert_percent / 100.0) * mult);
                    }
                }
            }
        }
    }
    let mut total_build_degen = 0.0;
    for &damage_type in DMG_TYPES {
        let base_val = store.sum(ModType::Base, None, &[s(&format!("{damage_type}Degen"))]);
        if base_val > 0.0 {
            for &damage_converted_type in DMG_TYPES {
                let convert_percent = shift.damage_over_time_shift_table[damage_type][damage_converted_type];
                if convert_percent > 0.0 {
                    let total = base_val * (convert_percent / 100.0) * g(output, &format!("{damage_converted_type}TakenDotMult"));
                    let key = format!("{damage_converted_type}BuildDegen");
                    let cur = g(output, &key);
                    output.insert(key, cur + total);
                    total_build_degen += total;
                }
            }
        }
    }
    if total_build_degen == 0.0 {
        output.remove("TotalBuildDegen");
        return;
    }
    output.insert("TotalBuildDegen".into(), total_build_degen);

    let mut net_life = g(output, "LifeRegenRecovery");
    let mut net_mana = g(output, "ManaRegenRecovery");
    let mut net_es = g(output, "EnergyShieldRegenRecovery");
    let (life_degen, mana_degen, es_degen) = net_degen_split(output, store, DMG_TYPES.iter().map(|&dt| (dt, output.get(&format!("{dt}BuildDegen")).copied())));
    net_life -= life_degen;
    net_mana -= mana_degen;
    net_es -= es_degen;
    output.insert("NetLifeRegen".into(), net_life);
    output.insert("NetManaRegen".into(), net_mana);
    output.insert("NetEnergyShieldRegen".into(), net_es);
    output.insert("TotalNetRegen".into(), net_life + net_mana + net_es);
    if pom_offence::bd::on() {
        let degens: Vec<(&'static str, f64)> = DMG_TYPES.iter().filter_map(|&dt| output.get(&format!("{dt}BuildDegen")).map(|&v| (dt, v))).collect();
        let n = crate::bd_est2::net_degen_rows(output, store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]), &degens, false);
        crate::bd_est2::net_regen_tables(&n, output);
    }
}

/// Shared by `build_degen` and `comprehensive_degen`: splits a per-damage-type degen total across
/// life/mana/ES using Mind over Matter + ES bypass, matching Lua lines 3471-3508 (and their
/// `comprehensive_degen` twin, 3712-3734). `degens` yields `(damageType, Some(totalDegenOrNone))`;
/// a `None` (Lua nil, i.e. the type contributes no degen at all) is skipped, matching the Lua's own
/// `if output[damageType.."BuildDegen"] then` / `if typeDegen ~= 0 then` guards.
fn net_degen_split<'a>(output: &HashMap<String, f64>, store: &ModStore, degens: impl Iterator<Item = (&'a str, Option<f64>)>) -> (f64, f64, f64) {
    let mut total_life = 0.0;
    let mut total_mana = 0.0;
    let mut total_es = 0.0;
    let es_regen_recovery = g(output, "EnergyShieldRegenRecovery");
    let es_protects_mana = store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]);
    for (damage_type, degen) in degens {
        let Some(type_degen) = degen else { continue };
        if type_degen == 0.0 {
            continue;
        }
        let taken_from_mana = g(output, &format!("{damage_type}MindOverMatter")) + g(output, "sharedMindOverMatter");
        let es_bypass = g(output, &format!("{damage_type}EnergyShieldBypass")) / 100.0;
        let (life_degen, mana_degen, es_degen);
        if es_regen_recovery > 0.0 {
            if es_protects_mana {
                life_degen = type_degen * (1.0 - taken_from_mana / 100.0);
                es_degen = type_degen * (1.0 - es_bypass) * (taken_from_mana / 100.0);
            } else {
                life_degen = type_degen * es_bypass * (1.0 - taken_from_mana / 100.0);
                es_degen = type_degen * (1.0 - es_bypass);
            }
            mana_degen = type_degen * es_bypass * (taken_from_mana / 100.0);
        } else {
            life_degen = type_degen * (1.0 - taken_from_mana / 100.0);
            mana_degen = type_degen * (taken_from_mana / 100.0);
            es_degen = 0.0;
        }
        total_life += life_degen;
        total_mana += mana_degen;
        total_es += es_degen;
    }
    (total_life, total_mana, total_es)
}

/// "comprehensive degen" (Lua lines 3531-3785): folds enemy ignite/poison (and the always-zero
/// `enemyBleedChance` stub - never assigned past its `local enemyBleedChance = 0` declaration
/// anywhere in upstream, ported as a literal always-0) into `TotalBuildDegen` when
/// `damageCategoryConfig == "DamageOverTime"` or either ailment chance is positive.
pub fn comprehensive_degen(output: &mut HashMap<String, f64>, store: &ModStore, enemy: &ModStore, config_input: &HashMap<String, f64>, config_placeholder: &HashMap<String, f64>, shift: &ShiftTables, damage_category_config: &str) {
    let enemy_crit_ailment_effect = 1.0 + g(output, "EnemyCritChance") / 100.0 * 0.5 * (1.0 - g(output, "CritExtraDamageReduction") / 100.0);
    let enemy_crit_threshold = 10.1;
    let enemy_bleed_chance = 0.0;
    let mut enemy_ignite_chance = 0.0;
    if g(output, "SelfIgniteEffect") != 0.0 && g(output, "IgniteAvoidChance") < 100.0 && g(output, "SelfIgniteDuration") != 0.0 && damage_category_config != "DamageOverTime" {
        let base_ignite_chance = enemy.sum(ModType::Base, None, &[pom_engine::sym!("IgniteChance"), pom_engine::sym!("ElementalAilmentChance")]);
        let enemy_crit_chance = g(output, "EnemyCritChance");
        let enemy_crit_ailment_chance = if !store.flag(None, &[pom_engine::sym!("CritsOnYouDontAlwaysApplyElementalAilments")]) && (enemy_crit_chance > enemy_crit_threshold || base_ignite_chance > 0.0) { enemy_crit_chance } else { 0.0 };
        enemy_ignite_chance = (enemy_crit_ailment_chance + (1.0 - enemy_crit_ailment_chance / 100.0) * base_ignite_chance) * (1.0 - g(output, "IgniteAvoidChance") / 100.0);
    }
    let mut enemy_poison_chance = 0.0;
    if g(output, "SelfPoisonEffect") != 0.0 && g(output, "PoisonAvoidChance") < 100.0 && g(output, "SelfPoisonDuration") != 0.0 && damage_category_config != "DamageOverTime" {
        enemy_poison_chance = enemy.sum(ModType::Base, None, &[pom_engine::sym!("PoisonChance")]) * (1.0 - g(output, "PoisonAvoidChance") / 100.0);
    }
    if damage_category_config != "DamageOverTime" && (enemy_ignite_chance + enemy_poison_chance + enemy_bleed_chance) <= 0.0 {
        return;
    }

    let total_build_degen = output.get("TotalBuildDegen").copied().unwrap_or(0.0);
    let mut total_degen = total_build_degen;

    if damage_category_config == "DamageOverTime" {
        for &damage_type in DMG_TYPES {
            let base_val = cfg_num(config_input, config_placeholder, &format!("enemy{damage_type}Damage")).unwrap_or(0.0);
            if base_val > 0.0 {
                for &damage_converted_type in DMG_TYPES {
                    let convert_percent = shift.damage_over_time_shift_table[damage_type][damage_converted_type];
                    if convert_percent > 0.0 {
                        let total = base_val * (convert_percent / 100.0) * g(output, &format!("{damage_converted_type}TakenDotMult"));
                        let key = format!("{damage_converted_type}EnemyDegen");
                        let cur = g(output, &key);
                        output.insert(key, cur + total);
                        total_degen += total;
                    }
                }
                if pom_offence::bd::on() {
                    let source = if config_input.contains_key(&format!("enemy{damage_type}Damage")) { "Config" } else { "Default" };
                    let mut order: Vec<&str> = DMG_TYPES.iter().copied().filter(|&d| d != damage_type).collect();
                    order.push(damage_type);
                    for dest in order {
                        let convert_percent = shift.damage_over_time_shift_table[damage_type][dest];
                        if convert_percent > 0.0 {
                            let mult = g(output, &format!("{dest}TakenDotMult"));
                            crate::bd_est2::degen_row("TotalDegen", &format!("{dest}EnemyDegen"), Some(source), damage_type, dest, base_val, convert_percent, mult, base_val * (convert_percent / 100.0) * mult);
                        }
                    }
                }
            }
        }
    } else if enemy_ignite_chance + enemy_poison_chance + enemy_bleed_chance > 0.0 {
        let ailments: [(&str, &str, &[&str]); 2] = [("Ignite", "Fire", if enemy.flag(None, &[pom_engine::sym!("AllDamageIgnites")]) { DMG_TYPES } else { &["Fire"] }), ("Poison", "Chaos", &["Physical", "Chaos"])];
        for &(source, ailment_damage_type, source_types) in &ailments {
            let active = match source {
                "Ignite" => enemy_ignite_chance > 0.0,
                "Poison" => enemy_poison_chance > 0.0,
                _ => false,
            };
            if !active {
                continue;
            }
            let mut base_val = 0.0;
            for &dt in source_types {
                base_val += g(output, &format!("{dt}TakenDamage"));
            }
            base_val = base_val * misc(&format!("{source}PercentBase")) * (enemy_crit_ailment_effect / g(output, "EnemyCritEffect")) * g(output, &format!("Self{source}Effect")) / 100.0;
            if base_val > 0.0 {
                for &damage_converted_type in DMG_TYPES {
                    let convert_percent = shift.damage_over_time_shift_table[ailment_damage_type][damage_converted_type];
                    if convert_percent > 0.0 {
                        let total = base_val * (convert_percent / 100.0) * g(output, &format!("{damage_converted_type}TakenDotMult"));
                        let key = format!("{damage_converted_type}EnemyDegen");
                        let cur = g(output, &key);
                        output.insert(key, cur + total);
                        total_degen += total;
                    }
                }
                if pom_offence::bd::on() {
                    let mut order: Vec<&str> = DMG_TYPES.iter().copied().filter(|&d| d != ailment_damage_type).collect();
                    order.push(ailment_damage_type);
                    for dest in order {
                        let convert_percent = shift.damage_over_time_shift_table[ailment_damage_type][dest];
                        if convert_percent > 0.0 {
                            let mult = g(output, &format!("{dest}TakenDotMult"));
                            crate::bd_est2::degen_row("TotalDegen", &format!("{dest}EnemyDegen"), Some(source), ailment_damage_type, dest, base_val, convert_percent, mult, base_val * (convert_percent / 100.0) * mult);
                        }
                    }
                }
            }
        }
    }

    if total_degen == total_build_degen {
        output.remove("TotalDegen");
        return;
    }
    output.insert("TotalDegen".into(), total_degen);

    let mut net_life = g(output, "LifeRegenRecovery");
    let mut net_mana = g(output, "ManaRegenRecovery");
    let mut net_es = g(output, "EnergyShieldRegenRecovery");
    let degens: Vec<(&str, Option<f64>)> = DMG_TYPES
        .iter()
        .map(|&dt| {
            let v = output.get(&format!("{dt}BuildDegen")).copied().unwrap_or(0.0) + output.get(&format!("{dt}EnemyDegen")).copied().unwrap_or(0.0);
            (dt, Some(v))
        })
        .collect();
    let (life_degen, mana_degen, es_degen) = net_degen_split(output, store, degens.into_iter());
    net_life += g(output, "LifeRecoupRecoveryAvg") - life_degen - g(output, "LifeLossLostAvg");
    net_mana += g(output, "ManaRecoupRecoveryAvg") - mana_degen;
    net_es += g(output, "EnergyShieldRecoupRecoveryAvg") - es_degen;
    output.insert("ComprehensiveNetLifeRegen".into(), net_life);
    output.insert("ComprehensiveNetManaRegen".into(), net_mana);
    output.insert("ComprehensiveNetEnergyShieldRegen".into(), net_es);
    output.insert("ComprehensiveTotalNetRegen".into(), net_life + net_mana + net_es);
    if pom_offence::bd::on() {
        let degens: Vec<(&'static str, f64)> = DMG_TYPES
            .iter()
            .filter_map(|&dt| {
                let v = output.get(&format!("{dt}BuildDegen")).copied().unwrap_or(0.0) + output.get(&format!("{dt}EnemyDegen")).copied().unwrap_or(0.0);
                (v != 0.0).then_some((dt, v))
            })
            .collect();
        let n = crate::bd_est2::net_degen_rows(output, store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]), &degens, true);
        crate::bd_est2::net_regen_tables(&n, output);
    }
}

/// The non-ModDB inputs `calcs.buildDefenceEstimations(env, actor)` reads directly off `env`
/// (mirrors `crate::defence::DefenceEnv` for `calcs.defence`).
pub struct EstimationsEnv {
    pub enemy_level: f64,
    pub config_input: HashMap<String, f64>,
    pub config_flags: HashMap<String, bool>,
    pub config_str: HashMap<String, String>,
    pub config_placeholder: HashMap<String, f64>,
    pub config_placeholder_str: HashMap<String, String>,
    /// `preOutput`'s boolean entries (`specificTypeAvoidance`, ...).
    pub pre_output_bool: HashMap<String, bool>,
}

/// `calcs.buildDefenceEstimations(env, actor)` (Modules/CalcDefence.lua:1674-3874) end to end.
/// Runs every section in Lua source order; each section function documents its own named gaps.
/// Two permanent, named cross-module gaps span multiple sections and are not repeated per call
/// site: `output.enemySkillTime`/`EHPSurvivalTime` need `calcs.actionSpeedMod` (`CalcPerform.lua`,
/// owned by the calc crate - same category as `defence.rs`'s `ActionSpeedMod` gap), left
/// untouched, so every field that divides by `EHPSurvivalTime` downstream (`recoup`,
/// `petrified_and_net_recovery`) inherits it; `output.AlliedEnergyShield` needs
/// `actor.parent.output`/`actor.partyMembers.output` (Soul Link), also left untouched.
pub fn build_defence_estimations(output: &mut HashMap<String, f64>, store: &ModStore, enemy: &ModStore, env: &EstimationsEnv) {
    let damage_category_config = damage_category_config(&env.config_str);
    let specific_type_avoidance = env.pre_output_bool.get("specificTypeAvoidance").copied().unwrap_or(false);

    not_hit_chance(output, &env.config_input, &damage_category_config, specific_type_avoidance);
    enemy_damage(output, store, enemy, &env.config_input, &env.config_placeholder, &damage_category_config, env.enemy_level);
    let shift = damage_taken_as(output, store);
    taken_mult_degen(output, store);
    incoming_hit_mult(output, store, enemy, &damage_category_config);
    stun(output, store, &damage_category_config, env.pre_output_bool.get("envEnergyShieldProtectsMana").copied());
    life_recoverable(output, store, &env.config_flags);
    life_loss_prevention(output, store, &env.config_flags);
    bypass_and_mom(output, store);
    guard_and_aegis(output, store);
    allies_and_shields(output, store, &damage_category_config);
    total_pool(output, store);
    if damage_category_config != "DamageOverTime" {
        hits_to_die_ehp(output, store, enemy, &env.config_input, &env.config_flags, &env.pre_output_bool, &damage_category_config);
        survival_time(output, enemy, &env.config_input, &env.config_placeholder);
    }
    recoup(output, store, &damage_category_config);
    petrified_and_net_recovery(output, store);
    pvp(output, &env.config_input, &env.config_flags);
    max_hit_and_dot_ehp(output, store, &shift);
    build_degen(output, store, &shift);
    comprehensive_degen(output, store, enemy, &env.config_input, &env.config_placeholder, &shift, &damage_category_config);
    crate::bd_est2::taken_hit_tables(output, store);
}

/// The "Enemy damage input" and "Damage Taken as" sections, graded directly against the recorded
/// `postOutput` (no probes). Kept alongside the full `enemy_damage`/`damage_taken_as` above (which
/// are graded against section probes) so both grading paths stay live; the logic is the same.
pub mod recorded_subset {
    use crate::defence::{is_elemental, s, DMG_TYPES};
    use pom_engine::modifier::ModType;
    use pom_engine::modstore::store::ModStore;
    use pom_engine::modstore::types::Cfg;
    use pom_engine::fxhash::HashMap;

    fn g(output: &HashMap<String, f64>, key: &str) -> f64 {
        output.get(key).copied().unwrap_or(0.0)
    }

    /// `env.configInput[key] or env.configPlaceholder[key] or default`: Lua's `or` chain is a
    /// presence check (0 is truthy in Lua - only `nil`/`false` are falsy), not a "nonzero" check, so
    /// this must check key presence, not value.
    fn cfg_num(config_input: &HashMap<String, f64>, config_placeholder: &HashMap<String, f64>, key: &str, default: f64) -> f64 {
        config_input.get(key).or_else(|| config_placeholder.get(key)).copied().unwrap_or(default)
    }

    /// `bit.bnot(KeywordFlag.MatchAll)` (Data/Global.lua:171, `MatchAll = 0x40000000`): LuaJIT's `bit`
    /// library is 32-bit, so the complement only clears the low 32 bits - matches
    /// `pom_engine::modstore::store::MATCH_ALL_MASK` (private to that crate, so recomputed here).
    fn enemy_cfg() -> Cfg {
        Cfg { keyword_flags: (!0x4000_0000u64) & 0xFFFF_FFFF, ..Default::default() }
    }

    /// "Enemy damage input and modifications" (Lua lines 1709-1844). `store`/`enemy` are the actor's
    /// own and its enemy's `ModStore` (`modDB`/`enemyDB` in the Lua - note `modDB` here, unusually,
    /// means the *player's*, not the enemy's). Mutates `output` in place, matching the Lua.
    pub fn enemy_damage_input(
        output: &mut HashMap<String, f64>,
        store: &ModStore,
        enemy: &ModStore,
        config_input: &HashMap<String, f64>,
        config_placeholder: &HashMap<String, f64>,
        damage_category_config: &str,
        enemy_level: f64,
    ) {
        output.insert("totalEnemyDamage".into(), 0.0);
        output.insert("totalEnemyDamageIn".into(), 0.0);

        if damage_category_config == "DamageOverTime" {
            for &dt in DMG_TYPES {
                output.insert(format!("{dt}EnemyPen"), 0.0);
                let mut names = vec![pom_engine::sym!("Damage"), s(&format!("{dt}Damage"))];
                if is_elemental(dt) {
                    names.push(pom_engine::sym!("ElementalDamage"));
                }
                let mult = crate::tools::mod_(enemy, None, &names);
                output.insert(format!("{dt}EnemyDamageMult"), mult);
                output.insert(format!("{dt}EnemyOverwhelm"), 0.0);
                output.insert(format!("{dt}EnemyDamage"), 0.0);
            }
            return;
        }

        let configured_evade = g(output, "ConfiguredEvadeChance");
        let enemy_crit_chance = if enemy.flag(None, &[pom_engine::sym!("NeverCrit")]) {
            0.0
        } else if enemy.flag(None, &[pom_engine::sym!("AlwaysCrit")]) {
            100.0
        } else {
            let base = store.override_(None, &[pom_engine::sym!("enemyCritChance")]).and_then(|v| v.num()).unwrap_or_else(|| cfg_num(config_input, config_placeholder, "enemyCritChance", 0.0));
            let inc = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("EnemyCritChance")]) / 100.0 + enemy.sum(ModType::Inc, None, &[pom_engine::sym!("CritChance")]) / 100.0;
            (base * inc * (1.0 - configured_evade / 100.0)).min(100.0).max(0.0)
        };
        output.insert("EnemyCritChance".into(), enemy_crit_chance);
        let enemy_crit_damage = (cfg_num(config_input, config_placeholder, "enemyCritDamage", 0.0) + enemy.sum(ModType::Base, None, &[pom_engine::sym!("CritMultiplier")])).max(0.0);
        let crit_extra_reduction = g(output, "CritExtraDamageReduction");
        let enemy_crit_effect = 1.0 + enemy_crit_chance / 100.0 * (enemy_crit_damage / 100.0) * (1.0 - crit_extra_reduction / 100.0);
        output.insert("EnemyCritEffect".into(), enemy_crit_effect);

        let e_cfg = enemy_cfg();
        // `enemyDamageConversion[damageTypeTo][damageType] = amount`: only "Physical" (first in
        // DMG_TYPES) ever writes into this, and every other type reads it later in the same pass, so
        // a plain per-target-type map (no `damageType` sub-key needed - Physical is the only source)
        // suffices instead of the Lua's nested table.
        let mut enemy_damage_conversion: HashMap<&str, f64> = HashMap::default();

        let mut total_enemy_damage = 0.0;
        let mut total_enemy_damage_in = 0.0;
        for &dt in DMG_TYPES {
            let mut names = vec![pom_engine::sym!("Damage"), s(&format!("{dt}Damage"))];
            if is_elemental(dt) {
                names.push(pom_engine::sym!("ElementalDamage"));
            }
            let enemy_damage_mult = crate::tools::mod_(enemy, None, &names);

            let mut enemy_damage = config_input.get(&format!("enemy{dt}Damage")).copied();
            let mut enemy_pen = config_input.get(&format!("enemy{dt}Pen")).copied();
            let mut enemy_overwhelm = config_input.get(&format!("enemy{dt}Overwhelm")).copied();

            if enemy_damage.is_none() {
                enemy_damage = Some(config_placeholder.get(&format!("enemy{dt}Damage")).copied().unwrap_or(0.0));
            }
            if enemy_pen.is_none() {
                enemy_pen = Some(config_placeholder.get(&format!("enemy{dt}Pen")).copied().unwrap_or(0.0));
            }
            if enemy_overwhelm.is_none() {
                // Lua reads `env.configPlaceholder["enemy"..damageType.."enemyOverwhelm"]` here (note:
                // "enemyOverwhelm" is appended, not "Overwhelm" - a literal quirk of upstream,
                // apparently a typo that means the placeholder fallback for Overwhelm never matches
                // any real placeholder key; preserved faithfully).
                enemy_overwhelm = Some(config_placeholder.get(&format!("enemy{dt}enemyOverwhelm")).copied().unwrap_or(0.0));
            }
            let mut enemy_damage = enemy_damage.unwrap();
            let enemy_pen = enemy_pen.unwrap();
            let mut enemy_overwhelm = enemy_overwhelm.unwrap();

            enemy_damage += (enemy.sum(ModType::Base, Some(&e_cfg), &[s(&format!("{dt}Min"))]) + enemy.sum(ModType::Base, Some(&e_cfg), &[s(&format!("{dt}Max"))])) / 2.0;

            let mut conversion_total = 0.0;
            if dt == "Physical" {
                let mut conv: HashMap<&str, f64> = HashMap::default();
                let mut conv_skill: HashMap<&str, f64> = HashMap::default();
                let mut total = 0.0;
                let mut total_skill = 0.0;
                for &to in DMG_TYPES {
                    let v_skill = enemy.sum(ModType::Base, Some(&e_cfg), &[s(&format!("{dt}DamageSkillConvertTo{to}"))]);
                    let v = enemy.sum(ModType::Base, Some(&e_cfg), &[s(&format!("{dt}DamageConvertTo{to}"))]);
                    conv_skill.insert(to, v_skill);
                    conv.insert(to, v);
                    total_skill += v_skill;
                    total += v;
                }
                if total_skill > 100.0 {
                    let mult = 100.0 / total_skill;
                    total_skill *= mult;
                    total = 0.0;
                    for &to in DMG_TYPES {
                        *conv_skill.get_mut(to).unwrap() *= mult;
                        conv.insert(to, 0.0);
                    }
                } else if total + total_skill > 100.0 {
                    let mult = (100.0 - total_skill) / total;
                    total *= mult;
                    for &to in DMG_TYPES {
                        *conv.get_mut(to).unwrap() *= mult;
                    }
                }
                conversion_total = total + total_skill;
                for &to in DMG_TYPES {
                    let gain_as_pct = enemy.sum(ModType::Base, Some(&e_cfg), &[s(&format!("{dt}DamageGainAs{to}"))]) / 100.0;
                    let mut conversion_pct = conv[to] / 100.0;
                    let skill_conversion_pct = conv_skill[to] / 100.0;
                    if skill_conversion_pct > 0.0 {
                        let skill_conversion_pct = if dt == "Physical" && to != "Chaos" {
                            let phys_bonus = 1.0 + crate::data::monster_phys_conversion_multi(enemy_level) / 100.0;
                            skill_conversion_pct * phys_bonus
                        } else {
                            skill_conversion_pct
                        };
                        conversion_pct += skill_conversion_pct;
                    }
                    if gain_as_pct > 0.0 || conversion_pct > 0.0 {
                        *enemy_damage_conversion.entry(to).or_insert(0.0) += enemy_damage * gain_as_pct + enemy_damage * conversion_pct;
                    }
                }
            }

            // Overwhelm is Physical-only in game; upstream applies it to every damage type. POM_STRICT_COMPAT=1 keeps the upstream behaviour.
            if dt == "Physical" || !pom_offence::data::pom_fixes_on() {
                enemy_overwhelm += enemy.sum(ModType::Base, None, &[pom_engine::sym!("PhysicalOverwhelm")]) + store.sum(ModType::Base, None, &[pom_engine::sym!("EnemyPhysicalOverwhelm")]);
            }

            output.insert(format!("{dt}EnemyPen"), enemy_pen);
            output.insert(format!("{dt}EnemyDamageMult"), enemy_damage_mult);
            output.insert(format!("{dt}EnemyOverwhelm"), enemy_overwhelm);
            total_enemy_damage_in += enemy_damage;
            let mut this_type_damage = enemy_damage * (1.0 - conversion_total / 100.0) * enemy_damage_mult * enemy_crit_effect;
            if let Some(&converted) = enemy_damage_conversion.get(dt) {
                // `calcLib.mod(enemyDB, nil, "Damage", damageType.."Damage", damageTypeFrom.."Damage",
                // isElemental[damageType] and "ElementalDamage" or nil, isElemental[damageTypeFrom] and
                // "ElementalDamage" or nil)`: damageTypeFrom is always "Physical" here (see comment
                // above), so both the from-type name and its elemental alias are fixed.
                let mut names = vec![pom_engine::sym!("Damage"), s(&format!("{dt}Damage")), pom_engine::sym!("PhysicalDamage")];
                if is_elemental(dt) {
                    names.push(pom_engine::sym!("ElementalDamage"));
                }
                // Physical is never elemental, so damageTypeFrom's elemental alias never applies.
                let conv_mult = crate::tools::mod_(enemy, None, &names);
                this_type_damage += converted * conv_mult * enemy_crit_effect;
            }
            output.insert(format!("{dt}EnemyDamage"), this_type_damage);
            total_enemy_damage += this_type_damage;
        }
        output.insert("totalEnemyDamage".into(), total_enemy_damage);
        output.insert("totalEnemyDamageIn".into(), total_enemy_damage_in);
    }

    /// "Damage Taken as" (Lua lines 1846-1922). `actor.damageShiftTable`/`damageOverTimeShiftTable`
    /// are per-actor Lua state normally persisted for later reuse (by `reducePoolsByDamage` etc, not
    /// yet ported); this port only needs the local
    /// `shiftTable` values live long enough to compute `output.<Type>TakenDamage`, so they're plain
    /// locals here, not written anywhere persistent.
    pub fn damage_taken_as(output: &mut HashMap<String, f64>, store: &ModStore) {
        // `shiftTable[damageType][destType]`: `damage_shift[damageType_idx][destType_idx]`, indices
        // into `DMG_TYPES` in order (Physical, Lightning, Cold, Fire, Chaos).
        let mut damage_shift = [[0.0f64; 5]; 5];
        for (i, &dt) in DMG_TYPES.iter().enumerate() {
            let mut dest_total = 0.0;
            for (j, &dest) in DMG_TYPES.iter().enumerate() {
                if dest == dt {
                    continue;
                }
                let mut dot_names = vec![s(&format!("{dt}DamageTakenAs{dest}"))];
                if is_elemental(dt) {
                    dot_names.push(s(&format!("ElementalDamageTakenAs{dest}")));
                }
                let dot_shift = store.sum(ModType::Base, None, &dot_names);
                let mut hit_names = vec![s(&format!("{dt}DamageFromHitsTakenAs{dest}"))];
                if is_elemental(dt) {
                    hit_names.push(s(&format!("ElementalDamageFromHitsTakenAs{dest}")));
                }
                let shift = dot_shift + store.sum(ModType::Base, None, &hit_names);
                damage_shift[i][j] = shift;
                dest_total += shift;
            }
            damage_shift[i][i] = (100.0 - dest_total).max(0.0);
            let enemy_damage = g(output, &format!("{dt}EnemyDamage"));
            output.insert(format!("{dt}TakenDamage"), enemy_damage * damage_shift[i][i] / 100.0);
        }
        for (i, &dt) in DMG_TYPES.iter().enumerate() {
            for (j, &dest) in DMG_TYPES.iter().enumerate() {
                if dt == dest {
                    continue;
                }
                let enemy_damage = g(output, &format!("{dt}EnemyDamage"));
                let damage = enemy_damage * damage_shift[i][j] / 100.0;
                *output.entry(format!("{dest}TakenDamage")).or_insert(0.0) += damage;
            }
        }
        let mut total_taken = 0.0;
        for &dt in DMG_TYPES {
            total_taken += g(output, &format!("{dt}TakenDamage"));
        }
        output.insert("totalTakenDamage".into(), total_taken);
    }

    // The later sections (damage-taken multipliers, incoming hit, stun, Life Recoverable),
    // graded against the recorded `postOutput`.
    use crate::data::misc;

    /// `output[key] or default`: a presence check like `cfg_num`, not a "value is 0" check - `0` is
    /// truthy in Lua's `or`.
    fn opt_or(output: &HashMap<String, f64>, key: &str, default: f64) -> f64 {
        output.get(key).copied().unwrap_or(default)
    }

    const HIT_SOURCE_LIST: &[&str] = &["Attack", "Spell"];

    /// "Damage taken multipliers/Degen calculations", the "Hit"/"Dot" sub-blocks only (Lua lines
    /// 1924-1984 - `output.AnyTakenReflect` is a boolean, dropped by the recorder's scalar flattener
    /// like every other boolean output field, so not set here). `output[<HitType>TakenHitMult]`
    /// (`AttackTakenHitMult`/`SpellTakenHitMult`, as opposed to the per-damage-type
    /// `output[<Type><HitType>TakenHitMult]`) is intentionally overwritten on every `damageType`
    /// iteration in the Lua - only the *last* damage type in `DMG_TYPES` (Chaos) survives as the final
    /// value, a quirk of upstream preserved faithfully here, not a bug in this port.
    pub fn damage_taken_multipliers(output: &mut HashMap<String, f64>, store: &ModStore) {
        for &dt in DMG_TYPES {
            let mut base_taken_inc = store.sum(ModType::Inc, None, &[pom_engine::sym!("DamageTaken"), s(&format!("{dt}DamageTaken"))]);
            let mut base_taken_more = store.more(None, &[pom_engine::sym!("DamageTaken"), s(&format!("{dt}DamageTaken"))]);
            if is_elemental(dt) {
                base_taken_inc += store.sum(ModType::Inc, None, &[pom_engine::sym!("ElementalDamageTaken")]);
                base_taken_more *= store.more(None, &[pom_engine::sym!("ElementalDamageTaken")]);
            }
            // Hit
            let mut taken_inc = base_taken_inc + store.sum(ModType::Inc, None, &[pom_engine::sym!("DamageTakenWhenHit"), s(&format!("{dt}DamageTakenWhenHit"))]);
            let mut taken_more = base_taken_more * store.more(None, &[pom_engine::sym!("DamageTakenWhenHit"), s(&format!("{dt}DamageTakenWhenHit"))]);
            if is_elemental(dt) {
                taken_inc += store.sum(ModType::Inc, None, &[pom_engine::sym!("ElementalDamageTakenWhenHit")]);
                taken_more *= store.more(None, &[pom_engine::sym!("ElementalDamageTakenWhenHit")]);
            }
            output.insert(format!("{dt}TakenHitMult"), ((1.0 + taken_inc / 100.0) * taken_more).max(0.0));

            for &hit_type in HIT_SOURCE_LIST {
                let inc_type = taken_inc + store.sum(ModType::Inc, None, &[s(&format!("{hit_type}DamageTaken"))]);
                let more_type = taken_more * store.more(None, &[s(&format!("{hit_type}DamageTaken"))]);
                let v = ((1.0 + inc_type / 100.0) * more_type).max(0.0);
                output.insert(format!("{hit_type}TakenHitMult"), v);
                output.insert(format!("{dt}{hit_type}TakenHitMult"), v);
            }
            // Reflect
            taken_inc += store.sum(ModType::Inc, None, &[pom_engine::sym!("ReflectedDamageTaken"), s(&format!("{dt}ReflectedDamageTaken"))]);
            taken_more *= store.more(None, &[pom_engine::sym!("ReflectedDamageTaken"), s(&format!("{dt}ReflectedDamageTaken"))]);
            if is_elemental(dt) {
                taken_inc += store.sum(ModType::Inc, None, &[pom_engine::sym!("ElementalReflectedDamageTaken")]);
                taken_more *= store.more(None, &[pom_engine::sym!("ElementalReflectedDamageTaken")]);
            }
            output.insert(format!("{dt}TakenReflect"), ((1.0 + taken_inc / 100.0) * taken_more).max(0.0));

            // Dot
            let mut dot_inc = base_taken_inc + store.sum(ModType::Inc, None, &[pom_engine::sym!("DamageTakenOverTime"), s(&format!("{dt}DamageTakenOverTime"))]);
            let mut dot_more = base_taken_more * store.more(None, &[pom_engine::sym!("DamageTakenOverTime"), s(&format!("{dt}DamageTakenOverTime"))]);
            if is_elemental(dt) {
                dot_inc += store.sum(ModType::Inc, None, &[pom_engine::sym!("ElementalDamageTakenOverTime")]);
                dot_more *= store.more(None, &[pom_engine::sym!("ElementalDamageTakenOverTime")]);
            }
            let resist = if store.flag(None, &[s(&format!("SelfIgnore{dt}Resistance"))]) { 0.0 } else { opt_or(output, &format!("{dt}ResistOverTime"), g(output, &format!("{dt}Resist"))) };
            let reduction = if store.flag(None, &[s(&format!("SelfIgnoreBase{dt}DamageReduction"))]) { 0.0 } else { g(output, &format!("Base{dt}DamageReduction")) };
            let v = ((1.0 - resist / 100.0) * (1.0 - reduction / 100.0) * (1.0 + dot_inc / 100.0) * dot_more).max(0.0);
            output.insert(format!("{dt}TakenDotMult"), v);
        }
    }

    /// "Incoming hit damage multipliers" (Lua lines 1986-2091 - the breakdown-only tail (2092-2140)
    /// and the dead `if output.AnyTakenReflect then ... end` branch at 2140-2143 (`AnyTakenReflect` is
    /// unconditionally `false`, see `damage_taken_multipliers`'s doc comment) are skipped, matching
    /// this crate's existing precedent of never reproducing breakdown-only or genuinely-dead code).
    /// Requires `damage_taken_as`, `damage_taken_multipliers`, and `enemy_damage_input` to have
    /// already run this call (reads `{dt}TakenDamage`/`{dt}TakenHitMult`/`{dt}AttackTakenHitMult`/
    /// `{dt}SpellTakenHitMult`/`{dt}TakenReflect`/`{dt}EnemyPen`/`{dt}EnemyOverwhelm`, all written by
    /// those three). This is the section that reassigns `output[dt.."TakenHitMult"]` to its real final
    /// value (line 2086) - see `damage_taken_multipliers`'s doc comment for why grading that field
    /// there, before this section runs, would be wrong.
    pub fn incoming_hit_damage_multipliers(output: &mut HashMap<String, f64>, store: &ModStore, enemy: &ModStore, damage_category_config: &str) {
        let enemy_impale_cfg = Cfg {
            flags: if matches!(damage_category_config, "Melee" | "Projectile" | "Average") { 1 } else { 0 },
            keyword_flags: 0,
            ..Default::default()
        };
        // `(1 - (output.ImpaleAvoidChance or 0))`: no `/100` in upstream despite
        // `ImpaleAvoidChance` being a 0-100 percentage everywhere else - a genuine quirk of the
        // original (line 2000), ported faithfully, not a bug in this port.
        let enemy_impale_chance = enemy.sum(ModType::Base, Some(&enemy_impale_cfg), &[pom_engine::sym!("ImpaleChance")])
            * if damage_category_config == "Average" { 0.5 } else { 1.0 }
            * (1.0 - g(output, "ImpaleAvoidChance"));

        let armour = g(output, "Armour");
        let armour_defense = g(output, "ArmourDefense");
        let ward = g(output, "Ward");
        let damage_reduction_max = g(output, "DamageReductionMax");
        let mut total_taken_hit = 0.0;
        for &dt in DMG_TYPES {
            let resist = if store.flag(None, &[s(&format!("SelfIgnore{dt}Resistance"))]) { 0.0 } else { opt_or(output, &format!("{dt}ResistWhenHit"), g(output, &format!("{dt}Resist"))) };
            let reduction = if store.flag(None, &[s(&format!("SelfIgnoreBase{dt}DamageReduction"))]) { 0.0 } else { opt_or(output, &format!("Base{dt}DamageReductionWhenHit"), g(output, &format!("Base{dt}DamageReduction"))) };
            let enemy_pen = if store.flag(None, &[s(&format!("SelfIgnore{dt}Resistance")), s(&format!("EnemyCannotPen{dt}Resistance"))]) { 0.0 } else { g(output, &format!("{dt}EnemyPen")) };
            let enemy_overwhelm = if store.flag(None, &[s(&format!("SelfIgnore{dt}DamageReduction"))]) { 0.0 } else { g(output, &format!("{dt}EnemyOverwhelm")) };
            let damage = g(output, &format!("{dt}TakenDamage"));
            let mut impale_damage = if enemy_impale_chance > 0.0 && dt == "Physical" { damage * misc("ImpaleStoredDamageBase") } else { 0.0 };

            let percent_of_armour_applies = (if store.flag(None, &[s(&format!("ArmourDoesNotApplyTo{dt}DamageTaken"))]) { 0.0 } else { store.sum(ModType::Base, None, &[s(&format!("ArmourAppliesTo{dt}DamageTaken"))]) }).min(100.0);
            let mut effective_applied_armour = (armour * percent_of_armour_applies / 100.0) * (1.0 + armour_defense);
            let physical_reduction_based_on_ward = dt == "Physical" && store.flag(None, &[pom_engine::sym!("PhysicalReductionBasedOnWard")]);
            if physical_reduction_based_on_ward {
                let multiplier = store.override_(None, &[pom_engine::sym!("PhysicalReductionBasedOnWardPercent")]).and_then(|v| v.num()).unwrap_or(0.0) / 100.0;
                effective_applied_armour = ward * multiplier;
            }
            let res_mult = 1.0 - (resist - enemy_pen) / 100.0;

            let mut taken_flat = store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTaken"), s(&format!("{dt}DamageTaken")), pom_engine::sym!("DamageTakenWhenHit"), s(&format!("{dt}DamageTakenWhenHit"))]);
            match damage_category_config {
                "Melee" | "Projectile" => {
                    taken_flat += store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTakenFromAttacks"), s(&format!("{dt}DamageTakenFromAttacks")), s(&format!("{dt}DamageTakenFrom{damage_category_config}Attacks"))]);
                }
                "Spell" | "SpellProjectile" => {
                    taken_flat += store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTakenFromSpells"), s(&format!("{dt}DamageTakenFromSpells")), s(&format!("{dt}DamageTakenFromSpellProjectiles"))]);
                }
                "Average" => {
                    taken_flat += store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTakenFromAttacks"), s(&format!("{dt}DamageTakenFromAttacks"))]) / 2.0
                        + store.sum(ModType::Base, None, &[s(&format!("{dt}DamageTakenFromProjectileAttacks"))]) / 4.0
                        + store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTakenFromSpells"), s(&format!("{dt}DamageTakenFromSpells"))]) / 2.0
                        + store.sum(ModType::Base, None, &[pom_engine::sym!("DamageTakenFromSpellProjectiles"), s(&format!("{dt}DamageTakenFromSpellProjectiles"))]) / 4.0;
                }
                _ => {}
            }
            output.insert(format!("{dt}takenFlat"), taken_flat);

            let mut armour_reduct = 0.0;
            let mut impale_armour_reduct = 0.0;
            if percent_of_armour_applies > 0.0 || physical_reduction_based_on_ward {
                armour_reduct = crate::defence::armour_reduction(effective_applied_armour, damage * res_mult).min(damage_reduction_max);
                if impale_damage > 0.0 {
                    impale_armour_reduct = crate::defence::armour_reduction(effective_applied_armour, impale_damage * res_mult).min(damage_reduction_max);
                }
            }
            let total_reduct = (armour_reduct + reduction).min(damage_reduction_max);
            let reduct_mult = 1.0 - (total_reduct - enemy_overwhelm).min(damage_reduction_max).max(0.0) / 100.0;
            output.insert(format!("{dt}DamageReduction"), 100.0 - reduct_mult * 100.0);
            if impale_damage > 0.0 {
                impale_damage *= res_mult * (1.0 - (((impale_armour_reduct + reduction).min(damage_reduction_max)) - enemy_overwhelm).min(damage_reduction_max).max(0.0) / 100.0);
                impale_damage = impale_damage * enemy_impale_chance / 100.0 * 5.0 * g(output, &format!("{dt}TakenReflect"));
            }

            let (mut taken_mult, mut spell_suppress_mult) = (g(output, &format!("{dt}TakenHitMult")), 1.0);
            match damage_category_config {
                "Melee" | "Projectile" => {
                    taken_mult = g(output, &format!("{dt}AttackTakenHitMult"));
                }
                "Spell" | "SpellProjectile" => {
                    taken_mult = g(output, &format!("{dt}SpellTakenHitMult"));
                    spell_suppress_mult = if g(output, "EffectiveSpellSuppressionChance") == 100.0 { 1.0 - g(output, "SpellSuppressionEffect") / 100.0 } else { 1.0 };
                }
                "Average" => {
                    taken_mult = (g(output, &format!("{dt}SpellTakenHitMult")) + g(output, &format!("{dt}AttackTakenHitMult"))) / 2.0;
                    spell_suppress_mult = if g(output, "EffectiveSpellSuppressionChance") == 100.0 { 1.0 - g(output, "SpellSuppressionEffect") / 100.0 / 2.0 } else { 1.0 };
                }
                _ => {}
            }
            output.insert(format!("{dt}EffectiveAppliedArmour"), effective_applied_armour);
            output.insert(format!("{dt}ResistTakenHitMulti"), res_mult);
            let after_reduction_multi = taken_mult * spell_suppress_mult;
            output.insert(format!("{dt}AfterReductionTakenHitMulti"), after_reduction_multi);
            let base_mult = res_mult * reduct_mult;
            output.insert(format!("{dt}BaseTakenHitMult"), base_mult * after_reduction_multi);
            let taken_hit = (damage * base_mult + taken_flat).max(0.0) * taken_mult * spell_suppress_mult + impale_damage;
            output.insert(format!("{dt}TakenHit"), taken_hit);
            output.insert(format!("{dt}TakenHitMult"), if damage > 0.0 { taken_hit / damage } else { 0.0 });
            total_taken_hit += taken_hit;
        }
        output.insert("totalTakenHit".into(), total_taken_hit);
    }

    /// "stun" (Lua lines 2153-2256). `env.modDB` (line 2181, `EnergyShieldProtectsMana`) is the
    /// *player's* own ModDB, distinct from `actor.modDB` only when the acting actor is a minion (this
    /// crate has no separate recording of the player's store for a minion-actor event - same scope
    /// limit as the other minion gaps in "Named gaps inside calcs.defence itself"); `store` is used
    /// directly here, which is exactly correct for `actor_kind == "player"` events and only wrong for
    /// this one rare flag check on minion events.
    pub fn stun(output: &mut HashMap<String, f64>, store: &ModStore, damage_category_config: &str) {
        let stun_threshold_base = if store.flag(None, &[pom_engine::sym!("StunThresholdBasedOnEnergyShieldInsteadOfLife")]) {
            g(output, "EnergyShield") * store.sum(ModType::Base, None, &[pom_engine::sym!("StunThresholdEnergyShieldPercent")]) / 100.0
        } else if store.flag(None, &[pom_engine::sym!("StunThresholdBasedOnManaInsteadOfLife")]) {
            g(output, "Mana") * store.sum(ModType::Base, None, &[pom_engine::sym!("StunThresholdManaPercent")]) / 100.0
        } else if store.flag(None, &[pom_engine::sym!("ChaosInoculation")]) {
            store.sum(ModType::Base, None, &[pom_engine::sym!("Life")])
        } else {
            g(output, "Life")
        };
        let stun_threshold_base = if store.flag(None, &[pom_engine::sym!("AddESToStunThreshold")]) {
            stun_threshold_base + g(output, "EnergyShield") * store.sum(ModType::Base, None, &[pom_engine::sym!("ESToStunThresholdPercent")]) / 100.0
        } else {
            stun_threshold_base
        };
        let stun_threshold_mod = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("StunThreshold")]) / 100.0;
        let stun_threshold = stun_threshold_base * stun_threshold_mod;
        output.insert("StunThreshold".into(), stun_threshold);

        let mut not_avoid_chance = if store.flag(None, &[pom_engine::sym!("StunImmune")]) { 0.0 } else { 100.0 - store.sum(ModType::Base, None, &[pom_engine::sym!("AvoidStun")]).min(100.0) };
        if g(output, "EnergyShield") > g(output, "totalTakenHit") && !store.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]) {
            not_avoid_chance *= 0.5;
        }
        output.insert("StunAvoidChance".into(), 100.0 - not_avoid_chance);

        if 100.0 - not_avoid_chance >= 100.0 {
            output.insert("StunDuration".into(), 0.0);
            output.insert("BlockDuration".into(), 0.0);
        } else {
            let stun_duration_mod = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("StunDuration")]) / 100.0;
            let base_stun_duration = misc("StunBaseDuration");
            let stun_recovery = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("StunRecovery")]) / 100.0;
            let stun_and_block_recovery = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("StunRecovery"), pom_engine::sym!("BlockRecovery")]) / 100.0;
            let tick_rate = misc("ServerTickRate");
            output.insert("StunDuration".into(), (base_stun_duration * stun_duration_mod / stun_recovery * tick_rate).ceil() / tick_rate);
            output.insert("BlockDuration".into(), (base_stun_duration * stun_duration_mod / stun_and_block_recovery * tick_rate).ceil() / tick_rate);
        }
        output.insert("InterruptStunAvoidChance".into(), store.sum(ModType::Base, None, &[pom_engine::sym!("AvoidInterruptStun")]).min(100.0));

        let mut effective_enemy_damage = g(output, "totalTakenHit") + g(output, "PhysicalTakenHit") * 0.25;
        // Faithful to upstream (lines 2233-2236): the second branch's condition
        // (`damageCategoryConfig ~= "Melee"`) is checked only when the first (`~= "Average"`) already
        // matched, so `"Melee"` never actually reaches either branch - apparent original quirk, not
        // altered here.
        if damage_category_config != "Average" {
            effective_enemy_damage = effective_enemy_damage * (1.0 + misc("StunNotMeleeDamageMult") * 3.0) / 4.0;
        } else if damage_category_config != "Melee" {
            effective_enemy_damage *= misc("StunNotMeleeDamageMult");
        }
        let base_stun_chance = (misc("StunBaseMult") * effective_enemy_damage / stun_threshold).min(100.0);
        let min_stun_chance_needed = misc("MinStunChanceNeeded");
        let self_stun_chance = (if base_stun_chance > min_stun_chance_needed { base_stun_chance } else { 0.0 }) * not_avoid_chance / 100.0;
        output.insert("SelfStunChance".into(), self_stun_chance);
    }

    /// "Life Recoverable" (Lua lines 2258-2272). `output.LifeUnreserved`/`LifeCancellableReservation`
    /// are permanent cross-module gaps this crate never computes (see "Named gaps" - minion Life/Mana
    /// reservation lives in the calc crate), so they're only correct here when carried through
    /// unmodified from `pre_output`; this function just reads them, same as the Lua reads
    /// `output.LifeUnreserved` as an upstream-computed input.
    pub fn life_recoverable(output: &mut HashMap<String, f64>, store: &ModStore, condition_low_life: bool) {
        let mut life_recoverable = g(output, "LifeUnreserved");
        if condition_low_life {
            let low_life_pct = opt_or(output, "LowLifePercentage", misc("LowPoolThreshold"));
            life_recoverable = (g(output, "Life") * low_life_pct / 100.0).min(g(output, "LifeUnreserved"));
        }
        if store.flag(None, &[pom_engine::sym!("DamageInsteadReservesLife")]) {
            life_recoverable = (g(output, "LifeCancellableReservation") / 100.0) * g(output, "Life");
        }
        output.insert("LifeRecoverable".into(), life_recoverable.max(1.0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pom_engine::modifier::Mod;
    use pom_engine::value::Value;

    #[test]
    fn overwhelm_is_physical_only() {
        let mut enemy = ModStore::new_db(None, None);
        enemy.add_mod(Mod { name: Sym::new("PhysicalOverwhelm"), ty: ModType::Base, value: Value::Num(15.0), flags: 0, keyword_flags: 0, source: None, tags: (vec![]).into() });
        let store = ModStore::new_db(None, None);
        let empty = HashMap::default();
        let mut output = HashMap::default();
        enemy_damage(&mut output, &store, &enemy, &empty, &empty, "Melee", 84.0);
        assert_eq!(output["PhysicalEnemyOverwhelm"], 15.0);
        assert_eq!(output["FireEnemyOverwhelm"], 0.0);
    }
}
