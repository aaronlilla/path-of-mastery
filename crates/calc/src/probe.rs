//! Parses the `PROBE(name, value)` JSONL output
//! (`{"probe":name,"build":build,"n":k,"v":value}` per line). `perform_curses.rs`/`perform_minions.rs`
//! both call `PROBE(name, jsonString)`
//! with a hand-built JSON string as the value (reusing the calc recorder's
//! `serMod`/`serModList` conventions so the payload parses with `snapshot::parse_mod`), so the
//! generic `ser()` this file's own value goes through double-encodes it: `v` comes back as a JSON
//! *string* holding JSON text, which `probe_value` decodes a second time.
use serde_json::Value as J;
use pom_engine::fxhash::HashMap;
use std::path::Path;

pub struct ProbeLine {
    pub build: String,
    pub n: i64,
    pub v: J,
}

/// One probe name's captures, keyed by `(build, n)` - the same `n`-th call within that build
/// pairs an "in" probe with its matching "out" probe on the same line of source (both increment
/// their own per-probe-name counter on every `calcs.perform`/`initMinionModDB` call, so the k-th
/// "curse_in" and k-th "curse_out" always belong to the same call).
pub fn load_probe(path: &Path, name: &str) -> HashMap<(String, i64), J> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {}", path.display(), e));
    let mut out = HashMap::default();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let row: J = serde_json::from_str(line).unwrap_or_else(|e| panic!("bad probe line: {e}: {line}"));
        let Some(probe_name) = row.get("probe").and_then(|x| x.as_str()) else { continue };
        if probe_name != name {
            continue;
        }
        let build = row.get("build").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if build.is_empty() || build == "nil" {
            continue; // headless warmup passes before the first real build loads
        }
        let n = row.get("n").and_then(|x| x.as_i64()).unwrap_or(0);
        let v_str = row.get("v").and_then(|x| x.as_str()).unwrap_or("null");
        let v: J = match serde_json::from_str(v_str) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("skipping bad probe payload for {name} {build}#{n}: {e}");
                continue;
            }
        };
        out.insert((build, n), v);
    }
    out
}

#[allow(dead_code)]
pub fn load_probe_lines(path: &Path, name: &str) -> Vec<ProbeLine> {
    load_probe(path, name).into_iter().map(|((build, n), v)| ProbeLine { build, n, v }).collect()
}
