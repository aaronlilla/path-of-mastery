//! Interned strings. Every mod name, tag kind and tag field is a `Sym` (a u32), so hot-path
//! lookups compare integers instead of hashing strings the way the Lua original does.
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

#[derive(Copy, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct Sym(pub u32);

struct Interner { map: HashMap<&'static str, Sym>, names: Vec<&'static str> }

fn interner() -> &'static RwLock<Interner> {
    static I: OnceLock<RwLock<Interner>> = OnceLock::new();
    I.get_or_init(|| RwLock::new(Interner { map: HashMap::new(), names: Vec::new() }))
}

impl Sym {
    pub fn new(s: &str) -> Sym {
        if let Some(&id) = interner().read().unwrap().map.get(s) { return id; }
        let mut w = interner().write().unwrap();
        if let Some(&id) = w.map.get(s) { return id; }
        let leaked: &'static str = Box::leak(s.to_owned().into_boxed_str());
        let id = Sym(w.names.len() as u32);
        w.names.push(leaked);
        w.map.insert(leaked, id);
        id
    }
    pub fn as_str(self) -> &'static str { interner().read().unwrap().names[self.0 as usize] }
}
