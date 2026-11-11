//! `CalcOffence.lua`'s skill-geometry / duration / warcry-default sections, for every main skill
//! (attack or not - none of these read the per-hand weapon pass): chain/projectile/split/fork/
//! pierce counts (1064-1152), melee weapon range + strike targets (1153-1183), `calcAreaOfEffect`
//! (388-460), `StoredUses` (1333-1336), the `Totem`/`Reserve`/`SoulGainPrevention` durations
//! (1592-1637) and the `OffensiveWarcryEffect` family defaults (2618-2624).
//!
//! Numbers only go into `env.output`; the four `...String` keys that can hold real text
//! ("Cannot chain", "All targets", ...) go into `env.output_str`.
//!
//! Not modelled (left unproduced, never guessed): the per-warcry exert-uptime loop
//! (2626-2812) needs the attack pass's `Speed`, which the pipeline does not produce for attacks,
//! so when a relevant exerting warcry is active the warcry keys are skipped entirely.
use crate::Env;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::{Cfg, ScalarValue};
use pom_engine::sym::Sym;
use pom_skills::assemble::ComputedSkill;
use pom_skills::skill_type;
use pom_engine::fxhash::HashMap;

struct Q<'a> {
    m: &'a ModStore,
    cfg: &'a Cfg,
}
impl Q<'_> {
    fn sum(&self, names: &[&str]) -> f64 {
        let s: Vec<Sym> = names.iter().map(|n| Sym::new(n)).collect();
        self.m.sum(ModType::Base, Some(self.cfg), &s)
    }
    fn more(&self, name: &str) -> f64 {
        self.m.more(Some(self.cfg), &[Sym::new(name)])
    }
    fn flag(&self, name: &str) -> bool {
        self.m.flag(Some(self.cfg), &[Sym::new(name)])
    }
    fn mod_(&self, names: &[&str]) -> f64 {
        pom_offence::tools::calc_lib_mod(self.m, Some(self.cfg), names)
    }
}

fn sd_num(m: &HashMap<String, ScalarValue>, k: &str) -> Option<f64> {
    match m.get(k) {
        Some(ScalarValue::Num(n)) => Some(*n),
        _ => None,
    }
}

