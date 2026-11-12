// Port of Modules/CalcOffence.lua's "Calculate costs" block (1667-1895): the per-resource
// upfront/per-second/percent skill costs (`<Resource>Cost`, `<Resource>HasCost`, `ManaCostRaw`,
// ...), and `ManaCostPayablePool` (1898). The per-second cost of upfront costs (5920-5950) needs
// the skill's final Speed/Cooldown, so it is a separate step (`add_upfront_per_second`).
//
// Everything is read through `ModStore` (the skill's own mod list, parented to the player's
// modDB) plus a few scalars the caller resolves from gem-level data, so the module has no
// dependency on the live pipeline.
use crate::tools::calc_lib_mod_s;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use serde_json::Value;

pub const COST_ORDER: [&str; 13] = [
    "Mana", "Life", "ES", "Soul", "Rage", "ManaPercent", "LifePercent", "ManaPerMinute", "LifePerMinute",
    "ManaPercentPerMinute", "LifePercentPerMinute", "ESPerMinute", "ESPercentPerMinute",
];

struct Cost {
    name: &'static str,
    text: &'static str,
    ty: &'static str,
    upfront: bool,
    percent: bool,
    unaffected_by_generic: bool,
    base_cost: f64,
    /// `baseCostRaw` only exists on the Mana table until a "cost instead of mana" branch zeroes
    /// another table's copy, so it is an Option like the Lua's nil.
    base_cost_raw: Option<f64>,
    total_cost: f64,
    base_cost_no_mult: f64,
    final_base_cost: f64,
}

fn def(name: &'static str) -> Cost {
    let (ty, upfront, percent) = match name {
        "Mana" => ("Mana", true, false),
        "Life" => ("Life", true, false),
        "ES" => ("ES", true, false),
        "Soul" => ("Soul", true, false),
        "Rage" => ("Rage", true, false),
        "ManaPercent" => ("Mana", true, true),
        "LifePercent" => ("Life", true, true),
        "ManaPerMinute" => ("Mana", false, false),
        "LifePerMinute" => ("Life", false, false),
        "ManaPercentPerMinute" => ("Mana", false, true),
        "LifePercentPerMinute" => ("Life", false, true),
        "ESPerMinute" => ("ES", false, false),
        _ => ("ES", false, true),
    };
    let text = match name {
        "Mana" | "ManaPercent" => "mana",
        "Life" | "LifePercent" => "life",
        "ES" => "ES",
        "Soul" => "soul",
        "Rage" => "rage",
        "ManaPerMinute" | "ManaPercentPerMinute" => "mana/s",
        "LifePerMinute" | "LifePercentPerMinute" => "life/s",
        _ => "ES/s",
    };
    Cost {
        name,
        text,
        ty,
        upfront,
        percent,
        unaffected_by_generic: name == "Soul",
        base_cost: 0.0,
        base_cost_raw: if name == "Mana" { Some(0.0) } else { None },
        total_cost: 0.0,
        base_cost_no_mult: 0.0,
        final_base_cost: 0.0,
    }
}

/// Each resource's modifier and output names, in `COST_ORDER` order. Interned once instead of formatted and
/// interned for every resource of every skill on every calculation.
struct Names {
    /// `Base<resource>CostOverride`, `<resource>CostNoMult`, `<resource>CostBase`, `<resource>Cost`
    override_: Sym,
    no_mult: Sym,
    cost_base: Sym,
    cost: Sym,
    /// `<type>Cost`, `<type>CostEfficiency`
    ty_cost: Sym,
    ty_eff: Sym,
    /// Output keys: the resource name with "Minute" read as "Second" for per-minute costs.
    has_cost_key: String,
    cost_key: String,
    cost_raw_key: String,
}

