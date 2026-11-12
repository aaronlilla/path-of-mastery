//! Rust port of the upstream passive tree logic (Classes/PassiveSpec.lua and the
//! calculation-relevant parts of Classes/PassiveTree.lua), graded against recorded answers from
//! upstream.
//!
//! Current scope (see `spec.rs` for the precise breakdown): tree copy/init from
//! `engine-data/tree_<version>.json` (loaded directly in `treedata.rs`, not through pom-engine's
//! typed loader, so this crate can resolve the `$ref` aliases the tree export still uses for
//! `nodesInRadius`/`keystoneMap`/`clusterNodeMap`/etc.), build-XML `<Spec>` parsing (`xmlspec.rs`,
//! both the new node-hash-list format and the legacy GGG tree-URL format), allocation,
//! `BuildAllDependsAndPaths` (paths/depends/connectedToStart), points counting, mastery effect
//! selection, `EncodeURL`/`DecodeURL`, and node modList building via `pom_engine::modparser`.
//!
//! Not yet implemented (tracked separately, not silently approximated):
//! - Abyss conquered-node replacement (jewel types 7-11; see `timelessjewel.rs` for why Legion
//!   types 1-6 are in scope and Abyss isn't yet).
//! - Cluster jewel subgraph generation (`clusterjewel.rs`): implemented against an explicit
//!   `ClusterJewelInput` struct rather than real equipped-item data, since `pom-item` is still an
//!   empty stub.
//! - Tattoo `<Overrides>` application (parsed by `xmlspec.rs`, not yet applied in `spec.rs`).

pub mod clusterjewel;
pub mod import_clusters;
pub mod ljhash;
pub mod node;
pub mod spec;
pub mod stats;
pub mod abyss;
pub mod timelessjewel;
pub mod treedata;
pub mod xmlspec;

use std::path::Path;

/// The nodes `ItemsTab:Init` creates a "Jewel <id>" slot for (`type == "Socket"` nodes of the
/// latest tree, ascending id). On the active spec `ItemSlotClass:Populate` writes an explicit
/// `spec.jewels[node] = 0` for every one of them that holds no valid jewel.
pub const LATEST_JEWEL_SOCKETS: &[i64] = &[2311, 2491, 3109, 6230, 6910, 7960, 9408, 9797, 10532, 11150, 12161, 12613, 13170, 14993, 16218, 17219, 18436, 21984, 22748, 22994, 23756, 23984, 24970, 26196, 26725, 28475, 29712, 31683, 32763, 33631, 33753, 33989, 34483, 36634, 36931, 40400, 41263, 41876, 44169, 46393, 46519, 46882, 48679, 48768, 49080, 49684, 51198, 54127, 55190, 59585, 60735, 61288, 61305, 61419, 61666, 61834, 64583];

/// The initial `self.jewels` of the active spec, in upstream's insertion order: the XML
/// `<Socket>` entries (itemId > 0) first, then an explicit `0` for every other latest-tree socket.
pub fn active_spec_jewel_seed(xml_sockets: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let mut v: Vec<(i64, i64)> = xml_sockets.to_vec();
    for &n in LATEST_JEWEL_SOCKETS {
        if !v.iter().any(|&(k, _)| k == n) {
            v.push((n, 0));
        }
    }
    v
}

/// Loads a `PassiveSpec` from a build's XML text against the given tree data.
pub fn spec_from_xml<'t>(tree: &'t treedata::TreeData, xml_text: &str) -> Result<spec::PassiveSpec<'t>, String> {
    spec_from_xml_with_jewels(tree, xml_text, None, &pom_engine::fxhash::HashMap::default())
}

/// Same as `spec_from_xml`, but also runs `build_cluster_jewel_graphs` (Load + PostLoad, matching
/// upstream's actual call sequence) when `cj_data` is given. `jewel_inputs` stands in for real
/// equipped-item data (see `clusterjewel.rs`); the golden test harness fills it from the
/// recorder's own dump of each socketed jewel's `jewelData`/`clusterJewel` fields.
pub fn spec_from_xml_with_jewels<'t>(
    tree: &'t treedata::TreeData,
    xml_text: &str,
    cj_data: Option<&clusterjewel::ClusterJewelData>,
    jewel_inputs: &pom_engine::fxhash::HashMap<i64, clusterjewel::ClusterJewelInput>,
) -> Result<spec::PassiveSpec<'t>, String> {
    spec_from_xml_with_jewels_and_timeless(tree, xml_text, cj_data, jewel_inputs, None)
}

/// Same as `spec_from_xml_with_jewels`, additionally passing `timeless_data` (the Legion jewel
/// lookup tables, see `timelessjewel.rs`) through to `PassiveSpec` for conquered-node replacement.
pub fn spec_from_xml_with_jewels_and_timeless<'t>(
    tree: &'t treedata::TreeData,
    xml_text: &str,
    cj_data: Option<&clusterjewel::ClusterJewelData>,
    jewel_inputs: &pom_engine::fxhash::HashMap<i64, clusterjewel::ClusterJewelInput>,
    timeless_data: Option<&'t timelessjewel::TimelessJewelData>,
) -> Result<spec::PassiveSpec<'t>, String> {
    spec_from_xml_full(tree, xml_text, cj_data, jewel_inputs, timeless_data, None)
}

