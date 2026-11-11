//! Curse slots and application inside `calcs.perform` (Modules/CalcPerform.lua:3143-3376): once
//! the player-cast, minion-cast, and ally-party curse lists are fully built (buff-loop curses at
//! lines 2653-2707, `ExtraCurse`-granted curses i.e. curse-on-hit/blasphemy-aura-copies at
//! 3143-3190, ally-party curses at 3191-3212), the curse limit gets computed, curses compete for
//! a bounded number of slots by priority (hexes) or bypass the limit entirely (marks via
//! `ignoreHexLimit`, `SocketedCursesAdditionalLimit`-granted extra hex slots), and the winning
//! slots' mods get folded into the enemy/player/minion `ModStore`s plus the `CurseOnEnemy`
//! multiplier and `Cursed`/`Marked` conditions.
//!
//! This module ports exactly that: slot assignment (`assign_curse_slots`, CalcPerform.lua:
//! 3215-3315) and application (`apply_curse_slots`, lines 3361-3376). It takes the fully-resolved
//! `curses`/`minionCurses`/`allyCurses` lists as input (each curse's own `modList`/`priority`/
//! `isMark`/etc already computed) rather than reconstructing them from `env.player.activeSkillList`
//! from scratch - the same "already-resolved mod lists in, this crate's own logic out" split
//! `perform.rs`'s `merge_flask_mods` uses for flask items, justified here because building those
//! curse objects needs the full (unported) `CalcActiveSkill`/skill-instance-mod pipeline, while
//! everything this file actually ports (limit math, priority-ordered slot eviction, hex-vs-mark
//! bypass rules, the enemy/player/minion mods the winning slots produce) is self-contained and
//! independently gradeable with a probe pair, with the probe
//! boundary drawn at CalcPerform.lua:3216 (curse lists fully built) and :3362 (slots assigned).
//! One field on each input curse, `skip`, is precomputed by the probe/caller from
//! CalcPerform.lua:3230-3238's "disable this curse if its an aura that only affects the caster"
//! check (needs `env.player.activeSkillList`, out of scope here for the same reason as above);
//! the probe supplies it.
use pom_engine::modifier::Mod;
use pom_engine::modstore::ModStore;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use serde_json::Value as J;

/// One entry of `curses`/`minionCurses`/`allyCurses` as fully built by the time
/// CalcPerform.lua:3216 is reached (right before "-- Set curse limit").
#[derive(Clone)]
pub struct CurseIn {
    pub name: String,
    pub from_player: bool,
    pub priority: f64,
    pub is_mark: bool,
    pub ignore_hex_limit: bool,
    pub socketed_hex_limit: bool,
    /// Precomputed `skipAddingCurse` from the aura-self-only check at CalcPerform.lua:3230-3238.
    pub skip: bool,
    pub mod_list: Vec<Mod>,
    pub buff_mod_list: Vec<Mod>,
    pub minion_buff_mod_list: Vec<Mod>,
}

/// One entry of `env.curseSlots` after assignment (CalcPerform.lua:3220-3315).
#[derive(Clone)]
pub struct CurseSlot {
    pub name: String,
    pub from_player: bool,
    pub priority: f64,
    pub is_mark: bool,
    pub mod_list: Vec<Mod>,
    pub buff_mod_list: Vec<Mod>,
    pub minion_buff_mod_list: Vec<Mod>,
}

impl From<&CurseIn> for CurseSlot {
    fn from(c: &CurseIn) -> CurseSlot {
        CurseSlot { name: c.name.clone(), from_player: c.from_player, priority: c.priority, is_mark: c.is_mark, mod_list: c.mod_list.clone(), buff_mod_list: c.buff_mod_list.clone(), minion_buff_mod_list: c.minion_buff_mod_list.clone() }
    }
}

/// `output.EnemyCurseLimit = modDB:Flag(nil, "CurseLimitIsMaximumPowerCharges") and
/// output.PowerChargesMax or modDB:Sum("BASE", nil, "EnemyCurseLimit")` (CalcPerform.lua:3216).
/// `power_charges_max` is `output.PowerChargesMax` (owned by the parallel charges-porting
/// session's `perform_charges.rs`, taken as a recorded input here - see module doc).
pub fn compute_enemy_curse_limit(player: &ModStore, power_charges_max: f64) -> f64 {
    compute_enemy_curse_limit_raw(player.flag(None, &[pom_engine::sym!("CurseLimitIsMaximumPowerCharges")]), player.sum(pom_engine::modifier::ModType::Base, None, &[pom_engine::sym!("EnemyCurseLimit")]), power_charges_max)
}

