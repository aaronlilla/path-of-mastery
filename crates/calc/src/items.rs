//! Reads the item crate's own recording (`engine-data/item_golden/corpus/<build>.jsonl`) for
//! the equipped-item contribution to a build's modDB. Only covers the common merge path
//! (Modules/CalcSetup.lua lines 1067-1270's final `else` branch: `env.itemModDB:ScaleAddList(
//! srcList, scale)` with `scale == 1`) plus four of its special-cased slots (Kalandra's Touch,
//! abyssal-socket `SocketedJewelEffect` scaling, gloves/boots `EffectOfBonusesFrom*` scaling,
//! Widowhail-scaled quivers) - Necromantic Aegis, Energy Blade, The Iron Mass, The Dancing
//! Dervish and corrupted-jewel-effect scaling are still not ported.
//! Each item's already-combined mods (implicit + explicit + enchant + crucible + scourge, as the
//! item crate finalized it) are used as `srcList` directly: a single-slot item (jewels, flasks,
//! amulets, belts, armour) records them as a flat `modList`; a ring or weapon, which can go in
//! more than one slot, instead records one list per possible slot under `slotModList` (see
//! `ItemMods`).
use crate::modbuild::m;
use crate::rawlua::parse_raw_mod;
use pom_engine::modifier::{Mod, ModType};
use pom_engine::modstore::ModStore;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use serde_json::Value as J;
use pom_engine::fxhash::HashMap;
use std::path::Path;

/// One item's recorded mods: either a single flat list (an item that only ever occupies one
/// kind of slot: jewels, flasks, amulets, belts, armour pieces) or, for an item that can go in
/// more than one slot (rings: "Ring 1"/"Ring 2"/"Ring 3"; weapons: "Weapon 1"/"Weapon 2"), one
/// list per possible `sourceSlot` under the recording's `slotModList` (each build's item picks
/// whichever one matches where it's actually equipped). The alternates only ever differ in that
/// `sourceSlot` label, never in the mods themselves, so any one of them is a safe fallback.
enum ItemMods {
    Flat(Vec<Mod>),
    BySlot(Vec<(String, Vec<Mod>)>),
}

/// The recorded item-level fields `mergeFlasks` needs beyond an item's own mod list - see
/// `BuildItems::flask_meta_for_slot`.
pub struct FlaskItemMeta<'a> {
    pub base_name: &'a str,
    pub title: Option<&'a str>,
    pub rarity: &'a str,
    pub effect_inc: f64,
}

/// One build's equipped items, keyed by `itemId` (`build.itemsTab.items[id]`'s key, matching
/// the recorder's `itemSlots` map).
pub struct BuildItems {
    by_item_id: HashMap<i64, ItemMods>,
    /// Each item's own `type` field (e.g. `"Bow"`, `"One Handed Sword"`), for `weaponData.type`
    /// lookups (`data::weapon_is_melee`) that don't need the item's mods at all.
    item_type: HashMap<i64, String>,
    /// Each item's own display `name` (e.g. `"Kalandra's Touch, Ring"`), for the handful of
    /// special-case branches CalcSetup.lua's item loop keys off an exact/partial item name
    /// instead of its type.
    item_name: HashMap<i64, String>,
    /// `1 + (sum of this item's own "X% increased Effect of Socketed Abyss Jewels"-style
    /// "SocketedJewelEffect" INC rolls) / 100` (`Item.lua:2691`'s `self.socketedJewelEffectModifier`,
    /// a `calcLocal` extraction - consumed out of the item's final `modList` before recording, so
    /// this crate re-derives it from the raw `explicitModLines`/`implicitModLines` mod text
    /// instead). Only meaningful for an item that has an abyssal socket; every other item's
    /// absence from this map means the default multiplier of 1 (`combined_mods` treats a missing
    /// entry that way).
    socketed_jewel_effect: HashMap<i64, f64>,
    /// `item.baseName` (e.g. "Quicksilver Flask"), recorded directly. `mergeFlasks`'s
    /// `buffModList` grouping key (CalcPerform.lua:1727) and `data::flask_base_info`'s lookup key.
    base_name: HashMap<i64, String>,
    /// `item.title` (only set for RARE/UNIQUE/RELIC rarity - `Item.lua:1017-1019`), recorded
    /// directly. `mergeFlasks`'s `modList` grouping key for a UNIQUE/RELIC flask.
    title: HashMap<i64, String>,
    /// `item.rarity` ("NORMAL"/"MAGIC"/"RARE"/"UNIQUE"/"RELIC"), recorded directly.
    rarity: HashMap<i64, String>,
    /// `item.flaskData.effectInc` (`calcLocal(modList, "FlaskEffect", "INC", 0) +
    /// calcLocal(modList, "LocalEffect", "INC", 0)`, Item.lua:2452) - recorded directly since
    /// `calcLocal` mutates the item's own modList by removing these mods before this crate's
    /// `modList`/`slotModList` recording ever sees it, so there's no way to re-derive this sum
    /// from the recorded mod list alone. 0 for a non-flask item (missing from this map).
    flask_effect_inc: HashMap<i64, f64>,
}

