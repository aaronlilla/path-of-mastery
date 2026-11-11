//! Port of LuaJIT 2.1's table (GCtab) hash-part algorithm, from the exact
//! source upstream ships (LuaJIT/LuaJIT commit 2460b3ff93a1c955de3d62cfc825de7d68dc272e), covering only
//! the number-keyed subset (`lj_tab.c`/`lj_tab.h`'s hashrot/hashnum, `lj_tab_newkey`'s Brent's
//! variation, countint/countarray/counthash/bestasize/rehashtab, resize, and the
//! array-then-hash-node-array `lj_tab_next` traversal order).
//!
//! Why this exists: `self.allocNodes` in upstream PassiveSpec.lua is a plain Lua table keyed
//! by node id, and several places (the depends/paths pass, the 0-1 BFS root list, `EncodeURL`)
//! iterate it with `pairs()`. Lua/LuaJIT's `pairs()` order for such a table is not insertion order
//! or numeric order; it is exactly this hash-part slot order. When two allocated nodes give a
//! frontier node the same shortest path length, or when a build's node ids don't sort the way the
//! encoded tree URL lists them, only reproducing this exact order gets a byte-identical answer.
//! An earlier JS port of the whole runtime used the same algorithm and reproduced 3,400 of 3,401
//! test builds; this is that algorithm, scoped to the one table this crate needs it for.
//!
//! Node ids here are always non-negative integers well inside the safe f64-integer range, so this
//! only needs the "opaque key" bookkeeping (a non-number key that still occupies a hash node) in
//! spirit, never in practice: `self.allocNodes` is never keyed by anything but a node id.

const HASH_ROT1: u32 = 14;
const HASH_ROT2: u32 = 5;
const HASH_ROT3: u32 = 13;
const LJ_MAX_ABITS: u32 = 28;
const LJ_MAX_ASIZE: i64 = (1i64 << (LJ_MAX_ABITS - 1)) + 1; // 134217729

fn rol(x: u32, n: u32) -> u32 {
    x.rotate_left(n)
}

fn hashrot(lo: u32, hi: u32) -> u32 {
    let lo = lo ^ hi;
    let hi = rol(hi, HASH_ROT1);
    let lo = lo.wrapping_sub(hi);
    let hi = rol(hi, HASH_ROT2);
    let hi = hi ^ lo;
    let hi = hi.wrapping_sub(rol(lo, HASH_ROT3));
    hi
}

/// `hashnum(t, o)`: `hashrot(lo32, hi32 << 1)` of the key's f64 bit pattern (x64 LuaJIT layout).
fn hashnum_raw(num_val: f64) -> u32 {
    let bits = num_val.to_bits();
    let lo = (bits & 0xFFFF_FFFF) as u32;
    let hi = ((bits >> 32) as u32) << 1;
    hashrot(lo, hi)
}

fn fls(x: u32) -> u32 {
    31 - x.leading_zeros()
}

fn hsize2hbits(s: i64) -> u32 {
    if s == 0 {
        0
    } else if s == 1 {
        1
    } else {
        1 + fls((s - 1) as u32)
    }
}

#[derive(Clone, Copy, Debug)]
struct Node {
    key: Option<i64>,
    present: bool,
    next: i64, // -1 sentinel
}

fn mk_node() -> Node {
    Node { key: None, present: false, next: -1 }
}

/// Number-keyed subset of a LuaJIT table's hash part, used to reproduce `pairs()`/`next()` order.
pub struct LjHash {
    asize: i64,
    arr: Vec<bool>,
    hmask: i64, // -1 == no hash part
    nodes: Vec<Node>,
    freetop: i64,
    opaque: i64,
}

impl LjHash {
    pub fn new() -> LjHash {
        LjHash { asize: 0, arr: Vec::new(), hmask: -1, nodes: Vec::new(), freetop: 0, opaque: 0 }
    }

    fn in_array(&self, key: i64) -> bool {
        key >= 0 && key < self.asize
    }
    fn hash_pos(&self, key: i64) -> i64 {
        (hashnum_raw(key as f64) as i64) & self.hmask
    }

    fn find_from(&self, n: i64, key: i64) -> i64 {
        let mut idx = n;
        while idx != -1 {
            if self.nodes[idx as usize].key == Some(key) {
                return idx;
            }
            idx = self.nodes[idx as usize].next;
        }
        -1
    }

