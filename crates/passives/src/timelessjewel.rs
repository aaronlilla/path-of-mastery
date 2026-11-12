//! Reads upstream's Legion (timeless jewel) lookup tables directly from
//! `Data/TimelessJewelData` (read-only: this module only ever opens files there, never
//! writes), porting `Modules/DataLegionLookUpTableHelper.lua`'s `readLUT` and
//! `Modules/DataJewelFileLoader.lua`'s `loadJewelFile`.
//!
//! Scope: Legion jewel types only, 1-6 (Glorious Vanity, Lethal Pride, Brutal Restraint, Militant
//! Faith, Elegant Hubris, Heroic Tragedy: the six conquerors that appear in the recorded builds
//! this crate is graded against). Abyss jewel types (7-11, `Modules/DataAbyssJewelLookUpTableHelper.lua`) are
//! not ported. No recorded build uses one (checked by filtering
//! the recorded jewels' `conqueredBy.type`; only vaal, karui, maraketh,
//! templar and eternal appear, all Legion), and their on-disk format (`ABYS`/`ABYN` framed
//! records, not the fixed per-node/per-seed byte table Legion jewels use) differs enough that
//! porting it faithfully needs its own pass. `TimelessJewelData::read_lut` returns an empty
//! result for jewel types outside 1-6, matching upstream's own "Missing LUT" fallback path.
//!
//! Byte-layout notes, verified against upstream's `data.readLUT` over 504 randomized
//! (node, jewelType, seed) triples spanning all 6 types before trusting this port:
//! - `NodeIndexMapping.lua` is a flat sequence of `nodeIDList[<id>] = { index = I, size = S }`
//!   assignments plus three special keys: `nodeIDList["size"]` (node count for Glorious Vanity's
//!   layout), `nodeIDList["sizeNotable"]` (how many of the lowest-index nodes are Notables, which
//!   is what the non-Glorious-Vanity types' data is keyed by), and
//!   `nodeIDList["localIdToGlobalId"][jewelType][localId] = globalId`. This is parsed directly as
//!   text, not through a Lua interpreter: the format is fixed and regenerated only by
//!   `repairLUTs()` in upstream, a dev-only path.
//! - For jewel types 2-6, `<Name>.bin`/`.zip` is the raw per-(nodeIndex, seedOffset) byte table.
//!   `loadTimelessJewel` stores it as `data.timelessJewelLUTs[jewelType].data` verbatim, and
//!   `readLUT` reads one byte at `index * seedSize + seedOffset` for a Notable-index node
//!   (`index <= nodeIDList.sizeNotable`) and returns nothing for a non-Notable index.
//! - For jewel type 1 (Glorious Vanity), the file has two regions: a `nodeCount * seedSize`-byte
//!   header of per-(node, seed) *lengths* (one byte each), followed by every node's raw data
//!   blocks back to back in node-index order. The header is `nodeCount * seedSize + 1` bytes
//!   nominally (`jewelData:sub(1, sizeOffset + 1)` in upstream), but the running cursor the
//!   original advances through the rest of the file starts one byte earlier, at offset
//!   `nodeCount * seedSize` (0-based). Node 0's raw data begins at the header's last byte, not
//!   just past it. This was the one place a literal transcription (starting each node's raw block
//!   right after the nominal header length) gave answers off by one byte from every real call;
//!   the byte-random verification above is what caught it.
//! - Glorious Vanity results whose byte length is 2, 3, 6 or 8 have their first byte (or first
//!   half, for 6/8) passed through `localIdToGlobalId`; other types' single-byte result always is.
//! - Elegant Hubris (jewel type 5) is the one type whose `data.timelessJewelSeedMin/Max` constants
//!   are pre-divided by 20 (`2000/20`, `160000/20`). The real conqueror seed (`conqueredBy.id`,
//!   e.g. 2000-160000) is divided by 20 inside `readLUT` before use, so callers always pass the
//!   raw undivided seed, same as every other type.

use std::cell::RefCell;
use pom_engine::fxhash::HashMap;
use std::path::{Path, PathBuf};