fn first_source_slot(v: &J) -> Option<String> {
    v.as_array()?.first()?.get("sourceSlot")?.as_str().map(|s| s.to_string())
}

/// Sums every unconditional (no tags), unflagged "SocketedJewelEffect" INC mod across an item's
/// recorded mod-line groups (`explicitModLines`/`implicitModLines`/`crucibleModLines`/
/// `scourgeModLines`/`enchantModLines`) - the same set `Item.lua:2691`'s `calcLocal(baseList, ...)`
/// scans, since `baseList` is those lines' mods combined before the final `modList` is built. Each
/// field records as a JSON array of `{line, modList, ...}` when non-empty, or as `{}` (the
/// recorder's convention for "empty Lua table, could be either shape") when there's nothing there.
fn socketed_jewel_effect_sum(v: &J) -> f64 {
    let mut sum = 0.0;
    for field in ["explicitModLines", "implicitModLines", "crucibleModLines", "scourgeModLines", "enchantModLines"] {
        let Some(lines) = v.get(field).and_then(|f| f.as_array()) else { continue };
        for line in lines {
            let Some(mod_list) = line.get("modList").and_then(|m| m.as_array()) else { continue };
            for raw in mod_list {
                let m = parse_raw_mod(raw);
                if m.name.as_str() == "SocketedJewelEffect" && m.ty == pom_engine::modifier::ModType::Inc && m.flags == 0 && m.keyword_flags == 0 && m.tags.is_empty() {
                    if let Some(n) = m.value.num() {
                        sum += n;
                    }
                }
            }
        }
    }
    sum
}

