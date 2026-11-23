//! Desktop-owned, gh stack-compatible file locks. EOF releases the lock even
//! when the desktop exits unexpectedly. The lock inode remains on disk.
use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    path::Path,
    time::{Duration, Instant},
};

#[cfg(unix)]
fn try_lock(file: &File) -> io::Result<bool> {
    use rustix::fs::{FlockOperation, flock};
    match flock(file, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::WOULDBLOCK) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[cfg(windows)]
fn try_lock(file: &File) -> io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::{ERROR_LOCK_VIOLATION, GetLastError},
        Storage::FileSystem::{LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx},
        System::IO::OVERLAPPED,
    };
    // A zero offset and a one-byte length match gh stack's LockFileEx call.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    unsafe {
        let result = LockFileEx(
            file.as_raw_handle(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        );
        if result != 0 {
            return Ok(true);
        }
        let code = GetLastError();
        if code == ERROR_LOCK_VIOLATION {
            return Ok(false);
        }
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

pub(crate) fn hold(common_dir: &Path, kind: &str, wait: bool) -> io::Result<bool> {
    let name = match kind {
        "operation" => "gh-stack-operation.lock",
        "catalog" => "gh-stack.lock",
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unknown stack lock",
            ));
        }
    };
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(common_dir.join(name))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if try_lock(&lock)? {
            break;
        }
        if !wait || Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut stdout = io::stdout().lock();
    stdout.write_all(b"locked\n")?;
    stdout.flush()?;
    io::copy(&mut io::stdin().lock(), &mut io::sink())?;
    drop(lock);
    Ok(true)
}

#[cfg(windows)]
pub(crate) fn replace_catalog(dir: &Path, temporary: &str, destination: &str) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    if !temporary.starts_with(".pwrgit-stack-")
        || !temporary
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        || !matches!(
            destination,
            "gh-stack" | "pwrgit-stack" | "pwrgit-stack-op.json"
        )
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid stack state path",
        ));
    }
    let wide = |name: &str| -> Vec<u16> {
        dir.join(name)
            .as_os_str()
            .encode_wide()
            .chain([0])
            .collect()
    };
    let from = wide(temporary);
    let to = wide(destination);
    // Windows doesn't expose POSIX directory fsync. Ask the filesystem for
    // write-through for the same-directory replacement.
    let result = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