/// Port of `data.nodeIDList` (`Data/TimelessJewelData/NodeIndexMapping.lua`).
pub struct NodeIndexMapping {
    /// tree node id -> (index into the per-jewel-type byte tables, total raw byte length used by
    /// Glorious Vanity's per-node block; the latter only matters for jewel type 1).
    by_node_id: HashMap<i64, (i64, i64)>,
    /// `nodeIDList["size"]`: total node count in Glorious Vanity's layout.
    gv_size: i64,
    /// `nodeIDList["sizeNotable"]`: nodes with `index <= sizeNotable` are Notables (the only ones
    /// jewel types 2-6 carry data for).
    size_notable: i64,
    /// `nodeIDList["localIdToGlobalId"][jewelType][localId] = globalId`.
    local_to_global: HashMap<i64, HashMap<i64, i64>>,
    /// Precomputed once: index -> Glorious Vanity per-node raw block length, so `read_lut` doesn't
    /// re-scan all ~1937 entries on every call.
    gv_index_to_size: Vec<i64>,
}

fn parse_after_eq_i64(s: &str) -> Option<i64> {
    s.trim().trim_end_matches(|c: char| !c.is_ascii_digit() && c != '-').parse().ok()
}

impl NodeIndexMapping {
    pub fn load(path: &Path) -> Result<NodeIndexMapping, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {}", path.display(), e))?;
        let mut by_node_id = HashMap::default();
        let mut gv_size = 0i64;
        let mut size_notable = 0i64;
        let mut local_to_global: HashMap<i64, HashMap<i64, i64>> = HashMap::default();

        for raw_line in text.lines() {
            let line = raw_line.trim();
            if let Some(rest) = line.strip_prefix("nodeIDList[\"size\"] = ") {
                gv_size = rest.trim().parse().unwrap_or(0);
            } else if let Some(rest) = line.strip_prefix("nodeIDList[\"sizeNotable\"] = ") {
                size_notable = rest.trim().parse().unwrap_or(0);
            } else if let Some(rest) = line.strip_prefix("nodeIDList[\"localIdToGlobalId\"][") {
                // nodeIDList["localIdToGlobalId"][JT]["size"] = N   (skip)
                // nodeIDList["localIdToGlobalId"][JT][LOCAL] = GLOBAL
                let Some(close1) = rest.find(']') else { continue };
                let Ok(jt) = rest[..close1].parse::<i64>() else { continue };
                let rest2 = &rest[close1 + 1..];
                let Some(rest2) = rest2.strip_prefix('[') else { continue };
                let Some(close2) = rest2.find(']') else { continue };
                let key = &rest2[..close2];
                let Ok(local_id) = key.parse::<i64>() else { continue };
                let Some(eq) = rest2.find('=') else { continue };
                let Some(global_id) = parse_after_eq_i64(&rest2[eq + 1..]) else { continue };
                local_to_global.entry(jt).or_default().insert(local_id, global_id);
            } else if let Some(rest) = line.strip_prefix("nodeIDList[") {
                // nodeIDList[NODEID] = { index = I, size = S }
                let Some(close) = rest.find(']') else { continue };
                let Ok(node_id) = rest[..close].parse::<i64>() else { continue };
                let after = &rest[close + 1..];
                let (Some(ix), Some(sx)) = (after.find("index ="), after.find("size =")) else { continue };
                let index_str: String = after[ix + 7..].trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
                let size_str: String = after[sx + 6..].trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
                if let (Ok(index), Ok(size)) = (index_str.parse::<i64>(), size_str.parse::<i64>()) {
                    by_node_id.insert(node_id, (index, size));
                }
            }
        }

        let mut gv_index_to_size = vec![0i64; gv_size.max(0) as usize];
        for &(idx, sz) in by_node_id.values() {
            if idx >= 0 && (idx as usize) < gv_index_to_size.len() {
                gv_index_to_size[idx as usize] = sz;
            }
        }

        Ok(NodeIndexMapping { by_node_id, gv_size, size_notable, local_to_global, gv_index_to_size })
    }

    fn convert_local_to_global(&self, jewel_type: i64, local_id: i64) -> i64 {
        self.local_to_global.get(&jewel_type).and_then(|m| m.get(&local_id)).copied().unwrap_or(local_id)
    }
}

fn seed_min(jewel_type: i64) -> i64 {
    match jewel_type {
        1 => 100,
        2 => 10000,
        3 => 500,
        4 => 2000,
        5 => 100,
        6 => 100,
        _ => 0,
    }
}

fn seed_max(jewel_type: i64) -> i64 {
    match jewel_type {
        1 => 8000,
        2 => 18000,
        3 => 8000,
        4 => 10000,
        5 => 8000,
        6 => 8000,
        _ => 0,
    }
}

