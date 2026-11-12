//! `calculateOmniscience` (Modules/CalcPerform.lua:440-502), the Omniscience-keystone path taken
//! instead of `calculateAttributes` (`perform::compute_attributes`) whenever `modDB:Flag(nil,
//! "Omniscience")` is set (CalcPerform.lua:504-508). Mutates `modDB` by adding a set of "Omni"
//! BASE/INC/MORE mods (from summed per-stat attribute mods and a double/triple-dip reduction),
//! then leaves `output.Str`/`.Dex`/`.Int` at the class's flat base values (`classStats.base_str`
//! etc, not the computed attribute value - see the module doc's walk-through below) and
//! `output.Omni` at the final summed value, `output.LowestAttribute`, and the dozen
//! `Str`/`Dex`/`Int`-comparison `modDB.conditions` (lines 471-495; since `output.Str/.Dex/.Int`
//! are always the class's flat base here, these never vary build-to-build for a given class -
//! only which class). Ported verbatim, including the apparent quirk that
//! `output.Str`/`.Dex`/`.Int`'s per-pass computation (line 447) is immediately discarded by the
//! unconditional reset three lines later (474-477): every reader of `output.Str` after this
//! function runs sees the class base, never a mod-adjusted value, for an Omniscience build.
//!
//! Two-pass structure (`for pass = 1, 2`), pass numbers exactly as in the Lua:
//! - pass 1: skips the per-stat Omni-conversion block (`if pass ~= 1`), runs the double/triple-dip
//!   reduction block (`if pass ~= 2`) once, using whatever "StrDex"/"StrInt"/"DexInt"/"All"
//!   conversion mods already exist (none of the Omni mods have been added yet at this point).
//! - pass 2: runs the per-stat Omni-conversion block (adding 9 mods: BASE/INC/MORE for each of
//!   Str/Dex/Int), skips the reduction block (already ran in pass 1).
//! - both passes: reset `output.Str/Dex/Int` to the class base and recompute `output.Omni` from
//!   whatever Omni mods exist in `modDB` so far (so pass 1's `output.Omni` reflects only the
//!   reduction mods; pass 2's reflects reduction + conversion together).
use crate::data::ClassBaseStats;
use crate::perform::round;
use crate::tools;
use pom_engine::modifier::{Mod, ModType};
use pom_engine::modstore::ModStore;
use pom_engine::sym::Sym;

fn sym(s: &str) -> Sym {
    Sym::new(s)
}

pub struct OmniResult {
    pub str_: f64,
    pub dex: f64,
    pub int_: f64,
    pub omni: f64,
    pub lowest_attribute: f64,
    /// The "Omni" mods added to `modDB` by this function, in the order upstream adds them -
    /// for grading against golden's recorded post-Perform mod list (name "Omni", various sources).
    pub added_mods: Vec<Mod>,
}

/// `store` must already have this build's non-Omniscience mods merged in (item/tree/config/base);
/// this function both reads and adds to it, matching upstream's `modDB:NewMod` calls.
pub fn calculate_omniscience(store: &mut ModStore, class_stats: &ClassBaseStats) -> OmniResult {
    calculate_omniscience_with(store, class_stats, &mut |_, _, _| {})
}

/// `calculate_omniscience` that also tells `on_total(store, stat, total)` every `output[stat]` (pass 2: `min(round(calcLib.val(modDB, stat)), base)`,
/// read before that stat's Omni mods are added) and `output.Omni` (each pass, stat "Omni") with the store as it is at that line: what
/// `breakdown.simple(nil, nil, output[stat], stat)` reads (CalcPerform.lua:448-450, 480-482).
pub fn calculate_omniscience_with(store: &mut ModStore, class_stats: &ClassBaseStats, on_total: &mut dyn FnMut(&ModStore, &str, f64)) -> OmniResult {
    let mut added_mods = Vec::new();
    let mut new_mod = |store: &mut ModStore, name: &str, ty: ModType, value: f64, source: &str| {
        let m = Mod { name: sym(name), ty, value: pom_engine::value::Value::Num(value), flags: 0, keyword_flags: 0, source: Some(source.into()), tags: (vec![]).into() };
        store.add_mod(m.clone());
        added_mods.push(m);
    };

    let mut omni = 0.0;
    for pass in 1..=2 {
        if pass != 1 {
            for (stat, base) in [("Str", class_stats.str_), ("Dex", class_stats.dex), ("Int", class_stats.int_)] {
                // `output[stat] = min(round(calcLib.val(modDB, stat)), base)` (line 447) is
                // computed here in upstream but unconditionally overwritten by the reset
                // below before anything reads it - no observable effect, so not computed here.
                on_total(store, stat, round(tools::val(store, sym(stat), None)).min(base));
                let base_val = store.sum(ModType::Base, None, &[sym(stat)]) - base;
                let inc_val = store.sum(ModType::Inc, None, &[sym(stat)]);
                let more_val = store.sum(ModType::More, None, &[sym(stat)]);
                new_mod(store, "Omni", ModType::Base, base_val, &format!("{stat} conversion Omniscience"));
                new_mod(store, "Omni", ModType::Inc, inc_val, "Omniscience");
                new_mod(store, "Omni", ModType::More, more_val, "Omniscience");
            }
        }

        if pass != 2 {
            for ty in [ModType::Base, ModType::Inc, ModType::More] {
                let reduction = store.sum(ty, None, &[sym("StrDex")]) + store.sum(ty, None, &[sym("StrInt")]) + store.sum(ty, None, &[sym("DexInt")]) + 2.0 * store.sum(ty, None, &[sym("All")]);
                new_mod(store, "Omni", ty, -reduction, "Reduction from Double/Triple Dipped attributes to Omniscience");
            }
        }

        omni = round(tools::val(store, sym("Omni"), None)).max(0.0);
        on_total(store, "Omni", omni);
    }

    // `output.Str/.Dex/.Int` are reset to the class's flat base every pass (see the module doc),
    // so these derived conditions (CalcPerform.lua:471-495) are the same both passes and depend
    // only on the class's base stats, never on any mod: set once, after the loop, from the same
    // three values `OmniResult` already returns.
    let (str_, dex, int_) = (class_stats.str_, class_stats.dex, class_stats.int_);
    let mut stats = [str_, dex, int_];
    stats.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let set = |store: &mut ModStore, name: &str, v: bool| {
        store.conditions.insert(sym(name), v);
    };
    set(store, "TwoHighestAttributesEqual", stats[1] == stats[2]);
    set(store, "DexHigherThanInt", dex > int_);
    set(store, "StrHigherThanInt", str_ > int_);
    set(store, "IntHigherThanDex", int_ > dex);
    set(store, "StrHigherThanDex", str_ > dex);
    set(store, "IntHigherThanStr", int_ > str_);
    set(store, "DexHigherThanStr", dex > str_);
    set(store, "StrHighestAttribute", str_ >= dex && str_ >= int_);
    set(store, "IntHighestAttribute", int_ >= str_ && int_ >= dex);
    set(store, "DexHighestAttribute", dex >= str_ && dex >= int_);
    set(store, "IntSingleHighestAttribute", int_ > str_ && int_ > dex);
    set(store, "DexSingleHighestAttribute", dex > str_ && dex > int_);

    OmniResult { str_, dex, int_, omni, lowest_attribute: stats[0], added_mods }
}
