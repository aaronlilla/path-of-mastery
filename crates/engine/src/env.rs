//! The engine's debug switches read environment variables in hot code (some once per skill). `std::env::var` locks
//! and copies the environment on every call, so these read each variable once per thread and keep the answer.
//! `POM_BUILD_NAME` is changed between builds by pom-cli and is always read live.
use crate::fxhash::HashMap;
use std::cell::RefCell;

fn cached(name: &str) -> Option<&'static str> {
    thread_local! {
        static CACHE: RefCell<HashMap<String, Option<&'static str>>> = RefCell::new(HashMap::default());
    }
    if let Some(v) = CACHE.with(|c| c.borrow().get(name).copied()) {
        return v;
    }
    let v = std::env::var(name).ok().map(|s| &*Box::leak(s.into_boxed_str()));
    CACHE.with(|c| c.borrow_mut().insert(name.to_string(), v));
    v
}

pub fn var(name: impl AsRef<str>) -> Result<String, std::env::VarError> {
    let name = name.as_ref();
    if name == "POM_BUILD_NAME" {
        return std::env::var(name);
    }
    cached(name).map(|s| s.to_string()).ok_or(std::env::VarError::NotPresent)
}

pub fn var_os(name: impl AsRef<str>) -> Option<std::ffi::OsString> {
    let name = name.as_ref();
    if name == "POM_BUILD_NAME" {
        return std::env::var_os(name);
    }
    cached(name).map(|s| s.into())
}
