// Port of ModParser.lua lines 6096-6146: the `for gemId, gemData in pairs(data.gems) do ... end`
// loop that builds skillNameList/preSkillNameList (6096-6123, `build()` below) and, per skill tag
// (mine/trap/chaining/bow/projectile), injects per-gem specialModList entries (6124-6146,
// `build_gem_specials()` below).
use super::flags::keyword_flag as kf;
use super::special::support::{b, kw, mk_mod, num, s, stag, tg, wrap, SpecialArgs, SpecialVal};
use super::support::Entry;
use super::types::{tag, PMod, PVal};
use crate::data::GameData;
use crate::value::Value;
use std::path::Path;
use std::sync::OnceLock;

fn game_data() -> &'static GameData {
    crate::data::shared()
}

fn skill_name_entry(name: &str) -> Entry {
    Entry {
        tag: Some(tag("SkillName", vec![("skillName", Value::Str(name.into())), ("includeTransfigured", Value::Bool(true))])),
        ..Default::default()
    }
}

fn condition_entry(var: String) -> Entry {
    Entry { tag: Some(tag("Condition", vec![("var", Value::Str(var.into()))])), ..Default::default() }
}

fn buff_grant_entry(name: &str) -> Entry {
    Entry {
        add_to_skill: Some(tag("SkillName", vec![("skillName", Value::Str(name.into())), ("includeTransfigured", Value::Bool(true))])),
        tag: Some(tag("GlobalEffect", vec![("effectType", Value::Str("Buff".into()))])),
        ..Default::default()
    }
}

pub fn build() -> (Vec<(String, Entry)>, Vec<(String, Entry)>) {
    let mut skill_name_list: Vec<(String, Entry)> =
        vec![(" corpse cremation ".to_string(), skill_name_entry("Cremation"))];
    let mut pre_skill_name_list: Vec<(String, Entry)> = Vec::new();

    let gd = game_data();
    // Iterate in a stable (sorted by gem id) order so ties resolve the same way every run, as
    // close an approximation to Lua's `table.sort(skillIds)` as this port needs.
    let mut ids: Vec<&String> = gd.gems.keys().collect();
    ids.sort();
    for id in ids {
        let gem = &gd.gems[id];
        let Some(ge) = &gem.granted_effect else { continue };
        let hidden = ge.extra.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
        let support = ge.extra.get("support").and_then(|v| v.as_bool()).unwrap_or(false);
        if hidden || support {
            continue;
        }
        let name = ge.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let lower = name.to_lowercase();

        skill_name_list.push((format!(" {} ", lower), skill_name_entry(&name)));
        pre_skill_name_list.push((format!("^{} ", lower), skill_name_entry(&name)));
        pre_skill_name_list.push((format!("^{} has ?a? ", lower), skill_name_entry(&name)));
        pre_skill_name_list.push((format!("^{} deals ", lower), skill_name_entry(&name)));
        pre_skill_name_list.push((format!("^{} damage ", lower), skill_name_entry(&name)));

        if gem.tags.get("totem").copied().unwrap_or(false) {
            pre_skill_name_list.push((format!("^{} totem deals ", lower), skill_name_entry(&name)));
            pre_skill_name_list.push((format!("^{} totem grants ", lower), buff_grant_entry(&name)));
        }

        let skill_type_buff = ge
            .extra
            .get("skillTypes")
            .and_then(|v| v.get("5")) // SkillType.Buff == 5
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let base_flags_buff = ge.extra.get("baseFlags").and_then(|v| v.get("buff")).and_then(|v| v.as_bool()).unwrap_or(false);
        if skill_type_buff || base_flags_buff {
            pre_skill_name_list.push((format!("^{} grants ", lower), buff_grant_entry(&name)));
            pre_skill_name_list.push((format!("^{} grants a?n? ?additional ", lower), buff_grant_entry(&name)));
        }

        if gem.tags.get("aura").copied().unwrap_or(false) || gem.tags.get("herald").copied().unwrap_or(false) {
            let var = format!("AffectedBy{}", name.replace(' ', ""));
            skill_name_list.push((format!("while affected by {}", lower), condition_entry(var.clone())));
            skill_name_list.push((format!("while using {}", lower), condition_entry(var)));
        }

        if gem.tags.get("curse").copied().unwrap_or(false) {
            // Lua: skillName:gsub("^%l", string.upper):gsub(" %l", string.upper):gsub(" ", "")
            // -- title-cases the first letter of every word, then strips all spaces.
            let var = format!("SelfCast{}", super::special::support::title_case(&name).replace(' ', ""));
            skill_name_list.push((format!("if you've cast {} in the past (%d+) seconds", lower), condition_entry(var)));
        }
    }

    (skill_name_list, pre_skill_name_list)
}

fn skill_tag(skill: &str) -> PVal {
    stag("SkillName", vec![("skillName", s(skill.to_string())), ("includeTransfigured", b(true))])
}

