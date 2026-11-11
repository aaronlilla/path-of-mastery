//! Port of Modules/ConfigOptions.lua's 539 `apply` handlers and Classes/ConfigTab.lua's
//! `BuildModList` (the non-UI parts: XML loading of `<Config>`, config sets, defaults, and the
//! per-option dispatch that turns `configTab.input` into `configTab.modList` / `enemyModList`).
//!
//! Handlers live in `handlers::batchNN` (mechanical ports, one `fn` per option, grouped by their
//! source line range in ConfigOptions.lua) plus `specials` for the handful that read `build`
//! state (`enemyIsBoss`, `presetBossSkills`, `enemySizePreset`) and `mapmods` for the Data/ModMap.lua
//! affix apply functions the 8 `MapPrefix*`/`MapSuffix*` options dispatch into.
pub mod ctx;
pub mod gen;
pub mod handlers;
pub mod helpers;
pub mod mapmods;
pub mod specials;
pub mod types;
pub mod xml;

use ctx::ConfigCtx;
use gen::meta::OPTION_META;
use pom_engine::data::GameData;
use pom_engine::modifier::Mod;
use pom_engine::fxhash::HashMap;
use types::{OptionType, OwnedOptionValue};

pub type Handler = fn(&OwnedOptionValue, &mut ConfigCtx);
pub type HandlerMap = HashMap<&'static str, Handler>;

pub fn build_handler_map() -> HandlerMap {
    let mut m = HashMap::default();
    handlers::register_all(&mut m);
    specials::register(&mut m);
    m
}

/// `build_handler_map`, built once per process.
pub fn handler_map() -> &'static HandlerMap {
    static MAP: std::sync::OnceLock<HandlerMap> = std::sync::OnceLock::new();
    MAP.get_or_init(build_handler_map)
}

/// Port of `ConfigTabClass:BuildModList` (minus the custom-modifier-block parsing, which callers
/// handle separately with `pom_engine::modparser::parse_mod` — see `xml::apply_custom_mods`).
///
/// `input`/`placeholder` should be the config set's fully resolved maps (construction defaults
/// already overlaid with any `<Input>`/`<Placeholder>` XML values); see `xml::load_config_set`.
/// Passing back a previously-produced *output* `placeholder` (e.g. from a golden recording) as
/// the next call's input is also valid: the three handlers that mutate placeholder mid-pass
/// (`enemyIsBoss`, `presetBossSkills`, `enemySizePreset`) are idempotent fixed points, matching
/// why upstream harness calls `OnFrame` twice before treating a build as settled.
pub fn build_mod_list(
    input: &HashMap<String, OwnedOptionValue>,
    placeholder: HashMap<String, OwnedOptionValue>,
    game: &GameData,
    character_level: i64,
    handlers: &HandlerMap,
) -> (Vec<Mod>, Vec<Mod>, HashMap<String, OwnedOptionValue>) {
    let mut ctx = ConfigCtx::new(input, placeholder, game, character_level);
    for meta in OPTION_META.iter() {
        let Some(handler) = handlers.get(meta.var) else { continue };
        match meta.ty {
            OptionType::Check => {
                let truthy = ctx.get_input(meta.var).map(|v| v.as_bool()).unwrap_or(false);
                if truthy {
                    handler(&OwnedOptionValue::Bool(true), &mut ctx);
                }
            }
            OptionType::Count | OptionType::Integer | OptionType::Float | OptionType::CountAllowZero => {
                let allow_zero = meta.ty == OptionType::CountAllowZero;
                let from_input = ctx.get_input(meta.var).cloned();
                let fire_input = from_input.as_ref().is_some_and(|v| allow_zero || v.as_f64() != 0.0);
                if fire_input {
                    let v = from_input.unwrap();
                    handler(&v, &mut ctx);
                } else if let Some(v) = ctx.placeholder.get(meta.var).cloned() {
                    if allow_zero || v.as_f64() != 0.0 {
                        handler(&v, &mut ctx);
                    }
                }
            }
            OptionType::List => {
                if let Some(v) = ctx.get_input(meta.var).cloned() {
                    handler(&v, &mut ctx);
                }
            }
        }
    }
    (ctx.mods, ctx.enemy, ctx.placeholder)
}
