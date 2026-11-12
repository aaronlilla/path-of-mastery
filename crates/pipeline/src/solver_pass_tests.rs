//! Rules checked on the Templar Flicker Strike mid-league results (testdata/pass-mapping.xml,
//! testdata/pass-bossing.xml).

use super::*;
use items::{unique_list, unique_piece, Gear, ItemRules, SlotKind};

const MAP_GOAL: &str = r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"combined"},{"name":"EHP","metric":"ehp"}],"limits":{"resists":75,"pool":3000,"attributes":true,"reservation":true,"warnings":true,"cost":true},"wealth":"mid-league","assume":{"flasks":true,"flaskUptime":"mapping","playMode":"mapping","ailments":true,"charges":true}}"#;
const BOSS_GOAL: &str = r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"full"},{"name":"EHP","metric":"ehp"}],"limits":{"resists":75,"pool":3000,"attributes":true,"reservation":true,"warnings":true,"cost":true},"wealth":"mid-league","assume":{"flasks":true,"playMode":"bossing","ailments":true,"charges":true}}"#;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/testdata/pass-{name}.xml", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn solver(goal: &str) -> Solver {
    let goal: Goal = serde_json::from_str(goal).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap()
}

fn unique(name: &str) -> Arc<items::UniqueInfo> {
    unique_list(&ItemRules::default(), 90, None, &|_, _| true).into_iter().find(|u| u.name == name).unwrap_or_else(|| panic!("no {name}"))
}

/// `xml` with `<Item id="id">`'s text replaced by `text`.
fn with_item(xml: &str, id: usize, text: &str) -> String {
    let open = format!("<Item id=\"{id}\">");
    let a = xml.find(&open).unwrap() + open.len();
    let b = a + xml[a..].find("</Item>").unwrap();
    format!("{}{text}{}", &xml[..a], &xml[b..])
}

fn bare(s: &Solver) -> Gear {
    Gear { pieces: vec![None; s.slots.len()], ..Default::default() }
}

/// The main link's Sockets line is written on a unique body armour whose data text has no Implicits line
/// (Servant of Decay); before, the line went nowhere and the 6-link showed on an item with no sockets.
#[test]
fn sockets_line_lands_on_a_unique_without_implicits() {
    let u = unique("Servant of Decay");
    assert!(!u.xml.contains("Implicits:"));
    let x = sockets::with_sockets_line(&u.xml, "R-R-R-G-G-G");
    assert!(x.lines().any(|l| l == "Sockets: R-R-R-G-G-G"), "no Sockets line");
}

/// A lead holding Foulborn Rebuke of the Vaal (attack speed mutated into trap throwing speed) may take the
/// plain Rebuke back, which scores higher on the bossing result (attack speed is valued under the Flicker bypass);
/// another unique still cannot replace the held weapon.
#[test]
fn foulborn_form_gives_way_to_the_plain_one() {
    let s = solver(BOSS_GOAL);
    let u = unique("Rebuke of the Vaal");
    let foul = u.variants.iter().find(|v| v.label.starts_with("Foulborn ") && v.label.contains("Trap Throwing")).expect("the trap speed Foulborn form");
    let w1 = s.slot_of(SlotKind::Weapon1).unwrap();
    let mut g = bare(&s);
    g.pieces[w1] = Some(unique_piece(foul));
    g.held = vec![w1];
    assert!(s.with_piece(&g, w1, Some(unique_piece(&u))).is_some(), "the held Foulborn form cannot become the plain one");
    let other = unique("Oro's Sacrifice");
    assert!(s.with_piece(&g, w1, Some(unique_piece(&other))).is_none(), "another unique replaced the held weapon");
    let x = fixture("bossing");
    let names: Vec<&str> = s.scorer.names.iter().map(|n| n.as_str()).collect();
    let score = |xml: &str| s.score(&eval_one(&mut None, &Cand::Xml(Arc::new(xml.to_string())), &names).unwrap()).0;
    let (f, p) = (score(&x), score(&with_item(&x, 1, &sockets::with_sockets_line(&u.xml, "R R R"))));
    assert!(p > f, "plain {p} <= foulborn {f}");
}

