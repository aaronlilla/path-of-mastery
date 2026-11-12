//! Item rules that
//! reach the items layer's own passes.

use super::*;

fn started() -> (Solver, State) {
    let goal: Goal = serde_json::from_str(r#"{"skill":"Tornado Shot","level":90,"assume":{"flasks":true}}"#).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let mut s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
    let c = s.candidates().unwrap();
    let mut st = s.initial_state(c[0], None, None).unwrap();
    s.init_gear(&mut st).unwrap();
    (s, st)
}

fn worn(s: &Solver, st: &State, name: &str) -> Option<Piece> {
    s.slots.iter().position(|d| d.name == name).and_then(|i| st.gear.pieces[i].clone())
}

/// Boots whose prefixes are all taken still get movement speed, in place of the prefix that costs least.
#[test]
fn full_boots_swap_in_movement_speed() {
    let (mut s, mut st) = started();
    let bi = s.slot_of(SlotKind::Boots).unwrap();
    let Some(Design::Craft { base, .. }) = st.gear.pieces[bi].as_ref().map(|p| p.design.clone()) else { panic!("crafted boots") };
    let ms = |f: &Fam| f.lines.iter().any(|l| l.ends_with("increased Movement Speed"));
    let mut mods = Vec::new();
    for f in 0..base.fams.len() {
        if base.fams[f].prefix && !base.fams[f].implicit && base.fams[f].source == "normal" && !ms(&base.fams[f]) && addable(&base, &mods, f) {
            mods.push(f);
        }
    }
    assert_eq!(mods.len(), base.prefix_limit);
    let g = s.with_piece(&st.gear, bi, Some(craft_piece(&base, mods, None, s.item_level))).unwrap();
    st.gear = Arc::new(g);
    s.rebase(&mut st).unwrap();
    s.movement_pass(&mut st).unwrap();
    let boots = worn(&s, &st, "Boots").unwrap();
    assert!(active_lines(&boots.xml).iter().any(|l| l.ends_with("% increased Movement Speed")), "no movement speed: {}", boots.label);
}

/// A flask whose buff is a defence fits the gear: armour bases take Granite, not Jade; evasion bases the
/// reverse; no Ward flask without ward.
#[test]
fn defence_flasks_follow_the_worn_bases() {
    let (s, st) = started();
    let mut g = (*st.gear).clone();
    let life = s.life_flask_slot();
    for k in 0..s.slots.len() {
        if matches!(s.slots[k].kind, SlotKind::Helmet | SlotKind::Body | SlotKind::Gloves | SlotKind::Boots | SlotKind::Weapon2) || (s.slots[k].kind == SlotKind::Flask && Some(k) != life) {
            g.pieces[k] = None;
        }
    }
    let (bi, fi) = (s.slot_of(SlotKind::Boots).unwrap(), s.slots.iter().position(|d| d.name == "Flask 3").unwrap());
    let fits = |g: &Gear, n: &str| s.with_piece(g, fi, Some(s.empty_craft(n).unwrap())).is_some();
    g.pieces[bi] = Some(s.empty_craft("Leviathan Greaves").unwrap());
    assert!(fits(&g, "Granite Flask") && !fits(&g, "Jade Flask") && !fits(&g, "Iron Flask"), "armour boots");
    g.pieces[bi] = Some(s.empty_craft("Slink Boots").unwrap());
    assert!(!fits(&g, "Granite Flask") && fits(&g, "Jade Flask"), "evasion boots");
}

/// A life build fills an open prefix with life (the helmet of the mapping result had none).
#[test]
fn life_build_puts_life_on_open_prefixes() {
    let (mut s, mut st) = started();
    s.life_pass(&mut st).unwrap();
    let h = worn(&s, &st, "Helmet").unwrap();
    assert!(h.xml.lines().any(|l| l.trim_end().ends_with("to maximum Life")), "no life: {}", h.label);
}

/// With nothing guarding against freeze, a utility flask gets the suffix that does.
#[test]
fn a_flask_guards_against_freeze() {
    let (mut s, mut st) = started();
    s.cover_pass(&mut st).unwrap();
    let flasks: Vec<Piece> = (1..=5).filter_map(|n| worn(&s, &st, &format!("Flask {n}"))).collect();
    let n = flasks.iter().filter(|p| active_lines(&p.xml).iter().any(|l| line_covers(l, "freeze", false))).count();
    assert!(n == 1 && flasks.iter().any(|p| p.xml.contains("Immunity to Freeze")), "{n} flasks guard against freeze");
}

/// An empty flask slot gets the utility flask that scores best (an empty slot left open
/// while a flask suffix meets an unmet chip).
#[test]
fn empty_flask_slot_gets_a_flask() {
    let (mut s, mut st) = started();
    let f4 = s.slots.iter().position(|d| d.name == "Flask 4").unwrap();
    let mut g = (*st.gear).clone();
    g.pieces[f4] = None;
    st.gear = Arc::new(g);
    s.rebase(&mut st).unwrap();
    let before = st.score;
    s.flask_fill_pass(&mut st).unwrap();
    assert!(st.gear.pieces[f4].is_some() && st.score > before, "Flask 4 stayed empty");
}

/// "gain a Flask Charge when you deal a Critical Strike" is worn only by a build that crits.
#[test]
fn on_crit_flask_lines_need_a_crit_build() {
    let (s, mut st) = started();
    let qs = s.craft_base("Quicksilver Flask", &[]).unwrap();
    let f = qs.fams.iter().position(|f| f.lines.iter().any(|l| l.contains("Flask Charge") && l.contains("Critical Strike"))).expect("an on-crit charge family");
    let p = craft_piece(&qs, vec![f], None, s.item_level);
    let ci = s.scorer.names.iter().position(|n| n == CRIT_RECENT).unwrap();
    st.vals[ci] = Some(0.0);
    assert!(!s.crit_lines_ok(&st, &p), "non-crit build took {}", p.label);
    st.vals[ci] = Some(1.0);
    assert!(s.crit_lines_ok(&st, &p));
}
