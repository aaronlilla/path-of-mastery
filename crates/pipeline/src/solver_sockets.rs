//! Sockets on the items that hold the build's gems: which item each skill group sits in, the `Sockets:` line written
//! on every socketed item (link sizes and colours as the gems need them), and what the colours and sockets cost
//! (Chromatic and Jeweller's Orbs, `Wealth::sockets_divines`).
use super::*;

/// Colour of a gem socket for the gem: its highest attribute requirement (R Str, G Dex, B Int; W for none).
pub(super) fn gem_colour(id: &str) -> char {
    let Some(g) = gd::game_data().gems.get(id) else { return 'W' };
    if g.req_str <= 0.0 && g.req_dex <= 0.0 && g.req_int <= 0.0 {
        'W'
    } else if g.req_str >= g.req_dex && g.req_str >= g.req_int {
        'R'
    } else if g.req_dex >= g.req_int {
        'G'
    } else {
        'B'
    }
}

/// Expected Chromatic Orbs to roll `n` sockets that hold at least `need` (R, G, B) given each socket's colour
/// chances `p` (at most `cap`).
pub(super) fn chromatics(n: usize, need: [usize; 3], p: [f64; 3], cap: f64) -> f64 {
    if need.iter().sum::<usize>() > n {
        return cap;
    }
    let fact = |k: usize| (1..=k).product::<usize>() as f64;
    let mut prob = 0.0;
    for a in need[0]..=n {
        for b in need[1]..=(n - a) {
            let c = n - a - b;
            if c >= need[2] {
                prob += fact(n) / (fact(a) * fact(b) * fact(c)) * p[0].powi(a as i32) * p[1].powi(b as i32) * p[2].powi(c as i32);
            }
        }
    }
    if prob <= 0.0 { cap } else { (1.0 / prob - 1.0).clamp(0.0, cap) }
}

/// Socket colour chances of a base from its Str/Dex/Int requirements (weighted by them, each plus 20 so a colour the base
/// does not ask for still turns up: shortcut, the weighting is only described, not published, at poedb.tw/Item_socket).
fn colour_odds(req: [f64; 3]) -> [f64; 3] {
    let w = req.map(|r| r + 20.0);
    let t: f64 = w.iter().sum();
    w.map(|x| x / t)
}

pub(super) struct SocketPlan {
    pub slot: usize,
    /// "R-G-B-B G" form, null when the item already has its own Sockets line.
    pub line: Option<String>,
    pub used: usize,
    pub chromatics: f64,
}