/// POM_PROF=1: prints the time of each step of building a spec, in ms, to stderr.
pub struct PfT(Option<std::time::Instant>);
impl PfT {
    pub fn new() -> PfT { PfT(pom_engine::env::var_os("POM_PROF").map(|_| std::time::Instant::now())) }
    pub fn lap(&mut self, l: &str) {
        if let Some(t) = self.0 { eprintln!("PROF   {l} {:.1}", t.elapsed().as_secs_f64() * 1000.0); self.0 = Some(std::time::Instant::now()); }
    }
}

/// Same, with `jewel_seed`: the exact initial contents of `self.jewels` in upstream's
/// insertion order (XML `<Socket>` order, then the explicit `0` entries `ItemSlotClass:Populate`
/// writes on the active spec), values included (a `0` is a present key). `None` means "just the
/// XML sockets with itemId > 0".
pub fn spec_from_xml_full<'t>(
    tree: &'t treedata::TreeData,
    xml_text: &str,
    cj_data: Option<&clusterjewel::ClusterJewelData>,
    jewel_inputs: &pom_engine::fxhash::HashMap<i64, clusterjewel::ClusterJewelInput>,
    timeless_data: Option<&'t timelessjewel::TimelessJewelData>,
    jewel_seed: Option<&[(i64, i64)]>,
) -> Result<spec::PassiveSpec<'t>, String> {
    // A stats-only run with cluster jewels skips the pass after the node list (see `import_from_node_list`),
    // unless the pass after the subgraphs prunes something: then the spec is rebuilt with both passes.
    // POM_CHECK_DEFER=1 builds every such spec both ways and reports any difference.
    let defer = cj_data.is_some() && spec::SKIP_PATHS.with(|c| c.get());
    // POM_CHECK_FASTDEP=1: also build the spec with the full depends loop and report a different allocation or
    // `connected_to_start` on an allocated non-start node.
    thread_local! {
        static CHECKING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    if spec::SKIP_PATHS.with(|c| c.get()) && pom_engine::env::var_os("POM_CHECK_FASTDEP").is_some() && !CHECKING.with(|c| c.get()) {
        CHECKING.with(|c| c.set(true));
        spec::FULL_DEPENDS.with(|c| c.set(true));
        let full = spec_from_xml_full(tree, xml_text, cj_data, jewel_inputs, timeless_data, jewel_seed);
        spec::FULL_DEPENDS.with(|c| c.set(false));
        let fast = spec_from_xml_full(tree, xml_text, cj_data, jewel_inputs, timeless_data, jewel_seed);
        CHECKING.with(|c| c.set(false));
        if let (Ok(a), Ok(b)) = (&full, &fast) {
            let view = |s: &spec::PassiveSpec| -> Vec<(i64, bool)> {
                let mut v: Vec<(i64, bool)> = s.nodes.iter().filter(|(_, n)| n.alloc).map(|(&id, n)| (id, n.kind != "ClassStart" && n.kind != "AscendClassStart" && n.connected_to_start)).collect();
                v.sort_unstable();
                v
            };
            let (va, vb) = (view(a), view(b));
            if va != vb {
                let only_full: Vec<&(i64, bool)> = va.iter().filter(|x| !vb.contains(x)).take(4).collect();
                let only_fast: Vec<&(i64, bool)> = vb.iter().filter(|x| !va.contains(x)).take(4).collect();
                eprintln!("FASTDEP DIFF {} full-only {:?} fast-only {:?}", pom_engine::env::var("POM_BUILD_NAME").unwrap_or_default(), only_full, only_fast);
            }
        }
        return fast;
    }
    let s = spec_from_xml_inner(tree, xml_text, cj_data, jewel_inputs, timeless_data, jewel_seed, defer)?;
    if !s.node_list_depends_deferred {
        return Ok(s);
    }
    if s.alloc_changed {
        return spec_from_xml_inner(tree, xml_text, cj_data, jewel_inputs, timeless_data, jewel_seed, false);
    }
    if pom_engine::env::var_os("POM_CHECK_DEFER").is_some() {
        let full = spec_from_xml_inner(tree, xml_text, cj_data, jewel_inputs, timeless_data, jewel_seed, false)?;
        let (a, b) = (full.state_parts(), s.state_parts());
        if a != b {
            let diff: Vec<String> = a.iter().zip(b.iter()).filter(|(x, y)| x != y).take(3).map(|(x, y)| format!("{x} => {y}")).collect();
            eprintln!("DEFER CHANGED {} {:?}", pom_engine::env::var("POM_BUILD_NAME").unwrap_or_default(), diff);
        }
    }
    Ok(s)
}

