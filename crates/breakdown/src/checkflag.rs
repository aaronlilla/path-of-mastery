//! Port of `Classes/CalcsTab.lua`'s `CalcsTab:CheckFlag` (the visibility gate every section, row
//! and cell goes through). Minion mode (`self.input.showMinion`) is not ported: `actor`/`player`
//! are always the main player actor, so the
//! `playerFlag` branch (`(player or self.calcsEnv.player)`) collapses to the same skillFlags map
//! as the plain `flag` branch.
use serde_json::Value as J;

pub struct FlagObj<'a> {
    pub flag: Option<&'a str>,
    pub not_flag: Option<&'a str>,
    pub flag_list: Option<&'a [String]>,
    pub not_flag_list: Option<&'a [String]>,
    pub player_flag: Option<&'a str>,
    pub have_output: Option<&'a str>,
}

fn split_ns_var(key: &str) -> Option<(&str, &str)> {
    let dot = key.find('.')?;
    let (ns, rest) = key.split_at(dot);
    let var = &rest[1..];
    let is_alpha = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphabetic());
    if is_alpha(ns) && is_alpha(var) {
        Some((ns, var))
    } else {
        None
    }
}

/// `not actor.output[key] or actor.output[key] == 0` (or the `ns.var` two-step form). Lua's `==`
/// never equates a string/table to the number `0`, so a *string* output value (however it reads)
/// is always truthy here -- only `nil`/`false`/the number `0` fail this check.
fn have_output_ok(output: &J, key: &str) -> bool {
    let v = if let Some((ns, var)) = split_ns_var(key) { output.get(ns).and_then(|s| s.get(var)) } else { output.get(key) };
    match v {
        None | Some(J::Null) => false,
        Some(J::Bool(b)) => *b,
        Some(J::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(_) => true,
    }
}

pub fn check_flag(obj: &FlagObj, skill_flags: &std::collections::HashMap<String, bool>, output: &J) -> bool {
    let has = |f: &str| skill_flags.get(f).copied().unwrap_or(false);
    if let Some(f) = obj.flag {
        if !has(f) {
            return false;
        }
    }
    if let Some(list) = obj.flag_list {
        for f in list {
            if !has(f) {
                return false;
            }
        }
    }
    if let Some(pf) = obj.player_flag {
        if !has(pf) {
            return false;
        }
    }
    if let Some(nf) = obj.not_flag {
        if has(nf) {
            return false;
        }
    }
    if let Some(list) = obj.not_flag_list {
        for f in list {
            if has(f) {
                return false;
            }
        }
    }
    if let Some(ho) = obj.have_output {
        if !have_output_ok(output, ho) {
            return false;
        }
    }
    true
}