/// `calcAreaOfEffect` (CalcOffence.lua:388-). `weapon_range` is `(range1, range2)` for
/// `skillData.radiusIsWeaponRange`.
fn calc_area_of_effect(env: &mut Env, q: &Q, sd: &HashMap<String, ScalarValue>, flags: &pom_engine::fxhash::HashSet<String>, weapon_range: (Option<f64>, Option<f64>)) {
    let (inc, more) = pom_offence::tools::calc_lib_mods_s(q.m, Some(q.cfg), &[pom_engine::sym!("AreaOfEffect"), pom_engine::sym!("AreaOfEffectPrimary")]);
    let area_mod = pom_offence::area::calc_area_mod(inc, more);
    env.output.insert("AreaOfEffectMod".into(), area_mod);
    let radius_mod = q.mod_(&["AreaOfEffectRadius"]);
    if pom_offence::bd::on() {
        bd_area_mod(q, area_mod);
    }
    let mut radius = sd_num(sd, "radius");
    if matches!(sd.get("radiusIsWeaponRange"), Some(ScalarValue::Bool(true))) {
        let mut range = 0f64;
        if flags.contains("weapon1Attack") {
            range = range.max(weapon_range.0.unwrap_or(0.0));
        }
        if flags.contains("weapon2Attack") {
            range = range.max(weapon_range.1.unwrap_or(0.0));
        }
        radius = Some(range + 2.0);
    }
    let Some(radius) = radius else { return };
    let extra = sd_num(sd, "radiusExtra").unwrap_or(0.0);
    let base = radius + extra + q.sum(&["AreaOfEffect"]);
    let r = pom_offence::area::calc_radius(base, area_mod, Some(radius_mod));
    env.output.insert("AreaOfEffectRadius".into(), r);
    env.output.insert("AreaOfEffectRadiusMetres".into(), r / 10.0);
    if pom_offence::bd::on() {
        let bp = pom_offence::area::calc_radius_breakpoints(base, inc, more, Some(radius_mod));
        bd_area_set("AreaOfEffectRadius", base, area_mod, r, bp, sd_str(sd, "radiusLabel"), radius_mod);
    }
    if let Some(sec) = sd_num(sd, "radiusSecondary") {
        let (inc, more) = pom_offence::tools::calc_lib_mods_s(q.m, Some(q.cfg), &[pom_engine::sym!("AreaOfEffect"), pom_engine::sym!("AreaOfEffectSecondary")]);
        let am = pom_offence::area::calc_area_mod(inc, more);
        env.output.insert("AreaOfEffectModSecondary".into(), am);
        let r = pom_offence::area::calc_radius(sec + extra, am, Some(radius_mod));
        env.output.insert("AreaOfEffectRadiusSecondary".into(), r);
        env.output.insert("AreaOfEffectRadiusSecondaryMetres".into(), r / 10.0);
        if pom_offence::bd::on() {
            let bp = if sd.get("projectileSpeedAppliesToMSAreaOfEffect").map_or(true, |v| !v.truthy()) { pom_offence::area::calc_radius_breakpoints(sec + extra, inc, more, Some(radius_mod)) } else { None };
            bd_area_set("AreaOfEffectRadiusSecondary", sec + extra, am, r, bp, sd_str(sd, "radiusSecondaryLabel"), radius_mod);
        }
    }
    if let Some(ter) = sd_num(sd, "radiusTertiary") {
        if let (None, Some(margin_pct)) = (sd.get("projectileSpeedAppliesToMSAreaOfEffect"), sd_num(sd, "radiusTertiaryBaseMargin")) {
            // Explosive Trap's "smaller explosions have between 30% reduced and 30% increased base radius at random" (CalcOffence.lua:432-447).
            let (inc, more) = pom_offence::tools::calc_lib_mods_s(q.m, Some(q.cfg), &[pom_engine::sym!("AreaOfEffect"), pom_engine::sym!("AreaOfEffectTertiary")]);
            let am = pom_offence::area::calc_area_mod(inc, more);
            env.output.insert("AreaOfEffectModTertiary".into(), am);
            let occ = tertiary_occurrences(ter + extra, margin_pct, am, radius_mod);
            let sum: f64 = occ.iter().map(|(r, n)| r * n).sum();
            env.tertiary_occ = occ.clone();
            for (rad, n) in &occ {
                env.output.insert(format!("AreaOfEffectRadiusTertiaryOccurrences.{}", *rad as i64), *n);
            }
            let r = sum / (margin_pct * 2.0 + 1.0);
            env.output.insert("AreaOfEffectRadiusTertiary".into(), r);
            env.output.insert("AreaOfEffectRadiusTertiaryMetres".into(), r / 10.0);
            if pom_offence::bd::on() {
                bd_tertiary_margin(ter + extra, margin_pct, inc, more, am, radius_mod, r, sd_str(sd, "radiusTertiaryLabel"));
            }
        } else if sd.get("projectileSpeedAppliesToMSAreaOfEffect").is_some() {
            // Molten Strike (CalcOffence.lua:185-191, 414-420): the tertiary (ball travel) radius scales with projectile speed.
            let (inc, more) = pom_offence::tools::calc_lib_mods_s(q.m, Some(q.cfg), &[pom_engine::sym!("AreaOfEffect"), pom_engine::sym!("AreaOfEffectTertiary")]);
            let am = pom_offence::area::calc_area_mod(inc, more);
            env.output.insert("AreaOfEffectModTertiary".into(), am);
            let (inc_spd, more_spd) = pom_offence::tools::calc_lib_mods_s(q.m, Some(q.cfg), &[pom_engine::sym!("ProjectileSpeed")]);
            let lua_round = |v: f64, dec: i32| (v * 10f64.powi(dec) + 0.5).floor() / 10f64.powi(dec);
            let speed_mod = lua_round(lua_round(inc_spd * more_spd, 10), 2);
            env.output.insert("SpeedModTertiary".into(), speed_mod);
            let base_radius = ter + extra;
            let deadzone = sd_num(sd, "radiusSecondary").unwrap_or(0.0);
            let max_dist_ignoring_speed = (base_radius * base_radius * am - deadzone * deadzone * (am - 1.0)).sqrt();
            let r = ((max_dist_ignoring_speed - deadzone) * speed_mod + deadzone).floor();
            env.output.insert("AreaOfEffectRadiusTertiary".into(), r);
            env.output.insert("AreaOfEffectRadiusTertiaryMetres".into(), r / 10.0);
            if pom_offence::bd::on() {
                bd_molten_strike(deadzone, base_radius, sd_str(sd, "radiusTertiaryLabel"), inc, more, inc_spd, more_spd);
            }
        } else if sd.get("projectileSpeedAppliesToMSAreaOfEffect").is_none() {
            let (inc, more) = pom_offence::tools::calc_lib_mods_s(q.m, Some(q.cfg), &[pom_engine::sym!("AreaOfEffect"), pom_engine::sym!("AreaOfEffectTertiary")]);
            let am = pom_offence::area::calc_area_mod(inc, more);
            env.output.insert("AreaOfEffectModTertiary".into(), am);
            let r = pom_offence::area::calc_radius(ter + extra, am, Some(radius_mod));
            env.output.insert("AreaOfEffectRadiusTertiary".into(), r);
            env.output.insert("AreaOfEffectRadiusTertiaryMetres".into(), r / 10.0);
            if pom_offence::bd::on() {
                let bp = pom_offence::area::calc_radius_breakpoints(ter + extra, inc, more, Some(radius_mod));
                bd_area_set("AreaOfEffectRadiusTertiary", ter + extra, am, r, bp, sd_str(sd, "radiusTertiaryLabel"), radius_mod);
            }
        }
    }
}