fn spec_from_xml_inner<'t>(
    tree: &'t treedata::TreeData,
    xml_text: &str,
    cj_data: Option<&clusterjewel::ClusterJewelData>,
    jewel_inputs: &pom_engine::fxhash::HashMap<i64, clusterjewel::ClusterJewelInput>,
    timeless_data: Option<&'t timelessjewel::TimelessJewelData>,
    jewel_seed: Option<&[(i64, i64)]>,
    defer: bool,
) -> Result<spec::PassiveSpec<'t>, String> {
    let mut pf = PfT::new();
    let parsed = match xmlspec::parse_active_spec(xml_text) {
        Ok(p) => p,
        Err(e) if e == "no <Spec> elements" => {
            // TreeTab:Load: no <Spec> -> `new PassiveSpec(build, latestTreeVersion)`: fresh spec, class 0.
            let mut s = spec::PassiveSpec::new(tree);
            s.timeless_data = timeless_data;
            s.select_class(0);
            s.build_all_depends_and_paths();
            if let Some(cj_data) = cj_data {
                s.build_cluster_jewel_graphs(cj_data);
            }
            return Ok(s);
        }
        Err(e) => return Err(e),
    };
    pf.lap("sp.parse_active_spec");
    let mut s = spec::PassiveSpec::new(tree);
    pf.lap("sp.PassiveSpec::new");
    s.timeless_data = timeless_data;
    // `BeginLegacyClusterHashConversion`: `xmlspec.rs` already defaults a missing
    // `clusterHashFormatVersion` to 1 (legacy) whenever a `nodes=` hash list is present, matching
    // `Load`'s own `tonumber(xml.attrib.clusterHashFormatVersion) or (xml.attrib.nodes and 1 or 2)`.
    s.needs_legacy_cluster_conversion = parsed.cluster_hash_format_version.unwrap_or(2) < 2;

    let class_id = parsed.class_id.unwrap_or(0);
    let ascend_class_id = parsed.ascend_class_id.unwrap_or(0);
    let secondary = parsed.secondary_ascend_class_id;

    if let Some(seed) = jewel_seed {
        for &(node_id, item_id) in seed {
            s.set_jewel(node_id, item_id);
        }
    } else {
        for (node_id, item_id) in &parsed.jewels {
            s.set_jewel(*node_id, *item_id);
        }
    }
    for (&node_id, input) in jewel_inputs {
        s.cluster_jewel_inputs.insert(node_id, input.clone());
    }
    resolve_hash_overrides(&mut s, &parsed.overrides);

    if let Some(hash_list) = &parsed.hash_list {
        let mastery_effects: pom_engine::fxhash::HashMap<i64, i64> = parsed.mastery_effects.iter().cloned().collect();
        s.defer_node_list_depends = defer;
        s.import_from_node_list(class_id, ascend_class_id, secondary, hash_list, &mastery_effects);
    } else if let Some(url) = &parsed.url {
        // PassiveSpec:Load discards DecodeURL's error string: a bad link leaves the fresh spec
        // (class 0, start node only) in place.
        if s.decode_url(url).is_err() {
            s.select_class(0);
        }
        if cj_data.is_none() {
            s.build_all_depends_and_paths();
        }
    } else {
        // Load: neither `nodes` nor a URL -> fresh spec (SelectClass(0) from the constructor).
        s.select_class(0);
    }
    pf.lap("sp.import");
    if let Some(cj_data) = cj_data {
        s.build_cluster_jewel_graphs(cj_data);
    }
    pf.lap("sp.cluster_graphs");
    Ok(s)
}

/// Loads `tree_<version>.json` from `dir` (normally `<repo>/engine-data`).
pub fn load_tree(dir: &Path, tree_file: &str) -> Result<treedata::TreeData, String> {
    treedata::TreeData::load(dir, tree_file)
}

/// Port of `Load`'s `<Overrides>` resolution (`Classes/PassiveSpec.lua` lines ~161-186): for each
/// saved override, find its tattoo template by exact display name in `tree.tattoo.nodes`, falling
/// back to a search by `(icon, activeEffectImage)` pair when the game has since renamed that
/// tattoo (the fallback only needs to work for this one spec, so unlike upstream this doesn't
/// mutate the tree's own `tattoo.nodes` table to remember the substitution for later lookups). A
/// node with no match at all (both the exact name and the sprite fallback fail) is silently
/// dropped, matching upstream's `ConPrintf`-and-skip.
fn resolve_hash_overrides(s: &mut spec::PassiveSpec, overrides: &[xmlspec::OverrideNode]) {
    let Some(tattoo_nodes) = s.tree.section("tattoo").and_then(|t| t.get("nodes")).and_then(|n| n.as_object()) else { return };
    for ov in overrides {
        let resolved = tattoo_nodes.get(&ov.dn).or_else(|| {
            tattoo_nodes.values().find(|data| {
                data.get("activeEffectImage").and_then(|v| v.as_str()) == Some(ov.active_effect_image.as_str())
                    && data.get("icon").and_then(|v| v.as_str()) == Some(ov.icon.as_str())
            })
        });
        if let Some(resolved) = resolved {
            s.hash_overrides.insert(ov.node_id, resolved);
        }
    }
}