fn gem_mine_speed(skill: &str, a: &SpecialArgs) -> Option<Vec<PMod>> {
    Some(vec![wrap("ExtraSkillMod", mk_mod("MineLayingSpeed", "INC", num(a.n(1)), vec![]), vec![tg(skill_tag(skill))])])
}
fn gem_trap_speed(skill: &str, a: &SpecialArgs) -> Option<Vec<PMod>> {
    Some(vec![wrap("ExtraSkillMod", mk_mod("TrapThrowingSpeed", "INC", num(a.n(1)), vec![]), vec![tg(skill_tag(skill))])])
}
fn gem_chains_additional_n(skill: &str, a: &SpecialArgs) -> Option<Vec<PMod>> {
    Some(vec![wrap("ExtraSkillMod", mk_mod("ChainCountMax", "BASE", num(a.n(1)), vec![]), vec![tg(skill_tag(skill))])])
}
fn gem_fires_additional_arrows_n(skill: &str, a: &SpecialArgs) -> Option<Vec<PMod>> {
    Some(vec![wrap("ExtraSkillMod", mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![kw(kf::Arrow)]), vec![tg(skill_tag(skill))])])
}
fn gem_pierces_additional_n(skill: &str, a: &SpecialArgs) -> Option<Vec<PMod>> {
    Some(vec![mk_mod("PierceCount", "BASE", num(a.n(1)), vec![tg(skill_tag(skill))])])
}
fn gem_fires_additional_projectiles_n(skill: &str, a: &SpecialArgs) -> Option<Vec<PMod>> {
    Some(vec![wrap("ExtraSkillMod", mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![]), vec![tg(skill_tag(skill))])])
}

/// Port of ModParser.lua lines 6124-6146: the per-gem-tag specialModList entries injected inside
/// the same `for gemId, gemData in pairs(data.gems) do ... end` loop as `build()` above. These are
/// added to Lua's specialModList *after* its one-time `^...$` anchoring pass (lines 5949-5953), so
/// unlike every other specialModList entry they carry only the anchor characters written directly
/// into their own pattern text (a leading `^`, no trailing `$`, and none at all for the
/// trap-throwing-speed pattern) -- callers must not blanket-anchor these the way `special::entries`
/// does for everything else.
pub fn build_gem_specials() -> Vec<(String, SpecialVal)> {
    use SpecialVal::{Mods, SkillFunc};
    let mut v: Vec<(String, SpecialVal)> = Vec::new();
    let gd = game_data();
    let mut ids: Vec<&String> = gd.gems.keys().collect();
    ids.sort();
    for id in ids {
        let gem = &gd.gems[id];
        let Some(ge) = &gem.granted_effect else { continue };
        let hidden = ge.extra.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
        let support = ge.extra.get("support").and_then(|v| v.as_bool()).unwrap_or(false);
        if hidden || support {
            continue;
        }
        let name = ge.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let lower = name.to_lowercase();
        let is_bow = gem.tags.get("bow").copied().unwrap_or(false);
        let is_projectile = gem.tags.get("projectile").copied().unwrap_or(false);

        if gem.tags.get("mine").copied().unwrap_or(false) {
            v.push((format!("^{} has (%d+)%% increased throwing speed", lower), SkillFunc(name.clone(), gem_mine_speed)));
        }
        if gem.tags.get("trap").copied().unwrap_or(false) {
            v.push((format!("(%d+)%% increased {} throwing speed", lower), SkillFunc(name.clone(), gem_trap_speed)));
        }
        if gem.tags.get("chaining").copied().unwrap_or(false) {
            v.push((
                format!("^{} chains an additional time", lower),
                Mods(vec![wrap("ExtraSkillMod", mk_mod("ChainCountMax", "BASE", num(1.0), vec![]), vec![tg(skill_tag(&name))])]),
            ));
            v.push((format!("^{} chains an additional (%d+) times", lower), SkillFunc(name.clone(), gem_chains_additional_n)));
            v.push((format!("^{} chains (%d+) additional times", lower), SkillFunc(name.clone(), gem_chains_additional_n)));
        }
        if is_bow {
            v.push((
                format!("^{} fires an additional arrow", lower),
                Mods(vec![wrap("ExtraSkillMod", mk_mod("ProjectileCount", "BASE", num(1.0), vec![kw(kf::Arrow)]), vec![tg(skill_tag(&name))])]),
            ));
            v.push((format!("^{} fires (%d+) additional arrows?", lower), SkillFunc(name.clone(), gem_fires_additional_arrows_n)));
        }
        if is_projectile {
            v.push((
                format!("^{} pierces an additional target", lower),
                Mods(vec![mk_mod("PierceCount", "BASE", num(1.0), vec![tg(skill_tag(&name))])]),
            ));
            v.push((format!("^{} pierces (%d+) additional targets?", lower), SkillFunc(name.clone(), gem_pierces_additional_n)));
        }
        if is_bow || is_projectile {
            v.push((
                format!("^{} fires an additional projectile", lower),
                Mods(vec![wrap("ExtraSkillMod", mk_mod("ProjectileCount", "BASE", num(1.0), vec![]), vec![tg(skill_tag(&name))])]),
            ));
            v.push((format!("^{} fires (%d+) additional projectiles", lower), SkillFunc(name.clone(), gem_fires_additional_projectiles_n)));
            v.push((format!("^{} fires (%d+) additional shard projectiles", lower), SkillFunc(name.clone(), gem_fires_additional_projectiles_n)));
        }
    }
    v
}