fn sd_str(m: &HashMap<String, ScalarValue>, k: &str) -> Option<String> {
    match m.get(k) {
        Some(ScalarValue::Str(s)) => Some(s.to_string()),
        _ => None,
    }
}

/// `breakdown.AreaOfEffectRadius[Secondary|Tertiary] = breakdown.area(...)` (CalcOffence.lua:395, 408, 476). A nil label
/// makes `t_insert(out, nil)` a no-op, so the list then starts at the next line.
fn bd_area_set(key: &str, base: f64, area_mod: f64, total: f64, bp: Option<(f64, f64, f64, f64)>, label: Option<String>, radius_mod: f64) {
    use pom_offence::bd;
    let mut out = pom_offence::bdbuild::area(base, area_mod, total, bp, label.as_deref().unwrap_or(""), Some(radius_mod));
    if label.is_none() {
        if let serde_json::Value::Object(m) = &mut out {
            let mut n = 1usize;
            m.shift_remove("1");
            while let Some(v) = m.shift_remove(&(n + 1).to_string()) {
                m.insert(n.to_string(), v);
                n += 1;
            }
        }
    }
    bd::root(|b| bd::set(b, key, out));
}

/// CalcOffence.lua:482-491: `breakdown.AreaOfEffectMod`.
fn bd_area_mod(q: &Q, area_mod: f64) {
    use pom_offence::{bd, bdbuild};
    let mut out = serde_json::Value::Array(vec![]);
    if area_mod != 1.0 {
        let mut c = bdbuild::Chain::new();
        c.links = vec![
            bdbuild::Link::n("%.2f ^8(increased/reduced)", 1.0 + q.m.sum(ModType::Inc, Some(q.cfg), &[pom_engine::sym!("AreaOfEffect")]) / 100.0),
            bdbuild::Link::n("%.2f ^8(more/less)", q.more("AreaOfEffect")),
        ];
        c.total = Some(pom_offence::sf!("= %.2f", area_mod));
        bdbuild::multi_chain(&mut out, &c);
    }
    bd::root(|b| bd::set(b, "AreaOfEffectMod", out));
}

