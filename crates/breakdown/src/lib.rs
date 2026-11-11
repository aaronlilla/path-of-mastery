//! Rust port of the upstream Calcs-tab breakdown layer (`Modules/CalcSections.lua`, `CalcBreakdown.lua`,
//! `CalcFormat.lua`, and the row-driving parts of `Classes/CalcsTab.lua`/`CalcSectionControl.lua`
//! they need).
pub mod checkflag;
pub mod format;
pub mod modifier;
pub mod modmatch;
pub mod popup;
pub mod record;
pub mod render;
pub mod sections;
pub mod sym;
pub mod value;
