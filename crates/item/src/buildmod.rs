//! Port of `ItemClass:BuildModList` / `BuildModListForSlotNum` (Classes/Item.lua lines 2184-2704):
//! flattens the mod-line buckets into one list, removes and folds "local" mods (a mod that only
//! applies to this item, e.g. a weapon's own +Physical Damage or an armour's own Evasion), and
//! copies the remainder per equip slot (2 for a weapon, 3 for a ring, 1 otherwise), substituting
//! `{SlotName}`/`{Hand}`/`{OtherSlotNum}` in tag string fields and adding the socket-count and
//! quality `Multiplier:` mods.
//!
//! Also computes the `weaponData`/`armourData`/`flaskData`/`tinctureData` derived numeric structs
//! (attack rate, damage rolls, the armour-percentile back-calculation, flask recovery/duration,
//! tincture mana burn/cooldown; Item.lua lines ~2288-2464) as a plain JSON map per struct, stored
//! on `Item` alongside the mod list. These reuse the exact same `calc_local_num`/`peek_local_flag`
//! call sequence the mod-removal code already needed (each `calcLocal` call both removes the mod
//! AND returns the folded value upstream goes on to use), so capturing the value costs nothing
//! extra in removal-order faithfulness. `armourData`'s percentile back-calculation reads
//! `item.armour_data_seed` (`parse.rs`'s port of the "Armour:"/"Evasion:"/etc. spec lines an
//! ordinary item copy of an armour piece already carries, plus an explicit "XBasePercentile:" line
//! on an "advanced copy" export) and defaults to 1 (max roll) only when nothing was seeded,
//! exactly matching upstream.
//! `tinctureData` is computed the same way but has no recorded answer key to grade against
//! (the recorder's `dumpItem` never captures `self.tinctureData`).
//!
//! Scope cut from upstream: `SocketCount`/`NoSockets`/`AbyssalSocketCount` mods are removed
//! (so they don't leak into the final list) but do not rebuild `item.sockets` here (that happens
//! earlier, in `build_mod_lists`), and the accuracy/leech local-condition tag injection (lines
//! 2330-2339) is skipped (it only adds a `Condition` tag, never removes a mod or writes a
//! `weaponData` field, so it cannot affect whether two mod lists OR two `weaponData` maps match --
//! only a downstream calc consumer that reads that tag on a live mod would notice). The "advanced
//! copy" crafting-bench format itself (a raw line starting with `{ ` or the multi-section
//! `Requirements:`-block copy) is unparsed, per `parse.rs`'s own cut list.
use crate::item::Item;
use pom_engine::data::{GameData, ItemBase};
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modparser::types::pmod_to_mod;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use serde_json::Value as J;
use pom_engine::fxhash::HashMap;
use std::sync::Arc;

const DMG_TYPES: &[&str] = &["Physical", "Lightning", "Cold", "Fire", "Chaos"];

/// `Modules/Common.lua`'s `round(val)` (no `dec`): `m_floor(val + 0.5)`.
fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}
/// `Modules/Common.lua`'s `round(val, dec)`: `m_floor(val * 10^dec + 0.5) / 10^dec`.
fn round_dec(v: f64, dec: i32) -> f64 {
    let m = 10f64.powi(dec);
    (v * m + 0.5).floor() / m
}
fn jnum(v: f64) -> J {
    serde_json::Number::from_f64(v).map(J::Number).unwrap_or(J::Null)
}
/// Reads a numeric field out of `base.extra["flask"]`/`base.extra["tincture"]` (plain
/// `serde_json::Value` maps, since `ItemBase::extra` is untyped flattened JSON).
fn flask_num(map: &J, key: &str) -> f64 {
    map.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0)
}
fn value_to_json(v: &Value) -> J {
    match v {
        Value::Nil => J::Null,
        Value::Bool(b) => J::Bool(*b),
        Value::Num(n) => jnum(*n),
        Value::Str(s) => J::String(s.to_string()),
        Value::List(l) => J::Array(l.iter().map(value_to_json).collect()),
        Value::Map(m) => J::Object(m.iter().map(|(k, v)| (k.as_str().to_string(), value_to_json(v))).collect()),
    }
}
/// Port of the percentile back-calculation shared by all 4 armour stats (Item.lua lines 2368-2382,
/// e.g. `if armourData.Armour and armourData.Armour > 0 and not armourData.ArmourBasePercentile
/// then armourData.ArmourBasePercentile = ((armourData.Armour / (incMult * qualityMult) -
/// armourBase)) / armourVariance ... end`): an explicit `XBasePercentile` seed always wins outright
/// (no back-calc); otherwise, if the raw rolled value was seeded and is positive, invert this
/// stat's own final formula for it; otherwise the percentile is unknown (caller defaults to 1).
fn back_calc_percentile(seed: &HashMap<String, f64>, value_key: &str, pct_key: &str, own_base: f64, own_variance: f64, inc_mult: f64, quality_mult: f64) -> Option<f64> {
    if let Some(&pct) = seed.get(pct_key) {
        return Some(pct);
    }
    let v = *seed.get(value_key)?;
    if v <= 0.0 {
        return None;
    }
    let raw = (v / (inc_mult * quality_mult) - own_base) / own_variance;
    Some(round_dec(raw.max(0.0).min(1.0), 4))
}

/// Port of the accuracy/leech local-condition tag injection (Item.lua lines 2330-2339, the weapon
/// branch's `for _, mod in ipairs(modList) do ... end` right after the `WeaponData` LIST-override
/// read): NOT a no-op for `mod_list` matching, despite this crate's earlier module doc claiming
/// otherwise -- it mutates real mods already in the final per-slot list, and the golden data
/// includes the tags it adds. Accuracy/ImpaleChance/LifeOnHit/ManaOnHit/PhysicalDamageLifeLeech/
/// PhysicalDamageManaLeech get a `Condition` tag written into their FIRST tag slot, but only when
/// they currently have none at all (`not mod[1]`); PoisonChance/BleedChance get one APPENDED at the
/// end, but only when they have no tags, or exactly one tag that's already a bare
/// `{Condition, CriticalStrike}` (i.e. from "X% chance to Poison on Critical Strike"-style mods).
fn inject_accuracy_leech_condition_tags(mods: &mut [Mod], slot_num: Option<i64>) {
    use pom_engine::modparser::flags::{keyword_flag, mod_flag};
    let condition_var = if slot_num == Some(1) { "MainHandAttack" } else { "OffHandAttack" };
    let cond_tag = || Tag { kind: pom_engine::sym!("Condition"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from(condition_var)))] };
    let accuracy = pom_engine::sym!("Accuracy");
    let impale_chance = pom_engine::sym!("ImpaleChance");
    let life_on_hit = pom_engine::sym!("LifeOnHit");
    let mana_on_hit = pom_engine::sym!("ManaOnHit");
    let phys_life_leech = pom_engine::sym!("PhysicalDamageLifeLeech");
    let phys_mana_leech = pom_engine::sym!("PhysicalDamageManaLeech");
    let poison_chance = pom_engine::sym!("PoisonChance");
    let bleed_chance = pom_engine::sym!("BleedChance");
    for m in mods.iter_mut() {
        // The keywordFlags guard (Attack-only or unset) gates ONLY this first branch in the
        // original, not the PoisonChance/BleedChance `elseif` below it.
        let kw_ok = m.keyword_flags == 0 || m.keyword_flags == keyword_flag::Attack;
        let first_slot_case = kw_ok
            && ((m.name == accuracy && m.flags == 0)
                || (m.name == impale_chance && m.flags != mod_flag::Spell)
                || ((m.name == life_on_hit || m.name == mana_on_hit) && m.flags == mod_flag::Attack)
                || ((m.name == phys_life_leech || m.name == phys_mana_leech) && m.flags == mod_flag::Attack));
        if first_slot_case {
            if m.tags.is_empty() {
                m.tags.push(cond_tag());
            }
            continue;
        }
        if (m.name == poison_chance || m.name == bleed_chance) && m.flags != mod_flag::Spell {
            let ok_to_append = m.tags.is_empty()
                || (m.tags.len() == 1 && m.tags[0].kind == pom_engine::sym!("Condition") && m.tags[0].get(pom_engine::sym!("var")) == &Value::Str(Arc::from("CriticalStrike")));
            if ok_to_append {
                m.tags.push(cond_tag());
            }
        }
    }
}