fn names() -> &'static [Names] {
    static N: std::sync::OnceLock<Vec<Names>> = std::sync::OnceLock::new();
    N.get_or_init(|| {
        COST_ORDER
            .iter()
            .map(|&r| {
                let d = def(r);
                let out = if d.upfront { r.to_string() } else { r.replace("Minute", "Second") };
                Names {
                    override_: Sym::new(&format!("Base{r}CostOverride")),
                    no_mult: Sym::new(&format!("{r}CostNoMult")),
                    cost_base: Sym::new(&format!("{r}CostBase")),
                    cost: Sym::new(&format!("{r}Cost")),
                    ty_cost: Sym::new(&format!("{}Cost", d.ty)),
                    ty_eff: Sym::new(&format!("{}CostEfficiency", d.ty)),
                    has_cost_key: format!("{out}HasCost"),
                    cost_key: format!("{out}Cost"),
                    cost_raw_key: format!("{out}CostRaw"),
                }
            })
            .collect()
    })
}

fn divisor(resource: &str) -> f64 {
    if resource.ends_with("PerMinute") { 60.0 } else { 1.0 }
}

fn round(v: f64, dec: i32) -> f64 {
    let p = 10f64.powi(dec);
    (v * p + 0.5).floor() / p
}
fn round0(v: f64) -> f64 {
    (v + 0.5).floor()
}
/// Common.lua's global `floor(val, dec)`.
pub fn floor_dec(v: f64, dec: i32) -> f64 {
    let p = 10f64.powi(dec);
    (v * p + 0.0001).floor() / p
}

/// What the block reads from outside the skill mod list.
pub struct CostInput<'a> {
    pub mods: &'a ModStore,
    pub cfg: &'a Cfg,
    /// `activeEffect.grantedEffectLevel.cost[resource]` (None when the level has no such cost).
    pub level_cost: &'a dyn Fn(&str) -> Option<f64>,
    /// `activeSkill.skillTypes[SkillType.ReservationBecomesCost]`
    pub reservation_becomes_cost: bool,
    /// `skillData.manaReservationFlat or grantedEffectLevel.manaReservationFlat or 0`
    pub mana_reservation_flat: f64,
    /// `skillData.manaReservationPercent or grantedEffectLevel.manaReservationPercent or 0`
    pub mana_reservation_percent: f64,
    /// `output.Mana`
    pub output_mana: f64,
    /// `output.ManaUnreserved`
    pub output_mana_unreserved: Option<f64>,
    /// `output.EnergyShield`
    pub output_energy_shield: Option<f64>,
    /// `modDB:Flag(nil, "EnergyShieldProtectsMana")`
    pub es_protects_mana: bool,
}