/// Explosive Trap's random base radius breakdown (CalcOffence.lua:446-471).
#[allow(clippy::too_many_arguments)]
fn bd_tertiary_margin(base_radius: f64, margin_pct: f64, inc: f64, more: f64, area_mod: f64, radius_mod: f64, avg: f64, label: Option<String>) {
    use pom_offence::{bd, sf};
    let margin_width = margin_pct * 2.0 + 1.0;
    let mut out = serde_json::Value::Array(vec![]);
    let (mut inc_bp, mut more_bp, mut red_bp, mut less_bp) = (f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::INFINITY);
    if let Some(l) = label {
        bd::ins_s(&mut out, l);
    }
    bd::ins_s(&mut out, sf!("R ^8(base radius)^7 x %.2f ^8(square root of area of effect modifier)", (100.0 * area_mod.sqrt()).floor() / 100.0));
    if radius_mod != 1.0 {
        bd::ins_s(&mut out, sf!("x %.2f ^8(final radius modifier)", radius_mod));
    }
    let mut base_occ = tertiary_base_occ(base_radius, margin_pct);
    base_occ.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    for (adj, n) in &base_occ {
        let rad = pom_offence::area::calc_radius(*adj, area_mod, Some(radius_mod));
        bd::ins_s(&mut out, sf!("%.1f%% ^8chance of^7 %.1fm ^8base radius resulting in^7 %.1fm ^8final radius", n / margin_width * 100.0, adj / 10.0, rad / 10.0));
        if let Some((i, m, r, l)) = pom_offence::area::calc_radius_breakpoints(*adj, inc, more, Some(radius_mod)) {
            inc_bp = inc_bp.min(i);
            more_bp = more_bp.min(m);
            red_bp = red_bp.min(r);
            less_bp = less_bp.min(l);
        }
    }
    bd::ins_s(&mut out, sf!("^8Next closest 0.1m breakpoint: %d%% increased AoE / a %d%% more AoE multiplier", inc_bp, more_bp));
    bd::ins_s(&mut out, sf!("^8Previous closest 0.1m breakpoint: %d%% reduced AoE / a %d%% less AoE multiplier", red_bp, less_bp));
    bd::ins_s(&mut out, sf!("On average, the radius is %.2fm", avg / 10.0));
    bd::root(|b| bd::set(b, "AreaOfEffectRadiusTertiary", out));
}

/// `setMoltenStrikeTertiaryRadiusBreakdown` (CalcOffence.lua:235-294).
fn bd_molten_strike(deadzone: f64, base_radius: f64, label: Option<String>, inc_area: f64, more_area: f64, inc_spd: f64, more_spd: f64) {
    use pom_offence::{bd, sf};
    let calc = |a: [f64; 4]| -> (f64, f64, f64) {
        let area_mod = bd::round(bd::round((inc_area + a[0] / 100.0) * more_area * (1.0 + a[1] / 100.0), 10), 2);
        let speed_mod = bd::round(bd::round((inc_spd + a[2] / 100.0) * more_spd * (1.0 + a[3] / 100.0), 10), 2);
        let max_dist_ignoring_speed = (base_radius * base_radius * area_mod - deadzone * deadzone * (area_mod - 1.0)).sqrt();
        ((((max_dist_ignoring_speed - deadzone) * speed_mod + deadzone).floor()), area_mod, speed_mod)
    };
    let (cur, cur_area, cur_speed) = calc([0.0; 4]);
    bd::root(|b| {
        let r = bd::t(b, "AreaOfEffectRadiusTertiary");
        if let Some(l) = &label {
            bd::ins_s(r, l.clone());
        }
        bd::ins_s(r, " = (sqrt(R*R*a - r*r*(a-1)) - r) * s + r");
        bd::ins_s(r, sf!(" = %d", cur));
        if cur > 0.0 {
            let find = |sign: f64, idx: usize| -> f64 {
                let mut args = [0.0f64; 4];
                let mut n = 0;
                loop {
                    args[idx] += sign;
                    let d = calc(args).0;
                    n += 1;
                    if d != cur || d == 0.0 || n > 1_000_000 {
                        return args[idx] * sign;
                    }
                }
            };
            bd::ins_s(r, sf!("^8Next AoE breakpoint: %d%% increased or %d%% more", find(1.0, 0), find(1.0, 1)));
            bd::ins_s(r, sf!("^8Next Proj. Speed breakpoint: %d%% increased or %d%% more", find(1.0, 2), find(1.0, 3)));
            bd::ins_s(r, sf!("^8Previous AoE breakpoint: %d%% increased or %d%% more", find(-1.0, 0), find(-1.0, 1)));
            bd::ins_s(r, sf!("^8Previous Proj. Speed breakpoint: %d%% increased or %d%% more", find(-1.0, 2), find(-1.0, 3)));
        }
        bd::set(r, "label", bd::s("Inputs"));
        let rows = bd::reset(r, "rowList");
        let row = |name: &str, value: String, desc: &str| bd::row(vec![("name", bd::s(name)), ("value", bd::s(value)), ("description", bd::s(desc))]);
        bd::ins(rows, row("r", sf!("%d", deadzone), "fixed deadzone radius"));
        bd::ins(rows, row("R", sf!("%d", base_radius), "base outer radius"));
        bd::ins(rows, row("a", sf!("%.2f", cur_area), "net AoE multiplier (scales area)"));
        bd::ins(rows, row("s", sf!("%.2f", cur_speed), "net projectile speed multiplier (scales range)"));
        let cols = bd::reset(r, "colList");
        for (l, k) in [("Variable", "name"), ("Value", "value"), ("Description", "description")] {
            bd::ins(cols, bd::row(vec![("label", bd::s(l)), ("key", bd::s(k))]));
        }
        bd::set(r, "radius", bd::num(cur));
    });
}