/// Same formula, taking the two `ModStore` reads directly rather than a `ModStore` - used by the
/// probe-based grading harness, which records these two scalars rather than a full player
/// `ModStore` snapshot (the curse lists are what CalcPerform.lua:3216's probe boundary actually
/// needs to capture; see the module doc above).
pub fn compute_enemy_curse_limit_raw(is_max_power_charges: bool, enemy_curse_limit_base: f64, power_charges_max: f64) -> f64 {
    if is_max_power_charges {
        power_charges_max
    } else {
        enemy_curse_limit_base
    }
}

/// `curseSlots[i] = curse`'s eviction/priority scan for one hex-limited curse
/// (CalcPerform.lua:3239-3271), applied within `assign_curse_slots`'s single shared `slots`
/// accumulator (`env.curseSlots`, one array reused across all three sources exactly like the
/// original's closure over the same `curseSlots` local). Returns the slot index it would land in
/// (`None` if it doesn't get a slot at all), mutating `slots`/`mark_slotted` the same way the
/// original mutates `curseSlots`/the enclosing `markSlotted` local - including when `curse.skip`
/// is true: a slot is still located and `markSlotted` still gets set/cleared, the curse just never
/// actually gets written into `slots` (CalcPerform.lua:3261-3271's own `skipAddingCurse` gate).
fn place_in_limited_slots(slots: &mut Vec<CurseSlot>, mark_slotted: &mut bool, limit: f64, curse: &CurseIn) {
    let n = limit.floor().max(0.0) as usize;
    let mut slot: Option<usize> = None;
    for i in 0..n {
        if curse.is_mark && *mark_slotted {
            slot = None;
            break;
        }
        if i >= slots.len() {
            slot = Some(i);
            break;
        } else if slots[i].name == curse.name {
            slot = if slots[i].priority < curse.priority { Some(i) } else { None };
            break;
        } else if slots[i].priority < curse.priority {
            slot = Some(i);
        }
    }
    if let Some(si) = slot {
        if si < slots.len() && slots[si].is_mark {
            *mark_slotted = false;
        }
        if !curse.skip {
            if si < slots.len() {
                slots[si] = CurseSlot::from(curse);
            } else {
                slots.push(CurseSlot::from(curse));
            }
        }
        if curse.is_mark {
            *mark_slotted = true;
        }
    }
}

/// The `ignoreHexLimit`/`socketedCursesHexLimit` append-or-replace-by-name scan
/// (CalcPerform.lua:3280-3289 and :3297-3309 - structurally identical except the hex-limit
/// variant also force-stops once `i >= socketedCursesHexLimitValue`, without an early `break`,
/// which the `stop_at` closure below replicates faithfully: once tripped it stays tripped for the
/// rest of the scan even if a later index would have matched by name).
fn append_or_replace_by_name(slots: &mut Vec<CurseSlot>, curse: &CurseIn, stop_at: Option<f64>) {
    let mut skip_adding = false;
    for i in 0..slots.len() {
        if slots[i].name == curse.name {
            if slots[i].priority < curse.priority {
                slots[i] = CurseSlot::from(curse);
            }
            skip_adding = true;
            break;
        }
        if let Some(threshold) = stop_at {
            if (i as f64 + 1.0) >= threshold {
                skip_adding = true;
            }
        }
    }
    if !skip_adding {
        slots.push(CurseSlot::from(curse));
    }
}

/// `env.curseSlots` assignment in full (CalcPerform.lua:3219-3315): `curses`/`minion_curses`/
/// `ally_curses` each paired with their own slot limit (`curses.limit` = `EnemyCurseLimit`,
/// `minionCurses.limit`, `allyCurses.limit` - the latter two are recorder/probe inputs, not
/// derived here; see module doc), plus `socketed_hex_limit_value` (`modDB:Sum("BASE", nil,
/// "SocketedCursesHexLimitValue")`).
pub fn assign_curse_slots(curses: &[CurseIn], curses_limit: f64, minion_curses: &[CurseIn], minion_curses_limit: f64, ally_curses: &[CurseIn], ally_curses_limit: f64, socketed_hex_limit_value: f64) -> Vec<CurseSlot> {
    let mut slots: Vec<CurseSlot> = Vec::new();
    let mut mark_slotted = false;
    for (src, limit) in [(curses, curses_limit), (minion_curses, minion_curses_limit), (ally_curses, ally_curses_limit)] {
        for curse in src {
            if curse.ignore_hex_limit || curse.socketed_hex_limit {
                continue;
            }
            place_in_limited_slots(&mut slots, &mut mark_slotted, limit, curse);
        }
    }
    // Second pass: only `curses` and `minionCurses` (CalcPerform.lua:3276 - ally curses never set
    // `ignoreHexLimit`/`socketedCursesHexLimit`, see module doc, so this exclusion is a no-op in
    // practice but is kept to match upstream's own source list exactly).
    for src in [curses, minion_curses] {
        for curse in src {
            if curse.ignore_hex_limit {
                append_or_replace_by_name(&mut slots, curse, None);
            }
            if curse.socketed_hex_limit {
                append_or_replace_by_name(&mut slots, curse, Some(socketed_hex_limit_value));
            }
        }
    }
    slots
}