/// Ordered `(output key, value)` pairs; `*HasCost` values are 1.0/0.0 (emitted as booleans by
/// the pipeline's BOOL_OUTPUT_KEYS).
pub fn calc_costs(i: &CostInput) -> Vec<(String, f64)> {
    let mut out: Vec<(String, f64)> = Vec::new();
    let m = i.mods;
    let cfg = Some(i.cfg);
    let nm = names();
    let base_sum = |names: &[Sym]| m.sum(ModType::Base, cfg, names);

    if !m.flag(cfg, &[pom_engine::sym!("HasNoCost")]) {
        let mut costs: Vec<Cost> = COST_ORDER.iter().map(|n| def(n)).collect();
        let idx = |n: &str| COST_ORDER.iter().position(|x| *x == n).unwrap();
        // Support cost multipliers are calculated first and rounded down after 4 digits.
        let mult = floor_dec(m.more(cfg, &[pom_engine::sym!("SupportManaMultiplier")]), 4);
        if pom_engine::env::var_os("POM_DEBUG_MULT").is_some() { eprintln!("MULT raw={:?} floor={:?}", m.more(cfg, &[pom_engine::sym!("SupportManaMultiplier")]), mult); }
        let additional_life = base_sum(&[pom_engine::sym!("ManaCostAsLifeCost")]) / 100.0;
        let additional_es = base_sum(&[pom_engine::sym!("ManaCostAsEnergyShieldCost")]) / 100.0;
        let hybrid_life = base_sum(&[pom_engine::sym!("HybridManaAndLifeCost_Life")]) / 100.0;
        let mut mult = mult;

        for (ri, resource) in COST_ORDER.iter().enumerate() {
            let skill_cost = match m.override_(cfg, &[nm[ri].override_]).and_then(|v| v.num()) {
                Some(v) => Some(v),
                None => (i.level_cost)(resource),
            };
            let mut base_cost = round(skill_cost.map(|c| c / divisor(resource)).unwrap_or(0.0), 2);
            let base_cost_no_mult = base_sum(&[nm[ri].no_mult]);
            let mut divine_blessing_correction = 0.0;
            let (upfront, percent, ty) = (costs[ri].upfront, costs[ri].percent, costs[ri].ty);
            if upfront {
                base_cost += base_sum(&[nm[ri].cost_base]);
                costs[ri].total_cost = base_sum(&[nm[ri].cost, pom_engine::sym!("Cost")]);
                if *resource == "Mana" && i.reservation_becomes_cost && !percent && !m.flag(cfg, &[pom_engine::sym!("CostESInsteadOfManaOrLife")]) && !m.flag(cfg, &[pom_engine::sym!("CostLifeInsteadOfMana")]) {
                    base_cost += i.mana_reservation_flat;
                    base_cost += (i.output_mana * i.mana_reservation_percent / 100.0).floor();
                    divine_blessing_correction = round0(i.output_mana * i.mana_reservation_percent / 100.0 * mult) - (i.output_mana * i.mana_reservation_percent / 100.0 * mult).floor();
                }
            }
            costs[ri].base_cost += base_cost;
            costs[ri].base_cost_no_mult += base_cost_no_mult;
            costs[ri].final_base_cost = ((costs[ri].base_cost * mult).floor() + costs[ri].base_cost_no_mult) + divine_blessing_correction;
            costs[ri].base_cost_raw = costs[ri].base_cost_raw.map(|_| costs[ri].base_cost * mult + costs[ri].base_cost_no_mult + divine_blessing_correction);

            match ty {
                "Life" => {
                    let mana_type = resource.replace("Life", "Mana");
                    let mi = idx(&mana_type);
                    if m.flag(cfg, &[pom_engine::sym!("CostLifeInsteadOfMana")]) {
                        if upfront {
                            let mana_total = base_sum(&[nm[mi].cost]);
                            costs[ri].total_cost += mana_total.max(0.0);
                            costs[mi].total_cost -= mana_total;
                        }
                        costs[ri].base_cost += costs[mi].base_cost;
                        costs[ri].base_cost_no_mult += costs[mi].base_cost_no_mult;
                        costs[ri].final_base_cost += costs[mi].final_base_cost;
                        costs[mi].base_cost = 0.0;
                        costs[mi].base_cost_raw = Some(0.0);
                        costs[mi].final_base_cost = 0.0;
                        costs[mi].base_cost_no_mult = 0.0;
                    } else if (additional_life > 0.0 || hybrid_life > 0.0) && !m.flag(cfg, &[pom_engine::sym!("CostESInsteadOfManaOrLife")]) {
                        costs[ri].base_cost = costs[mi].base_cost;
                        costs[ri].final_base_cost += round0(costs[mi].final_base_cost * (hybrid_life + additional_life));
                        if upfront && hybrid_life > 0.0 {
                            costs[ri].total_cost += round0(base_sum(&[nm[mi].cost]).max(0.0) * hybrid_life);
                        }
                    }
                }
                "ES" => {
                    let mana_type = resource.replace("ES", "Mana");
                    let life_type = resource.replace("ES", "Life");
                    let (mi, li) = (idx(&mana_type), idx(&life_type));
                    if m.flag(cfg, &[pom_engine::sym!("CostESInsteadOfManaOrLife")]) {
                        if upfront {
                            let mana_total = base_sum(&[nm[mi].cost]);
                            let life_total = base_sum(&[nm[li].cost]);
                            costs[ri].total_cost += mana_total.max(0.0) + life_total.max(0.0);
                            costs[mi].total_cost -= mana_total;
                            costs[li].total_cost -= life_total;
                        }
                        costs[ri].base_cost += costs[mi].base_cost + costs[li].base_cost;
                        costs[ri].base_cost_no_mult += costs[mi].base_cost_no_mult + costs[li].base_cost_no_mult;
                        costs[ri].final_base_cost += costs[mi].final_base_cost + costs[li].final_base_cost;
                        for j in [mi, li] {
                            costs[j].base_cost = 0.0;
                            costs[j].base_cost_raw = Some(0.0);
                            costs[j].final_base_cost = 0.0;
                            costs[j].base_cost_no_mult = 0.0;
                        }
                    } else if additional_es > 0.0 {
                        costs[ri].base_cost = costs[mi].base_cost;
                        costs[ri].final_base_cost += round0(costs[mi].final_base_cost * additional_es);
                    }
                }
                "Rage" => {
                    if m.flag(cfg, &[pom_engine::sym!("CostRageInsteadOfSouls")]) {
                        let si = idx("Soul");
                        costs[ri].base_cost = costs[si].base_cost;
                        costs[ri].base_cost_no_mult += costs[si].base_cost_no_mult;
                        costs[ri].final_base_cost = costs[si].base_cost;
                        mult = 1.0;
                        costs[si].base_cost = 0.0;
                        costs[si].base_cost_no_mult = 0.0;
                        costs[si].final_base_cost = 0.0;
                    }
                }
                _ => {}
            }
        }

        for (c, n) in costs.iter().zip(nm) {
            let has_cost = c.base_cost > 0.0 || c.total_cost > 0.0 || c.base_cost_no_mult > 0.0 || c.final_base_cost > 0.0;
            out.push((n.has_cost_key.clone(), if has_cost { 1.0 } else { 0.0 }));
            let cost_eff = calc_lib_mod_s(m, cfg, &[n.ty_eff, pom_engine::sym!("CostEfficiency")]);
            let more_type = m.more(cfg, &[n.ty_cost]);
            let mut v;
            let mut raw = None;
            let (mut bd_more_cost, mut bd_inc) = (1.0, 0.0);
            if !c.unaffected_by_generic {
                v = c.final_base_cost;
                let more_cost = m.more(cfg, &[pom_engine::sym!("Cost")]);
                let inc = m.sum(ModType::Inc, cfg, &[n.ty_cost, pom_engine::sym!("Cost")]);
                bd_more_cost = more_cost;
                bd_inc = inc;
                raw = c.base_cost_raw.map(|r| (((1.0 + inc / 100.0) * r * more_type * more_cost / cost_eff).max(0.0) + c.total_cost).max(0.0));
                v = if inc < 0.0 { ((1.0 + inc / 100.0) * v).ceil().max(0.0) } else { ((1.0 + inc / 100.0) * v).floor().max(0.0) };
                v = if more_type < 1.0 { (more_type * v).ceil().max(0.0) } else { (more_type * v).floor().max(0.0) };
                v = if more_cost < 1.0 { (more_cost * v).ceil().max(0.0) } else { (more_cost * v).floor().max(0.0) };
                v = (v / cost_eff).max(0.0);
                if c.upfront && !c.percent {
                    v = round0(v);
                }
                v = (v + c.total_cost).max(0.0);
                if c.ty == "Mana" && hybrid_life > 0.0 {
                    v = ((1.0 - hybrid_life) * v).floor().max(0.0);
                    raw = raw.map(|r| ((1.0 - hybrid_life) * r).max(0.0));
                }
            } else {
                let inc = m.sum(ModType::Inc, cfg, &[n.ty_cost]);
                bd_inc = inc;
                v = (c.base_cost + c.base_cost_no_mult).floor();
                if crate::data::pom_fixes_on() {
                    // Vaal soul cost modifiers round the amount subtracted down, like Mana cost; upstream rounds to nearest.
                    v = if inc < 0.0 { ((1.0 + inc / 100.0) * v).ceil().max(0.0) } else { ((1.0 + inc / 100.0) * v).floor().max(0.0) };
                    v = if more_type < 1.0 { (more_type * v).ceil().max(0.0) } else { (more_type * v).floor().max(0.0) };
                } else {
                    v = ((1.0 + inc / 100.0) * v).max(0.0);
                    v = (more_type * v).max(0.0);
                }
                v = (v / cost_eff).max(0.0);
                if c.upfront && !c.percent {
                    v = round0(v);
                }
                v = (v + c.total_cost).max(0.0);
                raw = c.base_cost_raw.map(|r| (((1.0 + inc / 100.0) * (r + c.base_cost_no_mult) * more_type / cost_eff).max(0.0) + c.total_cost).max(0.0));
            }
            if has_cost && crate::bd::on() {
                crate::bd_c::cost_breakdown(&crate::bd_c::CostBd {
                    cost_name: &n.cost_key,
                    ty: c.ty,
                    text: c.text,
                    upfront: c.upfront,
                    percent: c.percent,
                    base_cost: c.base_cost,
                    mult,
                    base_cost_no_mult: c.base_cost_no_mult,
                    hybrid_life_cost: hybrid_life,
                    additional_life_cost: additional_life,
                    additional_es_cost: additional_es,
                    life_instead_of_mana: m.flag(cfg, &[pom_engine::sym!("CostLifeInsteadOfMana")]),
                    es_instead_of_mana_or_life: m.flag(cfg, &[pom_engine::sym!("CostESInsteadOfManaOrLife")]),
                    inc: bd_inc,
                    more_cost: bd_more_cost,
                    more_type,
                    cost_efficiency: cost_eff,
                    total_cost: c.total_cost,
                    output_cost: v,
                });
            }
            out.push((n.cost_key.clone(), v));
            if let Some(r) = raw {
                out.push((n.cost_raw_key.clone(), r));
            }
        }
    }
    let pool = i.output_mana_unreserved.unwrap_or(0.0) + if i.es_protects_mana { i.output_energy_shield.unwrap_or(0.0) } else { 0.0 };
    out.push(("ManaCostPayablePool".to_string(), pool));
    out
}

