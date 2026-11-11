//! `pom-cli mechanics-scan`: the per-patch mechanics scan. Parses every unique,
//! passive node, item mod pool line and gem stat of the current game data with the Rust mod parser (ranges at the max
//! roll), reads what it leaves with the text rules, and sorts every result into the class registry
//! (mechanic_classes.json). Writes engine-data/mechanics.json and reports what it cannot classify: lines the parser
//! and the rules do not fully read whose text hits a family keyword (partial parses included), and gem stat ids upstream
//! drops (no stat map entry, no class), both against the reviewed list (mechanics_reviewed.json) so only new ones
//! fail the run.
use super::clear::Registry;
use pom_engine::fxhash::HashSet;
use pom_engine::modparser::text_rules::Rules;
use pom_engine::modparser::types::{PMod, PVal};
use serde_json::{json, Value as J};

/// One source line: where it comes from and its text.
#[derive(Clone, Debug)]
pub struct Line {
    pub kind: &'static str,
    pub source: String,
    pub text: String,
}

/// One gem: its skill id, stat ids (level, constant and quality stats), and support structure.
#[derive(Clone, Debug, Default)]
pub struct Gem {
    pub id: String,
    pub stats: Vec<(String, f64)>,
    pub adds: Vec<i64>,
    pub requires: Vec<i64>,
}

#[derive(Debug, Default)]
pub struct Scan {
    /// class -> hits ({source, kind, key, value, via, gate?})
    pub classes: std::collections::BTreeMap<String, Vec<J>>,
    /// Report keys ("line: <normalized>", "stat: <id>") with their source, in scan order.
    pub unclassified: Vec<(String, String)>,
    /// Stat ids upstream drops that are not in the registry (every one, before the keyword-free review filter).
    pub dropped_stats: usize,
}

/// "(5-8)%" -> "8%": every range at its max roll, as the item parser resolves a perfect roll.
pub fn max_roll(line: &str) -> String {
    let re = regex::Regex::new(r"\((-?[\d.]+)-(-?[\d.]+)\)").unwrap();
    re.replace_all(line, "$2").into_owned()
}

/// Lowercase, digits as '#': the form report keys use, so a re-roll is not a new line.
pub fn normalize(line: &str) -> String {
    let re = regex::Regex::new(r"\d+(\.\d+)?").unwrap();
    re.replace_all(&line.to_lowercase(), "#").into_owned()
}

fn tag_vars(m: &PMod) -> Vec<String> {
    m.tags
        .iter()
        .filter_map(|t| match t {
            PVal::Map(f) => f.iter().find(|(k, _)| k == "var").and_then(|(_, v)| if let PVal::Str(s) = v { Some(s.clone()) } else { None }),
            _ => None,
        })
        .collect()
}

fn pval_json(v: &PVal) -> J {
    match v {
        PVal::Num(n) => json!(n),
        PVal::Bool(b) => json!(b),
        PVal::Str(s) => json!(s),
        PVal::List(l) => J::Array(l.iter().map(pval_json).collect()),
        PVal::Map(m) => J::Object(m.iter().map(|(k, v)| (k.clone(), pval_json(v))).collect()),
        PVal::JewelFunc(_) => json!("<function>"),
    }
}

fn gate_of(m: &PMod) -> Option<J> {
    let t: Vec<J> = m.tags.iter().map(pval_json).filter(|t| t["type"] == "SkillType" || t["type"] == "Condition" || t["type"] == "ActorCondition").collect();
    (!t.is_empty()).then(|| J::Array(t))
}

