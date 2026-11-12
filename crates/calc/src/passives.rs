//! Reads the passives crate's own recording (`engine-data/passive_golden/corpus.jsonl`) for
//! the tree-node contribution to a build's modDB. Only covers the common case
//! (Modules/CalcSetup.lua's `calcs.buildModListForNode` without any radius-jewel scaling,
//! `PassiveSkillEffect`/`PassiveSkillHasNoEffect`/`PassiveSkillHasOtherEffect` handling, or the
//! granted-passive re-expansion at `initEnv` lines 1387-1422 that can add extra allocated nodes
//! after items are processed): each allocated node's own recorded `mods` (source `"Tree:<id>"`),
//! summed with no scaling or filtering.
use crate::rawlua::parse_raw_mod;
use pom_engine::modifier::Mod;
use serde_json::Value as J;
use pom_engine::fxhash::HashMap;

#[derive(Default)]
pub struct NodeTypeCounts {
    pub notable: usize,
    pub keystone: usize,
    pub mastery: usize,
}

pub struct PassivesCorpus {
    by_build: HashMap<String, Vec<Mod>>,
    counts: HashMap<String, NodeTypeCounts>,
}

impl PassivesCorpus {
    pub fn load(path: &std::path::Path) -> PassivesCorpus {
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {}", path.display(), e));
        let mut by_build = HashMap::default();
        let mut counts = HashMap::default();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let v: J = serde_json::from_str(line).unwrap_or_else(|e| panic!("bad passive_golden line: {e}"));
            let Some(name) = v.get("name").and_then(|n| n.as_str()) else { continue };
            if v.get("ok").and_then(|o| o.as_bool()) != Some(true) {
                continue;
            }
            let mut mods = Vec::new();
            let mut nc = NodeTypeCounts::default();
            if let Some(nodes) = v.get("nodeMods").and_then(|n| n.as_array()) {
                for node in nodes {
                    if let Some(node_mods) = node.get("mods").and_then(|m| m.as_array()) {
                        for m in node_mods {
                            mods.push(parse_raw_mod(m));
                        }
                    }
                    match node.get("type").and_then(|t| t.as_str()) {
                        Some("Notable") => nc.notable += 1,
                        Some("Keystone") => nc.keystone += 1,
                        Some("Mastery") => nc.mastery += 1,
                        _ => {}
                    }
                }
            }
            by_build.insert(name.to_string(), mods);
            counts.insert(name.to_string(), nc);
        }
        PassivesCorpus { by_build, counts }
    }

    /// The tree-mod contribution for one build, or `None` if it isn't in this corpus (or its
    /// passive recording failed).
    pub fn tree_mods(&self, build_name: &str) -> Option<&[Mod]> {
        self.by_build.get(build_name).map(|v| v.as_slice())
    }

    /// Allocated Notable/Keystone/Mastery counts (`initEnv` lines 702-705's
    /// `env.spec.allocatedNotableCount` etc.), derived here from each allocated node's `type`
    /// since the passives crate's recording doesn't carry the pre-computed spec fields directly.
    /// Mastery *type* counts (`allocatedMasteryTypeCount`, `AllocatedLifeMastery`) need grouping
    /// masteries by their mastery-group name, which isn't in this recording either; not derived
    /// here.
    pub fn node_type_counts(&self, build_name: &str) -> Option<&NodeTypeCounts> {
        self.counts.get(build_name)
    }
}