fn jewel_file_name(jewel_type: i64) -> Option<&'static str> {
    match jewel_type {
        1 => Some("GloriousVanity"),
        2 => Some("LethalPride"),
        3 => Some("BrutalRestraint"),
        4 => Some("MilitantFaith"),
        5 => Some("ElegantHubris"),
        6 => Some("HeroicTragedy"),
        _ => None,
    }
}

/// Port of `Modules/DataJewelFileLoader.lua`'s `loadJewelFile`, read-only (never writes the `.bin`
/// cache upstream does). Prefers an already-decompressed `<name>.bin` (upstream writes one
/// the first time it inflates a jewel's data; every Legion type this crate supports already has
/// one on disk from prior recorder runs) and falls back to inflating `<name>.zip` or its
/// `<name>.zip.part0`, `.part1`, ... pieces concatenated, matching upstream's own fallback.
fn load_jewel_file(dir: &Path, name: &str) -> Option<&'static [u8]> {
    // Mapped from a decompressed `.bin` (beside the data, or written once to the compact-data directory), so the
    // tables (hundreds of MB inflated) are paged from disk rather than held in memory.
    if let Some(bytes) = pom_engine::mmap::map_static(&dir.join(format!("{name}.bin"))).ok().filter(|b| !b.is_empty()) {
        return Some(bytes);
    }
    let cached = pom_engine::cjson::cache_dir(dir).join(format!("{name}.bin"));
    if let Some(bytes) = pom_engine::mmap::map_static(&cached).ok().filter(|b| !b.is_empty()) {
        return Some(bytes);
    }
    let inflated = inflate_jewel_file(dir, name)?;
    let _ = std::fs::create_dir_all(cached.parent()?);
    let tmp = cached.with_extension(format!("tmp{}", std::process::id()));
    if std::fs::write(&tmp, &inflated).is_ok() && std::fs::rename(&tmp, &cached).is_ok() {
        if let Some(bytes) = pom_engine::mmap::map_static(&cached).ok().filter(|b| !b.is_empty()) {
            return Some(bytes);
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Some(Box::leak(inflated.into_boxed_slice()))
}

fn inflate_jewel_file(dir: &Path, name: &str) -> Option<Vec<u8>> {
    let compressed = if let Ok(bytes) = std::fs::read(dir.join(format!("{name}.zip"))) {
        bytes
    } else {
        let mut parts = Vec::new();
        let mut part = 0u32;
        loop {
            match std::fs::read(dir.join(format!("{name}.zip.part{part}"))) {
                Ok(bytes) => {
                    parts.extend_from_slice(&bytes);
                    part += 1;
                }
                Err(_) => break,
            }
        }
        if parts.is_empty() {
            return None;
        }
        parts
    };
    inflate_zlib(&compressed)
}

fn inflate_zlib(data: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut decoder = flate2::read::ZlibDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).ok()?;
    Some(out)
}

/// Port of `data.readLUT`/`loadTimelessJewel`, scoped to Legion jewel types 1-6 (see module docs).
/// Holds `NodeIndexMapping` plus a lazily-populated, process-lifetime cache of each jewel type's
/// raw file bytes (loaded once, reused by every build the golden harness grades).
pub struct TimelessJewelData {
    node_index: NodeIndexMapping,
    data_dir: PathBuf,
    cache: RefCell<HashMap<i64, &'static [u8]>>,
    abyss_cache: RefCell<HashMap<i64, Option<std::rc::Rc<crate::abyss::AbyssLut>>>>,
}

impl TimelessJewelData {
    pub fn load(data_dir: &Path) -> Result<TimelessJewelData, String> {
        let node_index = NodeIndexMapping::load(&data_dir.join("NodeIndexMapping.lua"))?;
        Ok(TimelessJewelData { node_index, data_dir: data_dir.to_path_buf(), cache: RefCell::new(HashMap::default()), abyss_cache: RefCell::new(HashMap::default()) })
    }

    pub(crate) fn abyss_cache(&self) -> &RefCell<HashMap<i64, Option<std::rc::Rc<crate::abyss::AbyssLut>>>> {
        &self.abyss_cache
    }