/// A Foulborn lead that took the plain unique back names the plain item it wears.
#[test]
fn lead_label_names_the_worn_form() {
    let s = solver(BOSS_GOAL);
    let u = unique("Rebuke of the Vaal");
    let foul = u.variants.iter().find(|v| v.label.starts_with("Foulborn ")).expect("a Foulborn form");
    let w1 = s.slot_of(SlotKind::Weapon1).unwrap();
    let label = format!("plain · {} · Inquisitor", foul.label.trim_end_matches(" (unique)"));
    let mut g = bare(&s);
    g.pieces[w1] = Some(unique_piece(&u));
    assert_eq!(leads::worn_label(&label, &g), "plain · Rebuke of the Vaal · Inquisitor");
    g.pieces[w1] = Some(unique_piece(foul));
    assert_eq!(leads::worn_label(&label, &g), label);
}

/// "You are Chilled while you are Bleeding" (Venopuncture) puts chill on the player; the ring is worn only
/// with lasting chill immunity elsewhere on the gear.
#[test]
fn self_chill_ring_needs_chill_immunity() {
    let s = solver(BOSS_GOAL);
    let veno = unique_piece(&unique("Venopuncture"));
    let ring = s.slots.iter().position(|d| d.name == "Ring 1").unwrap();
    let g = bare(&s);
    assert!(s.with_piece(&g, ring, Some(veno.clone())).is_none(), "self-chilling ring worn with no chill immunity");
    let b = s.base_craft("Leviathan Greaves", &[]).unwrap();
    let f = b.fams.iter().position(|f| f.lines.iter().any(|l| l.contains("100% chance to Avoid being Chilled"))).expect("a boots line that avoids chill");
    let mut g2 = g.clone();
    g2.pieces[s.slot_of(SlotKind::Boots).unwrap()] = Some(items::craft_piece(&b, vec![f], None, 84));
    assert!(s.with_piece(&g2, ring, Some(veno)).is_some(), "chill-immune boots still keep the ring off");
}

/// The line readers behind it: what a line puts on the player, and what guards against it.
#[test]
fn self_ailment_lines_read() {
    assert_eq!(items::self_ailments("You are Chilled while you are Bleeding"), vec!["chill"]);
    assert!(items::self_ailments("You are Immune to Bleeding while Leeching").is_empty());
    assert!(items::line_covers("100% chance to Avoid being Chilled", "chill", true));
    assert!(items::line_eases("60% reduced Effect of Shock on you", "shock"));
    assert!(!items::line_covers("Immunity to Freeze and Chill during Effect", "freeze", true) && items::line_covers("Immunity to Freeze and Chill during Effect", "freeze", false));
    assert!(!items::line_covers("Non-Chilled Enemies you inflict Bleeding on are Chilled", "chill", false));
}

/// Review of the drawback reader: "Hexproof" is not a curse, the condition after " when " / " if " is not given, and
/// only full cover counts (a 10% avoid chance or reduced effect is not immunity).
#[test]
fn review_drawback_lines_read() {
    assert!(items::self_ailments("You are Hexproof if you have a Magic Ring in right slot").is_empty());
    assert_eq!(items::self_ailments("You are Chilled when you are Poisoned"), vec!["chill"]);
    assert_eq!(items::self_ailments("You are Shocked if you have been Hit Recently"), vec!["shock"]);
    assert!(!items::line_covers("10% chance to Avoid being Frozen", "freeze", false));
    assert!(!items::line_covers("60% reduced Effect of Shock on you", "shock", false));
    assert!(items::line_covers("Cannot be Shocked", "shock", true) && items::line_covers("Unaffected by Chill", "chill", true));
}

