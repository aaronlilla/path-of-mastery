//! Calcs-mode breakdown tables of `calcs.buildDefenceEstimations` (Modules/CalcDefence.lua 1674-3874), first half: enemy
//! damage, damage taken as, taken multipliers, incoming hit multipliers. Same rules as `bd_def`: every function writes the
//! table upstream writes at that line and is a no-op unless `bd::on()`.
use crate::bd_def::{push, put_chain, put_lines};
use pom_offence::bd::{self, ins, num, row, s, set};
use pom_offence::bdbuild::{Chain, Link};
use pom_offence::sf;
use serde_json::{json, Value};

/// `{ label = "...", rowList = { }, colList = { { label = L, key = K }, ... } }`.
pub fn table_with_rows(label: &str, cols: &[(&str, &str)]) -> Value {
    let col_list: Vec<Value> = cols.iter().map(|(l, k)| json!({ "label": l, "key": k })).collect();
    json!({ "label": label, "rowList": [], "colList": col_list })
}

/// `t_insert(breakdown[key].rowList, row)`.
pub fn push_row(key: &str, r: Value) {
    bd::root(|b| {
        let t = bd::t(b, key);
        let rl = bd::t(t, "rowList");
        ins(rl, r);
    });
}

pub fn put_table(key: &str, t: Value) {
    bd::root(|b| set(b, key, t));
}

fn sign(x: f64) -> &'static str {
    if x > 0.0 {
        "+"
    } else if x < 0.0 {
        "-"
    } else {
        ""
    }
}

/// Line 1720: `breakdown["totalEnemyDamage"] = { ... }`.
pub fn total_enemy_damage_init() {
    if !bd::on() {
        return;
    }
    put_table(
        "totalEnemyDamage",
        table_with_rows(
            "Total damage from the enemy",
            &[("Type", "type"), ("Value", "value"), ("Mult", "mult"), ("Crit", "crit"), ("Conversion", "convMult"), ("Final", "final"), ("From", "from")],
        ),
    );
}

/// Lines 1823-1844.
pub fn enemy_damage_type(damage_type: &str, source: &str, enemy_damage: f64, mult: f64, crit_effect: f64, conversion_extra: f64, final_: f64) {
    if !bd::on() {
        return;
    }
    let mut l = vec![sf!("from %s: %d", source, enemy_damage), sf!("* %.2f (modifiers to enemy damage)", mult), sf!("* %.3f (enemy crit effect)", crit_effect)];
    if conversion_extra != 0.0 {
        l.push(sf!("%s %d (enemy damage conversion)", if conversion_extra > 0.0 { "+" } else { "-" }, if conversion_extra >= 0.0 { conversion_extra } else { -conversion_extra }));
    }
    l.push(sf!("= %d", final_));
    put_lines(&format!("{damage_type}EnemyDamage"), l);
    push_row(
        "totalEnemyDamage",
        row(vec![
            ("type", s(damage_type)),
            ("value", s(sf!("%d", enemy_damage))),
            ("mult", s(sf!("%.2f", mult))),
            ("crit", s(sf!("%.2f", crit_effect))),
            ("convMult", s(sf!("%s%d", sign(conversion_extra), if conversion_extra >= 0.0 { conversion_extra } else { -conversion_extra }))),
            ("final", s(sf!("%d", final_))),
            ("from", s(source)),
        ]),
    );
}

/// Lines 1871-1886: `breakdown[type.."TakenDamage"]` for the same-type part.
pub fn taken_damage_same(damage_type: &str, value: f64) {
    if !bd::on() {
        return;
    }
    put_table(&format!("{damage_type}TakenDamage"), table_with_rows("Taken", &[("Type", "type"), ("Value", "value")]));
    push_row(&format!("{damage_type}TakenDamage"), row(vec![("type", s(damage_type)), ("value", s(sf!("%d", value)))]));
}

/// Lines 1892-1897.
pub fn taken_damage_converted(converted_type: &str, from_type: &str, damage: f64) {
    if !bd::on() || damage <= 0.0 {
        return;
    }
    push_row(&format!("{converted_type}TakenDamage"), row(vec![("type", s(from_type)), ("value", s(sf!("%d", damage)))]));
}

/// Lines 1903-1920: the `totalTakenDamage` table, filled from the per-type `TakenDamage` outputs.
pub fn total_taken_damage(values: &[(&str, f64)]) {
    if !bd::on() {
        return;
    }
    put_table("totalTakenDamage", table_with_rows("Total damage taken from the enemy after taken as", &[("Type", "type"), ("Value", "value")]));
    for (t, v) in values {
        push_row("totalTakenDamage", row(vec![("type", s(*t)), ("value", s(sf!("%d", *v)))]));
    }
}

/// Lines 1972-1983.
pub fn taken_dot_mult(damage_type: &str, resist: f64, reduction: f64, taken_inc: f64, taken_more: f64, result: f64) {
    if !bd::on() {
        return;
    }
    let mut c = Chain::new();
    c.label = Some("DoT Multiplier:".into());
    c.links = vec![
        Link::n("%.2f ^8(resistance)", 1.0 - resist / 100.0),
        Link::ns("%.2f ^8(%s damage reduction)", 1.0 - reduction / 100.0, &damage_type.to_lowercase()),
        Link::n("%.2f ^8(increased/reduced damage taken)", 1.0 + taken_inc / 100.0),
        Link::n("%.2f ^8(more/less damage taken)", taken_more),
    ];
    c.total = Some(sf!("= %.2f", result));
    put_chain(&format!("{damage_type}TakenDotMult"), &c);
}