/// Re-run `calcAreaOfEffect` after a mod was added to the skill's own mod list (CalcOffence.lua:2802,
/// Seismic Cry / Fist of War).
pub fn recalc_area(env: &mut Env, main: &ComputedSkill, sml: &ModStore, cfg: &Cfg, sd: &HashMap<String, ScalarValue>) {
    let q = Q { m: sml, cfg };
    let ranges = weapon_ranges(env, &q, &main.skill_flags);
    calc_area_of_effect(env, &q, sd, &main.skill_flags, ranges);
}

/// `output.AreaOfEffectRadiusTertiaryOccurrences` (CalcOffence.lua:432-445): `(final radius, occurrence count)`
/// for every possible base radius `floor(baseRadius * deviation)`, deviation in `1 +- margin` by 0.01 (a Lua float `for`).
pub fn tertiary_occurrences(base_radius: f64, margin_pct: f64, area_mod: f64, radius_mod: f64) -> Vec<(f64, f64)> {
    let base_occ = tertiary_base_occ(base_radius, margin_pct);
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (b, n) in base_occ {
        let r = pom_offence::area::calc_radius(b, area_mod, Some(radius_mod));
        match out.iter_mut().find(|(x, _)| *x == r) {
            Some(e) => e.1 += n,
            None => out.push((r, n)),
        }
    }
    out
}

/// `baseRadiiOccurrences` (CalcOffence.lua:432-437): `(floor(baseRadius * deviation), count)`.
fn tertiary_base_occ(base_radius: f64, margin_pct: f64) -> Vec<(f64, f64)> {
    let margin = margin_pct / 100.0;
    let mut base_occ: Vec<(f64, f64)> = Vec::new();
    let mut d = 1.0 - margin;
    while d <= 1.0 + margin + 0.01 {
        let r = (base_radius * d).floor();
        match base_occ.iter_mut().find(|(b, _)| *b == r) {
            Some(e) => e.1 += 1.0,
            None => base_occ.push((r, 1.0)),
        }
        d += 0.01;
    }
    base_occ
}