/// Review: cover is checked on the whole gear, not only on the piece placed. Taking off the chill-immune boots under a
/// self-chilling ring is refused; changing armour boots to evasion boots takes the Granite flask off.
#[test]
fn review_cover_holds_when_other_pieces_change() {
    let s = solver(BOSS_GOAL);
    let veno = unique_piece(&unique("Venopuncture"));
    let (ring, bi) = (s.slots.iter().position(|d| d.name == "Ring 1").unwrap(), s.slot_of(SlotKind::Boots).unwrap());
    let b = s.base_craft("Leviathan Greaves", &[]).unwrap();
    let f = b.fams.iter().position(|f| f.lines.iter().any(|l| l.contains("100% chance to Avoid being Chilled"))).unwrap();
    let mut g = bare(&s);
    g.pieces[bi] = Some(items::craft_piece(&b, vec![f], None, 84));
    let g = s.with_piece(&g, ring, Some(veno)).unwrap();
    assert!(s.with_piece(&g, bi, Some(s.empty_craft("Leviathan Greaves").unwrap())).is_none(), "chill cover taken off under the ring");
    let fi = s.slots.iter().position(|d| d.name == "Flask 3").unwrap();
    let mut g = bare(&s);
    assert!(s.with_piece(&g, fi, Some(s.empty_craft("Granite Flask").unwrap())).is_some(), "a defence flask waits for the armour slots");
    g.pieces[bi] = Some(s.empty_craft("Leviathan Greaves").unwrap());
    let g = s.with_piece(&g, fi, Some(s.empty_craft("Granite Flask").unwrap())).unwrap();
    let g = s.with_piece(&g, bi, Some(s.empty_craft("Slink Boots").unwrap())).unwrap();
    assert!(g.pieces[fi].is_none(), "Granite flask kept on evasion gear");
}

/// Review of 1415e06b4: a piece that was already unfit before the change (a locked Jade flask on armour gear, a kept
/// self-chilling ring with no cover) does not block changes to other slots.
#[test]
fn review_already_unfit_pieces_do_not_block_other_slots() {
    let mut s = solver(BOSS_GOAL);
    let (bi, fi) = (s.slot_of(SlotKind::Boots).unwrap(), s.slots.iter().position(|d| d.name == "Flask 3").unwrap());
    let (r1, r2, am) = (s.slots.iter().position(|d| d.name == "Ring 1").unwrap(), s.slots.iter().position(|d| d.name == "Ring 2").unwrap(), s.slot_of(SlotKind::Amulet).unwrap());
    s.slots[fi].locked = true;
    let mut g = bare(&s);
    g.pieces[bi] = Some(s.empty_craft("Leviathan Greaves").unwrap());
    g.pieces[fi] = Some(s.empty_craft("Jade Flask").unwrap());
    g.pieces[r1] = Some(unique_piece(&unique("Venopuncture")));
    let ring = s.with_piece(&g, r2, Some(s.empty_craft("Diamond Ring").unwrap()));
    assert!(ring.is_some(), "a ring swap stalls on the locked unfit flask or the uncovered kept ring");
    assert!(ring.unwrap().pieces[fi].is_some(), "locked flask taken off");
    assert!(s.with_piece(&g, am, Some(s.empty_craft("Onyx Amulet").unwrap())).is_some());
}

