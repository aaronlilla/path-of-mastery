//! Port of Modules/CalcTools.lua's pure functions - the ones that don't need a live
//! `ActiveSkill`/`GrantedEffect` object graph (that graph isn't modeled in this crate yet).
//! `calcLib.gemIsType` is not here: it's already ported as
//! `pom_engine::modstore::types::GemInfo::is_type`, verbatim, for ModStore's own tag matching.
use crate::data::game_data;
use pom_engine::modstore::{Cfg, ModStore};
use pom_engine::sym::Sym;

/// `calcLib.mod(modStore, cfg, ...)`: combined INC/MORE multiplier for the given mod names.
pub fn mod_(store: &ModStore, cfg: Option<&Cfg>, names: &[Sym]) -> f64 {
    (1.0 + store.sum(pom_engine::modifier::ModType::Inc, cfg, names) / 100.0) * store.more(cfg, names)
}

/// `calcLib.mods(modStore, cfg, ...)`: returns (increased, more) separately.
pub fn mods(store: &ModStore, cfg: Option<&Cfg>, names: &[Sym]) -> (f64, f64) {
    (1.0 + store.sum(pom_engine::modifier::ModType::Inc, cfg, names) / 100.0, store.more(cfg, names))
}

/// `calcLib.val(modStore, name, cfg)`: `0` when the BASE sum is `0` (skips the INC/MORE
/// multiplication in that case, same as the Lua, so a mod with a 0 base value never contributes a
/// nonzero result purely from a MORE multiplier).
pub fn val(store: &ModStore, name: Sym, cfg: Option<&Cfg>) -> f64 {
    let base = store.sum(pom_engine::modifier::ModType::Base, cfg, &[name]);
    if base != 0.0 {
        base * mod_(store, cfg, &[name])
    } else {
        0.0
    }
}

/// One entry of a `SkillType` postfix expression: either a literal type id to look up, or one of
/// the three postfix operators.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TypeExprTok {
    Type(i64),
    Or,
    And,
    Not,
}

/// `calcLib.doesTypeExpressionMatch(checkTypes, skillTypes, minionTypes)`: evaluates a
/// postfix-notation boolean expression over a skill's (and optionally its minion's) SkillType
/// set. `skill_types`/`minion_types` are `activeSkill.skillTypes`-style sets (present = true).
pub fn does_type_expression_match(check_types: &[TypeExprTok], skill_types: &[i64], minion_types: Option<&[i64]>) -> bool {
    let mut stack: Vec<bool> = Vec::new();
    for tok in check_types {
        match tok {
            TypeExprTok::Or => {
                let other = stack.pop().unwrap_or(false);
                if let Some(top) = stack.last_mut() {
                    *top = *top || other;
                } else {
                    stack.push(other);
                }
            }
            TypeExprTok::And => {
                let other = stack.pop().unwrap_or(false);
                if let Some(top) = stack.last_mut() {
                    *top = *top && other;
                } else {
                    stack.push(false);
                }
            }
            TypeExprTok::Not => {
                if let Some(top) = stack.last_mut() {
                    *top = !*top;
                } else {
                    stack.push(true);
                }
            }
            TypeExprTok::Type(id) => {
                let present = skill_types.contains(id) || minion_types.map(|mt| mt.contains(id)).unwrap_or(false);
                stack.push(present);
            }
        }
    }
    stack.iter().any(|v| *v)
}

/// In-game formula for a gem's attribute (Str/Dex/Int) requirement at a given level.
/// `calcLib.getGemStatRequirement(level, isSupport, multi)`.
pub fn get_gem_stat_requirement(level: f64, is_support: bool, multi: f64) -> f64 {
    if multi == 0.0 {
        return 0.0;
    }
    let stat_type = if is_support { 0.5 } else { 0.7 };
    let req = round_half_up((20.0 + (level - 3.0) * 3.0) * (multi / 100.0).powf(0.9) * stat_type);
    if req < 14.0 {
        0.0
    } else {
        req
    }
}

/// Lua's global `round(val)` (Modules/Common.lua): `math.floor(val + 0.5)`, unconditionally (not
/// symmetric around zero; that's the separate `roundSymmetric`, unused here).
fn round_half_up(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// `calcLib.getGameIdFromGemName(gemName, dropVaal)`: `None` for anything not resolvable
/// (unknown name, or the "isn't actually a gem name" case the Lua signals by returning nil).
pub fn get_game_id_from_gem_name(gem_name: &str, drop_vaal: bool) -> Option<String> {
    let gd = game_data();
    let for_base_name = gd.extra.get("gemForBaseName").ok().flatten()?;
    let gem_id = for_base_name.get(gem_name.to_lowercase())?.as_str()?.to_string();
    let gem = gd.gems.get(&gem_id)?;
    if drop_vaal && gem.vaal_gem {
        let vaal_map = gd.extra.get("gemVaalGemIdForBaseGemId").ok().flatten()?;
        let vaal_id = vaal_map.get(&gem_id)?.as_str()?;
        gd.gems.get(vaal_id)?.game_id.clone()
    } else {
        gem.game_id.clone()
    }
}

/// `calcLib.isGemIdSame(gemName, typeName, dropVaal)`.
pub fn is_gem_id_same(gem_name: &str, type_name: &str, drop_vaal: bool) -> bool {
    match (get_game_id_from_gem_name(gem_name, drop_vaal), get_game_id_from_gem_name(type_name, drop_vaal)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}