/// CalcOffence.lua:5917-5950: upfront costs also show as a per-second cost of the skill's use
/// rate. `use_speed` is the already-selected rate (the trap/mine/totem/unleash/plain branches
/// are the caller's job); `has_rate` is `output.Speed > 0 or output.Cooldown`.
pub fn add_upfront_per_second(out: &mut Vec<(String, f64)>, es_protects_mana: bool, es_cost_conversion: f64, has_rate: bool, use_speed: impl Fn() -> f64, time_type: &str) {
    let get = |out: &Vec<(String, f64)>, k: &str| out.iter().find(|(n, _)| n == k).map(|(_, v)| *v);
    let eb = es_protects_mana;
    let es_conv = es_cost_conversion;
    for resource in COST_ORDER {
        let d = def(resource);
        if !d.upfront {
            continue;
        }
        let has_cost = get(out, &format!("{resource}HasCost")).map(|v| v != 0.0).unwrap_or(false);
        let cost = get(out, &format!("{resource}Cost"));
        let per_sec_has = get(out, &format!("{resource}PerSecondHasCost")).map(|v| v != 0.0).unwrap_or(false);
        if !(has_cost && cost.unwrap_or(0.0) > 0.0 && !(per_sec_has && !(eb && es_conv != 0.0)) && has_rate) {
            continue;
        }
        let used = if eb && resource == "Mana" { "ES" } else { resource };
        let k = format!("{used}PerSecondCost");
        let prev = get(out, &k).unwrap_or(0.0);
        let val = prev + cost.unwrap() * use_speed();
        let hk = format!("{used}PerSecondHasCost");
        set(out, &hk, 1.0);
        set(out, &k, val);
        if crate::bd::on() {
            // CalcOffence.lua:5943-5947: `copyTable(breakdown[resource.."Cost"])` minus its last line, then the speed lines.
            let src_key = format!("{resource}Cost");
            crate::bd::cur(|b| {
                let mut t = crate::bd::get(b, &src_key).map(|v| v.clone()).unwrap_or(Value::Array(vec![]));
                bd_remove_last(&mut t);
                crate::bd::ins_s(&mut t, crate::sf!(&format!("x %.2f ^8({time_type} speed)"), use_speed()));
                crate::bd::ins_s(&mut t, crate::sf!("= %.2f per second", val));
                crate::bd::set(b, &k, t);
            });
        }
    }
}

