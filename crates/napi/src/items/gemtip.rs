//! Skill tooltips (`GemTooltip.AddGemTooltip`, `StatDescriber`) for the skills an item grants: name, tags, level, cost,
//! cast time, requirements, description and the skill's stat lines at that level.
use super::*;
use std::collections::HashMap as Map2;

// ---- stat descriptions -----------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Lim {
    Any,
    Bang,
    Num(f64),
}

struct Lang {
    limit: Vec<(Lim, Lim)>,
    text: String,
    specs: Vec<(String, f64)>,
    gem_quality: bool,
}

struct Desc {
    stats: Vec<String>,
    lang: Vec<Lang>,
}

struct Scope {
    parent: Option<String>,
    index: Map2<String, u32>,
    descs: Map2<u32, Desc>,
}

struct Describer {
    scopes: Map2<String, Scope>,
    pearls: Map2<i64, String>,
    costs: Vec<(String, String, f64)>,
}

static DESCRIBER: std::sync::OnceLock<Describer> = std::sync::OnceLock::new();

fn lim(v: &Value) -> Lim {
    match v {
        Value::Number(n) => Lim::Num(n.as_f64().unwrap_or(0.0)),
        Value::String(s) if s == "!" => Lim::Bang,
        _ => Lim::Any,
    }
}

