//! Port of `PassiveSpec.lua` `BuildSubgraph` (cluster jewel node/connector generation) plus the
//! static cluster-jewel template data from `Data/ClusterJewels.lua` (exported to
//! `engine-data/data_clusterJewels.json`).
//!
//! Scope: the current (`clusterHashFormatVersion == 2`) node-id layout only. The legacy (v1 hash)
//! migration path (`BeginLegacyClusterHashConversion`/`BuildLegacyProxyGroup`/
//! `BuildLegacyClusterOrbitMappings`) is not ported; it only matters for trees saved before that
//! migration, which the `<Spec clusterHashFormatVersion="...">` attribute already tells us. The
//! keystone-only branch, `clusterJewelKeystone`, is ported. `pom-item` is still an empty stub, so
//! this takes an explicit `ClusterJewelInput` per socketed jewel (the fields `PassiveSpec.lua`
//! reads off `item.jewelData`/`item.clusterJewel`) rather than parsing a real item.

use crate::treedata::{as_i64, i64_list, str_list, TreeData};
use pom_engine::cjson::J;
use pom_engine::modparser::types::{PMod, PVal};
use serde_json::Value;
use pom_engine::fxhash::HashMap;
use std::path::Path;

#[derive(Clone, Debug, Default)]
pub struct ClusterJewelInput {
    pub cluster_jewel_valid: bool,
    pub keystone: Option<String>,
    pub notables: Vec<String>,
    pub skill_tag: Option<String>,
    pub socket_count_override: Option<i64>,
    pub socket_count: Option<i64>,
    pub node_count: Option<i64>,
    pub nothingness_count: Option<i64>,
    pub added_mods: Vec<String>,
    pub inc_effect: Option<f64>,
    /// "Large" | "Medium" | "Small" (`item.clusterJewel.size`).
    pub size: String,
    pub size_index: i64,
    /// `item.jewelData.conqueredBy`, when this socket holds a timeless/conqueror jewel instead of
    /// a cluster jewel (mutually exclusive with the cluster fields above). See
    /// `crate::timelessjewel` for the conquered-node replacement this feeds.
    pub conquered_by: Option<ConqueredBy>,
    /// `item.jewelRadiusIndex`, Lua 1-based (matches `Modules/Data.lua`'s `data.jewelRadius`
    /// table order; subtract 1 to index a tree node's exported `nodesInRadius` array). Set for
    /// any radius jewel, not just cluster jewels: cluster, timeless/conqueror, Intuitive
    /// Leap-like, Impossible Escape. Recorded unconditionally by the answer-key recorder.
    pub jewel_radius_index: Option<i64>,
    /// `item.jewelData.intuitiveLeapLike`: this radius jewel lets a Notable, Keystone or Normal
    /// node in its radius count as connected to the tree even when it isn't on an allocated
    /// path (`PassiveSpec.lua`'s `node.intuitiveLeapLikesAffecting` carve-out).
    pub intuitive_leap_like: bool,
    /// `item.jewelData.intuitiveLeapKeystoneOnly`: when set, the carve-out above only applies to
    /// Keystones in radius (used by jewels like Split Personality), not every node type.
    pub intuitive_leap_keystone_only: bool,
    /// `item.jewelData.impossibleEscapeKeystones` keys: real tree keystone display names this
    /// Impossible Escape jewel currently protects. Empty when this isn't an Impossible Escape,
    /// or no keystone is allocated on the tree yet.
    pub impossible_escape_keystones: Vec<String>,
    /// `item.jewelData.limitDisabled`: sockets holding a limit-violating extra jewel are excluded
    /// from every "gather radius jewels" scan in upstream.
    pub limit_disabled: bool,
}

