//! Port of `Classes/PartyTab.lua`'s `Load` + `ParseBuffs` (the `<Party><ImportedBuffs>` blocks) and the
//! consumers in CalcPerform.lua (2997-3120, 3448-3459) / CalcSetup.lua:685 (`partyTab.enemyModList`).
//! `env.partyMembers` = the actor this builds: `modDB` (FLAG mods from "PartyMemberStats"), `output`
//! (numbers from the same block) and the per-type buff tables (`Aura`, `AuraDebuff`, `Curse`, `Warcry`,
//! `Link`, `extraAura`, `otherEffects`, each with a nested `Vaal` table for names starting "Vaal").
//! Not ported: `Curse` (party curses vs the curse limit, CalcPerform.lua:3192+), `AffectedByAuraMod`.
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modparser::flags::{keyword_flag, mod_flag};
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use std::cell::RefCell;
use pom_engine::fxhash::HashMap;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct PartyBuff {
    pub effect_mult: f64,
    pub mods: Vec<Mod>,
    pub is_mark: bool,
}

#[derive(Clone, Debug, Default)]
pub struct PartyData {
    /// `partyMembers.modDB` FLAG mods ("EnemyLightningResistEqualToYours", ...), by name.
    pub member_flags: Vec<String>,
    /// `partyMembers.output` (flat numbers only).
    pub member_output: HashMap<String, f64>,
    /// `actor[type][name]` (non-Vaal) in insertion order.
    pub lists: HashMap<String, Vec<(String, PartyBuff)>>,
    /// `actor[type]["Vaal"][name]`.
    pub vaal: HashMap<String, Vec<(String, PartyBuff)>>,
    /// `partyTab.enemyModList`.
    pub enemy_mods: Vec<Mod>,
    pub curse_limit: Option<f64>,
}

impl PartyData {
    pub fn is_empty(&self) -> bool {
        self.member_flags.is_empty() && self.member_output.is_empty() && self.lists.is_empty() && self.vaal.is_empty() && self.enemy_mods.is_empty()
    }
    pub fn list(&self, ty: &str) -> &[(String, PartyBuff)] {
        self.lists.get(ty).map(|v| v.as_slice()).unwrap_or(&[])
    }
    pub fn vaal_list(&self, ty: &str) -> &[(String, PartyBuff)] {
        self.vaal.get(ty).map(|v| v.as_slice()).unwrap_or(&[])
    }
    pub fn member_flag(&self, name: &str) -> bool {
        self.member_flags.iter().any(|f| f == name)
    }
    /// `allyBuffs["Aura"][name].effectMult` (non-Vaal `Aura` table, or its `Vaal` sub-table).
    pub fn aura_effect(&self, name: &str) -> Option<f64> {
        let list = if name.starts_with("Vaal") { self.vaal_list("Aura") } else { self.list("Aura") };
        list.iter().find(|(n, _)| n == name).map(|(_, b)| b.effect_mult)
    }
    pub fn aura_debuff_effect(&self, name: &str) -> Option<f64> {
        let list = if name.starts_with("Vaal") { self.vaal_list("AuraDebuff") } else { self.list("AuraDebuff") };
        list.iter().find(|(n, _)| n == name).map(|(_, b)| b.effect_mult)
    }
}

thread_local! {
    static CURRENT: RefCell<Arc<PartyData>> = RefCell::new(Arc::new(PartyData::default()));
}

pub fn set_current(p: Arc<PartyData>) {
    CURRENT.with(|c| *c.borrow_mut() = p);
}

pub fn current() -> Arc<PartyData> {
    CURRENT.with(|c| c.borrow().clone())
}

fn flag_by_name(n: &str) -> u64 {
    macro_rules! m { ($($x:ident),*) => { match n { $(stringify!($x) => mod_flag::$x,)* _ => 0 } } }
    m!(Attack, Spell, Hit, Dot, Cast, Melee, Area, Projectile, SourceMask, Ailment, MeleeHit, Weapon, Axe, Bow, Claw, Dagger, Mace, Staff, Sword, Wand, Unarmed, Fishing, WeaponMelee, WeaponRanged, Weapon1H, Weapon2H, WeaponMask)
}

fn keyword_by_name(n: &str) -> u64 {
    macro_rules! m { ($($x:ident),*) => { match n { $(stringify!($x) => keyword_flag::$x,)* _ => 0 } } }
    m!(Aura, Curse, Warcry, Movement, Physical, Fire, Cold, Lightning, Chaos, Vaal, Bow, Arrow, Trap, Mine, Totem, Minion, Attack, Spell, Hit, Ailment, Brand, Poison, Bleed, Ignite, PhysicalDot, LightningDot, ColdDot, FireDot, ChaosDot, MatchAll)
}

