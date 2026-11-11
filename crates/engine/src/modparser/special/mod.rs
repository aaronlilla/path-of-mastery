// specialModList (ModParser.lua lines 2130-5955), split across two files by original line range
// to parallelize porting: special_a.rs covers 2130-4040, special_b.rs covers 4041-5955. Order is
// preserved end-to-end (special_a entries then special_b entries) since scan()'s tie-break can,
// on an exact tie, depend on which entry came first.
pub mod helpers;
pub mod special_a;
pub mod special_b;
pub mod support;

pub use support::SpecialVal;

/// Builds the full runtime specialModList: `special_a`'s literal entries, then `special_b`'s
/// literal entries, then `special_b`'s game-data-driven keystone entries (Lua lines 5943-5949),
/// then anchors every pattern with `^...$`. The anchoring mirrors the original's final step
/// (lines 5951-5953): `local oldList = specialModList; specialModList = {}; for k, v in
/// pairs(oldList) do specialModList["^"..k.."$"] = v end`. Lua's own `scan()` (see scan.rs) picks
/// the earliest, then longest, then longest-pattern match among *all* patterns that match
/// anywhere in the line; without the anchors, a pattern that only matches a short prefix or
/// substring of the line could out-rank a different pattern that matches the whole line, and the
/// short match then fails parseMod's "whole line consumed" check with nothing left to fall back
/// to. Anchoring makes `find` itself refuse any match that doesn't span start-to-end.
pub fn entries() -> Vec<(String, SpecialVal)> {
    let mut v: Vec<(String, SpecialVal)> = special_a::entries().into_iter().map(|(p, sv)| (p.to_string(), sv)).collect();
    v.extend(special_b::entries().into_iter().map(|(p, sv)| (p.to_string(), sv)));
    v.extend(special_b::dynamic_entries());
    for (pat, _) in v.iter_mut() {
        *pat = format!("^{}$", pat);
    }
    // Per-gem specialModList entries (ModParser.lua lines 6124-6146) are injected by the real
    // parser *after* the ^...$ anchoring pass above (lines 5949-5953) runs, so they must not go
    // through it a second time here -- see the doc comment on build_gem_specials for their own,
    // already-correct anchor characters.
    v.extend(super::skill_names::build_gem_specials());

    // Lua's specialModList is a plain table, so assigning the same key twice keeps only the
    // value from whichever assignment runs last in source order and discards the earlier one
    // entirely. A real example: "iron will" is a literal entry (`{ flag("IronWill") }`) *and* a
    // real keystone name, so the keystone-name injection loop (lines 5943-5945, which runs after
    // the literal table is built) reassigns the same key to the keystone shape, silently
    // replacing the flag. Our Vec keeps both entries side by side instead of collapsing them, so
    // scan()'s tie-break can still pick the shadowed (wrong) one. Collapse duplicates here the
    // same way: keep only the last entry for each exact pattern string, in its original slot.
    let keep_idx: crate::fxhash::HashSet<usize> = {
        let mut last_index: crate::fxhash::HashMap<&str, usize> = crate::fxhash::HashMap::default();
        for (i, (pat, _)) in v.iter().enumerate() {
            last_index.insert(pat.as_str(), i);
        }
        last_index.into_values().collect()
    };
    let mut i = 0usize;
    v.retain(|_| {
        let keep = keep_idx.contains(&i);
        i += 1;
        keep
    });
    v
}
