// All ModParser.lua static tables, built once and reused across every parse call.
use super::gen_flags::build_mod_flag_list;
use super::gen_formlist::build_form_list;
use super::gen_names::build_mod_name_list;
use super::gen_small::{
    build_base_cost_types, build_cost_types, build_degen_types, build_dmg_types, build_flag_types,
    build_pen_types, build_regen_types, build_suffix_types, build_unsupported_mod_list, FlagVal,
    ResValOwned,
};
use super::modtag::{self, ModTagVal};
use super::preflag::{self, PreFlagVal};
use super::special::{self, SpecialVal};
use super::support::Entry;
use super::types::PMod;
use crate::fxhash::HashMap;
use std::sync::OnceLock;

pub struct Tables {
    pub form_list: Vec<(&'static str, &'static str)>,
    pub name_list: Vec<(&'static str, Entry)>,
    pub flag_list: Vec<(&'static str, Entry)>,
    pub pre_flag_list: Vec<(&'static str, PreFlagVal)>,
    pub mod_tag_list: Vec<(&'static str, ModTagVal)>,
    pub suffix_types: Vec<(&'static str, &'static str)>,
    pub pen_types: Vec<(&'static str, &'static str)>,
    pub flag_types: Vec<(&'static str, FlagVal)>,
    pub dmg_types: Vec<(&'static str, &'static str)>,
    pub unsupported: Vec<&'static str>,
    pub regen_types: Vec<(String, ResValOwned)>,
    pub degen_types: Vec<(String, ResValOwned)>,
    pub cost_types: Vec<(String, ResValOwned)>,
    pub base_cost_types: Vec<(String, ResValOwned)>,
    /// Active-skill-name lookup, built from `data.gems` (see skill_names.rs).
    pub skill_name_list: Vec<(String, Entry)>,
    pub pre_skill_name_list: Vec<(String, Entry)>,
    pub special_mod_list: Vec<(String, SpecialVal)>,
    /// Direct (non-pattern) lowercase whole-line lookup, built from data.clusterJewels (see
    /// cluster_jewels.rs).
    pub cluster_jewel_skills: HashMap<String, Vec<PMod>>,
}

pub fn get() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
    let skill_name_list_pair = super::skill_names::build();
    Tables {
        form_list: build_form_list(),
        name_list: build_mod_name_list(),
        flag_list: build_mod_flag_list(),
        pre_flag_list: preflag::build(),
        mod_tag_list: modtag::build(),
        suffix_types: build_suffix_types(),
        pen_types: build_pen_types(),
        flag_types: build_flag_types(),
        dmg_types: build_dmg_types(),
        unsupported: build_unsupported_mod_list(),
        regen_types: build_regen_types(),
        degen_types: build_degen_types(),
        cost_types: build_cost_types(),
        base_cost_types: build_base_cost_types(),
        skill_name_list: skill_name_list_pair.0,
        pre_skill_name_list: skill_name_list_pair.1,
        special_mod_list: special::entries(),
        cluster_jewel_skills: super::cluster_jewels::build(),
    }})
}
