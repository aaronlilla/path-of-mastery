//! `applyEnemyModifiers(actor)` (CalcPerform.lua:619-633): every `EnemyModifier` LIST mod in the
//! player's modDB carries a wrapped mod (`{ mod = <inner> }`) that is copied into the enemy's modDB
//! (source: the inner mod's own, else the wrapper's), once per distinct wrapper.
use pom_engine::modifier::{Mod, ModType};
use pom_engine::modstore::store::ModStore;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_engine::fxhash::HashSet;

pub fn apply_enemy_modifiers(player: &ModStore, enemy: &mut ModStore, cache: &mut HashSet<String>) {
    let mut add: Vec<Mod> = Vec::new();
    // Upstream keys its cache by the mod TABLE (identity), so two equal mods from two items (the same item in Ring 1
    // and Ring 2) are both applied: key = content + the n-th occurrence of that content in the modDB.
    let mut occ: pom_engine::fxhash::HashMap<String, usize> = pom_engine::fxhash::HashMap::default();
    for (v, m) in player.tabulate(None, None, &[pom_engine::sym!("EnemyModifier")]) {
        // SAFETY: `m` points into `player`'s live mod storage for the duration of this call.
        let outer: &Mod = unsafe { &*m };
        if outer.ty != ModType::List {
            continue;
        }
        let Value::Map(fields) = &outer.value else { continue };
        let Some((_, Value::Map(inner_map))) = fields.iter().find(|(k, _)| k.as_str() == "mod") else { continue };
        let _ = v;
        let base = format!("{:?}|{:?}|{:?}", inner_map, outer.source, outer.tags);
        let n = occ.entry(base.clone()).or_insert(0);
        *n += 1;
        let key = format!("{base}#{n}");
        if !cache.insert(key) {
            continue;
        }
        let mut inner = crate::actor_misc::map_to_mod(inner_map);
        if inner.source.is_none() {
            inner.source = outer.source.clone();
        }
        add.push(inner);
    }
    for m in add {
        enemy.add_mod(m);
    }
}
