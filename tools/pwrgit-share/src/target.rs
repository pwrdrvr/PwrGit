use crate::*;
use std::{collections::BTreeMap, fs::File};
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedReport {
    pub units_seeded: u64,
    pub units_skipped: BTreeMap<String, u64>,
    pub clone_count: u64,
    pub copy_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
impl SeedReport {
    fn skip(&mut self, reason: &str, n: u64) {
        *self.units_skipped.entry(reason.into()).or_default() += n;
    }
}
pub(crate) struct DonorLocks {
    _files: Vec<File>,
    profiles: std::collections::HashSet<PathBuf>,
}
impl DonorLocks {
    pub(crate) fn acquire(target: &Path) -> Result<Self> {
        let mut locks = Self {
            _files: Vec::new(),
            profiles: Default::default(),
        };
        fn walk(root: &Path, path: &Path, locks: &mut DonorLocks) -> Result<()> {
            check_cancel()?;
            let m = fs::symlink_metadata(path)?;
            if m.is_symlink() {
                return Ok(());
            }
            if m.is_dir() {
                for entry in fs::read_dir(path)? {
                    let p = entry?.path();
                    if p.file_name() != Some(std::ffi::OsStr::new("incremental")) {
                        walk(root, &p, locks)?;
                    }
                }
            } else if path.file_name().is_some_and(|name| {
                [".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock"]
                    .iter()
                    .any(|candidate| name == *candidate)
            }) {
                // Cargo 1.96+ keeps the legacy lock shared and holds the
                // separate build/artifact locks exclusively. Check all three.
                regular(root, path.strip_prefix(root).unwrap())?;
                let mut open = fs::OpenOptions::new();
                open.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    open.custom_flags(libc::O_NOFOLLOW);
                }
                let file = open.open(path)?;
                #[cfg(unix)]
                {
                    use std::os::fd::AsRawFd;
                    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } != 0
                    {
                        let e = io::Error::last_os_error();
                        if matches!(e.raw_os_error(), Some(libc::EWOULDBLOCK)) {
                            return Err(Error::new(
                                3,
                                format!("donor profile is locked: {}", path.display()),
                            ));
                        }
                        return Err(e.into());
                    }
                }
                #[cfg(not(unix))]
                return Err(Error::new(3, "donor locking unsupported on this platform"));
                locks
                    .profiles
                    .insert(fs::canonicalize(path.parent().unwrap())?);
                locks._files.push(file);
            }
            Ok(())
        }
        if fs::symlink_metadata(target).is_ok() {
            walk(target, target, &mut locks)?;
        }
        Ok(locks)
    }
}
pub fn target_seed(from: &Path, to: &Path) -> Result<SeedReport> {
    let locks = DonorLocks::acquire(from)?;
    seed_locked(from, to, &locks)
}
pub(crate) fn seed_locked(from: &Path, to: &Path, _locks: &DonorLocks) -> Result<SeedReport> {
    seed_locked_with_home(from, to, _locks, None)
}
pub(crate) fn seed_locked_with_home(
    from: &Path,
    to: &Path,
    _locks: &DonorLocks,
    home: Option<&Path>,
) -> Result<SeedReport> {
    seed_impl(from, to, _locks, home, false)
}
// There is deliberately no public flag or environment variable that bypasses
// the freshness gate. Only this crate's disposable experiment can bypass it.
#[cfg(test)]
pub(crate) fn experimental_seed(
    from: &Path,
    to: &Path,
    locks: &DonorLocks,
    home: &Path,
) -> Result<SeedReport> {
    seed_impl(from, to, locks, Some(home), true)
}
fn seed_impl(
    from: &Path,
    to: &Path,
    _locks: &DonorLocks,
    home: Option<&Path>,
    experiment: bool,
) -> Result<SeedReport> {
    check_cancel()?;
    if fs::symlink_metadata(to).is_ok() {
        return Err(Error::new(1, "target destination already exists"));
    }
    if from == to {
        return Err(Error::new(1, "target must be separate from donor"));
    }
    let parent = fs::canonicalize(
        to.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    let mut report = SeedReport::default();
    if probe(&parent)?.cow == "none" {
        report.reason = Some("cow-unavailable".into());
        return Ok(report);
    }
    if fs::symlink_metadata(from)?.is_symlink() {
        return Err(Error::new(1, "donor target cannot be a symlink"));
    }
    let from = fs::canonicalize(from)?;
    if !cow_same_device(&from, &parent)? {
        report.reason = Some("cross-filesystem".into());
        return Ok(report);
    }
    if parent.starts_with(&from) {
        return Err(Error::new(
            1,
            "target destination must be outside the donor target",
        ));
    }
    let donor = from
        .parent()
        .filter(|p| regular(p, Path::new("Cargo.toml")).is_ok());
    let Some(donor) = donor else {
        report.skip("layout-unknown", 1);
        report.reason = Some("layout-unknown".into());
        return Ok(report);
    };
    let mut current_cmd = Command::new("rustc");
    current_cmd.current_dir(donor).arg("-vV");
    if let Some(home) = home {
        current_cmd.env("CARGO_HOME", home);
    }
    let current = output(&mut current_cmd, 1)?;
    let current = String::from_utf8_lossy(&current.stdout);
    let commit = current
        .lines()
        .find_map(|s| s.strip_prefix("commit-hash: "))
        .unwrap_or("");
    let host = current
        .lines()
        .find_map(|s| s.strip_prefix("host: "))
        .ok_or_else(|| Error::new(1, "rustc did not report a host target"))?;
    // --offline prevents index updates and artifact fetching. No config is
    // written. CARGO_HOME, if set by the caller, is inherited unchanged.
    // Limit metadata to this host so an offline macOS cache need not contain
    // manifests for Windows/Linux-only dependencies.
    let mut cmd = Command::new("cargo");
    cmd.current_dir(donor).args([
        "metadata",
        "--offline",
        "--locked",
        "--filter-platform",
        host,
        "--format-version",
        "1",
    ]);
    if let Some(home) = home {
        cmd.env("CARGO_HOME", home);
    }
    let meta = output(&mut cmd, 1)?;
    let meta: serde_json::Value = serde_json::from_slice(&meta.stdout)?;
    let members = meta["workspace_members"]
        .as_array()
        .ok_or_else(|| Error::new(1, "invalid Cargo metadata"))?;
    let mut dependencies = 0;
    for pkg in meta["packages"]
        .as_array()
        .ok_or_else(|| Error::new(1, "invalid Cargo packages"))?
    {
        if members.contains(&pkg["id"]) {
            report.skip("workspace", 1);
        } else if pkg["source"]
            .as_str()
            .is_some_and(|s| s.starts_with("registry+") || s.starts_with("git+"))
        {
            dependencies += 1;
        } else {
            report.skip("path-dep", 1);
        }
    }
    let info = from.join(".rustc_info.json");
    let toolchain = regular(&from, Path::new(".rustc_info.json"))
        .ok()
        .and_then(|_| fs::read(info).ok())
        .and_then(|s| serde_json::from_slice::<serde_json::Value>(&s).ok());
    // Cargo stores the rustc -vV response in cached output values. Exact commit
    // comparison is conservative; unknown layouts never count as matching.
    if !toolchain
        .as_ref()
        .is_some_and(|v| !commit.is_empty() && v.to_string().contains(commit))
    {
        report.skip("toolchain-mismatch", dependencies.max(1));
        report.reason = Some("toolchain-mismatch".into());
        return Ok(report);
    }
    let mut cargo_cmd = Command::new("cargo");
    cargo_cmd.current_dir(donor).arg("--version");
    if let Some(home) = home {
        cargo_cmd.env("CARGO_HOME", home);
    }
    let cargo = output(&mut cargo_cmd, 1)?;
    if !experiment && !PROVEN_CARGO.contains(&String::from_utf8_lossy(&cargo.stdout).trim()) {
        report.skip("fingerprint-unproven", dependencies.max(1));
        report.reason = Some("fingerprint-unproven".into());
        return Ok(report);
    }
    let packages = meta["packages"].as_array().unwrap();
    let nodes = meta["resolve"]["nodes"]
        .as_array()
        .ok_or_else(|| Error::new(1, "missing Cargo resolve graph"))?;
    let mut eligible: std::collections::HashSet<String> = packages
        .iter()
        .filter(|p| {
            p["source"]
                .as_str()
                .is_some_and(|s| s.starts_with("registry+") || s.starts_with("git+"))
                && p["targets"].as_array().is_some_and(|ts| {
                    !ts.iter().any(|t| {
                        t["kind"]
                            .as_array()
                            .is_some_and(|k| k.iter().any(|v| v == "custom-build"))
                    })
                })
        })
        .filter_map(|p| p["id"].as_str().map(str::to_owned))
        .collect();
    // A library depending on a path/workspace/build-script unit is outside the
    // proven layout too. Iterate to a fixed point to exclude transitive users.
    loop {
        let rejected: Vec<_> = nodes
            .iter()
            .filter(|n| {
                n["id"].as_str().is_some_and(|id| eligible.contains(id))
                    && n["dependencies"].as_array().is_none_or(|deps| {
                        deps.iter()
                            .any(|d| d.as_str().is_none_or(|id| !eligible.contains(id)))
                    })
            })
            .filter_map(|n| n["id"].as_str().map(str::to_owned))
            .collect();
        if rejected.is_empty() {
            break;
        }
        for id in rejected {
            eligible.remove(&id);
        }
    }
    let stage = unique_dir(
        &parent,
        to.file_name()
            .ok_or_else(|| Error::new(1, "target needs a name"))?,
    )?;
    // Discover only classic profile .fingerprint directories. Unknown and
    // per-unit layouts are skipped, never guessed from filenames alone.
    let mut seeded = std::collections::HashSet::new();
    let mut fingerprints = Vec::new();
    find_fingerprints(&from, 0, &mut fingerprints)?;
    for fingerprint_root in fingerprints {
        let profile = fingerprint_root.parent().unwrap();
        if !_locks.profiles.contains(profile) {
            continue;
        }
        for entry in fs::read_dir(&fingerprint_root)? {
            check_cancel()?;
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some((pkgname, hash)) = name.rsplit_once('-') else {
                continue;
            };
            if hash.len() != 16 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
                continue;
            }
            let candidates: Vec<_> = packages
                .iter()
                .filter(|p| {
                    p["name"] == pkgname && p["id"].as_str().is_some_and(|id| eligible.contains(id))
                })
                .collect();
            // Multiple versions with one name cannot be attributed safely from
            // a directory name; an unknown unit is cheaper than a wrong unit.
            if candidates.len() != 1 {
                continue;
            }
            let pkg = candidates[0];
            let targets: Vec<_> = pkg["targets"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|t| {
                    t["kind"]
                        .as_array()
                        .is_some_and(|k| k.iter().any(|v| v == "lib"))
                })
                .collect();
            if targets.len() != 1 {
                continue;
            }
            let target = targets[0]["name"].as_str().unwrap().replace('-', "_");
            let lib = format!("lib-{target}");
            let fingerprint = entry.path();
            let json_path = fingerprint.join(format!("{lib}.json"));
            if regular(&from, json_path.strip_prefix(&from).unwrap()).is_err() {
                continue;
            }
            let data: serde_json::Value = serde_json::from_slice(&fs::read(&json_path)?)?;
            // Require the exact library fingerprint layout observed by the
            // freshness gate; test/bin/build-script fingerprints never enter.
            if !data["deps"].is_array() || !data["rustflags"].is_array() {
                continue;
            }
            let files = fs::read_dir(&fingerprint)?.collect::<io::Result<Vec<_>>>()?;
            let allowed = [
                lib.clone(),
                format!("{lib}.json"),
                format!("dep-{lib}"),
                "invoked.timestamp".into(),
            ];
            if files.iter().any(|f| {
                !f.file_type().is_ok_and(|m| m.is_file())
                    || !allowed.iter().any(|n| f.file_name() == n.as_str())
            }) {
                continue;
            }
            if !allowed
                .iter()
                .all(|n| files.iter().any(|f| f.file_name() == n.as_str()))
            {
                continue;
            }
            let deps = profile.join("deps");
            if !fs::symlink_metadata(&deps).is_ok_and(|m| m.is_dir()) {
                continue;
            }
            let prefix = format!("lib{target}-{hash}.");
            let depinfo = format!("{target}-{hash}.d");
            let artifacts = fs::read_dir(&deps)?
                .collect::<io::Result<Vec<_>>>()?
                .into_iter()
                .filter(|f| {
                    let n = f.file_name();
                    let n = n.to_string_lossy();
                    n == depinfo
                        || (n.starts_with(&prefix)
                            && ["rlib", "rmeta", "so", "dylib"]
                                .iter()
                                .any(|ext| n.ends_with(&format!(".{ext}"))))
                })
                .collect::<Vec<_>>();
            if !artifacts.iter().any(|f| {
                f.path()
                    .extension()
                    .is_some_and(|e| e == "rlib" || e == "so" || e == "dylib")
            }) {
                continue;
            }
            let mut paths: Vec<_> = files
                .into_iter()
                .chain(artifacts)
                .map(|f| f.path())
                .collect();
            if paths
                .iter()
                .any(|p| regular(&from, p.strip_prefix(&from).unwrap()).is_err())
            {
                continue;
            }
            for path in paths.drain(..) {
                check_cancel()?;
                let dest = stage.path.join(path.strip_prefix(&from).unwrap());
                fs::create_dir_all(dest.parent().unwrap())?;
                if let Err(e) = cow::clone_file(&path, &dest) {
                    if matches!(
                        e.raw_os_error(),
                        Some(libc::EXDEV | libc::ENOTSUP | libc::ENOTTY)
                    ) {
                        report.units_seeded = 0;
                        report.clone_count = 0;
                        report.reason = Some("cow-unavailable".into());
                        return Ok(report);
                    }
                    return Err(e.into());
                }
                report.clone_count += 1;
            }
            report.units_seeded += 1;
            seeded.insert(pkg["id"].as_str().unwrap().to_owned());
        }
    }
    let unknown = dependencies.saturating_sub(seeded.len() as u64);
    if unknown > 0 {
        report.skip("layout-unknown", unknown);
    }
    if report.units_seeded == 0 {
        report.reason = Some("layout-unknown".into());
        return Ok(report);
    }
    let rustc_info = from.join(".rustc_info.json");
    cow::clone_file(&rustc_info, &stage.path.join(".rustc_info.json"))?;
    report.clone_count += 1;
    check_cancel()?;
    write_record(
        &stage.path.join(".pwrgit-share.json"),
        report.clone_count,
        report.units_skipped.values().sum(),
    )?;
    cow::rename_new(&stage.path, to)?;
    // The old staging path is gone. Its guard still cleans it if publication
    // failed; it never owns the final target (or another process's partials).
    Ok(report)
}
// 1.94.1 fails when vendored sources relocate with the worktree. A fixed
// CARGO_HOME source path alone is insufficient evidence to enable a version.
const PROVEN_CARGO: &[&str] = &[];
fn find_fingerprints(path: &Path, depth: usize, out: &mut Vec<PathBuf>) -> Result<()> {
    if depth > 3 {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        check_cancel()?;
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if entry.file_name() == ".fingerprint" {
            out.push(entry.path());
        } else if !["incremental", "deps", "build"]
            .iter()
            .any(|s| entry.file_name() == *s)
        {
            find_fingerprints(&entry.path(), depth + 1, out)?;
        }
    }
    Ok(())
}