    pub(crate) fn load_file(&self, name: &str) -> Option<&'static [u8]> {
        load_jewel_file(&self.data_dir, name)
    }

    pub(crate) fn local_to_global(&self, jewel_type: i64, local_id: i64) -> i64 {
        self.node_index.convert_local_to_global(jewel_type, local_id)
    }

    fn jewel_bytes(&self, jewel_type: i64) -> Option<&'static [u8]> {
        if let Some(v) = self.cache.borrow().get(&jewel_type) {
            return Some(*v);
        }
        let name = jewel_file_name(jewel_type)?;
        let bytes = load_jewel_file(&self.data_dir, name)?;
        self.cache.borrow_mut().insert(jewel_type, bytes);
        Some(bytes)
    }

    /// Port of `DataLegionLookUpTableHelper.lua`'s `readLUT(seed, nodeID, jewelType)`. `seed` is
    /// always the raw, undivided conqueror seed (`conqueredBy.id`); the jewel-type-5 (Elegant
    /// Hubris) /20 division happens inside, matching upstream. Returns an empty list for
    /// anything upstream itself would ("Missing LUT", unmapped node id, non-Notable index for
    /// a non-Glorious-Vanity type, or a jewel type outside 1-6).
    pub fn read_lut(&self, seed: i64, node_id: i64, jewel_type: i64) -> Vec<i64> {
        let Some(&(index, _size)) = self.node_index.by_node_id.get(&node_id) else { return Vec::new() };
        if !(1..=6).contains(&jewel_type) {
            return Vec::new();
        }
        let seed = if jewel_type == 5 { seed.div_euclid(20) } else { seed };
        let s = seed_max(jewel_type) - seed_min(jewel_type) + 1;
        let seed_offset = seed - seed_min(jewel_type);
        if seed_offset < 0 || seed_offset >= s {
            return Vec::new();
        }
        let Some(data) = self.jewel_bytes(jewel_type) else { return Vec::new() };

        if jewel_type == 1 {
            let gv_size = self.node_index.gv_size;
            if index < 0 || index >= gv_size {
                return Vec::new();
            }
            // See module docs: the raw per-node blocks start one byte before the nominal
            // `gv_size * s + 1`-byte header length, i.e. at 0-based offset `gv_size * s`.
            let header_len = gv_size * s;
            let node_start: i64 = header_len + self.node_index.gv_index_to_size[..index as usize].iter().sum::<i64>();
            let base = (index * s) as usize;
            let mut local_offset: i64 = 0;
            for k in 0..seed_offset {
                local_offset += *data.get(base + k as usize).unwrap_or(&0) as i64;
            }
            let length = *data.get(base + seed_offset as usize).unwrap_or(&0) as i64;
            let start = (node_start + local_offset) as usize;
            let end = start + length as usize;
            if length <= 0 || end > data.len() {
                return Vec::new();
            }
            let mut result: Vec<i64> = data[start..end].iter().map(|&b| b as i64).collect();
            if length == 2 || length == 3 {
                result[0] = self.node_index.convert_local_to_global(jewel_type, result[0]);
            } else if length == 6 || length == 8 {
                for i in 0..(length as usize / 2) {
                    result[i] = self.node_index.convert_local_to_global(jewel_type, result[i]);
                }
            }
            result
        } else {
            if index > self.node_index.size_notable {
                return Vec::new();
            }
            let pos = (index * s + seed_offset) as usize;
            let Some(&local_id) = data.get(pos) else { return Vec::new() };
            vec![self.node_index.convert_local_to_global(jewel_type, local_id as i64)]
        }
    }
}

/// One node's row of a Legion table, ready to read many seeds without redoing the per-call work of `read_lut`
/// (Glorious Vanity's per-node start and per-seed offsets are summed once here, not once per seed).
pub struct NodeLut {
    data: &'static [u8],
    gv: Option<GvNode>,
    /// Flat tables (types 2-6): the byte of seed offset 0.
    flat_base: usize,
    /// `localIdToGlobalId` for this jewel type, indexed by the byte read.
    l2g: Box<[i64; 256]>,
    seed_count: i64,
}

struct GvNode {
    /// Where this node's header lengths start.
    lens_base: usize,
    /// Where seed offset 0's bytes start; `offsets[k]` is the byte count before seed offset k.
    start: usize,
    offsets: Vec<u32>,
}