/// The enemy/player/minion mod application (CalcPerform.lua:3361-3376): `modDB.multipliers
/// ["CurseOnEnemy"] = #curseSlots`, then per slot, `enemyDB.conditions["Cursed"]`/`["Marked"]`,
/// `enemyDB:AddList(slot.modList)`, `modDB:AddList(slot.buffModList)`,
/// `env.minion.modDB:AddList(slot.minionBuffModList)`.
pub fn apply_curse_slots(player: &mut ModStore, enemy: &mut ModStore, mut minion: Option<&mut ModStore>, slots: &[CurseSlot]) {
    player.multipliers.insert(pom_engine::sym!("CurseOnEnemy"), slots.len() as f64);
    for slot in slots {
        enemy.conditions.insert(pom_engine::sym!("Cursed"), true);
        // `Hexed` is set by Hex curses only (game text "if Enemy is Hexed"); Marks are Cursed but not Hexed.
        // Game-data fix: POM_STRICT_COMPAT=1 restores the upstream behaviour.
        if !slot.is_mark && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
            enemy.conditions.insert(pom_engine::sym!("Hexed"), true);
        }
        if slot.is_mark {
            enemy.conditions.insert(pom_engine::sym!("Marked"), true);
        }
        for mm in &slot.mod_list {
            enemy.add_mod(mm.clone());
        }
        for mm in &slot.buff_mod_list {
            player.add_mod(mm.clone());
        }
        if let Some(ms) = &mut minion {
            for mm in &slot.minion_buff_mod_list {
                ms.add_mod(mm.clone());
            }
        }
    }
}

// ===== Probe-based grading =====
// The probe pair brackets CalcPerform.lua:3143-3376 ("curse_in" at line 3216, right before
// `output.EnemyCurseLimit` is computed; "curse_out" at line 3362, right after `curveSlots` is
// fully assigned and `CurseOnEnemy` is set). See
// this crate's `probe.rs`.
fn jstr(v: &J, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn jf64(v: &J, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
fn jbool(v: &J, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}
fn parse_mod_list(v: Option<&J>) -> Vec<Mod> {
    v.and_then(|x| x.as_array()).map(|a| a.iter().map(crate::snapshot::parse_mod).collect()).unwrap_or_default()
}
fn parse_curse_list(v: &J, k: &str) -> Vec<CurseIn> {
    v.get(k).and_then(|x| x.as_array()).map(|a| a.iter().map(parse_curse_in).collect()).unwrap_or_default()
}
fn parse_curse_in(v: &J) -> CurseIn {
    CurseIn {
        name: jstr(v, "name"),
        from_player: jbool(v, "fromPlayer"),
        priority: jf64(v, "priority"),
        is_mark: jbool(v, "isMark"),
        ignore_hex_limit: jbool(v, "ignoreHexLimit"),
        socketed_hex_limit: jbool(v, "socketedCursesHexLimit"),
        skip: jbool(v, "skip"),
        mod_list: parse_mod_list(v.get("modList")),
        buff_mod_list: parse_mod_list(v.get("buffModList")),
        minion_buff_mod_list: parse_mod_list(v.get("minionBuffModList")),
    }
}

fn mods_equal(a: &Mod, b: &Mod) -> bool {
    fn value_close(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Nil, Value::Nil) => true,
            (Value::Bool(x), Value::Bool(y)) => x == y,
            (Value::Str(x), Value::Str(y)) => x == y,
            (Value::Num(x), Value::Num(y)) => (x.is_nan() && y.is_nan()) || (x - y).abs() <= 1e-6 * x.abs().max(y.abs()).max(1.0),
            (Value::List(x), Value::List(y)) => x.len() == y.len() && x.iter().zip(y.iter()).all(|(xi, yi)| value_close(xi, yi)),
            (Value::Map(x), Value::Map(y)) => x.len() == y.len() && x.iter().zip(y.iter()).all(|((kx, vx), (ky, vy))| kx == ky && value_close(vx, vy)),
            _ => false,
        }
    }
    a.name == b.name && a.ty == b.ty && a.flags == b.flags && a.keyword_flags == b.keyword_flags && a.source == b.source && value_close(&a.value, &b.value)
}
fn match_multiset(want: &[Mod], have: &[Mod]) -> usize {
    let mut pool: Vec<&Mod> = have.iter().collect();
    let mut matched = 0;
    for w in want {
        if let Some(pos) = pool.iter().position(|h| mods_equal(w, h)) {
            pool.remove(pos);
            matched += 1;
        }
    }
    matched
}