/// `t_remove(tbl)`: drops the last list item.
fn bd_remove_last(t: &mut Value) {
    match t {
        Value::Array(a) => {
            a.pop();
        }
        Value::Object(m) => {
            let n = m.keys().filter_map(|k| k.parse::<usize>().ok()).max();
            if let Some(n) = n {
                m.remove(&n.to_string());
            }
        }
        _ => {}
    }
}

fn set(out: &mut Vec<(String, f64)>, k: &str, v: f64) {
    if let Some(e) = out.iter_mut().find(|(n, _)| n == k) {
        e.1 = v;
    } else {
        out.push((k.to_string(), v));
    }
}

/// Removes the `<Resource>PerSecond{HasCost,Cost}` outputs of every upfront resource whose
/// per-second cost `add_upfront_per_second` would have (re)written, for callers that cannot
/// supply the skill's use rate yet.
pub fn drop_unknown_per_second(out: &mut Vec<(String, f64)>) {
    let mut drop: Vec<String> = Vec::new();
    for resource in COST_ORDER {
        if !def(resource).upfront {
            continue;
        }
        let get = |k: &str| out.iter().find(|(n, _)| n == k).map(|(_, v)| *v);
        if get(&format!("{resource}HasCost")).unwrap_or(0.0) != 0.0 && get(&format!("{resource}Cost")).unwrap_or(0.0) > 0.0 {
            // the rate can also change the ES-protects-mana target, so drop ES-protects-mana redirect
            drop.push(format!("{resource}PerSecondHasCost"));
            drop.push(format!("{resource}PerSecondCost"));
            if resource == "Mana" && get("ESPerSecondHasCost").unwrap_or(0.0) == 0.0 {
                drop.push("ESPerSecondHasCost".to_string());
                drop.push("ESPerSecondCost".to_string());
            }
        }
    }
    out.retain(|(n, _)| !drop.contains(n));
}

#[cfg(test)]
mod tests {
    use super::*;
    use pom_engine::modifier::Mod;
    use pom_engine::value::Value as V;

    #[test]
    fn soul_reduction_rounds_down() {
        let mut m = ModStore::new_list(None, None);
        m.add_mod(Mod { name: Sym::new("SoulCost"), ty: ModType::Inc, value: V::Num(-20.0), flags: 0, keyword_flags: 0, source: None, tags: Default::default() });
        let cfg = Cfg::default();
        let level_cost = |r: &str| if r == "Soul" { Some(28.0) } else { None };
        let out = calc_costs(&CostInput {
            mods: &m,
            cfg: &cfg,
            level_cost: &level_cost,
            reservation_becomes_cost: false,
            mana_reservation_flat: 0.0,
            mana_reservation_percent: 0.0,
            output_mana: 0.0,
            output_mana_unreserved: None,
            output_energy_shield: None,
            es_protects_mana: false,
        });
        let soul = out.iter().find(|(k, _)| k == "SoulCost").unwrap().1;
        // 28 - floor(28 * 0.2) = 23; upstream rounds 22.4 to nearest and shows 22.
        assert_eq!(soul, 23.0);
    }
}
