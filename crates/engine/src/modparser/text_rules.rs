//! Text rules: data-driven readers for mod lines `parse_mod` leaves unread or partly read
//! (engine-data/mechanic_text_rules.json). Not part of the upstream port: rules apply only on threads that turn them on (`set_active`, the solver's), so the answer-key tests never see a rule.
//! A rule reads a whole line by one case-insensitive regex with
//! named captures and fills a mod template; a gate capture (`"gate": "q"`) is looked up in the
//! file's `killQualifiers` (words -> extra tags). An unknown qualifier reads nothing, so the line
//! stays unread and the mechanics scan reports it.
use crate::modparser::types::{PMod, PVal};
use serde_json::Value as J;
use std::sync::{Arc, RwLock};

pub struct Rule {
    pub id: String,
    pub class: String,
    re: regex::Regex,
    mods: Vec<J>,
    gate: Option<String>,
}

#[derive(Default)]
pub struct Rules {
    pub rules: Vec<Rule>,
    qualifiers: Vec<(String, Vec<J>)>,
}

static LOADED: RwLock<Option<Arc<Rules>>> = RwLock::new(None);

impl Rules {
    pub fn from_json(text: &str) -> Result<Rules, String> {
        let j: J = serde_json::from_str(text).map_err(|e| format!("text rules: {e}"))?;
        let mut rules = Vec::new();
        for r in j["rules"].as_array().into_iter().flatten() {
            let id = r["id"].as_str().unwrap_or("").to_string();
            let re = regex::Regex::new(&format!("(?i){}", r["match"].as_str().unwrap_or("^$"))).map_err(|e| format!("text rule {id}: {e}"))?;
            rules.push(Rule { id, class: r["class"].as_str().unwrap_or("").to_string(), re, mods: r["mods"].as_array().cloned().unwrap_or_default(), gate: r["gate"].as_str().map(String::from) });
        }
        let qualifiers = j["killQualifiers"].as_object().map(|o| o.iter().map(|(k, v)| (k.to_lowercase(), v.as_array().cloned().unwrap_or_default())).collect()).unwrap_or_default();
        Ok(Rules { rules, qualifiers })
    }

    /// The first rule that reads the whole line: its id, class and mods.
    pub fn apply(&self, line: &str) -> Option<(&Rule, Vec<PMod>)> {
        let l = line.trim();
        for r in &self.rules {
            let Some(c) = r.re.captures(l) else { continue };
            let cap = |n: &str| c.name(n).map(|m| m.as_str().to_string());
            let mut extra_tags = Vec::new();
            if let Some(q) = r.gate.as_deref().and_then(|g| cap(g)) {
                let q = q.trim().to_lowercase();
                // (fails closed: an unknown qualifier reads nothing)
                let (_, tags) = self.qualifiers.iter().find(|(k, _)| *k == q)?;
                extra_tags = tags.iter().map(|t| fill(t, &cap)).collect::<Option<Vec<_>>>()?;
            }
            let mut out = Vec::new();
            for m in &r.mods {
                let mut tags: Vec<PVal> = m["tags"].as_array().into_iter().flatten().map(|t| fill(t, &cap)).collect::<Option<_>>()?;
                tags.extend(extra_tags.iter().cloned());
                out.push(PMod { name: m["name"].as_str()?.to_string(), ty: m["type"].as_str()?.to_string(), value: fill(&m["value"], &cap)?, flags: 0, keyword_flags: 0, source: None, tags, unreachable_tags: vec![] });
            }
            return Some((r, out));
        }
        None
    }
}

/// A template value with captures filled: `"$n"` the capture as a number, `"$c/100|1"` the capture divided by 100 or
/// 1 when absent, `"$t:title"` the capture with its first letter upper-cased; any other value as written.
fn fill(t: &J, cap: &dyn Fn(&str) -> Option<String>) -> Option<PVal> {
    Some(match t {
        J::Bool(b) => PVal::Bool(*b),
        J::Number(n) => PVal::Num(n.as_f64()?),
        J::Array(a) => PVal::List(a.iter().map(|x| fill(x, cap)).collect::<Option<_>>()?),
        J::Object(o) => PVal::Map(o.iter().map(|(k, v)| fill(v, cap).map(|v| (k.clone(), v))).collect::<Option<_>>()?),
        J::String(s) => match s.strip_prefix('$') {
            None => PVal::Str(s.clone()),
            Some(e) => {
                if let Some(name) = e.strip_suffix(":title") {
                    let v = cap(name)?;
                    let mut ch = v.chars();
                    PVal::Str(ch.next().map(|f| f.to_uppercase().collect::<String>() + ch.as_str()).unwrap_or_default())
                } else {
                    let (expr, default) = e.split_once('|').map_or((e, None), |(a, d)| (a, d.parse::<f64>().ok()));
                    let (name, div) = expr.split_once('/').map_or((expr, 1.0), |(a, d)| (a, d.parse::<f64>().unwrap_or(1.0)));
                    match cap(name) {
                        Some(v) => PVal::Num(v.parse::<f64>().ok()? / div),
                        None => PVal::Num(default?),
                    }
                }
            }
        },
        J::Null => return None,
    })
}

/// Loads the table every later `parse_mod` call consults (process-wide). Returns the rule count.
pub fn load(text: &str) -> Result<usize, String> {
    let r = Rules::from_json(text)?;
    let n = r.rules.len();
    *LOADED.write().unwrap() = Some(Arc::new(r));
    Ok(n)
}

pub fn load_file(path: &std::path::Path) -> Result<usize, String> {
    load(&std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?)
}

pub fn loaded() -> Option<Arc<Rules>> {
    LOADED.read().ok()?.clone()
}

type Parsed = (Option<Vec<PMod>>, Option<String>);

thread_local! {
    /// Rules apply only on threads that turned them on (the build solver's): every other parse, the open build's
    /// included, reads exactly like upstream.
    static ACTIVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Inside the hook's own call of the parser (and `parse_mod_no_rules`): no rules.
    static INNER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Turns the loaded rules on or off for this thread; returns the previous setting.
pub fn set_active(on: bool) -> bool {
    ACTIVE.with(|a| a.replace(on))
}

fn inner<T>(f: impl FnOnce() -> T) -> T {
    let prev = INNER.with(|i| i.replace(true));
    let r = f();
    INNER.with(|i| i.set(prev));
    r
}

/// `parse_mod`'s hook: on a thread with rules on, the parser's own reading, or the rules' reading of a line it left
/// unread or partly read. None (the plain parse goes on) everywhere else.
pub fn wrap(line: &str, parse: fn(&str) -> Parsed) -> Option<Parsed> {
    if !ACTIVE.with(|a| a.get()) || INNER.with(|i| i.get()) {
        return None;
    }
    let rules = loaded()?;
    let r = inner(|| parse(line));
    if matches!(r, (Some(_), None)) {
        return Some(r);
    }
    Some(rules.apply(line).map_or(r, |(_, m)| (Some(m), None)))
}

/// `parse_mod` without the text rules: the port's own reading (what the mechanics scan audits).
pub fn parse_mod_no_rules(line: &str) -> Parsed {
    inner(|| crate::modparser::parse::parse_mod(line))
}