/// Mirrors `Classes/ModStore.lua`'s `ModStoreClass:ScaleAddMod` for the two shapes this crate's
/// recorded mods actually take: a plain numeric `value` gets scaled directly; a LIST mod whose
/// value is a `{mod = <sub-mod>}` wrapper (every `MinionModifier` this crate has seen) has its
/// nested sub-mod's numeric value scaled instead, matching how upstream drills into
/// `scaledMod.value.mod` before checking `type(subMod.value) == "number"`. Any other LIST-value
/// shape (no `mod` key) is left unscaled, exactly as upstream leaves it when neither `.mod`
/// nor `.keyOfScaledMod` is present. Does not implement `data.highPrecisionMods`' per-mod-name
/// decimal-precision override (CalcSetup.lua's `ModStore.lua:75-82`): every scaled result here
/// takes the non-high-precision path (`round(v*scale,2)` then `math.modf`'s integer-part
/// truncation) since every case this crate has graded so far scales an already-integer value by
/// an integer-ish factor, which the two paths agree on.
fn scale_mod(m: &Mod, scale: f64) -> Mod {
    if scale == 1.0 {
        return m.clone();
    }
    let scale_num = |n: f64| ((n * scale * 100.0 + 0.5).floor() / 100.0).trunc();
    let mut out = m.clone();
    match &m.value {
        Value::Num(n) => out.value = Value::Num(scale_num(*n)),
        Value::Map(fields) => {
            let mod_key = pom_engine::sym!("mod");
            if let Some(pos) = fields.iter().position(|(k, _)| *k == mod_key) {
                if let Value::Map(inner) = &fields[pos].1 {
                    let value_key = pom_engine::sym!("value");
                    if let Some(vpos) = inner.iter().position(|(k, _)| *k == value_key) {
                        if let Value::Num(iv) = inner[vpos].1 {
                            let mut new_inner = (**inner).clone();
                            new_inner[vpos].1 = Value::Num(scale_num(iv));
                            let mut new_fields = (**fields).clone();
                            new_fields[pos].1 = Value::Map(std::sync::Arc::new(new_inner));
                            out.value = Value::Map(std::sync::Arc::new(new_fields));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    out
}

/// `calcLib.mod(modStore, nil, name)` (Modules/CalcTools.lua:16-18): `(1 + Sum(INC, name)/100) *
/// More(name)`.
fn calc_mod_factor(store: &ModStore, name: &str) -> f64 {
    let sym = Sym::new(name);
    (1.0 + store.sum(ModType::Inc, None, &[sym]) / 100.0) * store.more(None, &[sym])
}

/// A throwaway `ModStore` over a plain `Vec<Mod>`, for the one-off `Sum`/`More` evaluation
/// `calcLib.mod` needs - not this build's real `env.initialNodeModDB` (no `ModDB`-vs-`ModList`
/// bucketing difference matters for a flat `Sum`/`More` over the whole list either way).
fn mod_store_from(mods: &[Mod]) -> ModStore {
    let mut store = ModStore::new_list(None, None);
    for m in mods {
        store.add_mod(m.clone());
    }
    store
}

impl BuildItems {
    pub fn load(corpus_dir: &Path, build_name: &str) -> Option<BuildItems> {
        let path = corpus_dir.join(format!("{build_name}.jsonl"));
        let text = std::fs::read_to_string(&path).ok()?;
        let mut by_item_id = HashMap::default();
        let mut item_type = HashMap::default();
        let mut item_name = HashMap::default();
        let mut socketed_jewel_effect = HashMap::default();
        let mut base_name = HashMap::default();
        let mut title = HashMap::default();
        let mut rarity = HashMap::default();
        let mut flask_effect_inc = HashMap::default();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let v: J = serde_json::from_str(line).unwrap_or_else(|e| panic!("bad item_golden line in {}: {e}", path.display()));
            let Some(item_id) = v.get("itemId").and_then(|x| x.as_i64()) else { continue };
            let entry = if let Some(m) = v.get("modList") {
                ItemMods::Flat(m.as_array().map(|a| a.iter().map(parse_raw_mod).collect()).unwrap_or_default())
            } else if let Some(sml) = v.get("slotModList").and_then(|s| s.as_array()) {
                ItemMods::BySlot(
                    sml.iter()
                        .map(|arr| (first_source_slot(arr).unwrap_or_default(), arr.as_array().map(|a| a.iter().map(parse_raw_mod).collect()).unwrap_or_default()))
                        .collect(),
                )
            } else {
                ItemMods::Flat(Vec::new())
            };
            by_item_id.insert(item_id, entry);
            if let Some(ty) = v.get("type").and_then(|t| t.as_str()) {
                item_type.insert(item_id, ty.to_string());
            }
            if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                item_name.insert(item_id, name.to_string());
            }
            let sje = socketed_jewel_effect_sum(&v);
            if sje != 0.0 {
                socketed_jewel_effect.insert(item_id, 1.0 + sje / 100.0);
            }
            if let Some(bn) = v.get("baseName").and_then(|x| x.as_str()) {
                base_name.insert(item_id, bn.to_string());
            }
            if let Some(t) = v.get("title").and_then(|x| x.as_str()) {
                title.insert(item_id, t.to_string());
            }
            if let Some(r) = v.get("rarity").and_then(|x| x.as_str()) {
                rarity.insert(item_id, r.to_string());
            }
            if let Some(fei) = v.get("flaskData").and_then(|f| f.get("effectInc")).and_then(|x| x.as_f64()) {
                flask_effect_inc.insert(item_id, fei);
            }
        }
        Some(BuildItems { by_item_id, item_type, item_name, socketed_jewel_effect, base_name, title, rarity, flask_effect_inc })
    }

    /// The equipped item's own `type` string (`"Bow"`, `"One Handed Sword"`, ...) for
    /// `slotName` (`"Weapon 1"`/`"Weapon 2"`), or `None` if that slot has nothing equipped
    /// (`weaponData.type == "None"`, unarmed).
    pub fn item_type_for_slot(&self, item_slots: &HashMap<String, i64>, slot_name: &str) -> Option<&str> {
        let item_id = item_slots.get(slot_name)?;
        self.item_type.get(item_id).map(|s| s.as_str())
    }

    /// One item's mods for the slot it's actually equipped in. `None` only for an itemId with no
    /// matching recorded item (a recording gap, not expected in the sample corpus). For a
    /// `slotModList` item, picks the alternate matching `slot_name`, or the first one if none
    /// matches exactly (they don't differ in content, only in the unused `sourceSlot` label).
    pub fn mods_for_slot(&self, item_slots: &HashMap<String, i64>, slot_name: &str) -> Option<&[Mod]> {
        let item_id = item_slots.get(slot_name)?;
        let entry = self.by_item_id.get(item_id)?;
        match entry {
            ItemMods::Flat(mods) => Some(mods),
            ItemMods::BySlot(alts) => alts.iter().find(|(s, _)| s == slot_name).or_else(|| alts.first()).map(|(_, mods)| mods.as_slice()),
        }
    }

    /// `item.modSource` ("Item:<id>:<name>", `Item.lua:2553`) for the item equipped in
    /// `slot_name` - the source string a base-derived `buffModList` mod needs
    /// (`perform::flask_buff_mod_list`), matching what this same item's own rolled mods are
    /// already recorded under.
    pub fn mod_source_for_slot(&self, item_slots: &HashMap<String, i64>, slot_name: &str) -> Option<String> {
        let item_id = *item_slots.get(slot_name)?;
        let name = self.item_name.get(&item_id)?;
        Some(format!("Item:{item_id}:{name}"))
    }

    /// The recorded item-level fields `mergeFlasks` (CalcPerform.lua's flask/tincture merge)
    /// needs beyond the item's own mod list: `baseName`/`title`/`rarity`/`flaskData.effectInc`.
    /// `None` only for an itemId with no matching recorded item.
    pub fn flask_meta_for_slot(&self, item_slots: &HashMap<String, i64>, slot_name: &str) -> Option<FlaskItemMeta<'_>> {
        let item_id = *item_slots.get(slot_name)?;
        let base_name = self.base_name.get(&item_id)?.as_str();
        let rarity = self.rarity.get(&item_id).map(|s| s.as_str()).unwrap_or("NORMAL");
        let title = self.title.get(&item_id).map(|s| s.as_str());
        let effect_inc = self.flask_effect_inc.get(&item_id).copied().unwrap_or(0.0);
        Some(FlaskItemMeta { base_name, title, rarity, effect_inc })
    }

    /// `CalcSetup.lua:1189-1211`: a ring named "Kalandra's Touch" contributes none of its own
    /// mods (it has none worth noting - a unique whose only real explicit effect is this branch);
    /// instead it duplicates the *other* ring's entire mod list, re-sourced to itself, provided
    /// that other ring isn't ALSO a Kalandra's Touch. Upstream only ever pairs "Ring 1" with
    /// "Ring 2" (`(slotName == "Ring 1" and "Ring 2") or (slotName == "Ring 2" and "Ring 1")`) -
    /// "Ring 3" (The Unseen Hand's extra slot) is deliberately excluded, a real quirk of the
    /// original, not an omission here. `SocketedIn`-tagged mods (support-gem-facing, never
    /// present on a ring in practice) are filtered out to match upstream's own filter; an
    /// `ExtraSkill` mod from Kalandra's own list still applies ("Only ExtraSkill implicit mods
    /// work... this is likely an in game bug" - upstream's own comment, kept verbatim as the
    /// port's own behavior per this crate's port-faithfully rule).
    fn kalandra_touch_mods(&self, item_slots: &HashMap<String, i64>, slot_name: &str) -> Option<Vec<Mod>> {
        if slot_name != "Ring 1" && slot_name != "Ring 2" {
            return None;
        }
        let item_id = *item_slots.get(slot_name)?;
        let name = self.item_name.get(&item_id)?;
        if !name.contains("Kalandra's Touch") {
            return None;
        }
        let other_slot = if slot_name == "Ring 1" { "Ring 2" } else { "Ring 1" };
        let own_source: std::sync::Arc<str> = format!("Item:{item_id}:{name}").into();
        let mut out = Vec::new();
        if let Some(&other_id) = item_slots.get(other_slot) {
            let other_is_kalandra = self.item_name.get(&other_id).is_some_and(|n| n.contains("Kalandra's Touch"));
            if !other_is_kalandra {
                if let Some(other_mods) = self.mods_for_slot(item_slots, other_slot) {
                    for m in other_mods {
                        if m.tags.iter().any(|t| t.kind.as_str() == "SocketedIn") {
                            continue;
                        }
                        let mut copy = m.clone();
                        copy.source = Some(own_source.clone());
                        out.push(copy);
                    }
                }
            }
        }
        if let Some(own_mods) = self.mods_for_slot(item_slots, slot_name) {
            out.extend(own_mods.iter().filter(|m| m.name.as_str() == "ExtraSkill").cloned());
        }
        Some(out)
    }

    /// `CalcSetup.lua:1228-1236`: when Weapon 2 is a Quiver and either Weapon 1 is named
    /// "Widowhail" or the tree grants a nonzero `EffectOfBonusesFromQuiver` INC sum, the quiver's
    /// whole mod list is scaled by an extra `widowHailMod` factor on top of whatever else it was
    /// already scaled by, and an unscaled `WidowHailMultiplier` BASE mod (source `"Widowhail"`) is
    /// added alongside it. `widowHailMod = 1 + (ownSum + treeSum) / 100` where `ownSum` is Weapon
    /// 1's own (unscaled) `EffectOfBonusesFromQuiver` INC sum - *unless* there's no Weapon 1 at
    /// all, in which case upstream's `A and (B+C) or 100` idiom (lower-precedence `and`/`or`
    /// around `+`) degenerates to the literal fallback value `100`, i.e. `widowHailMod = 2.0`;
    /// ported as written, not smoothed over, since a Quiver can legally be equipped with no
    /// Weapon 1 in the tool even though it doesn't in-game. Returns `None` when the condition
    /// doesn't hold (the overwhelmingly common case - nothing here changes for a normal quiver).
    fn widowhail_scale(&self, item_slots: &HashMap<String, i64>, tree_store: &ModStore) -> Option<(f64, Mod)> {
        let quiver_id = *item_slots.get("Weapon 2")?;
        if self.item_type.get(&quiver_id).map(|s| s.as_str()) != Some("Quiver") {
            return None;
        }
        let effect_of_bonuses_from_quiver = pom_engine::sym!("EffectOfBonusesFromQuiver");
        let tree_sum = tree_store.sum(ModType::Inc, None, &[effect_of_bonuses_from_quiver]);
        let weapon1_id = item_slots.get("Weapon 1").copied();
        let weapon1_is_widowhail = weapon1_id.and_then(|id| self.item_name.get(&id)).is_some_and(|n| n.contains("Widowhail"));
        if !weapon1_is_widowhail && !(tree_sum > 0.0) {
            return None;
        }
        let widow_hail_mod = if weapon1_id.is_some() {
            let own_sum: f64 = self
                .mods_for_slot(item_slots, "Weapon 1")
                .map(|mods| mods.iter().filter(|m| m.name == effect_of_bonuses_from_quiver && m.ty == ModType::Inc).filter_map(|m| m.value.num()).sum())
                .unwrap_or(0.0);
            1.0 + (own_sum + tree_sum) / 100.0
        } else {
            2.0
        };
        Some((widow_hail_mod, m("WidowHailMultiplier", ModType::Base, widow_hail_mod, "Widowhail")))
    }

    /// Sums every item referenced by `item_slots` (slotName -> itemId, from the recorder's
    /// `itemSlots`) through `mods_for_slot`. An abyssal-socketed jewel ("`<Parent>` Abyssal Socket
    /// N", `ItemsTab.lua:231`'s naming) is scaled by its parent item's own
    /// `socketed_jewel_effect_modifier` first (CalcSetup.lua:1051-1058), matching
    /// `env.itemModDB:ScaleAddList(srcList, scale)`'s per-item scale argument - the parent's
    /// scale never applies to the parent's own mods, only to what's socketed into it. A Gloves or
    /// Boots item is scaled by `calcLib.mod(env.initialNodeModDB, nil, "EffectOfBonusesFrom<
    /// Gloves|Boots>")` (CalcSetup.lua:1244-1256) - upstream computes this as an unscaled copy
    /// merged with a `(mult - 1)`-scaled copy on top, which is arithmetically the same as scaling
    /// the whole list by `mult` directly the way the abyssal-socket case already does, so it
    /// reuses `scale_mod` rather than replicating the two-list merge; `tree_mods` (this build's
    /// `env.initialNodeModDB`, i.e. `alloc_node_mods`' flattened mod lists - tree/cluster-jewel
    /// mods only, matching what upstream passes here) backs the one-off `ModStore` that
    /// `calcLib.mod` needs, built fresh per call since this crate has no long-lived store to reuse
    /// (also shared with `widowhail_scale`'s own `Sum` call, so at most one gets built per build).
    /// Weapon 2 additionally goes through `widowhail_scale` (see its own doc comment) on top of
    /// any abyssal/effect scaling already computed for it (never both in practice - a quiver is
    /// never Gloves/Boots-typed or itself abyssal-socketed). A Kalandra's Touch ring (see
    /// `kalandra_touch_mods`) replaces its own mods entirely.
    pub fn combined_mods(&self, item_slots: &HashMap<String, i64>, tree_mods: &[Mod]) -> Vec<Mod> {
        let mut out = Vec::new();
        let mut tree_store: Option<ModStore> = None;
        for slot_name in item_slots.keys() {
            if let Some(mods) = self.kalandra_touch_mods(item_slots, slot_name) {
                out.extend(mods);
                continue;
            }
            let Some(mods) = self.mods_for_slot(item_slots, slot_name) else { continue };
            let abyssal_scale = slot_name
                .find(" Abyssal Socket ")
                .and_then(|idx| item_slots.get(&slot_name[..idx]))
                .and_then(|parent_id| self.socketed_jewel_effect.get(parent_id))
                .copied()
                .unwrap_or(1.0);
            let effect_stat = item_slots.get(slot_name).and_then(|id| self.item_type.get(id)).and_then(|ty| match ty.as_str() {
                "Gloves" => Some("EffectOfBonusesFromGloves"),
                "Boots" => Some("EffectOfBonusesFromBoots"),
                _ => None,
            });
            let effect_scale = match effect_stat {
                Some(stat) => calc_mod_factor(tree_store.get_or_insert_with(|| mod_store_from(tree_mods)), stat),
                None => 1.0,
            };
            let widowhail = if slot_name == "Weapon 2" { self.widowhail_scale(item_slots, tree_store.get_or_insert_with(|| mod_store_from(tree_mods))) } else { None };
            let scale = abyssal_scale * effect_scale * widowhail.as_ref().map(|(f, _)| *f).unwrap_or(1.0);
            if scale == 1.0 {
                out.extend(mods.iter().cloned());
            } else {
                out.extend(mods.iter().map(|m| scale_mod(m, scale)));
            }
            if let Some((_, extra_mod)) = widowhail {
                out.push(extra_mod);
            }
        }
        out
    }
}