/// Grades `assign_curse_slots`/`compute_enemy_curse_limit_raw`/`apply_curse_slots` against every
/// `curse_in`/`curse_out` probe pair in `path` (one pair per `calcs.perform` call recorded -
/// MAIN-mode passes and every FullDPS/tooltip pass alike, all equally valid test cases for this
/// self-contained a section of the port). Returns a "matched N/total" report.
pub fn grade_from_probe_file(path: &std::path::Path) -> String {
    use std::fmt::Write as _;
    let mut report = String::new();
    let ins = crate::probe::load_probe(path, "curse_in");
    let outs = crate::probe::load_probe(path, "curse_out");
    let mut total = 0usize;
    let mut slot_seq_matched = 0usize;
    let mut limit_matched = 0usize;
    let mut mod_matched = 0usize;
    let mut mod_want_total = 0usize;
    let mut first_misses: Vec<String> = Vec::new();
    for (key, vin) in &ins {
        let Some(vout) = outs.get(key) else { continue };
        total += 1;
        let curses = parse_curse_list(vin, "curses");
        let minion_curses = parse_curse_list(vin, "minionCurses");
        let ally_curses = parse_curse_list(vin, "allyCurses");
        let minion_curses_limit = jf64(vin, "minionCursesLimit");
        let ally_curses_limit = vin.get("allyCursesLimit").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let power_charges_max = jf64(vin, "powerChargesMax");
        let is_max_pc = jbool(vin, "curseLimitIsMaxPowerCharges");
        let base_limit = jf64(vin, "enemyCurseLimitBase");
        let socketed_hex_limit_value = jf64(vin, "socketedCursesHexLimitValue");

        let enemy_curse_limit = compute_enemy_curse_limit_raw(is_max_pc, base_limit, power_charges_max);
        let want_limit = jf64(vout, "enemyCurseLimit");
        if (enemy_curse_limit - want_limit).abs() < 1e-6 {
            limit_matched += 1;
        } else if first_misses.len() < 30 {
            first_misses.push(format!("{}#{}: EnemyCurseLimit mine={enemy_curse_limit} golden={want_limit}", key.0, key.1));
        }

        let slots = assign_curse_slots(&curses, enemy_curse_limit, &minion_curses, minion_curses_limit, &ally_curses, ally_curses_limit, socketed_hex_limit_value);
        let want_slots = vout.get("curseSlots").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        let seq_matches = slots.len() == want_slots.len()
            && slots.iter().zip(want_slots.iter()).all(|(s, w)| s.name == jstr(w, "name") && s.is_mark == jbool(w, "isMark") && (s.priority - jf64(w, "priority")).abs() < 1e-6);
        if seq_matches {
            slot_seq_matched += 1;
        } else if first_misses.len() < 30 {
            let mine: Vec<String> = slots.iter().map(|s| format!("{}(p{},{})", s.name, s.priority, if s.is_mark { "mark" } else { "hex" })).collect();
            let want: Vec<String> = want_slots.iter().map(|w| format!("{}(p{},{})", jstr(w, "name"), jf64(w, "priority"), if jbool(w, "isMark") { "mark" } else { "hex" })).collect();
            first_misses.push(format!("{}#{}: curseSlots mine={mine:?} golden={want:?}", key.0, key.1));
        }

        // Mod-level check: the union of what apply_curse_slots would add, against the union of
        // what golden's own recorded slots carry (independent of whether the slot *sequence*
        // above matched exactly - a slot-order swap with identical resulting mods still counts
        // here, giving a finer-grained signal than the strict sequence check).
        let mut want_mods: Vec<Mod> = Vec::new();
        for w in &want_slots {
            want_mods.extend(parse_mod_list(w.get("modList")));
            want_mods.extend(parse_mod_list(w.get("buffModList")));
            want_mods.extend(parse_mod_list(w.get("minionBuffModList")));
        }
        let mut have_mods: Vec<Mod> = Vec::new();
        for s in &slots {
            have_mods.extend(s.mod_list.iter().cloned());
            have_mods.extend(s.buff_mod_list.iter().cloned());
            have_mods.extend(s.minion_buff_mod_list.iter().cloned());
        }
        mod_matched += match_multiset(&want_mods, &have_mods);
        mod_want_total += want_mods.len();
    }
    let _ = writeln!(report, "curses (probe-graded): {total} calcs.perform passes with a curse_in/curse_out pair");
    let _ = writeln!(report, "curses: EnemyCurseLimit matched {limit_matched}/{total}");
    let _ = writeln!(report, "curses: curseSlots exact sequence matched {slot_seq_matched}/{total}");
    let _ = writeln!(report, "curses: slot mods matched {mod_matched}/{mod_want_total}");
    if !first_misses.is_empty() {
        let _ = writeln!(report, "\nfirst mismatches (curses):");
        for l in first_misses.iter().take(30) {
            let _ = writeln!(report, "  {l}");
        }
    }
    report
}