/// Port of the `for _, value in ipairs(modList:List(nil, "ArmourData")) do armourData[value.key] =
/// value.value end` pattern (identical for `WeaponData`/`FlaskData`/`TinctureData`): a real
/// corrupted/crafted-implicit mod (e.g. "Has no Energy Shield", "No Physical Damage") can carry a
/// LIST mod naming a derived-data field to overwrite, or -- when its value map has no `value` key
/// at all, e.g. `mod("WeaponData", "LIST", { key = "PhysicalMin" })` -- to delete (Lua `t[k] = nil`
/// removes the key). This is a non-mutating read of `mods`: unlike `calcLocal`, `modList:List(...)`
/// never removes the mod from the list, so it survives into the final `mod_list` too.
fn apply_data_overrides(mods: &[Mod], name: &str, map: &mut serde_json::Map<String, J>) {
    let name_sym = Sym::new(name);
    for m in mods {
        if m.name != name_sym || !matches!(m.ty, ModType::List) {
            continue;
        }
        let Value::Str(key) = m.value.get(pom_engine::sym!("key")) else { continue };
        let val = m.value.get(pom_engine::sym!("value"));
        if matches!(val, Value::Nil) {
            map.remove(key.as_ref());
        } else {
            map.insert(key.to_string(), value_to_json(val));
        }
    }
}

fn tag_allows_local(m: &Mod) -> bool {
    match m.tags.first() {
        None => true,
        Some(t) => t.kind == pom_engine::sym!("InSlot"),
    }
}

/// Port of `calcLocal` for BASE/INC/MORE: removes every exact (name, type, flags) match with no
/// tags (or a single `InSlot` tag) from `mods`, returning the folded value (sum for BASE/INC,
/// running product for MORE).
fn calc_local_num(mods: &mut Vec<Mod>, name: &str, ty: ModType, flags: u64) -> f64 {
    let name_sym = Sym::new(name);
    let mut result = if matches!(ty, ModType::More) { 1.0 } else { 0.0 };
    let mut i = 0;
    while i < mods.len() {
        let m = &mods[i];
        if m.name == name_sym && m.ty == ty && m.flags == flags && m.keyword_flags == 0 && tag_allows_local(m) {
            if let Some(v) = mods[i].value.num() {
                if matches!(ty, ModType::More) {
                    result *= (100.0 + v) / 100.0;
                } else {
                    result += v;
                }
            }
            mods.remove(i);
        } else {
            i += 1;
        }
    }
    result
}

/// Port of `calcLocal` for FLAG.
fn calc_local_flag(mods: &mut Vec<Mod>, name: &str, flags: u64) -> bool {
    let name_sym = Sym::new(name);
    let mut result = false;
    let mut i = 0;
    while i < mods.len() {
        let m = &mods[i];
        if m.name == name_sym && matches!(m.ty, ModType::Flag) && m.flags == flags && m.keyword_flags == 0 && tag_allows_local(m) {
            result = result || mods[i].value.truthy();
            mods.remove(i);
        } else {
            i += 1;
        }
    }
    result
}

/// Non-removing read of a FLAG mod. Two flask calls (`LifeFlaskEffectNotRemoved`/
/// `ManaFlaskEffectNotRemoved`, Item.lua's `flaskData.lifeEffectNotRemoved`/`manaEffectNotRemoved`)
/// run `calcLocal` against `baseList`, not the per-slot `modList` copy `BuildModListForSlotNum`
/// builds at its top -- since that copy already happened, removing the mod from `baseList` doesn't
/// remove it from the slot's own list, so it survives into the final `mod_list`. Every OTHER
/// `calcLocal` call in this branch runs on the per-slot list instead and DOES remove its mod; only
/// these two are scoped to `baseList`, almost certainly a quirk rather than an intentional
/// exception, but the golden data bears it out and this port keeps it faithfully.
fn peek_local_flag(mods: &[Mod], name: &str, flags: u64) -> bool {
    let name_sym = Sym::new(name);
    mods.iter()
        .filter(|m| m.name == name_sym && matches!(m.ty, ModType::Flag) && m.flags == flags && m.keyword_flags == 0 && tag_allows_local(m))
        .fold(false, |acc, m| acc || m.value.truthy())
}

/// Port of `modLib.setSource` (Modules/ModTools.lua): sets a mod's `source`, and -- when its value
/// is a `{mod = <inner>}` wrapper (`MinionModifier`/`EnemyModifier`/`NodeModifier`/
/// `ExtraSkillMod`-shaped LIST mods) -- ALSO stamps the same source onto that inner mod. This is
/// what `BuildModList`'s `baseList:AddMod(modLib.setSource(mod, self.modSource))` call actually
/// does; a plain `mod.source = source` (this crate's first version) leaves the inner mod's
/// `source` unset, which is a real, visible mismatch in the golden data for any "Minions
/// deal/have..." or "Herald of X reserves no mana..."-style wrapped mod.
fn set_mod_source(m: &mut Mod, source: Arc<str>) {
    m.source = Some(source.clone());
    let Value::Map(fields) = &m.value else { return };
    let mod_key = pom_engine::sym!("mod");
    let Some((_, inner)) = fields.iter().find(|(k, _)| *k == mod_key) else { return };
    let Value::Map(inner_fields) = inner else { return };
    let source_key = pom_engine::sym!("source");
    let mut new_inner: Vec<(Sym, Value)> = inner_fields.iter().filter(|(k, _)| *k != source_key).cloned().collect();
    new_inner.push((source_key, Value::Str(source)));
    let new_inner_map = Value::Map(Arc::new(new_inner));
    let new_fields: Vec<(Sym, Value)> = fields.iter().map(|(k, v)| if *k == mod_key { (*k, new_inner_map.clone()) } else { (*k, v.clone()) }).collect();
    m.value = Value::Map(Arc::new(new_fields));
}

fn mod_source_for(item: &Item) -> Arc<str> {
    Arc::from(format!("Item:{}:{}", item.id.unwrap_or(-1), item.name).as_str())
}

fn new_mod(name: &str, ty: ModType, value: f64, source: &str) -> Mod {
    Mod { name: Sym::new(name), ty, value: Value::Num(value), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (vec![]).into() }
}

pub(crate) fn is_line_active(vl: &Option<Vec<i64>>, variant_count: i64, selected_variant: Option<i64>, alt_variants: &[i64]) -> bool {
    match vl {
        None => true,
        Some(list) => {
            if variant_count == 0 {
                return true;
            }
            let sel = selected_variant.unwrap_or(variant_count);
            list.contains(&sel) || alt_variants.iter().any(|v| list.contains(v))
        }
    }
}