impl NodeLut {
    /// The bytes for `seed_offset` (seed minus the type's lowest seed) as upstream's `readLUT` returns them, written
    /// to `out` and counted. Returns 0 when upstream returns an empty list.
    pub fn get(&self, seed_offset: i64, out: &mut [i64; 8]) -> usize {
        if seed_offset < 0 || seed_offset >= self.seed_count {
            return 0;
        }
        match &self.gv {
            None => {
                let Some(&b) = self.data.get(self.flat_base + seed_offset as usize) else { return 0 };
                out[0] = self.l2g[b as usize];
                1
            }
            Some(g) => {
                let k = seed_offset as usize;
                let length = *self.data.get(g.lens_base + k).unwrap_or(&0) as usize;
                if length == 0 || length > 8 {
                    return 0;
                }
                let start = g.start + g.offsets[k] as usize;
                let end = start + length;
                if end > self.data.len() {
                    return 0;
                }
                for (i, &b) in self.data[start..end].iter().enumerate() {
                    out[i] = b as i64;
                }
                if length == 2 || length == 3 {
                    out[0] = self.l2g[out[0] as usize & 255];
                } else if length == 6 || length == 8 {
                    for v in out.iter_mut().take(length / 2) {
                        *v = self.l2g[*v as usize & 255];
                    }
                }
                length
            }
        }
    }
}

/// The lowest and highest seed of a Legion jewel type, and the step between seeds (Elegant Hubris counts in twenties).
pub fn seed_bounds(jewel_type: i64) -> (i64, i64, i64) {
    if (7..=11).contains(&jewel_type) {
        return (100, 8000, 1);
    }
    let step = if jewel_type == 5 { 20 } else { 1 };
    (seed_min(jewel_type) * step, seed_max(jewel_type) * step, step)
}

/// The data file a Legion jewel type reads (`GloriousVanity`, ...), without extension.
pub fn table_name(jewel_type: i64) -> Option<&'static str> {
    jewel_file_name(jewel_type)
}

impl TimelessJewelData {
    /// The directory the tables are read from.
    pub fn dir(&self) -> &Path {
        &self.data_dir
    }

    /// A tree node's row of a jewel type's table, or None where `read_lut` would always return an empty list (unknown
    /// node, a non-Notable index for types 2-6, a missing table).
    pub fn node_lut(&self, jewel_type: i64, node_id: i64) -> Option<NodeLut> {
        if !(1..=6).contains(&jewel_type) {
            return None;
        }
        let &(index, _size) = self.node_index.by_node_id.get(&node_id)?;
        let data = self.jewel_bytes(jewel_type)?;
        let s = seed_max(jewel_type) - seed_min(jewel_type) + 1;
        let mut l2g = Box::new([0i64; 256]);
        for (i, v) in l2g.iter_mut().enumerate() {
            *v = self.node_index.convert_local_to_global(jewel_type, i as i64);
        }
        if jewel_type == 1 {
            let gv_size = self.node_index.gv_size;
            if index < 0 || index >= gv_size {
                return None;
            }
            let header_len = gv_size * s;
            let node_start: i64 = header_len + self.node_index.gv_index_to_size[..index as usize].iter().sum::<i64>();
            let lens_base = (index * s) as usize;
            let mut offsets = Vec::with_capacity(s as usize + 1);
            let mut acc: u32 = 0;
            for k in 0..s as usize {
                offsets.push(acc);
                acc += *data.get(lens_base + k).unwrap_or(&0) as u32;
            }
            offsets.push(acc);
            Some(NodeLut { data, gv: Some(GvNode { lens_base, start: node_start as usize, offsets }), flat_base: 0, l2g, seed_count: s })
        } else {
            if index > self.node_index.size_notable {
                return None;
            }
            Some(NodeLut { data, gv: None, flat_base: (index * s) as usize, l2g, seed_count: s })
        }
    }

    /// Whether the files of a jewel type's table are in the data folder (a `.bin`, or its zip or zip parts), without
    /// reading them. 1 to 6 are the Legion tables, 7 to 11 the Abyss ones.
    pub fn table_present(&self, jewel_type: i64) -> bool {
        let Some(name) = jewel_file_name(jewel_type).or_else(|| crate::abyss::abyss_file_name(jewel_type)) else { return false };
        let dir = &self.data_dir;
        let nonempty = |p: std::path::PathBuf| std::fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false);
        nonempty(dir.join(format!("{name}.bin")))
            || nonempty(pom_engine::cjson::cache_dir(dir).join(format!("{name}.bin")))
            || nonempty(dir.join(format!("{name}.zip")))
            || nonempty(dir.join(format!("{name}.zip.part0")))
    }

    /// Whether the table file for a Legion jewel type can be read (or inflated from its zip).
    pub fn has_table(&self, jewel_type: i64) -> bool {
        self.jewel_bytes(jewel_type).is_some()
    }
}