fn cow_same_device(a: &Path, b: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(fs::metadata(a)?.dev() == fs::metadata(b)?.dev())
    }
    #[cfg(not(unix))]
    {
        let _ = (a, b);
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_staging_is_private_and_owned_only() {
        let parent = std::env::temp_dir();
        let stage =
            unique_dir(&parent, std::ffi::OsStr::new("pwrgit-share-failed-target")).unwrap();
        let p = stage.path.clone();
        assert_ne!(p.file_name().unwrap(), "target");
        assert!(p.to_string_lossy().ends_with(".pwrgit-share-partial"));
        fs::write(p.join("incomplete"), b"not fresh").unwrap();
        let survivor = unique_dir(&parent, std::ffi::OsStr::new("other-process")).unwrap();
        drop(stage);
        assert!(!p.exists());
        assert!(survivor.path.exists());
    }
    #[test]
    fn publish_does_not_replace_existing_directory() {
        let parent = std::env::temp_dir();
        let stage = unique_dir(&parent, std::ffi::OsStr::new("publish")).unwrap();
        let existing = unique_dir(&parent, std::ffi::OsStr::new("existing")).unwrap();
        assert!(cow::rename_new(&stage.path, &existing.path).is_err());
        assert!(stage.path.exists());
        assert!(existing.path.exists());
    }
}