/// `modLib.parseTags`: comma-separated groups of `/`-separated `name=value` pairs.
fn parse_tags(s: &str) -> Vec<Tag> {
    let mut out = Vec::new();
    if s.is_empty() || s == "-" {
        return out;
    }
    for group in s.split(',') {
        if group.is_empty() {
            continue;
        }
        let mut kind = String::new();
        let mut fields: Vec<(Sym, Value)> = Vec::new();
        for part in group.split('/') {
            if part.is_empty() {
                continue;
            }
            let Some((name, val)) = part.split_once('=') else { continue };
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphabetic()) || val.is_empty() {
                continue;
            }
            let v = if name == "threshold" {
                val.parse::<f64>().map(Value::Num).unwrap_or(Value::Nil)
            } else if val == "true" {
                Value::Bool(true)
            } else {
                Value::Str(Arc::from(val))
            };
            if name == "type" {
                if let Value::Str(s) = &v {
                    kind = s.to_string();
                }
            } else {
                fields.push((Sym::new(name), v));
            }
        }
        out.push(Tag { kind: Sym::new(&kind), fields });
    }
    out
}

/// `modLib.parseFormattedSourceMod`.
pub fn parse_formatted_source_mod(line: &str) -> Option<Mod> {
    let mut parts: Vec<&str> = line.split('|').collect();
    parts.push("");
    if parts.len() < 4 {
        return None;
    }
    let value = if parts[0] == "true" { Value::Bool(true) } else { Value::Num(parts[0].trim().parse::<f64>().unwrap_or(0.0)) };
    let ty = ModType::parse(parts[3])?;
    let get = |i: usize| parts.get(i).copied().unwrap_or("");
    Some(Mod {
        name: Sym::new(parts[2]),
        ty,
        value,
        flags: flag_by_name(get(4)),
        keyword_flags: keyword_by_name(get(5)),
        source: Some(Arc::from(parts[1])),
        tags: (parse_tags(get(6))).into(),
    })
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn lines_of(text: &str) -> Vec<&str> {
    // Upstream's XML reader trims the text node but keeps inner "\r" of CRLF files, so lines of a CRLF build
    // end in "\r" (which is why such builds' `---` dividers, flags and effect types never match).
    text.trim().split('\n').collect()
}

fn parse_buffs(data: &mut PartyData, buf: &str, buff_type: &str) {
    let mut mode = if buff_type == "Curse" { "CurseLimit" } else { "Name" };
    let mut current_name = String::new();
    let mut current_effect = 0.0f64;
    let mut is_mark = false;
    let mut current_mod_type: String = match buff_type {
        "Link" => "Link".into(),
        "Warcry" => "Warcry".into(),
        _ => "Unknown".into(),
    };
    for line in lines_of(buf) {
        if line != "---" && line.contains("---") {
            // comment
        } else if mode == "CurseLimit" && !line.is_empty() {
            data.curse_limit = line.trim().parse::<f64>().ok();
            mode = "Name";
        } else if mode == "Name" && !line.is_empty() {
            current_name = line.replace("_Debuff", "");
            current_effect = 0.0;
            if line == "extraAura" || line == "otherEffects" {
                current_mod_type = line.to_string();
                mode = "Stats";
            } else {
                mode = "Effect";
                current_mod_type = "Unknown".into();
            }
        } else if mode == "Effect" {
            current_effect = line.trim().parse::<f64>().unwrap_or(0.0);
            mode = if buff_type == "Curse" { "isMark" } else { "Stats" };
        } else if mode == "isMark" {
            is_mark = line == "true";
            mode = "Stats";
        } else if line == "---" {
            mode = "Name";
        } else if line.contains('|') && current_name != "SKIP" && !line.contains("MinionModifier|LIST") {
            let mut line = line.to_string();
            if current_mod_type == "otherEffects" {
                // `([%w ']-%w+)|(%w+)|(.+)`
                let mut it = line.splitn(3, '|');
                let (Some(n), Some(e), Some(rest)) = (it.next(), it.next(), it.next()) else { continue };
                if n.is_empty() || !n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b' ' || b == b'\'') || e.is_empty() || !e.bytes().all(|b| b.is_ascii_alphanumeric()) {
                    continue;
                }
                current_name = n.to_string();
                current_effect = e.parse::<f64>().unwrap_or(0.0);
                line = rest.to_string();
            }
            let Some(mut m) = parse_formatted_source_mod(&line) else { continue };
            for t in &m.tags {
                if t.kind.as_str() == "GlobalEffect" && current_mod_type != "Link" && current_mod_type != "Warcry" && current_mod_type != "otherEffects" {
                    if let Value::Str(s) = t.get(pom_engine::sym!("effectType")) {
                        current_mod_type = s.to_string();
                    }
                }
            }
            let vaal = current_name.starts_with("Vaal");
            let table = if vaal { data.vaal.entry(current_mod_type.clone()).or_default() } else { data.lists.entry(current_mod_type.clone()).or_default() };
            let idx = table.iter().position(|(n, _)| *n == current_name);
            match idx {
                None => {
                    table.push((current_name.clone(), PartyBuff { effect_mult: current_effect, mods: Vec::new(), is_mark }));
                }
                Some(i) => {
                    if table[i].1.effect_mult != current_effect {
                        if table[i].1.effect_mult < current_effect {
                            table[i] = (current_name.clone(), PartyBuff { effect_mult: current_effect, mods: Vec::new(), is_mark });
                        } else {
                            current_name = "SKIP".into();
                        }
                    }
                }
            }
            if current_name != "SKIP" {
                if let Some(src) = m.source.clone() {
                    if let Some(rest) = src.strip_prefix("Item:").and_then(|r| r.split_once(':')).map(|(_, r)| r) {
                        m.source = Some(Arc::from(format!("Party - {rest}").as_str()));
                    }
                }
                if buff_type == "Link" {
                    m.name = Sym::new(&m.name.as_str().replace("Parent", "PartyMember"));
                    for t in m.tags.iter_mut() {
                        for (k, v) in t.fields.iter_mut() {
                            if k.as_str() == "actor" && matches!(v, Value::Str(s) if s.as_ref() == "parent") {
                                *v = Value::Str(Arc::from("partyMembers"));
                            }
                        }
                    }
                }
                let table = if vaal { data.vaal.get_mut(&current_mod_type).unwrap() } else { data.lists.get_mut(&current_mod_type).unwrap() };
                if let Some((_, b)) = table.iter_mut().find(|(n, _)| *n == current_name) {
                    b.mods.push(m);
                }
            }
        }
    }
}

