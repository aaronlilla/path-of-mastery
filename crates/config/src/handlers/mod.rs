//! Mechanical ports of ConfigOptions.lua's apply handlers, split into 9 files by source line
//! range (each ~55-60 handlers) purely to keep any single file's LLVM codegen fast. `enemyIsBoss`,
//! `presetBossSkills`, `enemySizePreset` and the 8 `MapPrefix*`/`MapSuffix*` options are NOT here;
//! see `crate::specials`.
pub mod batch01;
pub mod batch02;
pub mod batch03;
pub mod batch04;
pub mod batch05;
pub mod batch06;
pub mod batch07;
pub mod batch08;
pub mod batch09;

pub fn register_all(map: &mut crate::HandlerMap) {
    batch01::register(map);
    batch02::register(map);
    batch03::register(map);
    batch04::register(map);
    batch05::register(map);
    batch06::register(map);
    batch07::register(map);
    batch08::register(map);
    batch09::register(map);
}
