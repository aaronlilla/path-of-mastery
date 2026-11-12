//! The import matcher of `PassiveSpec:BuildSubgraph` (`addToAllocatedSubgraphNodes`, Classes/PassiveSpec.lua
//! l.2046-2072): a character imported from pathofexile.com names the cluster jewel passives it has allocated by
//! GGG's own ids (`hashes_ex`), and describes each socketed cluster jewel's subgraph (`jewel_data[*].subgraph`:
//! groups with a proxy id, nodes with an orbit index). When a subgraph is built, a generated node counts as
//! allocated if the imported node in its proxy group with the same orbit index (or the keystone) is in `hashes_ex`.
//!
//! The import data reaches the spec through a thread-local (`with_import`), read once when a spec is made, so the
//! many `spec_from_xml*` callers keep their signatures.

use std::cell::RefCell;
use std::rc::Rc;

#[derive(Debug, Clone)]
pub struct ImportGroup {
    /// The proxy node id the group stands in for (`groupData.proxy`).
    pub proxy: i64,
    /// The ids (GGG's, as JSON strings) of the group's nodes.
    pub nodes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ImportNode {
    pub group: Option<String>,
    pub is_keystone: bool,
    pub is_mastery: bool,
    pub orbit_index: Option<i64>,
}

#[derive(Debug, Default)]
pub struct ImportClusters {
    /// `spec.extended_hashes`.
    pub hashes_ex: Vec<i64>,
    /// `importedGroups`: every subgraph group of every jewel, in the order the jewel data lists them.
    pub groups: Vec<(String, ImportGroup)>,
    /// `importedNodes`.
    pub nodes: Vec<(String, ImportNode)>,
    /// The `hashes_ex` ids that allocated a generated node.
    pub matched: RefCell<Vec<i64>>,
}

fn as_num(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        serde_json::Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

impl ImportClusters {
    /// `jewel_data` is the answer's `jewel_data` object: socket id -> `{type, radius, subgraph: {groups, nodes}}`.
    pub fn from_json(hashes_ex: &[i64], jewel_data: &serde_json::Value) -> ImportClusters {
        let mut out = ImportClusters { hashes_ex: hashes_ex.to_vec(), ..Default::default() };
        let Some(jewels) = jewel_data.as_object() else { return out };
        for value in jewels.values() {
            let Some(sub) = value.get("subgraph") else { continue };
            if let Some(groups) = sub.get("groups").and_then(|g| g.as_object()) {
                for (gid, g) in groups {
                    let Some(proxy) = g.get("proxy").and_then(as_num) else { continue };
                    let nodes = g.get("nodes").and_then(|n| n.as_array()).map(|a| a.iter().filter_map(|x| match x {
                        serde_json::Value::String(s) => Some(s.clone()),
                        serde_json::Value::Number(n) => Some(n.to_string()),
                        _ => None,
                    }).collect()).unwrap_or_default();
                    // `importedGroups[groupId] = groupData`: a later jewel's group of the same name replaces the earlier.
                    out.groups.retain(|(k, _)| k != gid);
                    out.groups.push((gid.clone(), ImportGroup { proxy, nodes }));
                }
            }
            if let Some(nodes) = sub.get("nodes").and_then(|g| g.as_object()) {
                for (nid, n) in nodes {
                    let flag = |k: &str| n.get(k).map(|v| v.as_bool().unwrap_or(false)).unwrap_or(false);
                    out.nodes.retain(|(k, _)| k != nid);
                    out.nodes.push((nid.clone(), ImportNode { group: n.get("group").and_then(|v| v.as_str()).map(String::from), is_keystone: flag("isKeystone"), is_mastery: flag("isMastery"), orbit_index: n.get("orbitIndex").and_then(as_num) }));
                }
            }
        }
        out
    }

    /// `addToAllocatedSubgraphNodes` for a generated node (type `kind`, orbit index `oidx`) of the subgraph under
    /// the socket whose proxy node is `proxy`: the extended hash it takes, when it counts as allocated.
    pub fn matches(&self, proxy: i64, kind: &str, oidx: i64) -> Option<i64> {
        let (group_id, group) = self.groups.iter().find(|(_, g)| g.proxy == proxy)?;
        for (id, data) in &self.nodes {
            if data.group.as_deref() != Some(group_id.as_str()) {
                continue;
            }
            let hit = (kind == "Keystone" && data.is_keystone) || (Some(oidx) == data.orbit_index && !data.is_mastery);
            if hit {
                // The first imported node that fits decides: it must be one of the group's nodes and an extended hash.
                if group.nodes.iter().any(|n| n == id) {
                    let h = id.parse::<i64>().ok()?;
                    if self.hashes_ex.contains(&h) {
                        return Some(h);
                    }
                }
                return None;
            }
        }
        None
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Rc<ImportClusters>>> = const { RefCell::new(None) };
}

/// Runs `f` with `import` as the data every spec made inside it reads (and clears it afterwards, panics included).
pub fn with_import<R>(import: Rc<ImportClusters>, f: impl FnOnce() -> R) -> R {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            CURRENT.with(|c| *c.borrow_mut() = None);
        }
    }
    CURRENT.with(|c| *c.borrow_mut() = Some(import));
    let _reset = Reset;
    f()
}

pub fn current() -> Option<Rc<ImportClusters>> {
    CURRENT.with(|c| c.borrow().clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> ImportClusters {
        let jd = serde_json::json!({
            "20": { "type": "JewelPassiveTreeExpansionLarge", "subgraph": {
                "groups": { "expansion_20": { "proxy": "18756", "nodes": ["1195", "195", "196", "198"] } },
                "nodes": {
                    "1195": { "group": "expansion_20", "isMastery": true, "orbitIndex": 0 },
                    "195": { "group": "expansion_20", "orbitIndex": 0 },
                    "196": { "group": "expansion_20", "orbitIndex": 3 },
                    "198": { "group": "expansion_20", "orbitIndex": 9 },
                    "9": { "group": "expansion_other", "isKeystone": true, "orbitIndex": 1 }
                } } }
        });
        ImportClusters::from_json(&[196, 198], &jd)
    }

    #[test]
    fn a_node_takes_the_imported_node_with_its_orbit_index_when_that_is_an_extended_hash() {
        let d = data();
        assert_eq!(d.matches(18756, "Notable", 3), Some(196));
        assert_eq!(d.matches(18756, "Normal", 9), Some(198));
        // orbit index 0 is the first imported node (the mastery is skipped), 195 is not an extended hash
        assert_eq!(d.matches(18756, "Mastery", 0), None);
        assert_eq!(d.matches(18756, "Normal", 5), None);
        assert_eq!(d.matches(1, "Normal", 3), None);
    }
}
