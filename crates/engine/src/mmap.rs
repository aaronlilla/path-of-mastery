//! Read-only memory-mapped files. The compact data files and the timeless jewel tables are only read, so mapping
//! them lets the OS page them in from disk (and drop them again) instead of each process holding a private copy.
//! Off Windows the file is read into memory instead.

/// A file's bytes for the rest of the process.
pub fn map_static(path: &std::path::Path) -> std::io::Result<&'static [u8]> {
    imp::map(path)
}

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    extern "system" {
        fn CreateFileW(name: *const u16, access: u32, share: u32, sa: *mut u8, disposition: u32, flags: u32, template: isize) -> isize;
        fn CreateFileMappingW(file: isize, sa: *mut u8, protect: u32, size_high: u32, size_low: u32, name: *const u16) -> isize;
        fn MapViewOfFile(mapping: isize, access: u32, off_high: u32, off_low: u32, bytes: usize) -> *const u8;
        fn CloseHandle(h: isize) -> i32;
    }
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ_DELETE: u32 = 0x1 | 0x4;
    const OPEN_EXISTING: u32 = 3;
    const PAGE_READONLY: u32 = 0x02;
    const FILE_MAP_READ: u32 = 0x04;
    const INVALID: isize = -1;

    pub fn map(path: &std::path::Path) -> std::io::Result<&'static [u8]> {
        let len = std::fs::metadata(path)?.len() as usize;
        if len == 0 {
            return Ok(&[]);
        }
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            let f = CreateFileW(wide.as_ptr(), GENERIC_READ, FILE_SHARE_READ_DELETE, std::ptr::null_mut(), OPEN_EXISTING, 0, 0);
            if f == INVALID {
                return Err(std::io::Error::last_os_error());
            }
            let m = CreateFileMappingW(f, std::ptr::null_mut(), PAGE_READONLY, 0, 0, std::ptr::null());
            CloseHandle(f);
            if m == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let p = MapViewOfFile(m, FILE_MAP_READ, 0, 0, 0);
            // The view keeps the mapping alive; it is never unmapped.
            CloseHandle(m);
            if p.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            Ok(std::slice::from_raw_parts(p, len))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn map(path: &std::path::Path) -> std::io::Result<&'static [u8]> {
        Ok(Box::leak(std::fs::read(path)?.into_boxed_slice()))
    }
}