/// Port of `ItemClass:BuildModList`. No-op (leaves `item.mod_list`/`slot_mod_list` as `None`) when
/// there's no matched base, matching upstream's early return.
pub fn build_mod_lists(item: &mut Item, data: &GameData) {
    let Some(base) = item.base_name.as_ref().and_then(|n| data.item_bases.get(n)).cloned() else { return };

    let mod_source: Arc<str> = Arc::from(format!("Item:{}:{}", item.id.unwrap_or(-1), item.name).as_str());
    let variant_count = item.variant_count;
    let selected_variant = item.selected_variant;

    let mut base_list: Vec<Mod> = Vec::new();
    for bucket in [
        &item.enchant_mod_lines,
        &item.scourge_mod_lines,
        &item.class_requirement_mod_lines,
        &item.implicit_mod_lines,
        &item.explicit_mod_lines,
        &item.crucible_mod_lines,
    ] {
        for ml in bucket.iter() {
            if ml.disabled {
                continue;
            }
            if !is_line_active(&ml.variant_list, variant_count, selected_variant, &item.alt_variants) {
                continue;
            }
            // processModLine's variant override of pre-modifier parameters (Item.lua:2568-2572).
            if let Some(pos) = ml.line.find("Requires Class") {
                if let Some(rest) = ml.line[pos..].strip_prefix("Requires Class ") {
                    item.class_restriction = Some(rest.to_string());
                }
            }
            if ml.extra.is_some() {
                continue;
            }
            if let Some(list) = &ml.mod_list {
                for pmod in list {
                    let mut m = pmod_to_mod(pmod);
                    set_mod_source(&mut m, mod_source.clone());
                    base_list.push(m);
                }
            }
        }
    }

    // Port of the hardcoded name hack (Item.lua lines 2611-2616). These 4 uniques have a
    // body-armour base with an Energy Shield roll that the upstream data does not want counted. The
    // original zeroes it with a fake `ArmourData` LIST mod: `calcLocal` never removes it, only the
    // armourData-derivation branch (not computed by this crate) reads it, so it survives into the
    // final mod_list. The int requirement is zeroed the same way, directly rather than through a mod.
    if matches!(
        item.name.as_str(),
        "Tabula Rasa, Simple Robe" | "Skin of the Loyal, Simple Robe" | "Skin of the Lords, Simple Robe" | "The Apostate, Cabalist Regalia"
    ) {
        base_list.push(Mod {
            name: pom_engine::sym!("ArmourData"),
            ty: ModType::List,
            value: Value::Map(Arc::new(vec![(pom_engine::sym!("key"), Value::Str(Arc::from("EnergyShield"))), (pom_engine::sym!("value"), Value::Num(0.0))])),
            flags: 0,
            keyword_flags: 0,
            source: None,
            tags: (vec![]).into(),
        });
        item.requirements.int = 0.0;
    }

    // `BuildModList`'s preamble on `baseList` (lines 2618-2626): attribute requirement mods.
    let no_attr_req = calc_local_flag(&mut base_list, "NoAttributeRequirements", 0);
    if no_attr_req {
        item.requirements.str_mod = Some(0.0);
        item.requirements.dex_mod = Some(0.0);
        item.requirements.int_mod = Some(0.0);
    } else {
        let str_base = calc_local_num(&mut base_list, "StrRequirement", ModType::Base, 0);
        let str_inc = calc_local_num(&mut base_list, "StrRequirement", ModType::Inc, 0);
        item.requirements.str_mod = Some(((item.requirements.str_ + str_base) * (1.0 + str_inc / 100.0)).floor());
        let dex_base = calc_local_num(&mut base_list, "DexRequirement", ModType::Base, 0);
        let dex_inc = calc_local_num(&mut base_list, "DexRequirement", ModType::Inc, 0);
        item.requirements.dex_mod = Some(((item.requirements.dex + dex_base) * (1.0 + dex_inc / 100.0)).floor());
        let int_base = calc_local_num(&mut base_list, "IntRequirement", ModType::Base, 0);
        let int_inc = calc_local_num(&mut base_list, "IntRequirement", ModType::Inc, 0);
        item.requirements.int_mod = Some(((item.requirements.int + int_base) * (1.0 + int_inc / 100.0)).floor());
    }

    // Port of the socket-count/no-sockets/abyssal-socket rebuild (Item.lua lines 2639-2686). These
    // mods are removed from `base_list` here (so they don't leak into the final list) AND used to
    // rebuild `item.sockets` itself, which matters for `mod_list` correctness: the per-slot
    // `Multiplier:{Color}SocketIn{Slot}` mods below are generated FROM `item.sockets`, so a
    // "Has no Sockets"/forced-socket-count/abyssal-socket unique needs the rebuilt set, not the
    // sockets parsed from the raw "Sockets:" line (which may not exist at all, e.g. Kaom's Heart's
    // "Has no Sockets" mod on a base with no "Sockets:" line).
    let socket_count = calc_local_num(&mut base_list, "SocketCount", ModType::Base, 0) as i64;
    let abyssal_socket_count = calc_local_num(&mut base_list, "AbyssalSocketCount", ModType::Base, 0) as i64;
    let no_sockets = calc_local_flag(&mut base_list, "NoSockets", 0);
    let socket_always_matches = calc_local_flag(&mut base_list, "SocketAlwaysMatches", 0);
    let socketed_jewel_effect = calc_local_num(&mut base_list, "SocketedJewelEffect", ModType::Inc, 0);
    // `self.abyssalSocketCount`/`self.socketedJewelEffectModifier` (Item.lua:2641-2647, 2691): read by
    // CalcSetup's abyss-jewel merge (parent item socket check + effect scale).
    item.abyssal_socket_count = if no_sockets { 0 } else { abyssal_socket_count };
    item.socketed_jewel_effect_modifier = 1.0 + socketed_jewel_effect / 100.0;
    item.socket_always_matches = socket_always_matches;
    let socket_limit = base.socket_limit.unwrap_or(0);
    let selectable_socket_count = socket_limit.max(item.sockets.len() as i64) - abyssal_socket_count;
    if no_sockets {
        item.sockets.clear();
    } else if socket_count > 0 {
        // Lua iterates i=1..max(socketCount, #sockets): an index beyond socketCount is dropped, an
        // existing socket at i is kept as-is (and updates the rolling `group` tracker), a missing
        // one is created with the default color and whatever `group` the tracker last saw (0 if no
        // existing socket has been seen yet).
        let mut group = 0i64;
        let max_len = socket_count.max(item.sockets.len() as i64);
        let mut new_sockets = Vec::with_capacity(socket_count as usize);
        for i in 1..=max_len {
            if i > socket_count {
                continue;
            }
            if let Some(existing) = item.sockets.get((i - 1) as usize) {
                group = existing.group;
                new_sockets.push(existing.clone());
            } else {
                new_sockets.push(crate::item::Socket { color: item.default_socket_color, group });
            }
        }
        item.sockets = new_sockets;
    } else if abyssal_socket_count > 0 {
        let mut new_sockets = Vec::new();
        let mut group = 0i64;
        for s in item.sockets.iter() {
            if s.color != 'A' {
                if new_sockets.len() as i64 >= selectable_socket_count {
                    break;
                }
                group = s.group;
                new_sockets.push(s.clone());
            }
        }
        for _ in 0..abyssal_socket_count {
            group += 1;
            new_sockets.push(crate::item::Socket { color: 'A', group });
        }
        item.sockets = new_sockets;
    }

    let is_weapon = base.weapon.is_some();
    let is_ring = item.item_type.as_deref() == Some("Ring");
    if is_weapon || is_ring {
        let n = if is_ring { 3 } else { 2 };
        let mut slots = Vec::with_capacity(n);
        for slot_num in 1..=n as i64 {
            slots.push(build_mod_list_for_slot(item, &base, &base_list, Some(slot_num)));
        }
        item.slot_mod_list = Some(slots);
    } else {
        item.mod_list = Some(build_mod_list_for_slot(item, &base, &base_list, None));
    }

    // Port of `if deferJewelRadiusIndexAssignment then self.jewelRadiusIndex = self.jewelData.
    // radiusIndex end` (Item.lua line 1637-1639): runs right after `self:BuildModList()` returns in
    // upstream, i.e. exactly here (jewels are always the single-slot branch above, never
    // weapon/ring-scoped, so `item.jewel_data` is already final by this point).
    if item.defer_jewel_radius_index {
        item.jewel_radius_index = item.jewel_data.radius_index;
    }
}