/// `weaponData1/2.range` -> `actor.weaponRange1/2` (CalcOffence.lua:1153-1158).
fn weapon_ranges(env: &Env, q: &Q, flags: &pom_engine::fxhash::HashSet<String>) -> (Option<f64>, Option<f64>) {
    let unarmed = 6.0 + q.sum(&["UnarmedRange"]) + 10.0 * q.sum(&["UnarmedRangeMetre"]);
    let one = |slot: &str, on: bool| -> Option<f64> {
        if !on {
            return None;
        }
        Some(match env.weapon_range.get(slot) {
            Some(r) => r + q.sum(&["MeleeWeaponRange"]) + 10.0 * q.sum(&["MeleeWeaponRangeMetre"]),
            None => unarmed,
        })
    };
    (one("Weapon 1", flags.contains("weapon1Attack")), one("Weapon 2", flags.contains("weapon2Attack")))
}

pub fn skill_geometry(env: &mut Env, main: &ComputedSkill, sml: &ModStore, cfg: &Cfg, sd: &HashMap<String, ScalarValue>) {
    let q = Q { m: sml, cfg };
    let flags = &main.skill_flags;
    let has = |f: &str| flags.contains(f);

    // "set other limits" (CalcOffence.lua:561-562), unconditional.
    env.output.insert("ActiveTrapLimit".into(), q.sum(&["ActiveTrapLimit"]));
    env.output.insert("ActiveMineLimit".into(), q.sum(&["ActiveMineLimit"]));

    // "Calculate skill type stats", minion branch (CalcOffence.lua:1055-1064).
    if let Some(limit) = env.minion_limit.clone() {
        if !limit.is_empty() {
            let val = |name: &str| {
                let base = q.sum(&[name]);
                if base != 0.0 { base * (1.0 + q.m.sum(ModType::Inc, Some(q.cfg), &[Sym::new(name)]) / 100.0) * q.more(name) } else { 0.0 }
            };
            let v = env.player.override_(None, &[Sym::new(&limit)]).and_then(|v| v.num()).unwrap_or_else(|| val(&limit) * q.more("ActiveMinionLimit"));
            env.output.insert("ActiveMinionLimit".into(), v.floor());
        }
        let per_cast = {
            let base = q.sum(&["MinionPerCastCount"]);
            let v = if base != 0.0 { base * (1.0 + q.m.sum(ModType::Inc, Some(q.cfg), &[pom_engine::sym!("MinionPerCastCount")]) / 100.0) * q.more("MinionPerCastCount") } else { 0.0 };
            v.floor()
        };
        env.output.insert("SummonedMinionsPerCast".into(), if per_cast == 0.0 { 1.0 } else { per_cast });
    }
    if has("chaining") {
        if q.flag("CannotChain") || q.flag("NoAdditionalChains") {
            env.output_str.insert("ChainMaxString".into(), "Cannot chain".into());
        } else {
            let mut names = vec!["ChainCountMax"];
            if !has("projectile") {
                names.push("BeamChainCountMax");
            }
            let mut cm = q.sum(&names);
            if q.flag("AdditionalProjectilesAddChainsInstead") {
                let pc = if q.flag("SingleProjectile") { 0.0 } else { ((q.sum(&["ProjectileCount"]) - 1.0) * q.more("ProjectileCount")).floor() };
                cm += pc;
            }
            cm *= q.more("ChainCountMax");
            let chain = cm.min(q.sum(&["ChainCount"]));
            env.output.insert("ChainMax".into(), cm);
            env.output.insert("ChainMaxString".into(), cm);
            env.output.insert("Chain".into(), chain);
            env.output.insert("ChainRemaining".into(), (cm - chain).max(0.0));
        }
    }
    if has("projectile") {
        if q.flag("NoAdditionalProjectiles") || q.flag("SingleProjectile") {
            env.output.insert("ProjectileCount".into(), 1.0);
        } else {
            let pmin = q.sum(&["ProjectileCountMinimum"]);
            let pmax = sml.override_(Some(cfg), &[pom_engine::sym!("ProjectileCountMaximum")]).and_then(|v| v.num()).unwrap_or(f64::INFINITY);
            let proj = (q.sum(&["ProjectileCount"]) * q.more("ProjectileCount")).floor();
            env.output.insert("ProjectileCount".into(), proj.min(pmax).max(pmin));
        }
        if q.flag("AdditionalProjectilesAddBouncesInstead") {
            let base = if q.flag("SingleProjectile") { 0.0 } else { q.sum(&["ProjectileCount"]) + q.sum(&["BounceCount"]) - 1.0 };
            env.output.insert("BounceCount".into(), (base * q.more("ProjectileCount")).floor());
        }
        let self_split = env.enemy.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("SelfSplitCount")]);
        if q.flag("CannotSplit") || main.skill_types.contains(&skill_type::PROJECTILE_NUMBER) {
            // Breakdown-gated in upstream; the reference keys were recorded with breakdown on.
            if q.sum(&["SplitCount"]) + self_split > 0.0 {
                env.output_str.insert("SplitCountString".into(), "Cannot split".into());
            }
        } else {
            let mut sc = q.sum(&["SplitCount"]) + self_split;
            if q.flag("AdditionalProjectilesAddSplitsInstead") {
                sc += if q.flag("SingleProjectile") { 0.0 } else { ((q.sum(&["ProjectileCount"]) - 1.0) * q.more("ProjectileCount")).floor() };
            }
            if q.flag("AdditionalChainsAddSplitsInstead") {
                sc += q.sum(&["ChainCountMax"]);
            }
            env.output.insert("SplitCount".into(), sc);
            env.output.insert("SplitCountString".into(), sc);
        }
        if q.flag("CannotFork") {
            env.output_str.insert("ForkCountString".into(), "Cannot fork".into());
        } else if q.flag("ForkOnce") {
            let cap = if q.flag("ForkTwice") { 2.0 } else { 1.0 };
            let fm = q.sum(&["ForkCountMax"]).min(cap);
            let forked = fm.min(q.sum(&["ForkedCount"]));
            env.output.insert("ForkCountMax".into(), fm);
            env.output.insert("ForkedCount".into(), forked);
            env.output.insert("ForkCountString".into(), fm);
            env.output.insert("ForkRemaining".into(), (fm - forked).max(0.0));
        } else {
            env.output_str.insert("ForkCountString".into(), "0".into());
        }
        if q.flag("CannotPierce") {
            env.output.insert("PierceCount".into(), 0.0);
            env.output_str.insert("PierceCountString".into(), "Cannot pierce".into());
        } else {
            let pc;
            if q.flag("PierceAllTargets") || env.enemy.flag(None, &[pom_engine::sym!("AlwaysPierceSelf")]) {
                pc = 100.0;
                env.output_str.insert("PierceCountString".into(), "All targets".into());
            } else {
                pc = q.sum(&["PierceCount"]);
                env.output.insert("PierceCountString".into(), pc);
            }
            env.output.insert("PierceCount".into(), pc);
            env.output.insert("PiercedCount".into(), pc.min(q.sum(&["PiercedCount"])));
        }
        env.output.insert("ProjectileSpeedMod".into(), q.mod_(&["ProjectileSpeed"]));
    }

    let ranges = weapon_ranges(env, &q, flags);
    if has("melee") && main.skill_types.contains(&skill_type::MELEE_SINGLE_TARGET) {
        let mut range = 100f64;
        if has("weapon1Attack") {
            range = range.min(ranges.0.unwrap_or(f64::INFINITY));
        }
        if has("weapon2Attack") {
            range = range.min(ranges.1.unwrap_or(f64::INFINITY));
        }
        env.output.insert("WeaponRange".into(), range + 2.0);
        env.output.insert("WeaponRangeMetre".into(), (range + 2.0) / 10.0);
        env.output.insert("StrikeTargets".into(), 1.0 + q.sum(&["AdditionalStrikeTarget"]));
    }
    if has("area") || sd.contains_key("radius") || (has("mine") && main.skill_types.contains(&skill_type::AURA)) {
        calc_area_of_effect(env, &q, sd, flags, ranges);
    }

    if let Some(base) = sd_num(sd, "storedUses") {
        env.output.insert("StoredUses".into(), base + q.sum(&["AdditionalCooldownUses", "AdditionalUses"]));
    }

    // Skill durations (1592-1637). `ServerTickRate` per `data.misc`.
    let tick = pom_offence::data::misc("ServerTickRate");
    let ceil_tick = |v: f64| (v * tick).ceil() / tick;
    let dur_mod = |extra: &[&str]| -> f64 { q.mod_(extra).max(0.0) };
    let base = sd_num(sd, "reserveDuration").unwrap_or(0.0);
    if base > 0.0 {
        env.output.insert("ReserveDuration".into(), ceil_tick(base * dur_mod(&["Duration"])));
    }
    let base = sd_num(sd, "soulPreventionDuration").unwrap_or(0.0);
    if base > 0.0 {
        let mut names = vec!["SoulGainPreventionDuration"];
        if sd.contains_key("skillEffectAppliesToSoulGainPrevention") {
            names.push("Duration");
        }
        if sd.contains_key("mineDurationAppliesToSkill") {
            names.push("MineDuration");
        }
        env.output.insert("SoulGainPreventionDuration".into(), ((base * dur_mod(&names) * tick).ceil().max(1.0)) / tick);
    }
    let tdm = dur_mod(&["TotemDuration"]);
    env.output.insert("TotemDurationMod".into(), tdm);
    env.output.insert("TotemDuration".into(), ceil_tick(q.sum(&["TotemDuration"]) * tdm));
}

