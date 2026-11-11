//! Interned strings. Every mod name, tag kind and tag field is a `Sym` (a u32), so hot-path
//! lookups compare integers instead of hashing strings the way the Lua original does.
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

#[derive(Copy, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct Sym(pub u32);

/// FxHash-style string hasher: the interner only needs speed, not DoS resistance, and ids are assigned in
/// first-seen order regardless of the hasher.
#[derive(Default, Clone, Copy)]
struct FxHasher(u64);
impl std::hash::Hasher for FxHasher {
    fn write(&mut self, bytes: &[u8]) {
        let mut chunks = bytes.chunks_exact(8);
        for c in &mut chunks {
            self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(c.try_into().unwrap())).wrapping_mul(0x517cc1b727220a95);
        }
        for &b in chunks.remainder() {
            self.0 = (self.0.rotate_left(5) ^ b as u64).wrapping_mul(0x517cc1b727220a95);
        }
    }
    fn finish(&self) -> u64 { self.0 }
}
type FxBuild = std::hash::BuildHasherDefault<FxHasher>;

struct Interner { map: HashMap<&'static str, Sym, FxBuild>, names: Vec<&'static str> }

fn interner() -> &'static RwLock<Interner> {
    static I: OnceLock<RwLock<Interner>> = OnceLock::new();
    I.get_or_init(|| RwLock::new(Interner { map: HashMap::default(), names: Vec::new() }))
}

impl Sym {
    pub fn new(s: &str) -> Sym {
        // Per-thread copy of the interned map: ids never change once assigned, so a hit here is always valid
        // and skips the shared lock.
        thread_local! {
            static LOCAL: std::cell::RefCell<HashMap<&'static str, Sym, FxBuild>> = std::cell::RefCell::new(HashMap::default());
        }
        if let Some(id) = LOCAL.with(|l| l.borrow().get(s).copied()) { return id; }
        let id = Sym::new_shared(s);
        let name = interner().read().unwrap().names[id.0 as usize];
        LOCAL.with(|l| l.borrow_mut().insert(name, id));
        id
    }
    fn new_shared(s: &str) -> Sym {
        if let Some(&id) = interner().read().unwrap().map.get(s) { return id; }
        let mut w = interner().write().unwrap();
        if let Some(&id) = w.map.get(s) { return id; }
        let leaked: &'static str = Box::leak(s.to_owned().into_boxed_str());
        let id = Sym(w.names.len() as u32);
        w.names.push(leaked);
        w.map.insert(leaked, id);
        id
    }
    pub fn as_str(self) -> &'static str {
        // Per-thread copy of the name table: names are only ever appended, so a copied prefix stays valid and a
        // miss just catches up with the shared table.
        thread_local! {
            static NAMES: std::cell::RefCell<Vec<&'static str>> = const { std::cell::RefCell::new(Vec::new()) };
        }
        if let Some(s) = NAMES.with(|n| n.borrow().get(self.0 as usize).copied()) {
            return s;
        }
        let shared = interner().read().unwrap();
        NAMES.with(|n| {
            let mut n = n.borrow_mut();
            let have = n.len();
            n.extend_from_slice(&shared.names[have..]);
        });
        shared.names[self.0 as usize]
    }
}

/// `Sym::new` for a string literal, interned once per call site: the calc names the same stats thousands of
/// times per run. The first call interns at the same point `Sym::new` would have, so ids keep their order.
#[macro_export]
macro_rules! sym {
    ($s:literal) => {{
        static S: std::sync::OnceLock<$crate::sym::Sym> = std::sync::OnceLock::new();
        *S.get_or_init(|| $crate::sym::Sym::new($s))
    }};
}
