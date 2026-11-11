use super::gen_modtag::build_mod_tag_list_data;
use super::modtag_funcs::{build_all, TagArgs, TagFn};
use super::support::Entry;

pub enum ModTagVal {
    Data(Entry),
    Func(TagFn),
}

pub fn build() -> Vec<(&'static str, ModTagVal)> {
    let mut out: Vec<(&'static str, ModTagVal)> =
        build_mod_tag_list_data().into_iter().map(|(k, v)| (k, ModTagVal::Data(v))).collect();
    out.extend(build_all().into_iter().map(|(k, f)| (k, ModTagVal::Func(f))));
    out
}

pub fn call(v: &ModTagVal, caps: [Option<&str>; 5]) -> Entry {
    match v {
        ModTagVal::Data(e) => e.clone(),
        ModTagVal::Func(f) => f(&TagArgs { c: caps }),
    }
}
