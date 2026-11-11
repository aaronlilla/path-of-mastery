//! Abyss timeless jewels (jewel types 7-11): port of `Modules/DataAbyssJewelLookUpTableHelper.lua`
//! (`readAbyssJewelLUT`). Files are `Data/TimelessJewelData/Abyss<Name>.zip.part*`, parsed once per
//! jewel type; each socket/node block is scanned lazily per seed the way `getRecordOffsets` does.

use crate::timelessjewel::TimelessJewelData;
use std::cell::RefCell;
use pom_engine::fxhash::HashMap;
use std::rc::Rc;

/// One part of an Abyss modification: `ty` 1 replaces the node with a Legion node, 2 adds the
/// stats of a Legion addition; `id` is already mapped through `localIdToGlobalId`.
#[derive(Clone, Debug)]
pub struct AbyssComponent {
    pub ty: u8,
    pub id: i64,
    pub rolls: Vec<i64>,
}

pub type AbyssModification = Vec<AbyssComponent>;

pub(crate) struct AbyssLut {
    data: &'static [u8],
    format: [u8; 4],
    seed_min: i64,
    seed_max: i64,
    seed_inc: i64,
    seed_count: i64,
    block_offsets: HashMap<i64, usize>,
    ascendancy_offsets: Vec<(String, usize)>,
    seed_offsets: RefCell<HashMap<String, Rc<Vec<usize>>>>,
}

pub fn abyss_file_name(jewel_type: i64) -> Option<&'static str> {
    match jewel_type {
        7 => Some("AbyssTecrod"),
        8 => Some("AbyssUlaman"),
        9 => Some("AbyssKurgal"),
        10 => Some("AbyssAmanamu"),
        11 => Some("AbyssZorath"),
        _ => None,
    }
}

fn u16_at(d: &[u8], o: usize) -> usize {
    d.get(o).copied().unwrap_or(0) as usize + d.get(o + 1).copied().unwrap_or(0) as usize * 256
}

fn skip_modification(d: &[u8], mut o: usize) -> usize {
    let n = d.get(o).copied().unwrap_or(0) as usize;
    o += 1;
    for _ in 0..n {
        let stat_count = d.get(o + 2).copied().unwrap_or(0) as usize;
        o += 3 + stat_count * 2;
    }
    o
}

fn skip_socket_record(d: &[u8], mut o: usize) -> usize {
    let n = d.get(o).copied().unwrap_or(0) as usize;
    o += 1;
    for _ in 0..n {
        o = skip_modification(d, o + 2);
    }
    o
}

fn skip_ascendancy_record(d: &[u8], o: usize) -> usize {
    o + 1 + d.get(o).copied().unwrap_or(0) as usize * 2
}

fn parse_abyss(t: &TimelessJewelData, jewel_type: i64) -> Option<AbyssLut> {
    let name = abyss_file_name(jewel_type)?;
    let bytes = t.load_file(name)?;
    let d: &[u8] = &bytes;
    let format = [*d.first()?, *d.get(1)?, *d.get(2)?, *d.get(3)?];
    if *d.get(4)? != 1 || *d.get(5)? as i64 != jewel_type {
        return None;
    }
    let seed_min = u16_at(d, 6) as i64;
    let seed_max = u16_at(d, 8) as i64;
    let seed_inc = u16_at(d, 10) as i64;
    if seed_inc == 0 {
        return None;
    }
    let seed_count = (seed_max - seed_min) / seed_inc + 1;
    let mut o = 12usize;
    let mut block_offsets = HashMap::default();
    let mut ascendancy_offsets = Vec::new();
    if &format == b"ABYS" {
        let socket_count = *d.get(o)? as usize;
        o += 2;
        let mut ids = Vec::new();
        for _ in 0..socket_count {
            ids.push(u16_at(d, o) as i64);
            o += 2;
        }
        for id in ids {
            block_offsets.insert(id, o);
            for _ in 0..seed_count {
                o = skip_socket_record(d, o);
            }
        }
    } else if &format == b"ABYN" {
        let node_count = u16_at(d, o);
        o += 2;
        let mut ids = Vec::new();
        for _ in 0..node_count {
            ids.push(u16_at(d, o) as i64);
            o += 2;
        }
        for id in ids {
            block_offsets.insert(id, o);
            for _ in 0..seed_count {
                o = skip_modification(d, o);
            }
        }
        if d.get(o..o + 4)? != b"ASCS" {
            return None;
        }
        o += 4;
        let asc_count = u16_at(d, o);
        o += 2;
        for _ in 0..asc_count {
            let nl = *d.get(o)? as usize;
            let nm = String::from_utf8_lossy(d.get(o + 1..o + 1 + nl)?).to_string();
            o += nl + 1;
            ascendancy_offsets.push((nm, o));
            for _ in 0..seed_count {
                o = skip_ascendancy_record(d, o);
            }
        }
    } else {
        return None;
    }
    Some(AbyssLut { data: bytes, format, seed_min, seed_max, seed_inc, seed_count, block_offsets, ascendancy_offsets, seed_offsets: RefCell::new(HashMap::default()) })
}

fn seed_index(l: &AbyssLut, seed: i64) -> Option<usize> {
    let off = seed - l.seed_min;
    if off < 0 || seed > l.seed_max || off % l.seed_inc != 0 {
        return None;
    }
    Some((off / l.seed_inc) as usize)
}