/// Port of `ItemClass:GetPrimarySlot`.
fn primary_slot(item: &Item, is_weapon: bool) -> String {
    let t = item.item_type.as_deref().unwrap_or("");
    if is_weapon {
        "Weapon 1".to_string()
    } else if t == "Quiver" || t == "Shield" {
        "Weapon 2".to_string()
    } else if t == "Ring" {
        "Ring 1".to_string()
    } else if t == "Flask" || t == "Tincture" {
        "Flask 1".to_string()
    } else if t == "Graft" {
        "Graft 1".to_string()
    } else {
        t.to_string()
    }
}

fn tag_num(tag: &Tag, key: &str) -> Option<i64> {
    tag.get(Sym::new(key)).num().map(|n| n as i64)
}

/// Port of the slot-scoping filter inside the `baseList` copy loop (lines 2231-2237): a mod tagged
/// `SlotNumber`/`InSlot` only survives into a slot whose number it names. `slot_num = None` (the
/// single unscoped "slot" for non-weapon/non-ring items, matching upstream's `BuildModListFor
/// SlotNum(baseList)` call with no second argument, i.e. `slotNum = nil`) never matches any tagged
/// number, exactly like Lua's `tag.num ~= nil`.
fn slot_ok(m: &Mod, slot_num: Option<i64>) -> bool {
    for tag in &m.tags {
        if tag.kind == pom_engine::sym!("SlotNumber") || tag.kind == pom_engine::sym!("InSlot") {
            if let Some(n) = tag_num(tag, "num") {
                if Some(n) != slot_num {
                    return false;
                }
            }
        }
    }
    true
}

fn substitute_tag_strings(tag: &mut Tag, slot_name: &str, hand: &str, other_slot_num: &str) {
    for (_, v) in tag.fields.iter_mut() {
        if let Value::Str(s) = v {
            if s.contains("{SlotName}") || s.contains("{Hand}") || s.contains("{OtherSlotNum}") {
                let replaced = s.replace("{SlotName}", slot_name).replace("{Hand}", hand).replace("{OtherSlotNum}", other_slot_num);
                *v = Value::Str(Arc::from(replaced.as_str()));
            }
        }
    }
}