impl Solver {
    /// Every skill group's gems: the main skill's, then each utility entry's (a Wither totem's holds its totem gem).
    pub(super) fn gem_groups(&self, main: &[&'static str], utils: &[&'static str]) -> Vec<Vec<&'static str>> {
        let mut v = vec![main.to_vec()];
        v.extend(utils.iter().map(|u| match self.totem {
            Some(t) if self.totemed(u) => vec![*u, t],
            _ => u.split('+').collect(),
        }));
        v
    }

    /// The item slot (index) each group sits in: the main skill in the longest link, an item that affects socketed gems
    /// first, then the body armour; the others in what sockets are left. An aura goes into an item that makes it a
    /// blessing (timed, pressed) only when no other item has room, so a standing aura stays reachable.
    pub(super) fn assign_groups(&self, gear: &Gear, groups: &[Vec<&'static str>]) -> Vec<Option<usize>> {
        self.group_homes(gear, groups).into_iter().map(|h| h.0).collect()
    }

    /// `assign_groups` with how many of each group's gems its slot holds. Before the bases are chosen a group that fits
    /// nowhere keeps all its gems (the open slots are still to be filled); after (`Gear::ready`) the main skill's group
    /// is cut to the longest link left (its first gems) and any other group holds none.
    pub(super) fn group_homes(&self, gear: &Gear, groups: &[Vec<&'static str>]) -> Vec<(Option<usize>, usize)> {
        let socketed = |i: usize| gear.pieces.get(i).and_then(|p| p.as_ref()).is_some_and(|p| p.xml.contains("Socketed"));
        let blesses = |i: usize| gear.pieces.get(i).and_then(|p| p.as_ref()).is_some_and(super::blessing_item);
        let aura = |g: &[&'static str]| g.iter().any(|id| self.gems.iter().any(|x| x.id == *id && x.kind == Kind::Aura));
        let mut free: Vec<(usize, usize, usize)> = (0..self.slots.len().min(gear.pieces.len()))
            .filter(|&i| matches!(self.slots[i].kind, SlotKind::Weapon1 | SlotKind::Weapon2 | SlotKind::Body | SlotKind::Helmet | SlotKind::Gloves | SlotKind::Boots))
            .map(|i| {
                let (total, link) = self.piece_sockets(gear, i);
                (i, total, link)
            })
            .filter(|x| x.1 > 0)
            .collect();
        groups
            .iter()
            .enumerate()
            .map(|(gi, g)| {
                let (need, by_link, aura) = (g.len(), gi == 0, gi > 0 && aura(g));
                let fit = free.iter().enumerate().filter(|(_, x)| x.1 >= need && (!by_link || x.2 >= need)).max_by_key(|(_, x)| (!(aura && blesses(x.0)), socketed(x.0), self.slots[x.0].kind == SlotKind::Body, x.1)).map(|(k, _)| (k, need));
                let cut = || free.iter().enumerate().filter(|(_, x)| x.2 > 0).max_by_key(|(_, x)| (x.2, socketed(x.0))).map(|(k, x)| (k, x.2));
                let Some((k, n)) = fit.or_else(|| if gear.ready && by_link { cut() } else { None }) else { return (None, if gear.ready { 0 } else { need }) };
                let (i, total, link) = free[k];
                free[k] = (i, total - n, link.min(total - n));
                (Some(i), n)
            })
            .collect()
    }

    /// The Str/Dex/Int requirements of the base an item is made on.
    fn base_reqs(p: &items::Piece) -> [f64; 3] {
        let game = pom_calc::data::game_data();
        let req = p.xml.lines().map(|l| l.trim()).find_map(|l| game.item_bases.get(l)).and_then(|b| b.req.as_ref());
        let r = |k: &str| req.and_then(|m| m.get(k)).copied().unwrap_or(0.0);
        [r("str"), r("dex"), r("int")]
    }

    /// Sockets each socketed item gets for `groups` in `gear`: the line to write and what its colours cost.
    pub(super) fn socket_plan(&self, gear: &Gear, groups: &[Vec<&'static str>]) -> Vec<SocketPlan> {
        let at = self.group_homes(gear, groups);
        let cap = Wealth::chromatic_cap();
        let mut out = Vec::new();
        for i in 0..self.slots.len().min(gear.pieces.len()) {
            if !matches!(self.slots[i].kind, SlotKind::Weapon1 | SlotKind::Weapon2 | SlotKind::Body | SlotKind::Helmet | SlotKind::Gloves | SlotKind::Boots) {
                continue;
            }
            let Some(p) = gear.pieces[i].as_ref() else { continue };
            let total = self.piece_sockets(gear, i).0;
            if total == 0 {
                continue;
            }
            let own = p.xml.lines().any(|l| l.trim().starts_with("Sockets: "));
            let req = Self::base_reqs(p);
            let mut need = [0usize; 3];
            let mut links: Vec<String> = Vec::new();
            let mut used = 0;
            for (gi, g) in groups.iter().enumerate().filter(|(gi, _)| at.get(*gi).is_some_and(|h| h.0 == Some(i))) {
                let cs: Vec<char> = g[..at[gi].1].iter().map(|id| gem_colour(id)).collect();
                for c in &cs {
                    match c {
                        'R' => need[0] += 1,
                        'G' => need[1] += 1,
                        'B' => need[2] += 1,
                        _ => {}
                    }
                }
                used += cs.len();
                links.push(cs.iter().map(|c| c.to_string()).collect::<Vec<_>>().join("-"));
            }
            // (the sockets no gem sits in: unlinked, the colour the base favours)
            let fav = if req[0] >= req[1] && req[0] >= req[2] { 'R' } else if req[1] >= req[2] { 'G' } else { 'B' };
            links.extend(std::iter::repeat_n(fav.to_string(), total.saturating_sub(used)));
            let chromatics = if own { 0.0 } else { chromatics(used, need, colour_odds(req), cap) };
            out.push(SocketPlan { slot: i, line: (!own).then(|| links.join(" ")), used: if own { 0 } else { used }, chromatics });
        }
        out
    }

    /// What the sockets of `gear` cost, in divine orbs, for the groups priced into it (`Gear::groups`).
    pub(super) fn socket_cost(&self, gear: &Gear) -> f64 {
        if gear.groups.is_empty() {
            return 0.0;
        }
        self.socket_plan(gear, &gear.groups).iter().filter(|s| !self.slots[s.slot].locked).map(|s| Wealth::sockets_divines(s.used, s.chromatics)).sum()
    }
}

/// `xml` (an item's text) with `line` as its Sockets line, in front of its Implicits line; a unique's data text has none,
/// so there it goes right after the base name line.
pub(super) fn with_sockets_line(xml: &str, line: &str) -> String {
    let mut out: Vec<String> = xml.lines().map(String::from).collect();
    let bases = &pom_calc::data::game_data().item_bases;
    let at = out.iter().position(|l| l.trim().starts_with("Implicits:")).or_else(|| out.iter().position(|l| bases.contains_key(l.trim().replace("&apos;", "'").as_str())).map(|i| i + 1));
    if let Some(at) = at {
        out.insert(at, format!("Sockets: {line}"));
    }
    out.join("\n")
}