    pub fn get(&self, key: i64) -> bool {
        if self.in_array(key) {
            return self.arr[key as usize];
        }
        if self.hmask < 0 {
            return false;
        }
        let idx = self.find_from(self.hash_pos(key), key);
        idx != -1 && self.nodes[idx as usize].present
    }

    /// Mirrors a Lua `self.allocNodes[key] = node` (`present=true`) or `= nil` (`present=false`).
    pub fn set(&mut self, key: i64, present: bool) {
        if self.in_array(key) {
            self.arr[key as usize] = present;
            return;
        }
        if self.hmask >= 0 {
            let idx = self.find_from(self.hash_pos(key), key);
            if idx != -1 {
                self.nodes[idx as usize].present = present;
                return;
            }
        }
        self.newkey(key, present);
    }

    /// `lj_tab_newkey`, Brent's variation. `key` is not yet present anywhere in the table.
    fn newkey(&mut self, key: i64, present: bool) {
        if self.hmask < 0 {
            self.rehash(key);
            self.set(key, present);
            return;
        }
        let n = self.hash_pos(key);
        if self.nodes[n as usize].present {
            let mut freenode = self.freetop;
            loop {
                if freenode == 0 {
                    self.rehash(key);
                    self.set(key, present);
                    return;
                }
                freenode -= 1;
                if self.nodes[freenode as usize].key.is_none() {
                    break;
                }
            }
            self.freetop = freenode;
            let collide = self.hash_pos(self.nodes[n as usize].key.unwrap());
            if collide != n {
                let mut p = collide;
                while self.nodes[p as usize].next != n {
                    p = self.nodes[p as usize].next;
                }
                self.nodes[p as usize].next = freenode;
                self.nodes[freenode as usize].key = self.nodes[n as usize].key;
                self.nodes[freenode as usize].present = self.nodes[n as usize].present;
                self.nodes[freenode as usize].next = self.nodes[n as usize].next;
                self.nodes[n as usize].next = -1;
                self.nodes[n as usize].present = false;
                let mut fnode = freenode;
                loop {
                    let nn_idx = self.nodes[fnode as usize].next;
                    if nn_idx == -1 {
                        break;
                    }
                    if self.nodes[nn_idx as usize].present && self.hash_pos(self.nodes[nn_idx as usize].key.unwrap()) == n {
                        self.nodes[fnode as usize].next = self.nodes[nn_idx as usize].next;
                        self.nodes[nn_idx as usize].next = self.nodes[n as usize].next;
                        self.nodes[n as usize].next = nn_idx;
                        let mut cur = fnode;
                        loop {
                            let idx2 = self.nodes[cur as usize].next;
                            if idx2 == -1 {
                                break;
                            }
                            if self.nodes[idx2 as usize].present {
                                let mn = self.hash_pos(self.nodes[idx2 as usize].key.unwrap());
                                if mn != cur && mn != idx2 {
                                    self.nodes[cur as usize].next = self.nodes[idx2 as usize].next;
                                    self.nodes[idx2 as usize].next = self.nodes[mn as usize].next;
                                    self.nodes[mn as usize].next = idx2;
                                } else {
                                    cur = idx2;
                                }
                            } else {
                                cur = idx2;
                            }
                        }
                        break;
                    } else {
                        fnode = nn_idx;
                    }
                }
                self.nodes[n as usize].key = Some(key);
                self.nodes[n as usize].present = present;
                return;
            } else {
                self.nodes[freenode as usize].next = self.nodes[n as usize].next;
                self.nodes[n as usize].next = freenode;
                self.nodes[freenode as usize].key = Some(key);
                self.nodes[freenode as usize].present = present;
                return;
            }
        }
        self.nodes[n as usize].key = Some(key);
        self.nodes[n as usize].present = present;
    }

    fn count_into_bins(key: i64, bins: &mut [i64; LJ_MAX_ABITS as usize]) -> i64 {
        if key < 0 || key >= LJ_MAX_ASIZE {
            return 0;
        }
        let idx = if key > 2 { fls((key - 1) as u32) } else { 0 };
        bins[idx as usize] += 1;
        1
    }