/// Port of `ItemClass:BuildModListForSlotNum`.
fn build_mod_list_for_slot(item: &mut Item, base: &ItemBase, base_list: &[Mod], slot_num: Option<i64>) -> Vec<Mod> {
    let mut slot_name = primary_slot(item, base.weapon.is_some());
    // Port of `if slotNum ~= 1 then slotName = slotName:gsub("1", tostring(slotNum)) end` (line
    // 2224-2226): for the single-"slot" non-weapon/non-ring case this port models as `slot_num =
    // None`, upstream passes no second argument at all, so `slotNum` is Lua `nil`, `tostring
    // (nil)` is the literal string `"nil"`, and `nil ~= 1` is true -- so e.g. "Flask 1"/"Graft 1"
    // (see `primary_slot`) really does become "Flask nil"/"Graft nil" in the live item, and that
    // literal text ends up in mod names like "Multiplier:QualityOnFlask nil". Faithfully kept
    // rather than "fixed", since the golden data is generated by the real behavior.
    match slot_num {
        Some(1) => {}
        Some(n) => slot_name = slot_name.replace('1', &n.to_string()),
        None => slot_name = slot_name.replace('1', "nil"),
    }
    let hand = if slot_num == Some(2) { "OffHand" } else { "MainHand" };
    let other_slot_num = if slot_num == Some(1) { "2" } else { "1" };

    let mut mods: Vec<Mod> = Vec::new();
    for base_mod in base_list {
        if !slot_ok(base_mod, slot_num) {
            continue;
        }
        let mut m = base_mod.clone();
        for tag in m.tags.iter_mut() {
            substitute_tag_strings(tag, &slot_name, hand, other_slot_num);
        }
        mods.push(m);
    }

    if !item.sockets.is_empty() {
        let mut group_counts: pom_engine::fxhash::HashMap<i64, i64> = pom_engine::fxhash::HashMap::default();
        for s in &item.sockets {
            *group_counts.entry(s.group).or_insert(0) += 1;
            let mult = match s.color {
                'R' => Some("RedSocketIn"),
                'G' => Some("GreenSocketIn"),
                'B' => Some("BlueSocketIn"),
                'W' => Some("WhiteSocketIn"),
                _ => None,
            };
            if let Some(mult) = mult {
                mods.push(new_mod(&format!("Multiplier:{}{}", mult, slot_name), ModType::Base, 1.0, "Item Sockets"));
            }
        }
        let unlinked = group_counts.values().filter(|&&c| c == 1).count() as f64;
        mods.push(new_mod(&format!("Multiplier:UnlinkedSocketIn{}", slot_name), ModType::Base, unlinked, "Unlinked Item Sockets"));
    }

    let crafted_quality = calc_local_num(&mut mods, "Quality", ModType::Base, 0);
    let _ = crafted_quality; // self.craftedQuality bookkeeping: not needed for mod_list output.
    let _corrupt_implicit_count = calc_local_num(&mut mods, "CorruptImplicitCount", ModType::Base, 0);

    if let Some(q) = item.quality {
        mods.push(new_mod(&format!("Multiplier:QualityOn{}", slot_name), ModType::Base, q, "Quality"));
    }

    let quality = item.quality.unwrap_or(0.0);
    if let Some(weapon) = base.weapon.clone() {
        let attack_speed_inc = calc_local_num(&mut mods, "Speed", ModType::Inc, pom_engine::modparser::flags::mod_flag::Attack)
            + (quality / 8.0 * calc_local_num(&mut mods, "AlternateQualityLocalAttackSpeedPer8Quality", ModType::Inc, 0)).floor();
        let attack_rate = round_dec(weapon.get("AttackRateBase").copied().unwrap_or(0.0) * (1.0 + attack_speed_inc / 100.0), 2);
        let range_bonus = calc_local_num(&mut mods, "WeaponRange", ModType::Base, 0)
            + 10.0 * calc_local_num(&mut mods, "WeaponRangeMetre", ModType::Base, 0)
            + (quality / 10.0 * calc_local_num(&mut mods, "AlternateQualityLocalWeaponRangePer10Quality", ModType::Base, 0)).floor();
        let range = weapon.get("Range").copied().unwrap_or(0.0) + range_bonus;
        let local_inc_ele = calc_local_num(&mut mods, "LocalElementalDamage", ModType::Inc, 0);

        let mut wd = serde_json::Map::new();
        wd.insert("type".to_string(), base.base_type.clone().map(J::String).unwrap_or(J::Null));
        if let Some(sub) = base.extra.get("subType") {
            wd.insert("subType".to_string(), sub.to_value());
        }
        wd.insert("name".to_string(), J::String(item.name.clone()));
        wd.insert("AttackSpeedInc".to_string(), jnum(attack_speed_inc));
        wd.insert("AttackRate".to_string(), jnum(attack_rate));
        wd.insert("rangeBonus".to_string(), jnum(range_bonus));
        wd.insert("range".to_string(), jnum(range));

        let mut elemental_dps: Option<f64> = None;
        for dmg_type in DMG_TYPES {
            let mut min = weapon.get(&format!("{}Min", dmg_type)).copied().unwrap_or(0.0) + calc_local_num(&mut mods, &format!("{}Min", dmg_type), ModType::Base, 0);
            let mut max = weapon.get(&format!("{}Max", dmg_type)).copied().unwrap_or(0.0) + calc_local_num(&mut mods, &format!("{}Max", dmg_type), ModType::Base, 0);
            if *dmg_type == "Physical" {
                let phys_inc = calc_local_num(&mut mods, "PhysicalDamage", ModType::Inc, 0);
                let mut quality_scalar = quality;
                if calc_local_num(&mut mods, "AlternateQualityWeapon", ModType::Base, 0) > 0.0 {
                    quality_scalar = 0.0;
                }
                min = round(min * (1.0 + phys_inc / 100.0) * (1.0 + quality_scalar / 100.0));
                max = round(max * (1.0 + phys_inc / 100.0) * (1.0 + quality_scalar / 100.0));
            } else if *dmg_type != "Chaos" {
                let local_inc = calc_local_num(&mut mods, &format!("Local{}Damage", dmg_type), ModType::Inc, 0) + local_inc_ele;
                min = round(min * (1.0 + local_inc / 100.0));
                max = round(max * (1.0 + local_inc / 100.0));
            }
            if min > 0.0 && max > 0.0 {
                wd.insert(format!("{}Min", dmg_type), jnum(min));
                wd.insert(format!("{}Max", dmg_type), jnum(max));
                let dps = (min + max) / 2.0 * attack_rate;
                wd.insert(format!("{}DPS", dmg_type), jnum(dps));
                if *dmg_type != "Physical" && *dmg_type != "Chaos" {
                    elemental_dps = Some(elemental_dps.unwrap_or(0.0) + dps);
                }
            }
        }
        if let Some(e) = elemental_dps {
            wd.insert("ElementalDPS".to_string(), jnum(e));
        }
        let crit_chance = round_dec(
            (weapon.get("CritChanceBase").copied().unwrap_or(0.0) + calc_local_num(&mut mods, "CritChance", ModType::Base, 0))
                * (1.0
                    + (calc_local_num(&mut mods, "CritChance", ModType::Inc, 0)
                        + (quality / 4.0 * calc_local_num(&mut mods, "AlternateQualityLocalCritChancePer4Quality", ModType::Inc, 0)).floor())
                        / 100.0),
            2,
        );
        wd.insert("CritChance".to_string(), jnum(crit_chance));
        apply_data_overrides(&mods, "WeaponData", &mut wd);
        inject_accuracy_leech_condition_tags(&mut mods, slot_num);
        // Item.lua reads `weaponData[dmgType.."DPS"]` for this sum AFTER the WeaponData LIST
        // override loop above has run, not from a value cached earlier -- so a "no Physical
        // Damage"-style override (which deletes `PhysicalDPS` from the map, see
        // `apply_data_overrides`'s doc) must actually drop out of this total, not just out of the
        // displayed field. Read back from `wd` rather than a value cached before the override.
        let total_dps: f64 = DMG_TYPES.iter().map(|t| wd.get(&format!("{}DPS", t)).and_then(|v| v.as_f64()).unwrap_or(0.0)).sum();
        wd.insert("TotalDPS".to_string(), jnum(total_dps));
        item.weapon_data.get_or_insert_with(Vec::new).push(J::Object(wd));
    } else if let Some(armour) = base.armour.clone() {
        let armour_base_min = armour.get("ArmourBaseMin").copied().unwrap_or(0.0);
        let armour_base = calc_local_num(&mut mods, "Armour", ModType::Base, 0) + armour_base_min;
        let armour_variance = armour.get("ArmourBaseMax").copied().unwrap_or(0.0) - armour_base_min;
        let armour_evasion_base = calc_local_num(&mut mods, "ArmourAndEvasion", ModType::Base, 0);
        let evasion_base_min = armour.get("EvasionBaseMin").copied().unwrap_or(0.0);
        let evasion_base = calc_local_num(&mut mods, "Evasion", ModType::Base, 0) + evasion_base_min;
        let evasion_variance = armour.get("EvasionBaseMax").copied().unwrap_or(0.0) - evasion_base_min;
        let evasion_energy_shield_base = calc_local_num(&mut mods, "EvasionAndEnergyShield", ModType::Base, 0);
        let energy_shield_base_min = armour.get("EnergyShieldBaseMin").copied().unwrap_or(0.0);
        let energy_shield_base = calc_local_num(&mut mods, "EnergyShield", ModType::Base, 0) + energy_shield_base_min;
        let energy_shield_variance = armour.get("EnergyShieldBaseMax").copied().unwrap_or(0.0) - energy_shield_base_min;
        let armour_energy_shield_base = calc_local_num(&mut mods, "ArmourAndEnergyShield", ModType::Base, 0);
        let ward_base_min = armour.get("WardBaseMin").copied().unwrap_or(0.0);
        let ward_base = calc_local_num(&mut mods, "Ward", ModType::Base, 0) + ward_base_min;
        let ward_variance = armour.get("WardBaseMax").copied().unwrap_or(0.0) - ward_base_min;
        let armour_inc = calc_local_num(&mut mods, "Armour", ModType::Inc, 0);
        let armour_evasion_inc = calc_local_num(&mut mods, "ArmourAndEvasion", ModType::Inc, 0);
        let evasion_inc = calc_local_num(&mut mods, "Evasion", ModType::Inc, 0);
        let evasion_energy_shield_inc = calc_local_num(&mut mods, "EvasionAndEnergyShield", ModType::Inc, 0);
        let energy_shield_inc = calc_local_num(&mut mods, "EnergyShield", ModType::Inc, 0);
        let ward_inc = calc_local_num(&mut mods, "Ward", ModType::Inc, 0);
        let armour_energy_shield_inc = calc_local_num(&mut mods, "ArmourAndEnergyShield", ModType::Inc, 0);
        let defences_inc = calc_local_num(&mut mods, "Defences", ModType::Inc, 0);
        let mut quality_scalar = quality;
        if calc_local_num(&mut mods, "AlternateQualityArmour", ModType::Base, 0) > 0.0 {
            quality_scalar = 0.0;
        }
        // Percentile back-calculation (Item.lua lines 2368-2382): if `armour_data_seed` (parsed off
        // the item's own real "Armour:"/etc. line, or an explicit "XBasePercentile:" line) tells us
        // the real rolled value, invert this stat's own final formula (using ONLY this stat's own
        // base term, matching upstream -- cross-type base contributions like `armourEvasionBase`
        // are NOT subtracted here even though the final formula below adds them back in, which is
        // upstream's own behavior, not a bug to fix) to recover the percentile. Otherwise it's
        // unknown and defaults to 1 (max roll) below, same as an ordinary item copy with no rolled
        // value in its raw text at all.
        let seed = &item.armour_data_seed;
        let armour_pct_seeded = back_calc_percentile(seed, "Armour", "ArmourBasePercentile", armour_base, armour_variance, 1.0 + (armour_inc + armour_evasion_inc + armour_energy_shield_inc + defences_inc) / 100.0, 1.0 + quality_scalar / 100.0);
        let evasion_pct_seeded = back_calc_percentile(seed, "Evasion", "EvasionBasePercentile", evasion_base, evasion_variance, 1.0 + (evasion_inc + armour_evasion_inc + evasion_energy_shield_inc + defences_inc) / 100.0, 1.0 + quality_scalar / 100.0);
        let energy_shield_pct_seeded = back_calc_percentile(
            seed,
            "EnergyShield",
            "EnergyShieldBasePercentile",
            energy_shield_base,
            energy_shield_variance,
            1.0 + (energy_shield_inc + armour_energy_shield_inc + evasion_energy_shield_inc + defences_inc) / 100.0,
            1.0 + quality_scalar / 100.0,
        );
        let ward_pct_seeded = back_calc_percentile(seed, "Ward", "WardBasePercentile", ward_base, ward_variance, 1.0 + (ward_inc + defences_inc) / 100.0, 1.0 + quality_scalar / 100.0);

        let armour_pct = armour_pct_seeded.unwrap_or(1.0);
        let ad_armour_base = round(armour_base_min + armour_variance * armour_pct);
        let ad_armour =
            round((armour_base + armour_evasion_base + armour_energy_shield_base + armour_variance * armour_pct) * (1.0 + (armour_inc + armour_evasion_inc + armour_energy_shield_inc + defences_inc) / 100.0) * (1.0 + quality_scalar / 100.0));
        let evasion_pct = evasion_pct_seeded.unwrap_or(1.0);
        let ad_evasion_base = round(evasion_base_min + evasion_variance * evasion_pct);
        let ad_evasion =
            round((evasion_base + armour_evasion_base + evasion_energy_shield_base + evasion_variance * evasion_pct) * (1.0 + (evasion_inc + armour_evasion_inc + evasion_energy_shield_inc + defences_inc) / 100.0) * (1.0 + quality_scalar / 100.0));
        let energy_shield_pct = energy_shield_pct_seeded.unwrap_or(1.0);
        let ad_energy_shield_base = round(energy_shield_base_min + energy_shield_variance * energy_shield_pct);
        let ad_energy_shield = round(
            (energy_shield_base + evasion_energy_shield_base + armour_energy_shield_base + energy_shield_variance * energy_shield_pct)
                * (1.0 + (energy_shield_inc + armour_energy_shield_inc + evasion_energy_shield_inc + defences_inc) / 100.0)
                * (1.0 + quality_scalar / 100.0),
        );
        let ward_pct = ward_pct_seeded.unwrap_or(1.0);
        let ad_ward_base = round(ward_base_min + ward_variance * ward_pct);
        let ad_ward = round((ward_base + ward_variance * ward_pct) * (1.0 + (ward_inc + defences_inc) / 100.0) * (1.0 + quality_scalar / 100.0));

        let mut ad = serde_json::Map::new();
        ad.insert("ArmourBase".to_string(), jnum(ad_armour_base));
        ad.insert("Armour".to_string(), jnum(ad_armour));
        ad.insert("EvasionBase".to_string(), jnum(ad_evasion_base));
        ad.insert("Evasion".to_string(), jnum(ad_evasion));
        ad.insert("EnergyShieldBase".to_string(), jnum(ad_energy_shield_base));
        ad.insert("EnergyShield".to_string(), jnum(ad_energy_shield));
        ad.insert("WardBase".to_string(), jnum(ad_ward_base));
        ad.insert("Ward".to_string(), jnum(ad_ward));
        if let Some(p) = armour_pct_seeded.or(if ad_armour > 0.0 { Some(1.0) } else { None }) {
            ad.insert("ArmourBasePercentile".to_string(), jnum(p));
        }
        if let Some(p) = evasion_pct_seeded.or(if ad_evasion > 0.0 { Some(1.0) } else { None }) {
            ad.insert("EvasionBasePercentile".to_string(), jnum(p));
        }
        if let Some(p) = energy_shield_pct_seeded.or(if ad_energy_shield > 0.0 { Some(1.0) } else { None }) {
            ad.insert("EnergyShieldBasePercentile".to_string(), jnum(p));
        }
        if let Some(p) = ward_pct_seeded.or(if ad_ward > 0.0 { Some(1.0) } else { None }) {
            ad.insert("WardBasePercentile".to_string(), jnum(p));
        }
        if let Some(block_base) = armour.get("BlockChance").copied() {
            let block_chance = ((block_base + calc_local_num(&mut mods, "BlockChance", ModType::Base, 0)) * (1.0 + calc_local_num(&mut mods, "BlockChance", ModType::Inc, 0) / 100.0)).floor();
            ad.insert("BlockChance".to_string(), jnum(block_chance));
        }
        if let Some(penalty) = armour.get("MovementPenalty").copied() {
            mods.push(Mod {
                name: pom_engine::sym!("MovementSpeed"),
                ty: ModType::Inc,
                value: Value::Num(-penalty),
                flags: 0,
                keyword_flags: 0,
                source: Some(mod_source_for(item)),
                tags: (vec![Tag {
                    kind: pom_engine::sym!("Condition"),
                    fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from("IgnoreMovementPenalties"))), (pom_engine::sym!("neg"), Value::Bool(true))],
                }]).into(),
            });
        }
        apply_data_overrides(&mods, "ArmourData", &mut ad);
        item.armour_data = Some(J::Object(ad));
    } else if let Some(flask) = base.extra.get("flask").map(|j| j.to_value()) {
        let duration_inc = calc_local_num(&mut mods, "Duration", ModType::Inc, 0);
        let duration_more = calc_local_num(&mut mods, "Duration", ModType::More, 0);
        let has_life = flask.get("life").is_some();
        let has_mana = flask.get("mana").is_some();
        let mut fd = serde_json::Map::new();
        if has_life || has_mana {
            let instant_perc = calc_local_num(&mut mods, "FlaskInstantRecovery", ModType::Base, 0);
            let instant_low_life_perc = calc_local_num(&mut mods, "FlaskLowLifeInstantRecovery", ModType::Base, 0);
            let recovery_mod = 1.0 + calc_local_num(&mut mods, "FlaskRecovery", ModType::Inc, 0) / 100.0;
            let rate_mod = 1.0 + calc_local_num(&mut mods, "FlaskRecoveryRate", ModType::Inc, 0) / 100.0;
            let duration = round_dec(flask_num(&flask, "duration") * (1.0 + duration_inc / 100.0) / rate_mod * duration_more, 1);
            fd.insert("instantPerc".to_string(), jnum(instant_perc));
            fd.insert("instantLowLifePerc".to_string(), jnum(instant_low_life_perc));
            fd.insert("duration".to_string(), jnum(duration));
            if has_life {
                let life_base = flask_num(&flask, "life") * (1.0 + quality / 100.0) * recovery_mod;
                let life_instant = life_base * instant_perc / 100.0;
                let life_gradual = life_base * (1.0 - instant_perc / 100.0);
                fd.insert("lifeBase".to_string(), jnum(life_base));
                fd.insert("lifeInstant".to_string(), jnum(life_instant));
                fd.insert("lifeGradual".to_string(), jnum(life_gradual));
                fd.insert("lifeTotal".to_string(), jnum(life_instant + life_gradual));
                fd.insert("lifeAdditional".to_string(), jnum(calc_local_num(&mut mods, "FlaskAdditionalLifeRecovery", ModType::Base, 0)));
                fd.insert("lifeEffectNotRemoved".to_string(), J::Bool(peek_local_flag(base_list, "LifeFlaskEffectNotRemoved", 0)));
            }
            if has_mana {
                let mana_base = flask_num(&flask, "mana") * (1.0 + quality / 100.0) * recovery_mod;
                let mana_instant = mana_base * instant_perc / 100.0;
                let mana_gradual = mana_base * (1.0 - instant_perc / 100.0);
                fd.insert("manaBase".to_string(), jnum(mana_base));
                fd.insert("manaInstant".to_string(), jnum(mana_instant));
                fd.insert("manaGradual".to_string(), jnum(mana_gradual));
                fd.insert("manaTotal".to_string(), jnum(mana_instant + mana_gradual));
                fd.insert("manaEffectNotRemoved".to_string(), J::Bool(peek_local_flag(base_list, "ManaFlaskEffectNotRemoved", 0)));
            }
        } else {
            let duration = round_dec(flask_num(&flask, "duration") * (1.0 + duration_inc / 100.0) * (1.0 + quality / 100.0) * duration_more, 1);
            fd.insert("duration".to_string(), jnum(duration));
        }
        fd.insert("chargesMax".to_string(), jnum(flask_num(&flask, "chargesMax") + calc_local_num(&mut mods, "FlaskCharges", ModType::Base, 0)));
        fd.insert("chargesUsed".to_string(), jnum((flask_num(&flask, "chargesUsed") * (1.0 + calc_local_num(&mut mods, "FlaskChargesUsed", ModType::Inc, 0) / 100.0)).floor()));
        fd.insert("gainMod".to_string(), jnum(1.0 + calc_local_num(&mut mods, "FlaskChargeRecovery", ModType::Inc, 0) / 100.0));
        fd.insert("effectInc".to_string(), jnum(calc_local_num(&mut mods, "FlaskEffect", ModType::Inc, 0) + calc_local_num(&mut mods, "LocalEffect", ModType::Inc, 0)));
        apply_data_overrides(&mods, "FlaskData", &mut fd);
        item.flask_data = Some(J::Object(fd));
    } else if let Some(tincture) = base.extra.get("tincture").map(|j| j.to_value()) {
        let mana_burn_rate_inc = calc_local_num(&mut mods, "TinctureManaBurnRate", ModType::Inc, 0);
        let mana_burn_rate_more = calc_local_num(&mut mods, "TinctureManaBurnRate", ModType::More, 0);
        let mana_burn = (flask_num(&tincture, "manaBurn") + 0.01) / (1.0 + mana_burn_rate_inc / 100.0) / (1.0 + mana_burn_rate_more / 100.0);
        let cooldown_inc = calc_local_num(&mut mods, "TinctureCooldownRecovery", ModType::Inc, 0) + calc_local_num(&mut mods, "CooldownRecovery", ModType::Inc, 0);
        let cooldown = flask_num(&tincture, "cooldown") / (1.0 + cooldown_inc / 100.0);
        let effect_inc = calc_local_num(&mut mods, "TinctureEffect", ModType::Inc, 0) + calc_local_num(&mut mods, "LocalEffect", ModType::Inc, 0);
        let mut td = serde_json::Map::new();
        td.insert("manaBurn".to_string(), jnum(mana_burn));
        td.insert("cooldownInc".to_string(), jnum(cooldown_inc));
        td.insert("cooldown".to_string(), jnum(cooldown));
        td.insert("effectInc".to_string(), jnum(effect_inc));
        apply_data_overrides(&mods, "TinctureData", &mut td);
        item.tincture_data = Some(J::Object(td));
    }
    // Jewel branch (lines 2465-2517): the "Grand Spectrum" special case (lines 2466-2469) actually
    // adds two mods to `mod_list`; the rest (lines 2471-2517) is `modList:List(...)` reads, which
    // never remove a mod, so they don't affect `mod_list`/`slot_mod_list` -- but DO produce
    // `item.jewel_data`, a real output `pom-passives`' cluster/timeless-jewel resolution needs (see
    // `crate::item::JewelData`'s doc comment). Computed here, not as a separate pass over the
    // already-returned `mods`, to match upstream's exact read point (right after Grand
    // Spectrum, before this function returns) in case a future mod ever makes that ordering matter.
    if item.item_type.as_deref() == Some("Jewel") {
        if item.name.contains("Grand Spectrum") {
            let spectrum_mod = new_mod("Multiplier:GrandSpectrum", ModType::Base, 1.0, &item.name);
            let spectrum_value = mod_as_value(&spectrum_mod);
            mods.push(spectrum_mod);
            mods.push(Mod {
                name: pom_engine::sym!("MinionModifier"),
                ty: ModType::List,
                value: Value::Map(Arc::new(vec![(pom_engine::sym!("mod"), spectrum_value)])),
                flags: 0,
                keyword_flags: 0,
                source: Some(Arc::from(item.name.as_str())),
                tags: (vec![]).into(),
            });
        }
        item.jewel_data = build_jewel_data(item.cluster_jewel.as_ref(), &mods);
    }

    mods
}