/// Names of the exerting warcries the uptime loop (CalcOffence.lua:2629-2812) reacts to, with the
/// main-skill type each one requires (`None` = any).
fn relevant_cry(name: &str, main: &ComputedSkill) -> bool {
    let t = |ty: i64| main.skill_types.contains(&ty);
    match name {
        "Ancestral Cry" => t(skill_type::MELEE_SINGLE_TARGET),
        "Infernal Cry" | "Battlemage's Cry" => true,
        "Intimidating Cry" | "Rallying Cry" => t(skill_type::MELEE),
        "Seismic Cry" => t(skill_type::SLAM),
        _ => false,
    }
}

/// The warcry / Fist of War outputs (CalcOffence.lua:2618-2624, 2626-2857, 2978-3031) for the
/// case where no exerting warcry (and no Fist of War slam) is in play - then every ratio is 0 and
/// every effect is 1. When one is in play its value needs the skill's `Speed` (attack pass), so the
/// keys are left unproduced instead.
pub fn warcry_outputs(env: &mut Env, main: &ComputedSkill, skills: &[ComputedSkill], sml: &ModStore, cfg: &Cfg) {
    let q = Q { m: sml, cfg };
    let t = |ty: i64| main.skill_types.contains(&ty);
    let cry_gate = !t(skill_type::NEVER_EXERTABLE) && !t(skill_type::TRIGGERED) && !t(skill_type::CHANNEL) && !t(skill_type::OTHER_THING_USES_SKILL) && !t(skill_type::RETALIATION) && !t(skill_type::SUMMONS_TOTEM);
    let cry_active = cry_gate && skills.iter().any(|s| !s.skill_flags.contains("disable") && relevant_cry(&s.name, main));
    // mode_combat (the default): Fist of War.
    let fow_cd = q.sum(&["FistOfWarCooldown"]);
    env.output.insert("FistOfWarCooldown".into(), fow_cd);
    let fow_active = fow_cd != 0.0 && t(skill_type::SLAM) && !t(skill_type::VAAL) && !t(skill_type::OTHER_THING_USES_SKILL);
    if cry_active || fow_active {
        return;
    }
    env.output.insert("FistOfWarDamageEffect".into(), 1.0);
    for k in ["OffensiveWarcryEffect", "MaxOffensiveWarcryEffect", "TheoreticalOffensiveWarcryEffect", "TheoreticalMaxOffensiveWarcryEffect", "RallyingHitEffect", "AilmentWarcryEffect"] {
        env.output.insert(k.into(), 1.0);
    }
    env.output.insert("GlobalWarcryUptimeRatio".into(), 0.0);
    if cry_gate {
        env.output.insert("ExertedAttackUptimeRatio".into(), 0.0);
    }
}