    fn count_array(&self, bins: &mut [i64; LJ_MAX_ABITS as usize]) -> i64 {
        let asize = self.asize;
        if asize == 0 {
            return 0;
        }
        let mut na = 0i64;
        let mut i: i64 = 0;
        for b in 0..LJ_MAX_ABITS {
            let mut top = 2i64 << b;
            if top >= asize {
                top = asize - 1;
                if i > top {
                    break;
                }
            }
            let mut n = 0i64;
            while i <= top {
                if self.arr[i as usize] {
                    n += 1;
                }
                i += 1;
            }
            bins[b as usize] += n;
            na += n;
        }
        na
    }

    fn count_hash(&self, bins: &mut [i64; LJ_MAX_ABITS as usize]) -> (i64, i64) {
        let mut total = 0i64;
        let mut na = 0i64;
        if self.hmask >= 0 {
            for i in 0..=self.hmask {
                let nd = &self.nodes[i as usize];
                if nd.present {
                    na += Self::count_into_bins(nd.key.unwrap(), bins);
                    total += 1;
                }
            }
        }
        (total, na)
    }

    fn best_asize(bins: &[i64; LJ_MAX_ABITS as usize], narray_in: i64) -> (i64, i64) {
        let mut sum = 0i64;
        let mut na = 0i64;
        let mut sz = 0i64;
        let nn = narray_in;
        let mut b = 0u32;
        while 2 * nn > (1i64 << b) && sum != nn {
            let bv = bins[b as usize];
            if bv > 0 {
                sum += bv;
                if 2 * sum > (1i64 << b) {
                    sz = (2i64 << b) + 1;
                    na = sum;
                }
            }
            b += 1;
            if b >= LJ_MAX_ABITS {
                break;
            }
        }
        (na, sz)
    }

    fn rehash(&mut self, new_key: i64) {
        let mut bins = [0i64; LJ_MAX_ABITS as usize];
        let mut asize_count = self.count_array(&mut bins);
        let mut total = 1 + asize_count;
        let (h_total, h_na) = self.count_hash(&mut bins);
        total += h_total + self.opaque;
        asize_count += h_na;
        asize_count += Self::count_into_bins(new_key, &mut bins);
        let (na, asize) = Self::best_asize(&bins, asize_count);
        total -= na;
        self.resize(asize, hsize2hbits(total) as i64);
    }

    fn resize(&mut self, new_asize: i64, new_hbits: i64) {
        let old_arr = std::mem::take(&mut self.arr);
        let old_asize = self.asize;
        let old_nodes = std::mem::take(&mut self.nodes);
        let old_hmask = self.hmask;

        if new_asize > old_asize {
            let mut arr2 = old_arr[..old_asize as usize].to_vec();
            arr2.resize(new_asize as usize, false);
            self.arr = arr2;
            self.asize = new_asize;
        } else {
            self.arr = old_arr.clone();
        }

        if new_hbits != 0 {
            let hsize = 1i64 << new_hbits;
            self.nodes = (0..hsize).map(|_| mk_node()).collect();
            self.hmask = hsize - 1;
            self.freetop = hsize;
        } else {
            self.nodes = Vec::new();
            self.hmask = -1;
            self.freetop = 0;
        }

        if new_asize < old_asize {
            let arr2 = self.arr[..new_asize as usize].to_vec();
            self.arr = arr2;
            self.asize = new_asize;
            for i in new_asize..old_asize {
                if old_arr[i as usize] {
                    self.set(i, true);
                }
            }
        }

        if old_hmask >= 0 {
            for i in 0..=old_hmask {
                let nd = &old_nodes[i as usize];
                if nd.present {
                    self.set(nd.key.unwrap(), true);
                }
            }
        }
    }

    /// Traversal order: array part low->high, then hash node array in slot order (`lj_tab_next`).
    /// A live snapshot: since `DeallocSingleNode` only ever clears existing keys during a pass
    /// (never inserts), taking this once per pass and having the caller re-check `node.alloc`
    /// as it consumes the list reproduces Lua's "skip a key cleared before `next` reaches its
    /// slot, keep one already yielded" semantics exactly.
    pub fn iterate(&self) -> Vec<i64> {
        let mut out = Vec::new();
        for i in 0..self.asize {
            if self.arr[i as usize] {
                out.push(i);
            }
        }
        if self.hmask >= 0 {
            for i in 0..=self.hmask {
                let nd = &self.nodes[i as usize];
                if nd.present {
                    out.push(nd.key.unwrap());
                }
            }
        }
        out
    }
}

impl Default for LjHash {
    fn default() -> Self {
        Self::new()
    }
}