fn record_offsets(l: &AbyssLut, key: &str, block: usize, skip: fn(&[u8], usize) -> usize) -> Rc<Vec<usize>> {
    if let Some(v) = l.seed_offsets.borrow().get(key) {
        return v.clone();
    }
    let mut v = Vec::with_capacity(l.seed_count as usize);
    let mut o = block;
    for _ in 0..l.seed_count {
        v.push(o);
        o = skip(&l.data, o);
    }
    let rc = Rc::new(v);
    l.seed_offsets.borrow_mut().insert(key.to_string(), rc.clone());
    rc
}

fn read_modification(t: &TimelessJewelData, d: &[u8], mut o: usize, jewel_type: i64) -> (AbyssModification, usize) {
    let n = d.get(o).copied().unwrap_or(0) as usize;
    o += 1;
    let mut out = Vec::new();
    for _ in 0..n {
        let ty = d.get(o).copied().unwrap_or(0);
        let local_id = d.get(o + 1).copied().unwrap_or(0) as i64;
        let stat_count = d.get(o + 2).copied().unwrap_or(0) as usize;
        o += 3;
        let id = t.local_to_global(jewel_type, local_id);
        let mut rolls = Vec::new();
        for _ in 0..stat_count {
            let r = u16_at(d, o) as i64;
            o += 2;
            rolls.push(if r >= 32768 { r - 65536 } else { r });
        }
        out.push(AbyssComponent { ty, id, rolls });
    }
    (out, o)
}

fn read_node(t: &TimelessJewelData, seed: i64, node_id: i64, jewel_type: i64) -> AbyssModification {
    let Some(l) = t.abyss_lut(jewel_type) else { return Vec::new() };
    let Some(si) = seed_index(&l, seed) else { return Vec::new() };
    if &l.format != b"ABYN" {
        return Vec::new();
    }
    let Some(&block) = l.block_offsets.get(&node_id) else { return Vec::new() };
    let offs = record_offsets(&l, &node_id.to_string(), block, skip_modification);
    read_modification(t, &l.data, offs[si], jewel_type).0
}

fn put(out: &mut Vec<(i64, AbyssModification)>, id: i64, m: AbyssModification) {
    if let Some(e) = out.iter_mut().find(|(k, _)| *k == id) {
        e.1 = m;
    } else {
        out.push((id, m));
    }
}

impl TimelessJewelData {
    pub(crate) fn abyss_lut(&self, jewel_type: i64) -> Option<Rc<AbyssLut>> {
        if let Some(l) = self.abyss_cache().borrow().get(&jewel_type) {
            return l.clone();
        }
        let lut = parse_abyss(self, jewel_type).map(Rc::new);
        // A table that is not there yet (still being inflated) is looked for again next time.
        if lut.is_some() {
            self.abyss_cache().borrow_mut().insert(jewel_type, lut.clone());
        }
        lut
    }

    /// Port of `readAbyssJewelLUT(seed, socketId, jewelType, path)`: affected node id -> modification,
    /// in file order. `path` is Zorath's (type 11) shortest path from the socket to the class start.
    pub fn read_abyss_lut(&self, seed: i64, socket_id: i64, jewel_type: i64, path: Option<&[i64]>) -> Vec<(i64, AbyssModification)> {
        self.read_abyss_lut_for(seed, socket_id, jewel_type, path, None)
    }

    /// Whether the table of an Abyss jewel type (7 to 11) can be read.
    pub fn has_abyss_table(&self, jewel_type: i64) -> bool {
        self.abyss_lut(jewel_type).is_some()
    }

    /// `read_abyss_lut` limited, for Zorath, to the ascendancy named `ascendancy` (the Find Timeless Jewel search passes
    /// the build's own; the calculation passes none and reads them all).
    pub fn read_abyss_lut_for(&self, seed: i64, socket_id: i64, jewel_type: i64, path: Option<&[i64]>, ascendancy: Option<&str>) -> Vec<(i64, AbyssModification)> {
        let mut out: Vec<(i64, AbyssModification)> = Vec::new();
        if (7..=10).contains(&jewel_type) {
            let Some(l) = self.abyss_lut(jewel_type) else { return out };
            let Some(si) = seed_index(&l, seed) else { return out };
            if &l.format != b"ABYS" {
                return out;
            }
            let Some(&block) = l.block_offsets.get(&socket_id) else { return out };
            let offs = record_offsets(&l, &socket_id.to_string(), block, skip_socket_record);
            let d: &[u8] = &l.data;
            let mut o = offs[si];
            let n = d.get(o).copied().unwrap_or(0) as usize;
            o += 1;
            for _ in 0..n {
                let node_id = u16_at(d, o) as i64;
                o += 2;
                let (m, no) = read_modification(self, d, o, jewel_type);
                o = no;
                put(&mut out, node_id, m);
            }
            return out;
        }
        let (11, Some(path)) = (jewel_type, path) else { return out };
        for &node_id in path {
            let m = read_node(self, seed, node_id, jewel_type);
            if !m.is_empty() {
                out.push((node_id, m));
            }
        }
        let Some(l) = self.abyss_lut(jewel_type) else { return out };
        let Some(si) = seed_index(&l, seed) else { return out };
        if &l.format != b"ABYN" {
            return out;
        }
        for (name, block) in &l.ascendancy_offsets {
            if ascendancy.is_some_and(|a| a != name) {
                continue;
            }
            let offs = record_offsets(&l, &format!("ascendancy:{name}"), *block, skip_ascendancy_record);
            let d: &[u8] = &l.data;
            let mut o = offs[si];
            let n = d.get(o).copied().unwrap_or(0) as usize;
            o += 1;
            for _ in 0..n {
                let node_id = u16_at(d, o) as i64;
                o += 2;
                let m = read_node(self, seed, node_id, jewel_type);
                put(&mut out, node_id, m);
            }
        }
        out
    }
}