fn describer() -> &'static Describer {
    DESCRIBER.get_or_init(|| {
        let root: Value = serde_json::from_str(include_str!("../../data/stat_descriptions.json")).unwrap_or(Value::Null);
        let mut scopes = Map2::new();
        if let Some(o) = root.get("scopes").and_then(|s| s.as_object()) {
            for (name, s) in o {
                let index = s["index"].as_object().map(|i| i.iter().filter_map(|(k, v)| Some((k.clone(), v.as_u64()? as u32))).collect()).unwrap_or_default();
                let mut descs = Map2::new();
                if let Some(d) = s["descs"].as_object() {
                    for (n, d) in d {
                        let Ok(n) = n.parse::<u32>() else { continue };
                        let stats = d["stats"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
                        let lang = d["lang"]
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .map(|l| Lang {
                                        limit: l["limit"].as_array().map(|ls| ls.iter().map(|p| (lim(&p[0]), lim(&p[1]))).collect()).unwrap_or_default(),
                                        text: l["text"].as_str().unwrap_or("").to_string(),
                                        specs: l["specs"].as_array().map(|ss| ss.iter().map(|s| (s["k"].as_str().unwrap_or("").to_string(), s["v"].as_f64().unwrap_or(0.0))).collect()).unwrap_or_default(),
                                        gem_quality: l["gem_quality"].as_bool().unwrap_or(false),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        descs.insert(n, Desc { stats, lang });
                    }
                }
                scopes.insert(name.clone(), Scope { parent: s["parent"].as_str().map(|p| p.to_string()), index, descs });
            }
        }
        let pearls = root["pearls"].as_object().map(|o| o.iter().filter_map(|(k, v)| Some((k.parse::<i64>().ok()?, v.as_str()?.to_string()))).collect()).unwrap_or_default();
        let costs = root["costs"].as_array().map(|a| a.iter().map(|c| (c["resource"].as_str().unwrap_or("").to_string(), c["text"].as_str().unwrap_or("").to_string(), c["divisor"].as_f64().unwrap_or(1.0))).collect()).unwrap_or_default();
        Describer { scopes, pearls, costs }
    })
}

#[derive(Clone)]
struct Val {
    min: f64,
    max: f64,
    fmt: String,
    text: Option<String>,
}

/// Lua's `round(x, d)`.
fn round_to(v: f64, d: i32) -> f64 {
    let m = 10f64.powi(d);
    (v * m + 0.5).floor() / m
}

fn apply_special(val: &mut [Val], kind: &str, v: usize, pearls: &Map2<i64, String>) {
    let Some(x) = val.get_mut(v) else { return };
    let (mn, mx) = (x.min, x.max);
    let g = |x: &mut Val| x.fmt = "g".to_string();
    match kind {
        "negate" => {
            x.min = -mx;
            x.max = -mn;
        }
        "invert_chance" => {
            x.min = 100.0 - mx;
            x.max = 100.0 - mn;
        }
        "negate_and_double" => {
            x.min = -2.0 * mx;
            x.max = -2.0 * mn;
        }
        "divide_by_two_0dp" => {
            x.min = mn / 2.0;
            x.max = mx / 2.0;
        }
        "divide_by_ten_0dp" => {
            x.min = mn / 10.0;
            x.max = mx / 10.0;
        }
        "divide_by_fifteen_0dp" => {
            x.min = mn / 15.0;
            x.max = mx / 15.0;
        }
        "divide_by_four" => {
            x.min = mn / 4.0;
            x.max = mx / 4.0;
            g(x);
        }
        "divide_by_five" => {
            x.min = mn / 5.0;
            x.max = mx / 5.0;
            g(x);
        }
        "divide_by_six" => {
            x.min = mn / 6.0;
            x.max = mx / 6.0;
            g(x);
        }
        "divide_by_ten_1dp_if_required" | "divide_by_ten_1dp" => {
            x.min = round_to(mn / 10.0, 1);
            x.max = round_to(mx / 10.0, 1);
            g(x);
        }
        "divide_by_twelve" => {
            x.min = mn / 12.0;
            x.max = mx / 12.0;
            g(x);
        }
        "divide_by_twenty" => {
            x.min = mn / 20.0;
            x.max = mx / 20.0;
            g(x);
        }
        "divide_by_one_hundred" => {
            x.min = mn / 100.0;
            x.max = mx / 100.0;
            g(x);
        }
        "divide_by_one_hundred_1dp" => {
            x.min = round_to(mn / 100.0, 1);
            x.max = round_to(mx / 100.0, 1);
            g(x);
        }
        "divide_by_one_hundred_2dp_if_required" | "divide_by_one_hundred_2dp" => {
            x.min = round_to(mn / 100.0, 2);
            x.max = round_to(mx / 100.0, 2);
            g(x);
        }
        "divide_by_one_hundred_and_negate" => {
            x.min = -round_to(mn / 100.0, 1);
            x.max = -round_to(mx / 100.0, 1);
            g(x);
        }
        "divide_by_twenty_then_double_0dp" => {
            x.min = round_to(mn / 20.0, 0) * 2.0;
            x.max = round_to(mx / 20.0, 0) * 2.0;
        }
        "divide_by_one_thousand" => {
            x.min = mn / 1000.0;
            x.max = mx / 1000.0;
            g(x);
        }
        "per_minute_to_per_second" | "per_minute_to_per_second_1dp" => {
            x.min = round_to(mn / 60.0, 1);
            x.max = round_to(mx / 60.0, 1);
            g(x);
        }
        "permyriad_per_minute_to_%_per_second" => {
            x.min = round_to(mn / 60.0 / 100.0, 1);
            x.max = round_to(mx / 60.0 / 100.0, 1);
            g(x);
        }
        "per_minute_to_per_second_0dp" => {
            x.min = mn / 60.0;
            x.max = mx / 60.0;
        }
        "per_minute_to_per_second_2dp" | "per_minute_to_per_second_2dp_if_required" => {
            x.min = round_to(mn / 60.0, 2);
            x.max = round_to(mx / 60.0, 2);
            g(x);
        }
        "milliseconds_to_seconds" => {
            x.min = mn / 1000.0;
            x.max = mx / 1000.0;
            g(x);
        }
        "milliseconds_to_seconds_0dp" => {
            x.min = mn / 1000.0;
            x.max = mx / 1000.0;
        }
        "milliseconds_to_seconds_1dp" => {
            x.min = round_to(mn / 1000.0, 1);
            x.max = round_to(mx / 1000.0, 1);
            g(x);
        }
        "milliseconds_to_seconds_2dp" | "milliseconds_to_seconds_2dp_if_required" => {
            x.min = round_to(mn / 1000.0, 2);
            x.max = round_to(mx / 1000.0, 2);
            g(x);
        }
        "deciseconds_to_seconds" => {
            x.min = mn / 10.0;
            x.max = mx / 10.0;
            x.fmt = ".2f".to_string();
        }
        "locations_to_metres" => {
            x.min = mn / 10.0;
            x.max = mx / 10.0;
            g(x);
        }
        "30%_of_value" => {
            x.min = mn * 0.3;
            x.max = mx * 0.3;
        }
        "60%_of_value" => {
            x.min = mn * 0.6;
            x.max = mx * 0.6;
        }
        "multiplicative_damage_modifier" => {
            x.min = 100.0 + mn;
            x.max = 100.0 + mx;
        }
        "multiplicative_permyriad_damage_modifier" => {
            x.min = 100.0 + round_to(mn / 100.0, 1);
            x.max = 100.0 + round_to(mx / 100.0, 1);
            g(x);
        }
        "multiply_by_four" => {
            x.min = mn * 4.0;
            x.max = mx * 4.0;
        }
        "times_one_point_five" => {
            x.min = mn * 1.5;
            x.max = mx * 1.5;
        }
        "times_twenty" => {
            x.min = mn * 20.0;
            x.max = mx * 20.0;
        }
        "double" => {
            x.min = mn * 2.0;
            x.max = mx * 2.0;
        }
        "plus_two_hundred" => {
            x.min = mn + 200.0;
            x.max = mx + 200.0;
        }
        "display_indexable_non_active_support" => {
            let name = pearls.get(&(mn as i64)).map(|n| n.replace(" Support", "")).unwrap_or_default();
            x.fmt = "s".to_string();
            x.text = Some(name);
        }
        _ => {}
    }
}

/// Lua's `string.format("%" .. fmt, v)` for the formats the descriptions use: `d`, `g`, `.2f` and `s`.
fn fmt_val(fmt: &str, plus: bool, v: f64, text: &Option<String>) -> String {
    if fmt == "s" {
        return text.clone().unwrap_or_default();
    }
    let body = match fmt {
        "d" => format!("{}", v.trunc() as i64),
        ".2f" => format!("{v:.2}"),
        _ => {
            // %g: six significant digits, no trailing zeros.
            let s = format!("{:.6}", v);
            let s = if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s };
            if s == "-0" { "0".to_string() } else { s }
        }
    };
    if plus && v >= 0.0 { format!("+{body}") } else { body }
}

fn range_text(v: &Val, plus: bool) -> String {
    if v.min == v.max {
        fmt_val(&v.fmt, plus, v.min, &v.text)
    } else if plus && v.max < 0.0 {
        format!("-({}-{})", -v.min.trunc() as i64, -v.max.trunc() as i64)
    } else if plus {
        format!("+({}-{})", v.min.trunc() as i64, v.max.trunc() as i64)
    } else {
        format!("({}-{})", fmt_val(&v.fmt, false, v.min, &v.text), fmt_val(&v.fmt, false, v.max, &v.text))
    }
}

/// The text of one description with its values substituted (`{0}`, `{}`, `{:+d}`, `{0:+d}`, `%%`).
fn substitute(text: &str, val: &[Val]) -> String {
    let b: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == '{' {
            if let Some(close) = b[i..].iter().position(|c| *c == '}') {
                let inner: String = b[i + 1..i + close].iter().collect();
                let (idx_part, fmt_part) = match inner.split_once(':') {
                    Some((a, f)) => (a.to_string(), Some(f.to_string())),
                    None => (inner.clone(), None),
                };
                let idx = if idx_part.is_empty() { Some(0) } else { idx_part.parse::<usize>().ok() };
                if let (Some(n), true) = (idx, idx_part.chars().all(|c| c.is_ascii_digit())) {
                    if let Some(v) = val.get(n) {
                        let plus = fmt_part.as_deref() == Some("+d");
                        if fmt_part.is_none() || matches!(fmt_part.as_deref(), Some("d") | Some("+d")) {
                            out.push_str(&range_text(v, plus));
                            i += close + 1;
                            continue;
                        }
                    }
                }
            }
        }
        if b[i] == '%' && b.get(i + 1) == Some(&'%') {
            out.push('%');
            i += 2;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// `StatDescriber`: the description lines of `stats` in `scope`, each with the stat that decided it.
fn describe(stats: &pom_engine::fxhash::HashMap<String, f64>, scope_name: &str, quality: bool) -> Vec<(String, String)> {
    let d = describer();
    // The scope and its parents, nearest first.
    let mut chain: Vec<&Scope> = Vec::new();
    let mut name = Some(scope_name.to_string());
    while let Some(n) = name {
        let Some(s) = d.scopes.get(&n) else { break };
        chain.push(s);
        name = s.parent.clone();
    }
    let mut chosen: Map2<String, (usize, u32, &Desc)> = Map2::new();
    let mut names: Vec<&String> = stats.keys().collect();
    names.sort();
    for s in names {
        if stats[s] == 0.0 {
            continue;
        }
        for (depth, scope) in chain.iter().enumerate() {
            if let Some(n) = scope.index.get(s) {
                if let Some(desc) = scope.descs.get(n) {
                    if !desc.lang.is_empty() {
                        if let Some(first) = desc.stats.first() {
                            chosen.insert(first.clone(), (depth + 1, *n, desc));
                        }
                    }
                }
                break;
            }
        }
    }
    let mut ordered: Vec<(usize, u32, &Desc)> = chosen.into_values().collect();
    ordered.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut out = Vec::new();
    for (_, _, desc) in ordered {
        let mut val: Vec<Val> = Vec::new();
        let mut stat = String::new();
        for s in &desc.stats {
            match stats.get(s) {
                Some(v) => {
                    val.push(Val { min: *v, max: *v, fmt: "d".into(), text: None });
                    stat = s.clone();
                }
                None => val.push(Val { min: 0.0, max: 0.0, fmt: "d".into(), text: None }),
            }
        }
        let matched = desc.lang.iter().find(|l| {
            if !(quality || !l.gem_quality) {
                return false;
            }
            l.limit.iter().enumerate().all(|(i, (a, b))| {
                let Some(v) = val.get(i) else { return true };
                match a {
                    Lim::Bang => !matches!(b, Lim::Num(n) if v.min == *n),
                    _ => {
                        let over = matches!(b, Lim::Num(n) if v.min > *n);
                        let under = matches!(a, Lim::Num(n) if v.min < *n);
                        !(over || under)
                    }
                }
            })
        });
        if let Some(l) = matched {
            for (k, v) in &l.specs {
                apply_special(&mut val, k, *v as usize - if *v >= 1.0 { 1 } else { 0 }, &d.pearls);
            }
            out.push((substitute(&l.text, &val), stat));
        }
    }
    out
}

// ---- the tooltip -----------------------------------------------------------------------------------------------------

fn lv(o: &pom_engine::cjson::J, k: &str) -> Option<f64> {
    o.get(k).and_then(|v| v.as_f64())
}

fn pair(label: &str, value: impl Into<String>) -> Value {
    line("big", vec![seg(Some("muted"), format!("{label}: ")), seg(Some("white"), value)])
}

/// `addCommonGemInfo` for one granted effect.
fn common(out: &mut Vec<Value>, game: &'static GameData, ge_id: &str, level: f64, gem: Option<&pom_engine::data::gems::GemData>, merge_from: Option<&str>, add_req: bool, player: &Player) {
    let Some(ge) = pom_skills::data::granted_effect_by_skill_id(ge_id) else { return };
    let lvl = pom_skills::data::skill_level_obj(ge_id, level);
    let support = ge.extra.get("support").map(|v| v.to_value().as_bool().unwrap_or(false)).unwrap_or(false);
    let max = gem.and_then(|g| g.natural_max_level).map(|m| m as f64);
    let max_text = if max.is_some_and(|m| level >= m) { " (Max)" } else { "" };
    out.push(line("big", vec![seg(Some("muted"), "Level: "), seg(Some("white"), format!("{}{}", level as i64, max_text))]));
    let d = describer();
    let reservation = |lvl: &pom_engine::cjson::J| -> Option<String> {
        let mut r: Option<String> = None;
        for (key, res) in [("manaReservationFlat", "Mana"), ("manaReservationPercent", "ManaPercent"), ("lifeReservationFlat", "Life"), ("lifeReservationPercent", "LifePercent")] {
            if let Some(v) = lv(lvl, key) {
                if let Some((_, text, _)) = d.costs.iter().find(|c| c.0 == res) {
                    let t = text.replace("{0}", &format!("{}", v as i64));
                    r = Some(match r {
                        Some(p) => format!("{p}, {t}"),
                        None => t,
                    });
                }
            }
        }
        r
    };
    if let Some(lvl) = lvl {
        if support {
            if let Some(m) = lv(&lvl, "manaMultiplier") {
                out.push(pair("Cost & Reservation Multiplier", format!("{}%", (m + 100.0) as i64)));
            }
            if let Some(r) = reservation(&lvl) {
                out.push(pair("Reservation Override", r));
            }
            if let Some(cd) = lv(&lvl, "cooldown") {
                let uses = lv(&lvl, "storedUses").filter(|u| *u > 1.0).map(|u| format!(" ({} uses)", u as i64)).unwrap_or_default();
                out.push(pair("Cooldown Time", format!("{cd:.2} sec{uses}")));
            }
        } else {
            if let Some(r) = reservation(&lvl) {
                out.push(pair("Reservation", r));
            }
            let mut cost: Option<String> = None;
            if let Some(c) = lvl.get("cost").and_then(|c| c.as_object()) {
                for (resource, text, divisor) in &d.costs {
                    if let Some(v) = c.get(resource).and_then(|v| v.as_f64()) {
                        let n = round_to(v / divisor, 2);
                        let t = text.replace("{0}", &fmt_val("g", false, n, &None));
                        cost = Some(match cost {
                            Some(p) => format!("{p}, {t}"),
                            None => t,
                        });
                    }
                }
            }
            if let Some(c) = cost {
                out.push(pair("Cost", c));
            }
            if let Some(cd) = lv(&lvl, "cooldown") {
                let uses = lv(&lvl, "storedUses").filter(|u| *u > 1.0).map(|u| format!(" ({} uses)", u as i64)).unwrap_or_default();
                out.push(pair("Cooldown Time", format!("{cd:.2} sec{uses}")));
            }
            if let Some(v) = lv(&lvl, "vaalStoredUses") {
                let souls = lvl.get("cost").and_then(|c| c.get("Soul")).and_then(|s| s.as_f64()).unwrap_or(0.0);
                out.push(line("big", vec![seg(Some("muted"), "Can Store "), seg(Some("white"), format!("{}", v as i64)), seg(Some("muted"), format!(" Use ({} Souls)", (v * souls) as i64))]));
            }
            if let Some(v) = lv(&lvl, "soulPreventionDuration") {
                out.push(pair("Soul Gain Prevention", format!("{} sec", v as i64)));
            }
            let attack = gem.is_some_and(|g| g.tags.get("attack").copied().unwrap_or(false));
            if attack {
                if let Some(v) = lv(&lvl, "attackSpeedMultiplier") {
                    out.push(pair("Attack Speed", format!("{}% of base", (v + 100.0) as i64)));
                }
                if let Some(v) = lv(&lvl, "attackTime") {
                    out.push(pair("Attack Time", format!("{:.2} sec", v / 1000.0)));
                }
                if let Some(v) = lv(&lvl, "baseMultiplier") {
                    out.push(pair("Attack Damage", format!("{}% of base", fmt_val("g", false, v * 100.0, &None))));
                }
            } else {
                let cast = ge.cast_time.unwrap_or(0.0);
                out.push(pair("Cast Time", if cast > 0.0 { format!("{cast:.2} sec") } else { "Instant".to_string() }));
            }
            if let Some(v) = lv(&lvl, "critChance") {
                out.push(pair("Critical Strike Chance", format!("{v:.2}%")));
            }
            if let Some(v) = lv(&lvl, "damageEffectiveness") {
                out.push(pair("Effectiveness of Added Damage", format!("{}%", (v * 100.0) as i64)));
            }
        }
    }
    if add_req {
        out.push(sep());
        let req_level = lvl.as_ref().and_then(|l| lv(l, "levelRequirement")).unwrap_or(1.0);
        let attr = |base: f64| pom_calc::tools::get_gem_stat_requirement(req_level, support, base);
        let (rs, rd, ri) = gem.map(|g| (attr(g.req_str), attr(g.req_dex), attr(g.req_int))).unwrap_or((0.0, 0.0, 0.0));
        let mut parts: Vec<Vec<Value>> = Vec::new();
        if req_level > 0.0 {
            let c = if player.level.is_some_and(|l| req_level > l) { Some("negative") } else { Some("white") };
            parts.push(vec![seg(Some("muted"), "Level "), seg(c, n0(req_level))]);
        }
        for (v, have, name, col) in [(rs, player.str_, "Str", "str"), (rd, player.dex, "Dex", "dex"), (ri, player.int, "Int", "int")] {
            if v > 14.0 || have.is_some_and(|h| v > h) {
                let c = if have.is_some_and(|h| v > h) { "negative" } else { col };
                parts.push(vec![seg(Some(c), n0(v)), seg(Some("muted"), format!(" {name}"))]);
            }
        }
        if !parts.is_empty() {
            let mut segs = vec![seg(Some("muted"), "Requires ")];
            for (i, p) in parts.into_iter().enumerate() {
                if i > 0 {
                    segs.push(seg(Some("muted"), ", "));
                }
                segs.extend(p);
            }
            out.push(line("big", segs));
        }
    }
    out.push(sep());
    if let Some(desc) = ge.extra.get("description").and_then(|v| v.as_str()) {
        out.push(line("big", vec![seg(Some("gem"), desc)]));
        out.push(sep());
    }
    // The stat lines.
    let quality = 0.0;
    let mut stats: pom_engine::fxhash::HashMap<String, f64> = Default::default();
    for (k, v) in pom_skills::modlist::build_skill_instance_stats(ge, level, quality, None) {
        *stats.entry(k).or_insert(0.0) += v;
    }
    if let Some(m) = merge_from.and_then(pom_skills::data::granted_effect_by_skill_id) {
        for (k, v) in pom_skills::modlist::build_skill_instance_stats(m, level, quality, None) {
            *stats.entry(k).or_insert(0.0) += v;
        }
    }
    let scope = ge.extra.get("statDescriptionScope").and_then(|v| v.as_str()).unwrap_or("skill_stat_descriptions");
    let supported = |stat: &str| -> bool { pom_skills::modlist::stat_map_lookup(ge_id, stat).is_some() };
    for (text, stat) in describe(&stats, scope, false) {
        let ok = supported(&stat);
        for part in text.split('\n') {
            if ok {
                out.push(line("big", vec![seg(Some("magic"), part)]));
            } else {
                out.push(line("big", vec![seg(Some("unsupported"), part), seg(Some("muted"), " (Not supported yet)")]));
            }
        }
    }
}

/// The tooltip of a skill at `level`: a list of tooltip lines, the first being its name.
pub fn tip(game: &'static GameData, skill_id: &str, level: f64, player: &Player) -> Result<Value, String> {
    let ge = pom_skills::data::granted_effect_by_skill_id(skill_id).ok_or_else(|| format!("unknown skill {skill_id}"))?;
    let gem = pom_skills::data::gem_for_skill(skill_id).and_then(|id| game.gems.get(id));
    let name = ge.name.clone().unwrap_or_else(|| skill_id.to_string());
    let mut out: Vec<Value> = vec![line("title", vec![seg(Some("gem"), name.clone())]), sep()];
    if let Some(tags) = gem.and_then(|g| g.tag_string.clone()) {
        out.push(line("big", vec![seg(Some("muted"), tags)]));
    }
    let secondary_id = gem.and_then(|g| g.secondary_granted_effect_id.clone());
    let secondary_support = secondary_id.as_deref().and_then(pom_skills::data::granted_effect_by_skill_id).is_some_and(|s| s.extra.get("support").map(|v| v.to_value().as_bool().unwrap_or(false)).unwrap_or(false));
    // A support secondary effect adds its stats to the primary's; any other secondary is a second section.
    let merge = if secondary_support { secondary_id.as_deref() } else { None };
    common(&mut out, game, skill_id, level, gem, merge, gem.is_some(), player);
    if let (Some(sid), false) = (secondary_id.as_deref(), secondary_support) {
        let sname = pom_skills::data::granted_effect_by_skill_id(sid).and_then(|s| s.name.clone()).unwrap_or_default();
        out.push(line("title", vec![seg(Some("gem"), sname)]));
        out.push(sep());
        common(&mut out, game, sid, level, gem, None, false, player);
    }
    while out.last().is_some_and(|l| l.get("k").and_then(|k| k.as_str()) == Some("sep")) {
        out.pop();
    }
    Ok(json!({ "name": name, "lines": out }))
}