#[derive(Clone, Debug)]
pub struct ConqueredBy {
    /// `item.jewelData.conqueredBy.id`: the raw, undivided conqueror seed.
    pub id: i64,
    /// `item.jewelData.conqueredBy.conqueror.type`: "vaal" | "karui" | "maraketh" | "templar" |
    /// "eternal" | "kalguur" | "abyss_murderous" | "abyss_searching" | "abyss_hypnotic" |
    /// "abyss_ghastly" | "abyss_special".
    pub conqueror_type: String,
    /// `item.jewelData.conqueredBy.conqueror.id`: which named historical conqueror (`ModParser.lua`'s
    /// `conquerorList`, e.g. "1", "2", "3", or a legacy "1_v2"/"2_v2"/"3_v2" variant) -- a small
    /// per-type id, unrelated to the seed above. Only used for the Keystone match string
    /// (`"<type>_keystone_<this>"`); `None` when the recorder couldn't read it (an older corpus
    /// recorded before this field existed).
    pub conqueror_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct ClusterSkill {
    name: String,
    icon: String,
    mastery_icon: Option<String>,
    stats: Vec<String>,
}

#[derive(Clone, Debug, Default)]
struct ClusterJewelBase {
    notable_indicies: Vec<i64>,
    small_indicies: Vec<i64>,
    socket_indicies: Vec<i64>,
    total_indicies: i64,
    skills: HashMap<String, ClusterSkill>,
}

pub struct ClusterJewelData {
    bases: HashMap<String, ClusterJewelBase>, // "Large"/"Medium"/"Small"
    notable_sort_order: HashMap<String, i64>,
    /// proxy node id -> sizeIndex -> start orbit index.
    orbit_offsets: HashMap<i64, HashMap<i64, i64>>,
}

impl ClusterJewelData {
    pub fn load(dir: &Path) -> Result<ClusterJewelData, String> {
        let path = dir.join("data_clusterJewels.json");
        let root = pom_engine::cjson::load(&path)?;

        let mut bases = HashMap::default();
        if let Some(jewels) = root.get("jewels").and_then(|v| v.as_object()) {
            for (_k, v) in jewels {
                let size = v.get("size").and_then(|s| s.as_str()).unwrap_or("").to_string();
                let mut skills = HashMap::default();
                if let Some(sk) = v.get("skills").and_then(|s| s.as_object()) {
                    for (tag, sv) in sk {
                        skills.insert(
                            tag.to_string(),
                            ClusterSkill {
                                name: sv.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                                icon: sv.get("icon").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                                mastery_icon: sv.get("masteryIcon").and_then(|s| s.as_str()).map(|s| s.to_string()),
                                stats: str_list(sv.get("stats").unwrap_or(J::NULL)),
                            },
                        );
                    }
                }
                bases.insert(
                    size,
                    ClusterJewelBase {
                        notable_indicies: i64_list(v.get("notableIndicies").unwrap_or(J::NULL)),
                        small_indicies: i64_list(v.get("smallIndicies").unwrap_or(J::NULL)),
                        socket_indicies: i64_list(v.get("socketIndicies").unwrap_or(J::NULL)),
                        total_indicies: v.get("totalIndicies").and_then(as_i64).unwrap_or(0),
                        skills,
                    },
                );
            }
        }

        let mut notable_sort_order = HashMap::default();
        if let Some(nso) = root.get("notableSortOrder").and_then(|v| v.as_object()) {
            for (k, v) in nso {
                if let Some(n) = as_i64(v) {
                    notable_sort_order.insert(k.to_string(), n);
                }
            }
        }

        let mut orbit_offsets = HashMap::default();
        if let Some(oo) = root.get("orbitOffsets").and_then(|v| v.as_object()) {
            for (proxy_id, v) in oo {
                let Ok(pid) = proxy_id.parse::<i64>() else { continue };
                let mut inner = HashMap::default();
                if let Some(o) = v.as_object() {
                    for (sk, sv) in o {
                        if let (Ok(size_idx), Some(start)) = (sk.parse::<i64>(), as_i64(sv)) {
                            inner.insert(size_idx, start);
                        }
                    }
                }
                orbit_offsets.insert(pid, inner);
            }
        }

        Ok(ClusterJewelData { bases, notable_sort_order, orbit_offsets })
    }
}

/// A generated subgraph node (before insertion into `PassiveSpec::nodes`).
pub struct GeneratedNode {
    pub id: i64,
    pub kind: String,
    pub dn: String,
    pub sd: Vec<String>,
    pub o: i64,
    pub oidx: i64,
    pub is_jewel_socket: bool,
    /// Copied from the real socket node found by `find_cluster_socket` (`makeJewel`'s
    /// `expansionJewel = socket.expansionJewel`), `Some` only for `kind == "Socket"`: without
    /// this a generated socket has nothing for a nested cluster jewel to recurse against.
    pub expansion_jewel: Option<ExpansionJewelRef>,
    /// A mod synthesized directly (not parsed from `sd` text), e.g. `clusterJewelIncEffect`'s
    /// `PassiveSkillEffect` INC on a Normal node. The caller (`spec.rs`'s `expand_socket`) has to
    /// append these itself after its own `process_stats(&node.sd, node.id)`, since re-running
    /// that parse from `sd` alone can never reproduce a mod that was never in the text.
    pub extra_mods: Vec<PMod>,
}

pub struct SubGraph {
    /// Upstream's local `id` *before* `+ (clusterJewel.sizeIndex << 4)`: pass this back in as
    /// `id_base` for a nested socket's own `build_subgraph` call (`self:BuildSubgraph(jewel, node,
    /// id, ...)` in upstream recurses with that same pre-offset `id`, not `nodeId`).
    pub id: i64,
    pub entrance_node: i64,
    pub parent_socket: i64,
    pub nodes: Vec<GeneratedNode>,
    pub connectors: Vec<(i64, i64)>,
    /// `(legacy_id, current_id)` pairs registered while placing this subgraph's sockets, only
    /// when the caller passed `needs_legacy = true` (`RegisterLegacyClusterNodeMap`'s calls from
    /// inside `makeJewel`). The caller applies these once every socket in the base tree has had
    /// its subgraph rebuilt (`ApplyLegacyClusterNodeRemap`, see `spec.rs`).
    pub legacy_node_map: Vec<(i64, i64)>,
}

struct ClusterNodeBase {
    dn: String,
    sd: Vec<String>,
}

fn cluster_node_lookup(tree: &TreeData, name: &str) -> Option<ClusterNodeBase> {
    let cnm = tree.section("clusterNodeMap")?.as_object()?;
    let v = cnm.get(name)?;
    let v = tree.deref(v);
    Some(ClusterNodeBase { dn: v.get("dn").and_then(|s| s.as_str()).unwrap_or("").to_string(), sd: str_list(v.get("sd").unwrap_or(J::NULL)) })
}

/// `expansionJewel.index/size/proxy`, copied onto a generated Socket node exactly like the
/// original's `makeJewel` (`expansionJewel = socket.expansionJewel`) so recursion into a nested
/// cluster jewel has real orbit data to work with.
#[derive(Clone, Copy, Debug)]
pub struct ExpansionJewelRef {
    pub index: i64,
    pub size: i64,
    pub proxy: i64,
}

/// Finds the expansion-socket node in `group_id` at proxy-relative `index` (`FindClusterSocket`).
fn find_cluster_socket(tree: &TreeData, group_id: i64, index: i64) -> Option<(i64, String, ExpansionJewelRef)> {
    let group = tree.group(group_id)?;
    let raw = group.get("n").or_else(|| group.get("nodes")).unwrap_or(J::NULL);
    let node_ids = i64_list(tree.deref(raw));
    for nid in node_ids {
        let Some(node) = tree.node(nid) else { continue };
        if let Some(ej) = node.get("expansionJewel") {
            if ej.get("index").and_then(as_i64) == Some(index) {
                let dn = node.get("dn").and_then(|s| s.as_str()).unwrap_or("").to_string();
                let ej_ref = ExpansionJewelRef {
                    index: ej.get("index").and_then(as_i64).unwrap_or(0),
                    size: ej.get("size").and_then(as_i64).unwrap_or(0),
                    proxy: ej.get("proxy").and_then(as_i64).unwrap_or(0),
                };
                return Some((nid, dn, ej_ref));
            }
        }
    }
    None
}

/// Port of `TranslateClusterOrbitIndex`.
fn translate_orbit_index(src_oidx: i64, src_n: i64, dest_n: i64) -> i64 {
    if src_n == dest_n {
        return src_oidx;
    }
    let map_12_16 = [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15];
    let map_16_12 = [0, 1, 1, 2, 3, 4, 4, 5, 6, 7, 7, 8, 9, 10, 10, 11];
    let map_6_16 = [0, 3, 5, 8, 11, 13];
    let map_16_6 = [0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5, 5, 5];
    let table: &[i64] = if src_n == 12 && dest_n == 16 {
        &map_12_16
    } else if src_n == 16 && dest_n == 12 {
        &map_16_12
    } else if src_n == 6 && dest_n == 16 {
        &map_6_16
    } else if src_n == 16 && dest_n == 6 {
        &map_16_6
    } else {
        return src_oidx * dest_n / src_n;
    };
    table.get(src_oidx as usize).copied().unwrap_or(0)
}

/// Port of `BuildLegacyProxyGroup`: a pre-`clusterHashFormatVersion` (`< 2`) save encodes a
/// nested cluster socket's id from the group the *legacy* parser would have descended into,
/// which can differ from the current parser's own `proxy_group_id` once a smaller enclosing
/// jewel has been upsized since the save was made. Walks outward (up to 4 levels, matching the
/// original's guard) through each level's own first/zeroth expansion socket to recover that
/// legacy group id.
fn build_legacy_proxy_group(tree: &TreeData, proxy_group_id: i64, expansion_jewel_size: i64, cluster_size_index: i64) -> i64 {
    let mut legacy_group_id = proxy_group_id;
    let mut group_size = expansion_jewel_size;
    let mut guard = 0;
    while cluster_size_index < group_size && guard < 4 {
        let socket = find_cluster_socket(tree, legacy_group_id, 1).or_else(|| find_cluster_socket(tree, legacy_group_id, 0));
        let Some((_sid, _dn, ej)) = socket else { break };
        let Some(legacy_proxy_node) = tree.node(ej.proxy) else { break };
        let Some(g) = legacy_proxy_node.get("g").and_then(as_i64) else { break };
        legacy_group_id = g;
        group_size = ej.size;
        guard += 1;
    }
    legacy_group_id
}

/// Port of `PassiveSpecClass:BuildSubgraph`. `id_base` is `id` in upstream (an accumulating
/// cluster-position id used for nested recursion; `None` means the top-level `0x10000` default).
/// `needs_legacy` is `self.legacyClusterNodeMap ~= nil` (`clusterHashFormatVersion < 2`, i.e. a
/// save from before the current node-id layout): when set, each socket this call places also
/// gets looked up in the pre-migration ("legacy") proxy group, and any differing id pair is
/// returned in `SubGraph::legacy_node_map` for the caller to apply once every socket in the base
/// tree has had its subgraph rebuilt (see `spec.rs`'s `apply_legacy_cluster_node_remap`).
pub fn build_subgraph(
    tree: &TreeData,
    cj_data: &ClusterJewelData,
    jewel: &ClusterJewelInput,
    parent_socket_id: i64,
    parent_expansion_index: i64,
    parent_expansion_size: i64,
    proxy_node_id: i64,
    id_base: Option<i64>,
    needs_legacy: bool,
) -> Option<SubGraph> {
    let mut id = id_base.unwrap_or(0x10000);
    if parent_expansion_size == 2 {
        id += parent_expansion_index << 6;
    } else if parent_expansion_size == 1 {
        id += parent_expansion_index << 9;
    }
    let node_id_base = id + (jewel.size_index << 4);

    let proxy_node = tree.node(proxy_node_id)?;
    let proxy_group_id = proxy_node.get("g").and_then(as_i64)?;
    if pom_engine::env::var("PASSIVE_SPEC_DEBUG").is_ok() {
        eprintln!("build_subgraph: proxy_node_id={proxy_node_id} proxy_group_id={proxy_group_id} socket_count_override={:?} socket_count={:?}", jewel.socket_count_override, jewel.socket_count);
    }

    let mut nodes = Vec::new();
    let mut connectors = Vec::new();

    if let Some(keystone_name) = &jewel.keystone {
        let base = cluster_node_lookup(tree, keystone_name)?;
        nodes.push(GeneratedNode { id: node_id_base, kind: "Keystone".to_string(), dn: base.dn, sd: base.sd, o: 0, oidx: 1, is_jewel_socket: false, expansion_jewel: None, extra_mods: Vec::new() });
        connectors.push((node_id_base, parent_socket_id));
        return Some(SubGraph { id, entrance_node: node_id_base, parent_socket: parent_socket_id, nodes, connectors, legacy_node_map: Vec::new() });
    }

    let cj = cj_data.bases.get(&jewel.size)?;
    let node_orbit = jewel.size_index + 1;

    let mut notable_bases: Vec<(i64, ClusterNodeBase)> = Vec::new();
    for name in &jewel.notables {
        let Some(base) = cluster_node_lookup(tree, name) else { return None };
        let order = cj_data.notable_sort_order.get(&base.dn).copied().unwrap_or(0);
        notable_bases.push((order, base));
    }
    notable_bases.sort_by_key(|(order, _)| *order);

    let default_skill = ClusterSkill { name: "Nothingness".to_string(), icon: String::new(), mastery_icon: None, stats: Vec::new() };
    let skill = jewel.skill_tag.as_ref().and_then(|t| cj.skills.get(t)).unwrap_or(&default_skill);

    let socket_count = jewel.socket_count_override.or(jewel.socket_count).unwrap_or(0);
    let notable_count = notable_bases.len() as i64;
    let node_count = jewel.node_count.unwrap_or(socket_count + notable_count + jewel.nothingness_count.unwrap_or(0));
    let small_count = node_count - socket_count - notable_count;

    // index -> (id, kind, dn, sd)
    let mut indicies: HashMap<i64, (i64, String, String, Vec<String>)> = HashMap::default();

    let mut mastery_node: Option<(i64, String, Vec<String>)> = None;
    if skill.mastery_icon.is_some() {
        mastery_node = Some((node_id_base + 12, "Nothingness".to_string(), Vec::new()));
    }

    // ---- sockets ----
    // `legacyProxyGroup` (`local legacyProxyGroup; if self.legacyClusterNodeMap then ... end`):
    // computed once, only when a legacy-format save needs it, before placing any socket.
    let legacy_group_id = if needs_legacy { Some(build_legacy_proxy_group(tree, proxy_group_id, parent_expansion_size, jewel.size_index)) } else { None };
    let mut legacy_node_map: Vec<(i64, i64)> = Vec::new();
    let mut place_socket = |jewel_index: i64| -> Option<(i64, String, ExpansionJewelRef)> {
        let current = find_cluster_socket(tree, proxy_group_id, jewel_index)?;
        if let Some(legacy_group_id) = legacy_group_id {
            if let Some((legacy_sid, ..)) = find_cluster_socket(tree, legacy_group_id, jewel_index) {
                legacy_node_map.push((legacy_sid, current.0));
            }
        }
        Some(current)
    };
    let mut made_sockets: Vec<(i64, i64, String, ExpansionJewelRef)> = Vec::new();
    if jewel.size == "Large" && socket_count == 1 {
        if let Some((sid, dn, ej)) = place_socket(1) {
            made_sockets.push((6, sid, dn, ej));
        }
    } else {
        let get_jewels = [0i64, 2, 1];
        for i in 0..socket_count as usize {
            let Some(&node_index) = cj.socket_indicies.get(i) else { break };
            let jewel_index = get_jewels.get(i).copied().unwrap_or(0);
            let found = place_socket(jewel_index);
            if pom_engine::env::var("PASSIVE_SPEC_DEBUG").is_ok() {
                eprintln!("  socket pass i={i} node_index={node_index} jewel_index={jewel_index} found={:?}", found.as_ref().map(|(sid, dn, _)| (sid, dn.clone())));
            }
            if let Some((sid, dn, ej)) = found {
                made_sockets.push((node_index, sid, dn, ej));
            }
        }
    }
    let mut socket_ej: HashMap<i64, ExpansionJewelRef> = HashMap::default();
    for (node_index, sid, dn, ej) in made_sockets {
        socket_ej.insert(node_index, ej);
        indicies.insert(node_index, (sid, "Socket".to_string(), dn, Vec::new()));
    }

    // ---- notables ----
    let is_medium = jewel.size == "Medium";
    let mut notable_index_list: Vec<i64> = Vec::new();
    for &raw_idx in &cj.notable_indicies {
        if notable_index_list.len() as i64 == notable_count {
            break;
        }
        let mut node_index = raw_idx;
        if is_medium {
            if socket_count == 0 && notable_count == 2 {
                if node_index == 6 {
                    node_index = 4;
                } else if node_index == 10 {
                    node_index = 8;
                }
            } else if node_count == 4 {
                if node_index == 10 {
                    node_index = 9;
                } else if node_index == 2 {
                    node_index = 3;
                }
            }
        }
        if !indicies.contains_key(&node_index) {
            notable_index_list.push(node_index);
        }
    }
    notable_index_list.sort();
    for (i, (_order, base)) in notable_bases.into_iter().enumerate() {
        let Some(&node_index) = notable_index_list.get(i) else { break };
        indicies.insert(node_index, (node_id_base + node_index, "Notable".to_string(), base.dn, base.sd));
    }

    // ---- small fill ----
    let mut small_index_list: Vec<i64> = Vec::new();
    for &raw_idx in &cj.small_indicies {
        if small_index_list.len() as i64 == small_count {
            break;
        }
        let mut node_index = raw_idx;
        if is_medium {
            if node_count == 5 && node_index == 4 {
                node_index = 3;
            } else if node_count == 4 {
                if node_index == 8 {
                    node_index = 9;
                } else if node_index == 4 {
                    node_index = 3;
                }
            }
        }
        if !indicies.contains_key(&node_index) {
            small_index_list.push(node_index);
        }
    }
    for i in 0..small_count {
        let Some(&node_index) = small_index_list.get(i as usize) else { break };
        let mut sd = skill.stats.clone();
        sd.extend(jewel.added_mods.iter().cloned());
        indicies.insert(node_index, (node_id_base + node_index, "Normal".to_string(), skill.name.clone(), sd));
    }

    let entrance = *indicies.get(&0).map(|(id, ..)| id)?;

    // ---- orbit index space conversion ----
    let skills_per_orbit_arr = i64_list(tree.deref(tree.section("skillsPerOrbit")?).clone().as_array().map(|_| tree.section("skillsPerOrbit").unwrap()).unwrap_or(J::NULL));
    let skills_per_orbit_arr = if skills_per_orbit_arr.is_empty() {
        i64_list(tree.section("constants").and_then(|c| c.get("skillsPerOrbit")).unwrap_or(J::NULL))
    } else {
        skills_per_orbit_arr
    };
    // Lua: self.tree.skillsPerOrbit[clusterJewel.sizeIndex + 2] (1-based) -> 0-based index (sizeIndex+1)
    let skills_per_orbit = skills_per_orbit_arr.get((jewel.size_index + 1) as usize).copied().unwrap_or(16);
    let start_oidx = cj_data.orbit_offsets.get(&proxy_node_id).and_then(|m| m.get(&jewel.size_index)).copied().unwrap_or(0);

    let mut oidx_map: HashMap<i64, i64> = HashMap::default();
    for (&node_index, _) in indicies.iter() {
        let corrected = (node_index + start_oidx).rem_euclid(cj.total_indicies);
        let translated = translate_orbit_index(corrected, cj.total_indicies, skills_per_orbit);
        oidx_map.insert(node_index, translated);
    }

    // ---- emit nodes with mods ----
    for (&node_index, (id, kind, dn, sd)) in indicies.iter() {
        let oidx = *oidx_map.get(&node_index).unwrap_or(&node_index);
        let mut extra_mods = Vec::new();
        if kind == "Normal" {
            if let Some(inc) = jewel.inc_effect {
                extra_mods.push(inc_effect_mod(*id, inc));
            }
        }
        nodes.push(GeneratedNode {
            id: *id,
            kind: kind.clone(),
            dn: dn.clone(),
            sd: sd.clone(),
            o: node_orbit,
            oidx,
            is_jewel_socket: kind == "Socket",
            expansion_jewel: socket_ej.get(&node_index).copied(),
            extra_mods,
        });
    }
    if let Some((mid, mdn, msd)) = mastery_node {
        nodes.push(GeneratedNode { id: mid, kind: "Mastery".to_string(), dn: mdn, sd: msd, o: 0, oidx: 0, is_jewel_socket: false, expansion_jewel: None, extra_mods: Vec::new() });
    }

    // ---- connectors: consecutive cluster-index order, closing the loop for non-Small ----
    let mut ordered_ids: Vec<i64> = Vec::new();
    for i in 0..cj.total_indicies {
        if let Some((id, ..)) = indicies.get(&i) {
            ordered_ids.push(*id);
        }
    }
    for w in ordered_ids.windows(2) {
        connectors.push((w[0], w[1]));
    }
    if jewel.size != "Small" && ordered_ids.len() > 1 {
        connectors.push((*ordered_ids.last().unwrap(), ordered_ids[0]));
    }
    connectors.push((entrance, parent_socket_id));

    Some(SubGraph { id, entrance_node: entrance, parent_socket: parent_socket_id, nodes, connectors, legacy_node_map })
}

/// Port of `node.modList:NewMod("PassiveSkillEffect", "INC", jewelData.clusterJewelIncEffect)`:
/// called with only 3 arguments (name, type, value), so `modLib.createMod`'s `source` local stays
/// `nil` (it's only ever set from a 4th, string-typed vararg). `node_id` is unused: this mod is
/// the one case in the crate that's deliberately sourceless, kept only so the call site still
/// reads like every other per-node mod constructor.
fn inc_effect_mod(_node_id: i64, value: f64) -> PMod {
    PMod { name: "PassiveSkillEffect".to_string(), ty: "INC".to_string(), value: PVal::Num(value), flags: 0, keyword_flags: 0, source: None, tags: Vec::new(), unreachable_tags: Vec::new() }
}