/// An item that spends a charge kind the main skill uses ("Consumes Frenzy Charges on use", Rotgut, next to Flicker
/// Strike's per-frenzy-charge stats) is not picked; a skill with no frenzy stat may wear it.
#[test]
fn charge_spending_items_skip_a_skill_that_uses_the_charge() {
    assert_eq!(items::spent_charges("Consumes Frenzy Charges on use"), vec!["frenzy".to_string()]);
    assert!(items::spent_charges("(6-10)% chance for Flasks you use to not consume Charges").is_empty());
    let rot = unique_piece(&unique("Rotgut"));
    let flicker = solver(BOSS_GOAL);
    let fi = flicker.slots.iter().position(|d| d.name == "Flask 3").unwrap();
    assert!(flicker.with_piece(&bare(&flicker), fi, Some(rot.clone())).is_none(), "Rotgut eats Flicker Strike's frenzy charges");
    let fire = solver(r#"{"skill":"Fireball","level":90,"wealth":"mid-league"}"#);
    let fi = fire.slots.iter().position(|d| d.name == "Flask 3").unwrap();
    assert!(fire.with_piece(&bare(&fire), fi, Some(rot)).is_some());
}

/// Review: a minor god is picked even when nothing is left open for one to cover.
#[test]
fn review_minor_god_when_all_covered() {
    let s = solver(MAP_GOAL);
    let x = fixture("mapping").replacen("<Notes>", "<Notes>\nImmunity to Freeze, Chill, Shock, Ignite, Poison, Bleeding, Blind, Maim and Curses\n", 1);
    let (out, _) = s.fill_pantheon(x, &["Flicker Strike".to_string()], &[]).unwrap();
    let minor = out.split("pantheonMinorGod=\"").nth(1).and_then(|r| r.split('"').next()).unwrap_or("None").to_string();
    assert_ne!(minor, "None");
}

/// An eldritch implicit is one of many its orb rolls, so landing a chosen one costs many orbs (mid league:
/// the tier 4 Exarch and Eater implicits of a helmet price from live listings, 0.11 divine).
#[test]
fn eldritch_implicits_cost_the_orbs_to_land_them() {
    let s = solver(BOSS_GOAL);
    let b = s.base_craft("Divine Crown", &[]).unwrap();
    let (ex, ea) = (b.fams.iter().position(|f| f.source == "exarch").unwrap(), b.fams.iter().position(|f| f.source == "eater").unwrap());
    let price = Wealth::craft_divines(None, &b, &[ex, ea], false);
    assert!((0.01..=0.5).contains(&price), "double eldritch helmet costs {price}");
}

/// The mapping result had no minor god; one is always set (free), here the one guarding against the most
/// ailments nothing else covers.
#[test]
fn a_minor_god_is_always_picked() {
    let s = solver(MAP_GOAL);
    let x = fixture("mapping");
    assert!(x.contains("pantheonMinorGod=\"None\""));
    let (out, _) = s.fill_pantheon(x, &["Flicker Strike".to_string()], &[]).unwrap();
    let minor = out.split("pantheonMinorGod=\"").nth(1).and_then(|r| r.split('"').next()).unwrap_or("None").to_string();
    assert_ne!(minor, "None");
}

/// Top tiers of life, resist and attribute lines cost more than low tiers on a rare (live-listing prices),
/// and several on one item cost more than their sum.
#[test]
fn price_top_tier_lines() {
    let s = solver(MAP_GOAL);
    let b = s.base_craft("Vaal Regalia", &[]).unwrap();
    let plain = |f: &items::Fam| f.source == "normal" && f.lines.len() == 1 && (f.lines[0].ends_with("to maximum Life") || f.lines[0].ends_with("Resistance"));
    let mut mods = Vec::new();
    for f in 0..b.fams.len() {
        if plain(&b.fams[f]) && b.fams[f].tier <= 2 && items::addable(&b, &mods, f) && mods.len() < 4 {
            mods.push(f);
        }
    }
    assert_eq!(mods.len(), 4);
    let (one, four) = (Wealth::craft_divines(None, &b, &mods[..1], false), Wealth::craft_divines(None, &b, &mods, false));
    assert!(one >= 0.01 && four > 4.0 * one && four >= 0.1, "one {one}, four {four}");
}

/// A crafted item over the wealth budget is not refused outright: its lines step down to the mod data's lower tiers
/// until the build fits (mid league: 10 divine).
#[test]
fn price_steps_down_over_budget() {
    let s = solver(MAP_GOAL);
    let b = s.base_craft("Vaal Regalia", &[]).unwrap();
    let mut mods = Vec::new();
    for f in 0..b.fams.len() {
        if b.fams[f].source == "normal" && b.fams[f].tier <= 2 && items::addable(&b, &mods, f) {
            mods.push(f);
        }
    }
    let p = items::craft_piece(&b, mods.clone(), None, s.item_level);
    let dear = s.piece_cost(&p);
    assert!(dear > 10.0, "{dear}");
    let body = s.slot_of(SlotKind::Body).unwrap();
    let g = s.with_piece(&bare(&s), body, Some(p)).expect("taken with lower tiers");
    let q = g.pieces[body].clone().unwrap();
    let items::Design::Craft { base: qb, mods: qm, .. } = &q.design else { panic!("crafted") };
    let cost = s.gear_cost(&g);
    assert!(cost <= 10.0 + 1e-9, "{cost}");
    assert_eq!(qm, &mods);
    assert!(qm.iter().any(|&m| qb.fams[m].tier > b.fams[m].tier));
    assert!(qm.iter().all(|&m| qb.fams[m].tier >= b.fams[m].tier && qb.fams[m].key == b.fams[m].key));
}

/// The main 6-link on a body armour costs its links (Fusings), its sockets (Jeweller's) and its colours (Chromatics):
/// six green gems on an Int base cost far more colour than on a Dex base.
#[test]
fn price_six_link_off_colour_sockets() {
    let s = solver(MAP_GOAL);
    let mut greens: Vec<&'static str> = gd::game_data().gems.keys().map(|k| k.as_str()).filter(|id| sockets::gem_colour(id) == 'G').collect();
    greens.sort();
    greens.truncate(6);
    let body = s.slot_of(SlotKind::Body).unwrap();
    let on = |base: &str| {
        let b = s.base_craft(base, &[]).unwrap();
        let mut g = bare(&s);
        g.pieces[body] = Some(items::craft_piece(&b, Vec::new(), None, s.item_level));
        g.groups = vec![greens.clone()];
        let plan = s.socket_plan(&g, &g.groups).into_iter().find(|p| p.slot == body).unwrap();
        (s.socket_cost(&g), plan.used, plan.chromatics, plan.line)
    };
    let (dex, int) = (on("Zodiac Leather"), on("Vaal Regalia"));
    let links = Wealth::links_divines(6);
    assert!(links > 0.5, "{links}");
    assert_eq!((dex.1, int.1), (6, 6));
    assert!(int.2 >= Wealth::chromatic_cap() - 1e-9 && int.2 > 10.0 * dex.2.max(1.0), "{} vs {}", int.2, dex.2);
    assert!(int.0 > dex.0 && int.0 >= Wealth::sockets_divines(6, Wealth::chromatic_cap()) - 1e-9);
    assert!(dex.0 >= Wealth::sockets_divines(6, 0.0));
}

/// Gear tiers ate the 10 divine and the gems got the leftover, so the 1.25 divine Empower
/// never replaced a weak link. Over budget, a support swap is weighed against stepping a crafted piece down.
#[test]
fn support_beats_the_gear_tier_that_eats_the_budget() {
    let goal: Goal = serde_json::from_str(BOSS_GOAL).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let mut s = Solver::new(fixture("bossing"), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
    let c = s.candidates().unwrap();
    let mut st = s.initial_state(c[0], None, None).unwrap();
    st.main = ["Flicker Strike", "Multistrike", "Fortify", "Close Combat", "Momentum", "Additional Accuracy"].iter().map(|n| find_gem(n).unwrap()).collect();
    let b = s.base_craft("Vaal Regalia", &[]).unwrap();
    let mut mods = Vec::new();
    for f in 0..b.fams.len() {
        if b.fams[f].source == "normal" && b.fams[f].tier <= 2 && items::addable(&b, &mods, f) {
            mods.push(f);
        }
    }
    let body = s.slot_of(SlotKind::Body).unwrap();
    let w1 = s.slot_of(SlotKind::Weapon1).unwrap();
    let wg = s.with_piece(&(*st.gear).clone(), w1, Some(unique_piece(&unique("Rebuke of the Vaal")))).expect("weapon");
    let g = s.with_piece(&wg, body, Some(items::craft_piece(&b, mods, None, s.item_level))).expect("stepped to budget");
    st.gear = Arc::new(g);
    s.rebase(&mut st).unwrap();
    let cap = s.goal.wealth.and_then(|w| w.budget()).unwrap();
    let emp = find_gem("Empower").unwrap();
    assert!(s.gear_cost(&st.gear) + Wealth::gem_price("Empower").unwrap() > cap, "the gear leaves room: {}", s.gear_cost(&st.gear));
    let swaps: Vec<_> = (2..6)
        .map(|i| {
            let mut m = st.main.clone();
            m[i] = emp;
            (m, st.utils.clone())
        })
        .collect();
    let n = s.try_setups(&st, swaps).unwrap().expect("Empower never displaced the gear tiers");
    assert!(n.main.contains(&emp) && s.gear_cost(&n.gear) <= cap + 1e-9 && n.score > st.score);
}

/// Over budget, a crafted piece loses its ordinary lines (life, resists, attributes: common, a lower tier is
/// nearly as good) before any scarce damage line: the plain "saves most" step dropped the scarce lines first (bossing
/// check solve 25.28 -> 25.06, Boss DPS 1.09M -> 0.92M). (League start: 6 good lines are over its 1 divine.)
#[test]
fn over_budget_steps_ordinary_lines_before_scarce() {
    let s = solver(&MAP_GOAL.replace("mid-league", "league-start"));
    let b = s.base_craft("Astral Plate", &[]).unwrap();
    let mut mods: Vec<usize> = Vec::new();
    for want_ord in [true, true, true, false, false, false] {
        let f = (0..b.fams.len()).find(|&f| b.fams[f].source == "normal" && b.fams[f].tier <= 2 && !b.fams[f].lower.is_empty() && wealth::is_ordinary(&b.fams[f]) == want_ord && items::addable(&b, &mods, f)).expect("a line");
        mods.push(f);
    }
    let p = items::craft_piece(&b, mods.clone(), None, s.item_level);
    let top: Vec<u32> = mods.iter().map(|&m| b.fams[m].tier).collect();
    let body = s.slot_of(SlotKind::Body).unwrap();
    let g = s.with_piece(&bare(&s), body, Some(p)).expect("stepped to budget");
    let Some(items::Design::Craft { base: qb, mods: qm, .. }) = g.pieces[body].as_ref().map(|q| &q.design) else { panic!("crafted") };
    let tiers: Vec<(bool, u32)> = qm.iter().map(|&m| (wealth::is_ordinary(&qb.fams[m]), qb.fams[m].tier)).collect();
    assert!(tiers.iter().zip(&top).filter(|(t, _)| !t.0).all(|(t, top)| t.1 == *top), "a scarce line stepped down first: {tiers:?}");
    assert!(tiers.iter().zip(&top).any(|(t, top)| t.1 > *top), "nothing stepped: {tiers:?}");
}

/// The gem layer ran before the tree and items matured and never again, so a clearly better support
/// (Mirage Archer over Chain on a Lightning Arrow solve, +21% DPS) was never swapped in. The finish swaps supports
/// again on the finished build, past the clock.
#[test]
fn final_support_swap_replaces_a_weak_support() {
    let goal: Goal = serde_json::from_str(MAP_GOAL).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let mut s = Solver::new(fixture("mapping"), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
    let c = s.candidates().unwrap();
    let mut st = s.initial_state(c[0], None, None).unwrap();
    st.main = ["Flicker Strike", "Multistrike", "Fortify", "Close Combat", "Momentum", "Additional Accuracy"].iter().map(|n| find_gem(n).unwrap()).collect();
    s.rebase(&mut st).unwrap();
    let last = st.main.len() - 1;
    // the worst support the last slot could hold
    let score_with = |s: &Solver, g: &'static str| {
        let mut t = st.clone();
        t.main[last] = g;
        let v = s.eval(vec![Cand::Xml(Arc::new(s.render(&t).unwrap()))]).pop().unwrap();
        v.map_or(f64::INFINITY, |v| s.score(&v).0)
    };
    let worst = s.support_candidates().into_iter().filter(|g| !st.main.contains(g)).min_by(|a, b| score_with(&s, a).total_cmp(&score_with(&s, b))).unwrap();
    st.main[last] = worst;
    s.rebase(&mut st).unwrap();
    let before = st.score;
    assert!(s.final_support_swap(&mut st).unwrap(), "no swap found over the worst support");
    assert!(st.score > before + 1e-6 && st.main[last] != worst, "{before} -> {}: {:?}", st.score, st.main);
}
