//! Calculation engine: a Rust port of the upstream Lua calculation code,
//! graded stat-for-stat against the original on a 3,401-build test set.
pub mod cjson;
pub mod env;
pub mod fxhash;
pub mod mmap;
pub mod sym;
pub mod value;
pub mod modifier;
pub mod data;
pub mod luapat;
pub mod modparser;
pub mod modstore;
