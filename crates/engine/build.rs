// Fingerprints this crate's source so a saved parse cache (engine-data/parse_cache.bin) written by one build of
// the parser is never served by a different one: see `modparser::parse::parse_cache_fingerprint`.
use std::path::Path;

fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() { walk(&p, out) } else if p.extension().is_some_and(|x| x == "rs") { out.push(p) }
    }
}

fn main() {
    let mut files = Vec::new();
    walk(Path::new("src"), &mut files);
    files.sort();
    let mut h: u64 = 0xcbf29ce484222325;
    for f in &files {
        let rel = f.to_string_lossy().replace('\\', "/");
        // Line endings don't count: the same source checked out with CRLF (git autocrlf) or LF gets one fingerprint.
        let bytes: Vec<u8> = std::fs::read(f).unwrap_or_default().into_iter().filter(|&b| b != 13u8).collect();
        // Text rules run after the parse and its caches (modparser/text_rules.rs): that file and its hook lines (marked
        // "// fp-skip") never change a cached parse, so they leave the fingerprint, and a saved cache, as it was.
        if rel.ends_with("modparser/text_rules.rs") {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let bytes: Vec<u8> = text.split('\n').filter(|l| !l.trim_end().ends_with("// fp-skip")).collect::<Vec<_>>().join("\n").into_bytes();
        for b in rel.bytes().chain(bytes) {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    println!("cargo:rustc-env=POM_ENGINE_SRC_FP={h:016x}");
    println!("cargo:rerun-if-changed=src");
}