fn parse_member_stats(data: &mut PartyData, buf: &str) {
    for line in lines_of(buf) {
        if line.contains('=') {
            // `^([%w ]-%w+)%.([%w ]-%w+)=(.+)$` (nested output tables) are not used by any consumer here.
            if let Some((left, v)) = line.split_once('=') {
                if line.contains('|') {
                    // `([%w ]-%w+)|(.+)=(.+)`: name | tags = value
                    let Some((k, tags)) = left.split_once('|') else { continue };
                    let Ok(mut v) = v.trim().parse::<f64>() else { continue };
                    for tag in tags.split('|') {
                        if tag == "percent" {
                            v /= 100.0;
                        } else if tag == "max" {
                            v = v.max(data.member_output.get(k).copied().unwrap_or(1.0));
                        }
                    }
                    data.member_output.insert(k.to_string(), v);
                } else if left.contains('.') {
                    // `^([%w ]-%w+)%.([%w ]-%w+)=(.+)$`: `actor.output[k1][k2] = v` (e.g. `MainHand.CritChance`), kept flat.
                    if let Ok(v) = v.trim().parse::<f64>() {
                        data.member_output.insert(left.to_string(), v);
                    }
                } else if let Ok(v) = v.trim().parse::<f64>() {
                    data.member_output.insert(left.to_string(), v);
                }
            }
        } else if !line.is_empty() {
            data.member_flags.push(line.to_string());
        }
    }
}

pub fn parse_party(xml_text: &str) -> PartyData {
    pom_skills::xmlskills::memo_sections("parse_party", xml_text, &["Party"], || parse_party_inner(xml_text))
}

fn parse_party_inner(xml_text: &str) -> PartyData {
    let mut data = PartyData::default();
    // Raw slicing (not roxmltree): an XML parser normalises "\r\n" to "\n", upstream's reader does not.
    let Some(pstart) = xml_text.find("<Party") else { return data };
    let Some(pend) = xml_text[pstart..].find("</Party>") else { return data };
    let party = &xml_text[pstart..pstart + pend];
    let mut rest = party;
    let mut blocks: Vec<(String, String)> = Vec::new();
    while let Some(i) = rest.find("<ImportedBuffs") {
        rest = &rest[i + "<ImportedBuffs".len()..];
        let Some(gt) = rest.find('>') else { break };
        let attrs = &rest[..gt];
        let self_closing = attrs.trim_end().ends_with('/');
        let name = attrs.split("name=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or("").to_string();
        rest = &rest[gt + 1..];
        if self_closing {
            continue;
        }
        let Some(end) = rest.find("</ImportedBuffs>") else { break };
        blocks.push((unescape(&name), unescape(&rest[..end])));
        rest = &rest[end..];
    }
    for (name, text) in blocks {
        match name.as_str() {
            "PartyMemberStats" => parse_member_stats(&mut data, &text),
            "Aura" => parse_buffs(&mut data, &text, "Aura"),
            "Curse" => parse_buffs(&mut data, &text, "Curse"),
            "Warcry Skills" => parse_buffs(&mut data, &text, "Warcry"),
            "Link Skills" => parse_buffs(&mut data, &text, "Link"),
            "EnemyConditions" => {
                for line in lines_of(&text) {
                    if !line.is_empty() {
                        data.enemy_mods.push(Mod { name: Sym::new(&line.replace("Condition:", "Condition:Party:")), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(Arc::from("Party")), tags: (Vec::new()).into() });
                    }
                }
            }
            "EnemyMods" => {
                for line in lines_of(&text) {
                    if !line.contains('|') {
                        continue;
                    }
                    if let Some(mut m) = parse_formatted_source_mod(line) {
                        m.source = Some(Arc::from(format!("Party{}", m.source.as_deref().unwrap_or("")).as_str()));
                        data.enemy_mods.push(m);
                    }
                }
            }
            _ => {}
        }
    }
    data
}
