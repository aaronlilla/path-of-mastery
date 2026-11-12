//! Shared by `treedata.rs` (the tree's own nodes, parsed once when the tree loads, matching
//! Classes/PassiveTree.lua `ProcessStats` running once at tree-load time) and `spec.rs` (mastery
//! effect selection and, later, tattoo/conquered-node replacement, matching
//! Classes/PassiveSpec.lua `NodeAdditionOrReplacementFromString`, which reuses the same parse
//! loop). Both call `modLib.parseMod` per `sd` line, retrying by combining with following lines
//! when a line doesn't parse cleanly on its own.

use pom_engine::modparser::parse_mod;
use pom_engine::modparser::types::{PMod, PVal};
use serde_json::Value as J;

fn set_source(pm: &mut PMod, source: &str) {
    pm.source = Some(source.to_string());
    if let PVal::Map(fields) = &mut pm.value {
        for (k, v) in fields.iter_mut() {
            if k == "mod" {
                if let PVal::Map(inner) = v {
                    if let Some(pos) = inner.iter().position(|(kk, _)| kk == "source") {
                        inner[pos].1 = PVal::Str(source.to_string());
                    } else {
                        inner.push(("source".to_string(), PVal::Str(source.to_string())));
                    }
                }
            }
        }
    }
}

/// Port of Classes/PassiveTree.lua `ProcessStats` / PassiveSpec.lua `NodeAdditionOrReplacementFromString`'s
/// parse loop: both parse `sd` lines through `modLib.parseMod`, retrying by combining with
/// following lines when a line doesn't parse cleanly on its own, then flatten the per-line results
/// (skipping lines the parser never resolved) into one ordered mod list with `Tree:<id>` sourced.
pub fn process_stats(sd: &[String], node_id: i64) -> Vec<PMod> {
    let mut lines: Vec<String> = Vec::new();
    for s in sd {
        if s.contains('\n') {
            lines.extend(s.split('\n').filter(|p| !p.is_empty()).map(|p| p.to_string()));
        } else {
            lines.push(s.clone());
        }
    }
    let mut per_line: Vec<Option<Vec<PMod>>> = vec![None; lines.len()];
    let mut i = 0;
    while i < lines.len() {
        let (mut list, mut extra) = parse_mod(&lines[i]);
        if list.is_none() || extra.is_some() {
            let mut end_i = i + 1;
            while end_i < lines.len() {
                let comb = lines[i..=end_i].join(" ");
                let (l2, e2) = parse_mod(&comb);
                if l2.is_some() && e2.is_none() {
                    list = l2;
                    extra = None;
                    for k in (i + 1)..=end_i {
                        per_line[k] = Some(Vec::new());
                    }
                    break;
                }
                end_i += 1;
            }
        }
        per_line[i] = Some(if extra.is_none() { list.unwrap_or_default() } else { Vec::new() });
        i += 1;
        while i < lines.len() && per_line[i].is_some() {
            i += 1;
        }
    }
    let source = format!("Tree:{}", node_id);
    let mut out = Vec::new();
    for entry in per_line.into_iter().flatten() {
        for mut pm in entry {
            set_source(&mut pm, &source);
            out.push(pm);
        }
    }
    out
}

// ---- JSON -> PMod (used only for legion/tattoo template nodes, whose exported `mods` already
// carry the template's own baked-in source, e.g. "Tree:vaal_keystone_2" -- not the numeric id of
// whatever node they're replacing onto. `ReplaceNode`'s `old.modList:AddList(newNode.modList)`
// copies those mods verbatim, so this reconstructs the same flat list from the tree export's
// per-line `mods` array (`crate::treedata`'s eagerly-resolved node JSON) rather than reparsing
// `sd` through `process_stats`, which would re-source everything to the wrong node id. ----

fn pval_from_json(v: &J) -> PVal {
    match v {
        J::Number(n) => PVal::Num(n.as_f64().unwrap_or(0.0)),
        J::Bool(b) => PVal::Bool(*b),
        J::String(s) if s == "Inf" => PVal::Num(f64::INFINITY),
        J::String(s) if s == "-Inf" => PVal::Num(f64::NEG_INFINITY),
        J::String(s) => PVal::Str(s.clone()),
        J::Array(a) => PVal::List(a.iter().map(pval_from_json).collect()),
        J::Object(o) => PVal::Map(o.iter().map(|(k, v)| (k.clone(), pval_from_json(v))).collect()),
        J::Null => PVal::Bool(false),
    }
}

fn pmod_from_json(v: &J) -> Option<PMod> {
    let obj = v.as_object()?;
    let name = obj.get("name")?.as_str()?.to_string();
    let ty = obj.get("type")?.as_str()?.to_string();
    let value = obj.get("value").map(pval_from_json).unwrap_or(PVal::Bool(false));
    let flags = obj.get("flags").and_then(|v| v.as_u64()).unwrap_or(0);
    let keyword_flags = obj.get("keywordFlags").and_then(|v| v.as_u64()).unwrap_or(0);
    let source = obj.get("source").and_then(|v| v.as_str()).map(|s| s.to_string());
    let mut tags = Vec::new();
    let mut i = 1usize;
    while let Some(t) = obj.get(&i.to_string()) {
        tags.push(pval_from_json(t));
        i += 1;
    }
    Some(PMod { name, ty, value, flags, keyword_flags, source, tags, unreachable_tags: Vec::new() })
}

fn json_seq(v: &J) -> Vec<&J> {
    match v {
        J::Array(a) => a.iter().collect(),
        J::Object(o) => {
            let mut keys: Vec<usize> = o.keys().filter_map(|k| k.parse().ok()).collect();
            keys.sort();
            keys.into_iter().filter_map(|k| o.get(&k.to_string())).collect()
        }
        _ => Vec::new(),
    }
}

/// Flattens a tree node's exported per-line `mods` (`[{list:[mod,...], extra?}, ...]`, `sd`'s
/// per-line parse result: see `Classes/PassiveTree.lua` `ProcessStats`) into one ordered mod
/// list, skipping any line whose `extra` is true, matching `ProcessStats`'s own flattening loop
/// exactly. Every mod inside keeps the source it was exported with.
pub fn flatten_node_mods_json(mods: pom_engine::cjson::J) -> Vec<PMod> {
    flatten_node_mods_value(&mods.to_value())
}

fn flatten_node_mods_value(mods: &J) -> Vec<PMod> {
    let mut out = Vec::new();
    for entry in json_seq(mods) {
        // Lua-truthy, not a JSON boolean: `extra` is `true` for some entries but the *leftover
        // unparsed text itself* (a non-empty string) for others, e.g. a stat line the exporter's
        // modparser could only partially match. Either shape means this entry's `list` is a bogus
        // partial parse (its "mod" here is not what the live original's own modList ends up with,
        // confirmed by grading a real build with a "Starlight Swig" Kalguur notable: the exported
        // `mods` carries a `{"extra": " for  to be Restored...", "list": [{"name": "Ward", ...}]}`
        // entry, but the graded, live-parsed answer never has that Ward mod at all), so it must be
        // dropped the same way a literal `extra = true` entry already was.
        let extra = entry.get("extra").map(|v| !matches!(v, J::Null | J::Bool(false))).unwrap_or(false);
        if extra {
            continue;
        }
        let Some(list) = entry.get("list") else { continue };
        for item in json_seq(list) {
            if let Some(pm) = pmod_from_json(item) {
                out.push(pm);
            }
        }
    }
    out
}
