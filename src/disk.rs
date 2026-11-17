//! Free space on the disk that holds a folder.
//!
//! The standard library cannot answer this, so each platform gets the smallest
//! possible query: `statvfs` on Unix and `GetDiskFreeSpaceExW` on Windows. When
//! neither answers, the storage page simply leaves the numbers out.

use std::path::Path;

use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct DiskSpace {
    /// Space this user can still write, which can be smaller than the disk's
    /// free space when a quota applies.
    pub free: u64,
    pub total: u64,
}

pub fn space_for(path: &Path) -> Option<DiskSpace> {
    platform::space_for(path)
}

#[cfg(unix)]
mod platform {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    use super::DiskSpace;

    pub fn space_for(path: &Path) -> Option<DiskSpace> {
        let directory = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(directory.as_ptr(), &mut stats) } != 0 {
            return None;
        }

        let block = if stats.f_frsize > 0 {
            stats.f_frsize
        } else {
            stats.f_bsize
        } as u64;

        Some(DiskSpace {
            free: (stats.f_bavail as u64).saturating_mul(block),
            total: (stats.f_blocks as u64).saturating_mul(block),
        })
    }
}

#[cfg(windows)]
mod platform {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use super::DiskSpace;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory: *const u16,
            free_bytes_available: *mut u64,
            total_bytes: *mut u64,
            total_free_bytes: *mut u64,
        ) -> i32;
    }

    pub fn space_for(path: &Path) -> Option<DiskSpace> {
        let directory: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free = 0u64;
        let mut total = 0u64;
        let mut total_free = 0u64;

        let asked = unsafe {
            GetDiskFreeSpaceExW(directory.as_ptr(), &mut free, &mut total, &mut total_free)
        };

        (asked != 0).then_some(DiskSpace { free, total })
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    use std::path::Path;

    use super::DiskSpace;

    pub fn space_for(_path: &Path) -> Option<DiskSpace> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_real_folder_reports_plausible_space() {
        let directory = std::env::temp_dir();
        let Some(space) = space_for(&directory) else {
            // Some sandboxes hide this; the page copes by hiding the numbers.
            return;
        };

        assert!(space.total > 0, "a disk has some size");
        assert!(
            space.free <= space.total,
            "free space cannot exceed the disk"
        );
    }

    #[test]
    fn a_missing_folder_has_no_answer() {
        let missing = std::env::temp_dir().join("grapho-not-a-real-folder-for-space");
        assert!(space_for(&missing).is_none());
    }
}
