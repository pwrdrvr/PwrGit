//! Reflink-only source materialization. Cargo seeding is fail-closed until its
//! exact Cargo version has passed the donor-independent freshness gate.
mod cow;
mod target;
mod worktree;
pub use cow::{Probe, probe};
pub use target::{SeedReport, target_seed};
pub use worktree::{Options, WorktreeReport, worktree_add};

use serde::Serialize;
use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
static CANCELLED: AtomicBool = AtomicBool::new(false);
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub struct Error {
    pub code: i32,
    pub detail: String,
}
impl Error {
    pub fn new(code: i32, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.detail)
    }
}
impl std::error::Error for Error {}
impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Self::new(1, e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new(1, e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, Error>;

/// Request cancellation. The CLI installs handlers; embedders can call this
/// from their own signal/cancellation handling. The next boundary cleans up.
pub fn cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
}
fn check_cancel() -> Result<()> {
    if CANCELLED.load(Ordering::SeqCst) {
        Err(Error::new(130, "cancelled"))
    } else {
        Ok(())
    }
}
#[cfg(unix)]
pub fn install_signal_handlers() {
    extern "C" fn handler(_: libc::c_int) {
        cancel();
    }
    unsafe {
        libc::signal(libc::SIGINT, handler as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, handler as *const () as libc::sighandler_t);
    }
}
#[cfg(not(unix))]
pub fn install_signal_handlers() {}
fn output(cmd: &mut Command, code: i32) -> Result<Output> {
    check_cancel()?;
    let o = cmd.output().map_err(|e| Error::new(code, e.to_string()))?;
    check_cancel()?;
    if !o.status.success() {
        return Err(Error::new(
            code,
            format!("{cmd:?}: {}", String::from_utf8_lossy(&o.stderr).trim()),
        ));
    }
    Ok(o)
}
fn git_command(root: &Path) -> Command {
    let mut cmd = Command::new("git");
    // Git's repository-local environment (rev-parse --local-env-vars), plus
    // namespaces, must not redirect -C to the caller's repository or index.
    // Keep ordinary config discovery so filters and hooks still work normally.
    for key in [
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_COUNT",
        "GIT_OBJECT_DIRECTORY",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_IMPLICIT_WORK_TREE",
        "GIT_GRAFT_FILE",
        "GIT_INDEX_FILE",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_REPLACE_REF_BASE",
        "GIT_PREFIX",
        "GIT_SHALLOW_FILE",
        "GIT_COMMON_DIR",
        "GIT_NAMESPACE",
    ] {
        cmd.env_remove(key);
    }
    cmd.arg("-C").arg(root);
    cmd
}
fn git(root: &Path, args: &[&std::ffi::OsStr], code: i32) -> Result<Output> {
    output(git_command(root).args(args), code)
}
fn git_s(root: &Path, args: &[&str], code: i32) -> Result<Output> {
    git(
        root,
        &args.iter().map(std::ffi::OsStr::new).collect::<Vec<_>>(),
        code,
    )
}

/// Reject symlinks in descendants of a trusted root, including the leaf.
fn regular(root: &Path, relative: &Path) -> io::Result<fs::Metadata> {
    let mut p = root.to_path_buf();
    for c in relative.components() {
        if !matches!(c, std::path::Component::Normal(_)) {
            return Err(io::Error::other("non-relative path"));
        }
        p.push(c);
        if fs::symlink_metadata(&p)?.is_symlink() {
            return Err(io::Error::other("symlink skipped"));
        }
    }
    let m = fs::symlink_metadata(&p)?;
    if !m.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    Ok(m)
}
fn unique_dir(parent: &Path, stem: &std::ffi::OsStr) -> Result<OwnedDir> {
    check_cancel()?;
    let mut name = stem.to_os_string();
    name.push(format!(
        ".{}.{}.pwrgit-share-partial",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let path = parent.join(name);
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&path)?;
    Ok(OwnedDir { path, armed: true })
}
struct OwnedDir {
    path: PathBuf,
    armed: bool,
}
impl Drop for OwnedDir {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub logical_bytes: u64,
    /// A scan cannot infer historical clone operations. Counts are zero unless
    /// supplied by the operation's report; no st_blocks/du guess is made.
    pub clone_count: u64,
    pub copy_count: u64,
    pub skip_count: u64,
    pub allocated_bytes: &'static str,
    pub counts_origin: &'static str,
}
pub fn measure(path: &Path) -> Result<Measurement> {
    let mut r = Measurement {
        logical_bytes: 0,
        clone_count: 0,
        copy_count: 0,
        skip_count: 0,
        allocated_bytes: "not-distinguishable",
        counts_origin: "scan-only; historical operations unknown",
    };
    fn visit(path: &Path, r: &mut Measurement) -> Result<()> {
        check_cancel()?;
        let m = fs::symlink_metadata(path)?;
        if m.is_file() {
            r.logical_bytes += m.len();
        } else if m.is_dir() {
            for e in fs::read_dir(path)? {
                visit(&e?.path(), r)?;
            }
        } else {
            r.skip_count += 1;
        }
        Ok(())
    }
    visit(path, &mut r)?;
    if !fs::symlink_metadata(path)?.is_dir() {
        return Ok(r);
    }
    let local = path.join(".pwrgit-share.json");
    let record = if regular(path, Path::new(".pwrgit-share.json")).is_ok() {
        Some(local)
    } else if fs::symlink_metadata(path.join(".git")).is_ok_and(|m| m.is_file()) {
        let out = git_command(path)
            .args([
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "pwrgit-share.json",
            ])
            .output()?;
        if out.status.success() {
            Some(PathBuf::from(
                String::from_utf8_lossy(&out.stdout).trim_end_matches('\n'),
            ))
        } else {
            None
        }
    } else {
        None
    };
    if let Some(record) = record
        .and_then(|p| fs::read(p).ok())
        .and_then(|s| serde_json::from_slice::<serde_json::Value>(&s).ok())
    {
        r.clone_count = record["cloneCount"].as_u64().unwrap_or(0);
        r.copy_count = record["copyCount"].as_u64().unwrap_or(0);
        r.skip_count = record["skipCount"].as_u64().unwrap_or(r.skip_count);
        r.counts_origin = "recorded initial materialization; subsequent edits not tracked";
    }
    Ok(r)
}

#[cfg(test)]
mod gate;

fn write_record(path: &Path, clones: u64, skips: u64) -> Result<()> {
    fs::write(
        path,
        serde_json::to_vec(
            &serde_json::json!({"cloneCount":clones,"copyCount":0,"skipCount":skips}),
        )?,
    )?;
    Ok(())
}