fn value_num_i64(v: &Value) -> Option<i64> {
    v.num().map(|n| n as i64)
}
fn value_str(v: &Value) -> Option<String> {
    if let Value::Str(s) = v {
        Some(s.to_string())
    } else {
        None
    }
}

/// Port of the timeless-jewel conqueror seed (`bathed in the blood of...`-style flavour lines,
/// `ModParser.lua` lines 5829-5854): `num` is a plain Lua number in upstream, but a legacy
/// (`"1_v2"`/`"2_v2"`/`"3_v2"`) conqueror id round-trips through this same `conqueror.id` field as
/// a STRING -- `crate::item::ConqueredBy::conqueror_id` normalizes both to a string (matching how
/// `crates/passives`' own `ClusterJewelInput::ConqueredBy` already expects it, see that crate's
/// `jewel_inputs_from_golden`), while `id` (the jewel's own numeric seed) stays an integer.
fn conqueror_id_string(v: &Value) -> Option<String> {
    match v {
        Value::Str(s) => Some(s.to_string()),
        Value::Num(n) => {
            if n.fract() == 0.0 {
                Some(format!("{}", *n as i64))
            } else {
                Some(format!("{n}"))
            }
        }
        _ => None,
    }
}

/// Port of `self.jewelData` (Item.lua lines 2472-2517, see `crate::item::JewelData`'s doc comment).
/// `mods` is the per-slot `modList` at the point upstream reads it (jewels are always a single
/// unscoped "slot", so this is simply the final `mod_list`). Every read here is a `modList:List(nil,
/// name)` port: only a LIST-type mod with `flags == 0`/`keyword_flags == 0` matches (`ModStoreClass
/// :List`'s `cfg = nil` default), and iteration order is `mods`' own order, matching Lua's `ipairs`
/// (relevant for the `jewelData[value.key] = value.value` "last one wins" sink below).
fn build_jewel_data(cluster_jewel: Option<&crate::item::ClusterJewelBaseInfo>, mods: &[Mod]) -> crate::item::JewelData {
    use crate::item::{ConqueredBy, JewelData};

    let mut jd = JewelData::default();
    let list_mod = |m: &Mod, name: &str| m.name == Sym::new(name) && matches!(m.ty, ModType::List) && m.flags == 0 && m.keyword_flags == 0;

    // `if modList:List(nil, "ImpossibleEscapeKeystones") then jewelData.impossibleEscapeKeystones =
    //  {}; for _, value in ipairs(...) do jewelData.impossibleEscapeKeystones[value.key] =
    //  value.value end end` -- the outer `if` only gates the `= {}` initialization (an empty
    // Vec here either way, so nothing to special-case) before the loop that would be a no-op on an
    // empty list regardless.
    for m in mods.iter().filter(|m| list_mod(m, "ImpossibleEscapeKeystones")) {
        if let Value::Str(key) = m.value.get(pom_engine::sym!("key")) {
            if m.value.get(pom_engine::sym!("value")).truthy() {
                jd.impossible_escape_keystones.push(key.to_string());
            }
        }
    }

    // `for _, value in ipairs(modList:List(nil, "JewelData")) do jewelData[value.key] =
    //  value.value end` -- a generic key/value sink; only the keys this crate's consumers actually
    // need are dispatched below (`impossibleEscapeKeystone` singular and the per-corrupted-rarity
    // `corrupted<Rarity>JewelIncEffect`/`jewelIncEffectFromClassStart` keys are real Lua fields but
    // have no reader anywhere in `PassiveSpec.lua`/`pom_passives`, so they're intentionally dropped
    // here rather than carried as dead struct fields).
    for m in mods.iter().filter(|m| list_mod(m, "JewelData")) {
        let Value::Str(key) = m.value.get(pom_engine::sym!("key")) else { continue };
        let val = m.value.get(pom_engine::sym!("value"));
        match key.as_ref() {
            "intuitiveLeapLike" => jd.intuitive_leap_like = val.truthy(),
            "intuitiveLeapKeystoneOnly" => jd.intuitive_leap_keystone_only = val.truthy(),
            "radiusIndex" => jd.radius_index = value_num_i64(val),
            "clusterJewelNodeCount" => jd.cluster_jewel_node_count = value_num_i64(val),
            "clusterJewelSocketCount" => jd.cluster_jewel_socket_count = value_num_i64(val),
            "clusterJewelSocketCountOverride" => jd.cluster_jewel_socket_count_override = value_num_i64(val),
            "clusterJewelNothingnessCount" => jd.cluster_jewel_nothingness_count = value_num_i64(val),
            "clusterJewelSmallsAreNothingness" => jd.cluster_jewel_smalls_are_nothingness = val.truthy(),
            "clusterJewelIncEffect" => jd.cluster_jewel_inc_effect = val.num(),
            "corruptedMagicJewelIncEffect" => jd.corrupted_magic_jewel_inc_effect = val.num(),
            "corruptedRareJewelIncEffect" => jd.corrupted_rare_jewel_inc_effect = val.num(),
            "jewelIncEffectFromClassStart" => jd.jewel_inc_effect_from_class_start = val.num(),
            "clusterJewelSkill" => jd.cluster_jewel_skill = value_str(val),
            "clusterJewelKeystone" => jd.cluster_jewel_keystone = value_str(val),
            "conqueredBy" => {
                if let Value::Map(_) = val {
                    let id = value_num_i64(val.get(pom_engine::sym!("id"))).unwrap_or(0);
                    let conqueror = val.get(pom_engine::sym!("conqueror"));
                    let conqueror_type = value_str(conqueror.get(pom_engine::sym!("type"))).unwrap_or_default();
                    let conqueror_id = conqueror_id_string(conqueror.get(pom_engine::sym!("id")));
                    jd.conquered_by = Some(ConqueredBy { id, conqueror_type, conqueror_id });
                }
            }
            _ => {}
        }
    }

    // `if self.clusterJewel then ... end` (lines 2486-2516).
    if let Some(cj) = cluster_jewel {
        for m in mods.iter().filter(|m| m.name == pom_engine::sym!("ClusterJewelNotable") && matches!(m.ty, ModType::List) && m.flags == 0 && m.keyword_flags == 0) {
            if let Some(s) = value_str(&m.value) {
                jd.cluster_jewel_notables.push(s);
            }
        }
        for m in mods.iter().filter(|m| m.name == pom_engine::sym!("AddToClusterJewelNode") && matches!(m.ty, ModType::List) && m.flags == 0 && m.keyword_flags == 0) {
            if let Some(s) = value_str(&m.value) {
                jd.cluster_jewel_added_mods.push(s);
            }
        }

        // Curse cluster relabeling quirk (lines 2497-2501): a genuine original quirk (small/medium
        // curse clusters share one parsed skill tag; this retargets small -> its own tag so
        // validation below and `pom_passives::clusterjewel`'s skill lookup both see the right one).
        if cj.size == "Small" && jd.cluster_jewel_skill.as_deref() == Some("affliction_curse_effect") {
            jd.cluster_jewel_skill = Some("affliction_curse_effect_small".to_string());
        } else if cj.size == "Medium" && jd.cluster_jewel_skill.as_deref() == Some("affliction_curse_effect_small") {
            jd.cluster_jewel_skill = Some("affliction_curse_effect".to_string());
        }

        // Validation (lines 2504-2510).
        if let Some(nc) = jd.cluster_jewel_node_count {
            jd.cluster_jewel_node_count = Some(nc.max(cj.min_nodes).min(cj.max_nodes));
        }
        if let Some(skill) = jd.cluster_jewel_skill.as_deref() {
            if !cj.skills.contains(skill) {
                jd.cluster_jewel_skill = None;
            }
        }

        // `jewelData.clusterJewelValid = jewelData.clusterJewelKeystone or ((jewelData.
        // clusterJewelSkill or jewelData.clusterJewelSmallsAreNothingness) and jewelData.
        // clusterJewelNodeCount) or (jewelData.clusterJewelSocketCountOverride and jewelData.
        // clusterJewelNothingnessCount)` (lines 2514-2516): this struct is typed, so the boolean
        // TRUTH of that OR/AND chain is all that's kept (see `JewelData::cluster_jewel_valid`'s doc
        // comment for why there's no separate "truthy but not literally `true`" shape to preserve).
        jd.cluster_jewel_valid = jd.cluster_jewel_keystone.is_some()
            || ((jd.cluster_jewel_skill.is_some() || jd.cluster_jewel_smalls_are_nothingness) && jd.cluster_jewel_node_count.is_some())
            || (jd.cluster_jewel_socket_count_override.is_some() && jd.cluster_jewel_nothingness_count.is_some());
    }

    jd
}

