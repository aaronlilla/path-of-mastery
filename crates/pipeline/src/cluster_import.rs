//! Character import: the cluster jewel passives of an imported character (`resolveImportedClusters`).
//!
//! The site names the passives of a socketed cluster jewel by its own ids (`hashes_ex`) and describes each jewel's
//! subgraph (`jewel_data`); upstream matches them while building the subgraphs (`ImportTab:ImportPassiveTreeAndJewels`
//! sets `spec.extended_hashes` / `spec.jewel_data`, `BuildSubgraph` allocates what matches). This builds the spec of the
//! given build text the same way and reports which nodes the matcher allocated on top of the text's own node list.

use crate::{cached_tree, cluster_jewel_data, cluster_jewel_input_from_item, items_section, parsed_item};
use pom_engine::data::GameData;
use pom_passives::import_clusters::{with_import, ImportClusters};
use std::rc::Rc;

pub struct ImportedClusters {
    /// Generated nodes (cluster subgraph ids from 65536 up, and the sockets inside a cluster jewel) the spec allocates that
    /// the text's `nodes=` list did not hold, ascending.
    pub allocated: Vec<i64>,
    /// Extended hashes that matched no generated node.
    pub unmatched: Vec<i64>,
}

pub fn resolve_imported_clusters(xml: &str, hashes_ex: &[i64], jewel_data: &serde_json::Value, game: &'static GameData) -> Result<ImportedClusters, String> {
    let parsed = pom_passives::xmlspec::parse_active_spec(xml)?;
    let version = parsed.tree_version.clone().unwrap_or_else(|| "3_6".to_string());
    let tree = cached_tree(&version)?;
    let mut items: pom_engine::fxhash::HashMap<i64, Rc<pom_item::Item>> = Default::default();
    for (id, raw, overrides) in &items_section(xml).items {
        let item = parsed_item(raw, *id, overrides, game);
        if item.base_name.as_ref().is_some_and(|n| game.item_bases.contains_key(n)) {
            items.insert(*id, item);
        }
    }
    let mut inputs: pom_engine::fxhash::HashMap<i64, pom_passives::clusterjewel::ClusterJewelInput> = Default::default();
    for (node_id, item_id) in &parsed.jewels {
        if let Some(item) = items.get(item_id) {
            inputs.insert(*node_id, cluster_jewel_input_from_item(item));
        }
    }
    let seed = pom_passives::active_spec_jewel_seed(&parsed.jewels);
    let import = Rc::new(ImportClusters::from_json(hashes_ex, jewel_data));
    let spec = with_import(import.clone(), || pom_passives::spec_from_xml_full(tree, xml, Some(cluster_jewel_data()), &inputs, None, Some(&seed)))?;
    let had: std::collections::HashSet<i64> = parsed.hash_list.clone().unwrap_or_default().into_iter().collect();
    let mut allocated: Vec<i64> = spec.nodes.iter().filter(|(id, n)| n.alloc && !had.contains(id) && spec.generated_group.contains_key(id)).map(|(&id, _)| id).collect();
    allocated.sort_unstable();
    let matched = import.matched.borrow();
    let unmatched = hashes_ex.iter().copied().filter(|h| !matched.contains(h)).collect();
    Ok(ImportedClusters { allocated, unmatched })
}