pub fn scan(lines: &[Line], gems: &[Gem], stat_map: &HashSet<String>, stat_mods: &std::collections::HashMap<String, Vec<String>>, reg: &Registry, rules: Option<&Rules>) -> Scan {
    let mut out = Scan::default();
    let hit = |out: &mut Scan, class: &str, h: J| out.classes.entry(class.to_string()).or_default().push(h);
    let keyword = |t: &str| reg.keywords.iter().any(|k| t.contains(k.as_str()));
    let mut i = 0;
    while i < lines.len() {
        let l = &lines[i];
        let text = max_roll(&l.text);
        let mut r = pom_engine::modparser::text_rules::parse_mod_no_rules(&text);
        // (a stat line split over two entries, as the passive and item parsers join them)
        if !matches!(r, (Some(_), None)) && lines.get(i + 1).is_some_and(|n| n.source == l.source) {
            let joined = format!("{text} {}", max_roll(&lines[i + 1].text));
            let r2 = pom_engine::modparser::text_rules::parse_mod_no_rules(&joined);
            if matches!(r2, (Some(_), None)) {
                r = r2;
                i += 1;
            }
        }
        i += 1;
        let (mods, via) = match r {
            (Some(m), None) => (m, "parser".to_string()),
            (partial, _) => match rules.and_then(|ru| ru.apply(&text)) {
                Some((rule, m)) => (m, format!("text-rule:{}", rule.id)),
                None => {
                    let n = normalize(&text);
                    if keyword(&n) {
                        let what = if partial.is_some() { "partial parse" } else { "unread" };
                        out.unclassified.push((format!("line: {n}"), format!("{} {} ({what}): {}", l.kind, l.source, l.text)));
                    }
                    continue;
                }
            },
        };
        for m in &mods {
            if let Some(c) = reg.class_of_mod(&m.name, &tag_vars(m)) {
                let mut h = json!({ "source": l.source, "kind": l.kind, "key": m.name, "value": pval_json(&m.value), "via": via, "line": l.text });
                if let Some(g) = gate_of(m) {
                    h["gate"] = g;
                }
                hit(&mut out, c, h);
            }
        }
    }
    for g in gems {
        if let Some(c) = reg.classes.iter().find(|c| c.adds.is_some_and(|a| g.adds.contains(&a)) && c.requires.is_some_and(|r| g.requires.contains(&r))) {
            hit(&mut out, &c.class, json!({ "source": g.id, "kind": "gem", "key": "structure", "value": json!({"adds": c.adds, "requires": c.requires}), "via": "structure" }));
        }
        for (id, v) in &g.stats {
            if let Some(c) = reg.class_of_stat(id) {
                hit(&mut out, c, json!({ "source": g.id, "kind": "gem", "key": id, "value": v, "via": "stat" }));
                continue;
            }
            if let Some(c) = stat_mods.get(id).into_iter().flatten().find_map(|m| reg.class_of_mod(m, &[])) {
                hit(&mut out, c, json!({ "source": g.id, "kind": "gem", "key": id, "value": v, "via": "statmap" }));
                continue;
            }
            if stat_map.contains(id) || reg.inert_prefixes.iter().any(|p| id.starts_with(p.as_str())) || reg.inert_contains.iter().any(|p| id.contains(p.as_str())) {
                continue;
            }
            out.dropped_stats += 1;
            out.unclassified.push((format!("stat: {id}"), format!("gem {}: stat {id} has no stat map entry and no class", g.id)));
        }
    }
    let mut seen = HashSet::default();
    out.unclassified.retain(|(k, _)| seen.insert(k.clone()));
    out
}

/// The game data's lines and gems (uniques, the newest passive tree, item mod pools, gems).
pub fn data_sources(dir: &std::path::Path) -> Result<(Vec<Line>, Vec<Gem>, HashSet<String>, std::collections::HashMap<String, Vec<String>>), String> {
    let read = |f: &str| -> Result<J, String> { serde_json::from_str(&std::fs::read_to_string(dir.join(f)).map_err(|e| format!("{f}: {e}"))?).map_err(|e| format!("{f}: {e}")) };
    let mut lines = Vec::new();
    let meta = regex::Regex::new(r"^[A-Za-z ]+:\s|^[A-Za-z ]+:$").unwrap();
    let strip = regex::Regex::new(r"\{[^}]*\}").unwrap();
    for (_, list) in read("data_uniques.json")?.as_object().ok_or("data_uniques.json")? {
        for u in list.as_array().into_iter().flatten().filter_map(|u| u.as_str()) {
            let mut it = u.lines();
            let name = it.next().unwrap_or("").to_string();
            for l in it.skip(1) {
                let l = strip.replace_all(l, "").trim().to_string();
                if !l.is_empty() && !meta.is_match(&l) {
                    lines.push(Line { kind: "unique", source: name.clone(), text: l });
                }
            }
        }
    }
    // The newest tree (tree_3_<n>.json with the highest n, no ruthless/alternate variant).
    let tree = std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().filter_map(|e| e.file_name().into_string().ok()).filter_map(|f| f.strip_prefix("tree_3_").and_then(|r| r.strip_suffix(".json")).and_then(|n| n.parse::<u32>().ok()).map(|n| (n, f.clone()))).max();
    if let Some((_, f)) = tree {
        for (id, n) in read(&f)?["nodes"].as_object().into_iter().flatten() {
            let name = format!("{} ({id})", n["dn"].as_str().unwrap_or(""));
            for l in n["sd"].as_array().into_iter().flatten().filter_map(|s| s.as_str()) {
                lines.push(Line { kind: "node", source: name.clone(), text: l.to_string() });
            }
        }
    }
    for (_, pool) in read("data_itemMods.json")?.as_object().into_iter().flatten() {
        for (id, m) in pool.as_object().into_iter().flatten() {
            for k in 1..=4 {
                if let Some(t) = m[k.to_string()].as_str() {
                    lines.push(Line { kind: "mod", source: id.clone(), text: t.to_string() });
                }
            }
        }
    }
    let map = read("data_skillStatMap.json")?;
    let per = read("data_skillStatMapPerSkill.json")?;
    let mut stat_map: HashSet<String> = map.as_object().into_iter().flatten().map(|(k, _)| k.clone()).collect();
    let mut stat_mods: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (k, v) in map.as_object().into_iter().flatten() {
        stat_mods.insert(k.clone(), v.as_array().into_iter().flatten().filter_map(|m| m["name"].as_str().map(String::from)).collect());
    }
    for (_, s) in per.as_object().into_iter().flatten() {
        stat_map.extend(s.as_object().into_iter().flatten().map(|(k, _)| k.clone()));
    }
    let ints = |v: &J| -> Vec<i64> { v.as_array().map(|a| a.iter().filter_map(|x| x.as_i64()).collect()).unwrap_or_default() };
    let mut gems = Vec::new();
    for (id, s) in read("data_skills.json")?.as_object().into_iter().flatten() {
        let mut stats: Vec<(String, f64)> = s["stats"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(|x| (x.to_string(), 1.0))).collect();
        for key in ["constantStats", "qualityStats"] {
            stats.extend(s[key].as_array().into_iter().flatten().filter_map(|c| Some((c[0].as_str()?.to_string(), c[1].as_f64().unwrap_or(0.0)))));
        }
        gems.push(Gem { id: id.clone(), stats, adds: ints(&s["addSkillTypes"]), requires: ints(&s["requireSkillTypes"]) });
    }
    Ok((lines, gems, stat_map, stat_mods))
}

