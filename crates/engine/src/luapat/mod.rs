//! Lua 5.1/LuaJIT string-library semantics needed by the ModParser port: pattern matching
//! (find/match/gmatch/gsub), string.format, and tonumber. Byte-based throughout.
pub mod pattern;
pub mod format;
pub mod numeric;

pub use pattern::{find, gmatch, gsub, lmatch, Cap, FindResult, GMatch, PatError, Repl};
pub use format::format;
pub use numeric::{fmtnum14g, tonumber};
