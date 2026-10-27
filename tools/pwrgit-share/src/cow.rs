use crate::*;
use std::{fs::OpenOptions, io::Write};
#[derive(Debug, Serialize)]
pub struct Probe {
    pub cow: String,
    pub detail: String,
}
/// Probe real bytes on the destination filesystem, never just its type name.
/// `directory` must already exist; worktree callers pass the destination parent.
pub fn probe(directory: &Path) -> Result<Probe> {
    let parent = fs::canonicalize(directory)?;
    if !parent.is_dir() {
        return Err(Error::new(1, "probe requires an existing directory"));
    }
    let stage = unique_dir(&parent, std::ffi::OsStr::new("probe"))?;
    let source = stage.path.join("source");
    let dest = stage.path.join("clone");
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&source)?;
    f.write_all(&vec![0x5a; 65536])?;
    f.sync_all()?;
    drop(f);
    match clone_file(&source, &dest) {
        Ok(()) => {
            if fs::read(&dest)? != fs::read(&source)? {
                return Err(Error::new(1, "clone probe bytes differ"));
            }
            fs::write(&dest, b"independent")?;
            if fs::metadata(&source)?.len() != 65536 {
                return Err(Error::new(1, "clone probe lacks write isolation"));
            }
            Ok(Probe {
                cow: if cfg!(target_os = "macos") {
                    "apfs"
                } else {
                    "ficlone"
                }
                .into(),
                detail:
                    "temporary-file clone and independent write succeeded in destination parent"
                        .into(),
            })
        }
        Err(e) => Ok(Probe {
            cow: "none".into(),
            detail: format!("destination clone unavailable: {e}"),
        }),
    }
}
/// No hardlink or byte-copy fallback. A failed clone is removed by its owner.
pub(crate) fn clone_file(source: &Path, dest: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        };
        // Open every donor component with O_NOFOLLOW. Keeping the directory fd
        // prevents a symlink swap between checking a parent and opening a leaf.
        let absolute = source.is_absolute();
        let start = if absolute { "/" } else { "." };
        let mut directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(start)?
            .into();
        let parts: Vec<_> = source
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(n) => Some(n),
                _ => None,
            })
            .collect();
        for (i, part) in parts.iter().enumerate() {
            let name = std::ffi::CString::new(part.as_bytes())?;
            let flags = libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | if i + 1 < parts.len() {
                    libc::O_DIRECTORY
                } else {
                    0
                };
            let fd = unsafe { libc::openat(OwnedFd::as_raw_fd(&directory), name.as_ptr(), flags) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            directory = unsafe { OwnedFd::from_raw_fd(fd) };
        }
        let source_file: fs::File = directory.into();
        let m = source_file.metadata()?;
        if !m.is_file() {
            return Err(io::Error::other("clone source is not regular"));
        }
        #[cfg(target_os = "macos")]
        {
            unsafe extern "C" {
                fn fclonefileat(
                    src: libc::c_int,
                    dst_dir: libc::c_int,
                    dst: *const libc::c_char,
                    flags: u32,
                ) -> libc::c_int;
            }
            let to = std::ffi::CString::new(dest.as_os_str().as_bytes())?;
            if unsafe { fclonefileat(source_file.as_raw_fd(), libc::AT_FDCWD, to.as_ptr(), 0) } != 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(target_os = "linux")]
        {
            let to = OpenOptions::new()
                .write(true)
                .create_new(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(dest)?;
            if unsafe {
                libc::ioctl(
                    to.as_raw_fd(),
                    0x40049409 as libc::c_ulong,
                    source_file.as_raw_fd(),
                )
            } != 0
            {
                let e = io::Error::last_os_error();
                drop(to);
                let _ = fs::remove_file(dest);
                return Err(e);
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no clone primitive",
        ));
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            fs::set_permissions(dest, m.permissions())?;
            let to = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(dest)?;
            to.set_times(fs::FileTimes::new().set_modified(m.modified()?))?;
            Ok(())
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (source, dest);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no clone primitive on this platform",
        ))
    }
}
/// Atomic publication must not replace even an empty pre-existing destination.
#[cfg(unix)]
pub(crate) fn rename_new(source: &Path, dest: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let s = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let d = std::ffi::CString::new(dest.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let rc = unsafe { libc::renamex_np(s.as_ptr(), d.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let rc = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            s.as_ptr(),
            libc::AT_FDCWD,
            d.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let rc = {
        let _ = (s, d);
        return Err(io::Error::other("atomic no-replace rename unavailable"));
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
#[cfg(not(unix))]
pub(crate) fn rename_new(source: &Path, dest: &Path) -> io::Result<()> {
    if dest.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "destination exists",
        ));
    }
    fs::rename(source, dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clone_preserves_mode_and_mtime_without_following_links() {
        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        if probe(&parent).unwrap().cow == "none" {
            return;
        }
        let dir = unique_dir(&parent, std::ffi::OsStr::new("metadata")).unwrap();
        let source = dir.path.join("source");
        let dest = dir.path.join("clone");
        fs::write(&source, "original").unwrap();
        let timestamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1700000000);
        fs::File::open(&source)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(timestamp))
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&source, fs::Permissions::from_mode(0o444)).unwrap();
        }
        clone_file(&source, &dest).unwrap();
        assert_eq!(fs::metadata(&dest).unwrap().modified().unwrap(), timestamp);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            assert_eq!(
                fs::metadata(&dest).unwrap().permissions().mode() & 0o7777,
                0o444
            );
            assert_eq!(fs::metadata(&dest).unwrap().nlink(), 1);
            let link = dir.path.join("link");
            std::os::unix::fs::symlink(&source, &link).unwrap();
            assert!(clone_file(&link, &dir.path.join("forbidden")).is_err());
        }
    }
}