/// `pom-cli mechanics-scan <out.json> [--seed]`: scans, writes the mechanics file, prints the unclassified report.
/// Exit 1 when the report has items not in mechanics_reviewed.json (beside the output); `--seed` writes every
/// current item into the reviewed list instead (first run of a data version a human then classifies).
pub fn run(dir: &std::path::Path, out_path: &std::path::Path, seed: bool) -> Result<i32, String> {
    let t = std::time::Instant::now();
    let reg = super::clear::registry();
    let rules = Rules::from_json(include_str!("../../../engine-data/mechanic_text_rules.json"))?;
    let (lines, gems, stat_map, stat_mods) = data_sources(dir)?;
    let s = scan(&lines, &gems, &stat_map, &stat_mods, reg, Some(&rules));
    let reviewed_path = out_path.with_file_name("mechanics_reviewed.json");
    let reviewed: HashSet<String> = std::fs::read_to_string(&reviewed_path).ok().and_then(|t| serde_json::from_str::<J>(&t).ok()).and_then(|j| j["reviewed"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())).unwrap_or_default();
    let mut h: u64 = 0xcbf29ce484222325;
    for l in &lines {
        for b in l.text.bytes() {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        }
    }
    let counts: serde_json::Map<String, J> = s.classes.iter().map(|(k, v)| (k.clone(), json!(v.len()))).collect();
    let doc = json!({
        "schema": "2",
        "about": "Generated by pom-cli mechanics-scan from the game data: every source of each mechanic class (mechanic_classes.json), found by parsed mod name, flag, tag var, gem stat id or support structure. via: parser | text-rule:<id> | stat | statmap | structure.",
        "dataHash": format!("{h:016x}"),
        "lines": lines.len(), "gems": gems.len(),
        "counts": counts,
        "classes": s.classes,
    });
    std::fs::write(out_path, serde_json::to_string_pretty(&doc).unwrap()).map_err(|e| format!("{}: {e}", out_path.display()))?;
    let new: Vec<&(String, String)> = s.unclassified.iter().filter(|(k, _)| !reviewed.contains(k)).collect();
    if seed {
        let all: Vec<&String> = s.unclassified.iter().map(|(k, _)| k).collect();
        std::fs::write(&reviewed_path, serde_json::to_string_pretty(&json!({ "about": "Report items a human reviewed (classified with a registry row or text rule, or inert). pom-cli mechanics-scan fails only on items not listed here. Seeded from the current data; review the 'line:' entries (keyword hits) once.", "reviewed": all })).unwrap()).map_err(|e| e.to_string())?;
    }
    for (_, what) in &new {
        println!("UNCLASSIFIED {what}");
    }
    println!(
        "mechanics-scan: {} lines, {} gems, {} classes with sources ({}), {} unclassified ({} keyword lines, {} dropped stat ids), {} new, {:.1} s",
        lines.len(),
        gems.len(),
        s.classes.len(),
        s.classes.iter().map(|(k, v)| format!("{k} {}", v.len())).collect::<Vec<_>>().join(", "),
        s.unclassified.len(),
        s.unclassified.iter().filter(|(k, _)| k.starts_with("line:")).count(),
        s.dropped_stats,
        if seed { 0 } else { new.len() },
        t.elapsed().as_secs_f64()
    );
    Ok(if !seed && !new.is_empty() { 1 } else { 0 })
}