/// Line 1989: `breakdown["totalTakenHit"] = { ... }`.
pub fn total_taken_hit_init() {
    if !bd::on() {
        return;
    }
    put_table(
        "totalTakenHit",
        table_with_rows("Total damage taken after mitigation", &[("Type", "type"), ("Incoming", "incoming"), ("Mult", "mult"), ("Value", "value")]),
    );
}

pub struct HitMult {
    pub damage_type: &'static str,
    pub damage: f64,
    pub resist: f64,
    pub reduction: f64,
    pub enemy_pen: f64,
    pub enemy_overwhelm: f64,
    pub armour_reduct: f64,
    pub percent_of_armour_applies: f64,
    pub physical_reduction_based_on_ward: bool,
    pub res_mult: f64,
    pub reduct_mult: f64,
    pub base_mult: f64,
    pub taken_flat: f64,
    pub taken_mult: f64,
    pub spell_suppress_mult: f64,
    pub impale_damage: f64,
    pub final_hit_mult: f64,
}

/// Lines 2043-2065 and 2091-2150 (the `AnyTakenReflect` tables never exist: the flag is always false).
pub fn incoming_hit(h: &HitMult) {
    if !bd::on() {
        return;
    }
    let dt = h.damage_type;
    let key = format!("{dt}DamageReduction");
    let mut l: Vec<String> = vec![];
    if h.armour_reduct != 0.0 {
        if h.res_mult != 1.0 {
            l.push(sf!("Enemy Hit Damage After Resistance: %d ^8(total incoming damage)", h.damage * h.res_mult));
        } else {
            l.push(sf!("Enemy Hit Damage: %d ^8(total incoming damage)", h.damage));
        }
        if h.percent_of_armour_applies != 100.0 && !h.physical_reduction_based_on_ward {
            l.push(sf!("%d%% percent of armour applies", h.percent_of_armour_applies));
        }
        l.push(sf!("Reduction from Armour: %d%%", h.armour_reduct));
    }
    if h.reduction != 0.0 {
        l.push(sf!("Base %s Damage Reduction: %d%%", dt, h.reduction));
    }
    if h.enemy_overwhelm != 0.0 {
        l.push(sf!("Enemy Overwhelm %s Damage: %d%%", dt, h.enemy_overwhelm));
    }
    if (h.armour_reduct != 0.0) as i32 + (h.reduction != 0.0) as i32 + (h.enemy_overwhelm != 0.0) as i32 >= 2 {
        l.push(sf!("Total %s Damage Reduction: %d%%", dt, 100.0 - h.reduct_mult * 100.0));
    }
    put_lines(&key, l);

    let key = format!("{dt}TakenHitMult");
    let mut l: Vec<String> = vec![];
    if h.resist != 0.0 {
        l.push(sf!("Resistance: %.2f", 1.0 - h.resist / 100.0));
    }
    if h.enemy_pen != 0.0 {
        l.push(sf!("+ Enemy Pen: %.2f", h.enemy_pen / 100.0));
    }
    if h.resist != 0.0 && h.enemy_pen != 0.0 {
        l.push(sf!("= %.2f", h.res_mult));
    }
    if h.reduction != 0.0 {
        l.push(sf!("Base %s Damage Taken: %.2f", dt, 1.0 - h.reduction / 100.0));
    }
    if h.armour_reduct != 0.0 {
        if h.res_mult != 1.0 {
            l.push(sf!("Enemy Hit Damage After Resistance: %d ^8(total incoming damage)", h.damage * h.res_mult));
        } else {
            l.push(sf!("Enemy Hit Damage: %d ^8(total incoming damage)", h.damage));
        }
        if h.percent_of_armour_applies != 100.0 && !h.physical_reduction_based_on_ward {
            l.push(sf!("%d%% percent of armour applies", h.percent_of_armour_applies));
        }
        l.push(sf!("Reduction from Armour: %.2f", 1.0 - h.armour_reduct / 100.0));
    }
    if h.enemy_overwhelm != 0.0 {
        l.push(sf!("+ Enemy Overwhelm %s Damage: %.2f", dt, h.enemy_overwhelm / 100.0));
    }
    if h.reduction != 0.0 || h.armour_reduct != 0.0 || h.enemy_overwhelm != 0.0 {
        l.push(sf!("= %.2f", h.reduct_mult));
    }
    if h.res_mult != 1.0 && h.reduct_mult != 1.0 {
        l.push(sf!("%.2f x %.2f = %.3f", h.res_mult, h.reduct_mult, h.base_mult));
    }
    if h.taken_flat != 0.0 {
        l.push(sf!("+ Flat: %d", h.taken_flat));
    }
    if h.taken_mult != 1.0 {
        l.push(sf!("x Taken: %.3f", h.taken_mult));
    }
    if h.spell_suppress_mult != 1.0 {
        l.push(sf!("x Spell Suppression: %.3f", h.spell_suppress_mult));
    }
    if h.impale_damage != 0.0 {
        l.push(sf!("+ Impale: %.1f", h.impale_damage));
    }
    if h.taken_mult != 1.0 || h.taken_flat != 0.0 || h.spell_suppress_mult != 1.0 || h.impale_damage != 0.0 {
        l.push(sf!("= %.3f", h.final_hit_mult));
    }
    put_lines(&key, l);
    let _ = (num(0.0), &push);
}