/// Encodes a `Mod` as the `Value` shape a LIST mod's nested `{mod = ...}` field needs (mirrors how
/// upstream just stores the mod table itself, since Lua has no type distinction there).
fn mod_as_value(m: &Mod) -> Value {
    let mut fields = vec![
        (pom_engine::sym!("name"), Value::Str(Arc::from(m.name.as_str()))),
        (pom_engine::sym!("type"), Value::Str(Arc::from(m.ty.as_str()))),
        (pom_engine::sym!("value"), m.value.clone()),
        (pom_engine::sym!("flags"), Value::Num(m.flags as f64)),
        (pom_engine::sym!("keywordFlags"), Value::Num(m.keyword_flags as f64)),
    ];
    if let Some(s) = &m.source {
        fields.push((pom_engine::sym!("source"), Value::Str(s.clone())));
    }
    Value::Map(Arc::new(fields))
}


/// `jewelData.funcList` (Item.lua:2472-2475): every `JewelFunc` LIST mod of the item's active mod
/// lines, as (kind, callable). Read straight off each line's `PMod`s because `Mod.value` can't
/// carry the callable (see `pom_engine::modparser::types::pval_to_value`).
pub fn jewel_funcs(item: &Item) -> Vec<pom_engine::modparser::jewelfunc::JewelFuncVal> {
    use pom_engine::modparser::jewelfunc::{JewelFuncVal, JewelKind};
    use pom_engine::modparser::types::PVal;
    let mut out = Vec::new();
    for bucket in [&item.enchant_mod_lines, &item.scourge_mod_lines, &item.class_requirement_mod_lines, &item.implicit_mod_lines, &item.explicit_mod_lines, &item.crucible_mod_lines] {
        for ml in bucket.iter() {
            if ml.disabled || ml.extra.is_some() || !is_line_active(&ml.variant_list, item.variant_count, item.selected_variant, &item.alt_variants) {
                continue;
            }
            let Some(list) = &ml.mod_list else { continue };
            for pm in list.iter().filter(|m| m.name == "JewelFunc" && m.ty == "LIST") {
                let PVal::Map(fields) = &pm.value else { continue };
                let mut func = None;
                let mut kind = None;
                for (k, v) in fields {
                    match (k.as_str(), v) {
                        ("func", PVal::JewelFunc(h)) => func = Some(h.0.clone()),
                        ("type", PVal::Str(t)) => {
                            kind = match t.as_str() {
                                "Other" => Some(JewelKind::Other),
                                "Self" => Some(JewelKind::SelfAlloc),
                                "SelfUnalloc" => Some(JewelKind::SelfUnalloc),
                                "Threshold" => Some(JewelKind::Threshold),
                                _ => None,
                            }
                        }
                        _ => {}
                    }
                }
                if let (Some(func), Some(kind)) = (func, kind) {
                    out.push(JewelFuncVal { kind, func });
                }
            }
        }
    }
    out
}
