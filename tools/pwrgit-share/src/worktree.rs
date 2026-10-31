use crate::*;
use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
};
#[derive(Default, Debug)]
pub struct Options {
    pub branch: Option<String>,
    pub seed_target: bool,
    /// Explicit library test/diagnostic override. It can only disable sharing.
    pub force_no_cow: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReport {
    pub fallback: String,
    pub cloned_files: u64,
    pub checkout_files: u64,
    pub hashed_mismatches: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<SeedReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_skipped: Option<String>,
}
struct Registration {
    donor: PathBuf,
    dest: PathBuf,
    armed: bool,
}
impl Drop for Registration {
    fn drop(&mut self) {
        if self.armed {
            // Deliberately bypass cancellation for cleanup. Never prune and
            // never remove any registration other than the one just created.
            let _ = git_command(&self.donor)
                .args(["worktree", "remove", "--force"])
                .arg(&self.dest)
                .output();
        }
    }
}
#[derive(Debug)]
struct Entry {
    mode: String,
    oid: String,
    path: PathBuf,
}
fn entries(root: &Path, commit: &str) -> Result<Vec<Entry>> {
    let out = git_s(root, &["ls-tree", "-r", "-z", commit], 4)?;
    let mut result = Vec::new();
    for record in out.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let tab = record
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| Error::new(4, "invalid Git tree entry"))?;
        let fields = std::str::from_utf8(&record[..tab])
            .map_err(|e| Error::new(4, e.to_string()))?
            .split(' ')
            .collect::<Vec<_>>();
        let path = bytes_path(&record[tab + 1..])?;
        if path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(Error::new(4, "unsafe Git tree path"));
        }
        result.push(Entry {
            mode: fields[0].into(),
            oid: fields[2].into(),
            path,
        });
    }
    Ok(result)
}
fn bytes_path(bytes: &[u8]) -> Result<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Ok(PathBuf::from(OsStr::from_bytes(bytes)))
    }
    #[cfg(not(unix))]
    {
        Ok(PathBuf::from(
            std::str::from_utf8(bytes).map_err(|e| Error::new(4, e.to_string()))?,
        ))
    }
}
fn dirty(root: &Path) -> Result<HashSet<PathBuf>> {
    // Both index and worktree changes matter. Do not rely on donor stat cache:
    // every actual clone is hashed again before it can enter the new index.
    let out = git_s(
        root,
        &["diff", "HEAD", "--name-only", "-z", "--no-renames"],
        4,
    )?;
    out.stdout
        .split(|b| *b == 0)
        .filter(|b| !b.is_empty())
        .map(bytes_path)
        .collect()
}
fn ignored(root: &Path, path: &Path) -> Result<bool> {
    let o = git_command(root)
        .args(["check-ignore", "--no-index", "-q", "--"])
        .arg(path)
        .output()?;
    match o.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(Error::new(1, "git check-ignore failed")),
    }
}
fn checkout_conversions(root: &Path, tree: &[Entry]) -> Result<HashSet<PathBuf>> {
    check_cancel()?;
    let autocrlf = git_command(root)
        .args(["config", "--get", "core.autocrlf"])
        .output()?;
    check_cancel()?;
    if !matches!(autocrlf.status.code(), Some(0 | 1)) {
        return Err(Error::new(1, "cannot read core.autocrlf"));
    }
    let value = String::from_utf8_lossy(&autocrlf.stdout)
        .trim()
        .to_ascii_lowercase();
    if autocrlf.status.success() && !["", "false", "no", "off", "0"].contains(&value.as_str()) {
        // Without proving which blobs Git considers text, leave all paths to
        // Git when automatic line-ending conversion is enabled.
        return Ok(tree.iter().map(|e| e.path.clone()).collect());
    }
    let mut conversions = HashSet::new();
    // --cached reads the target's attributes from read-tree's index, even
    // before .gitattributes has been checked out. Bound argv for large trees;
    // NUL-delimited output preserves arbitrary Git path bytes.
    for chunk in tree.chunks(128) {
        let mut args = vec![
            OsStr::new("check-attr"),
            OsStr::new("--cached"),
            OsStr::new("-z"),
            OsStr::new("--all"),
            OsStr::new("--"),
        ];
        args.extend(chunk.iter().map(|e| e.path.as_os_str()));
        let out = git(root, &args, 1)?;
        if out.stdout.is_empty() {
            continue;
        }
        let bytes = out
            .stdout
            .strip_suffix(b"\0")
            .ok_or_else(|| Error::new(1, "invalid Git attribute response"))?;
        let fields = bytes.split(|b| *b == 0).collect::<Vec<_>>();
        let mut triples = fields.chunks_exact(3);
        for triple in &mut triples {
            // --all omits unspecified attributes. Skip even explicitly unset
            // conversion attributes: the CLI renders -filter and a driver
            // literally named "unset" identically, so values cannot prove it
            // safe to bypass Git's conversion machinery.
            if [
                b"text".as_slice(),
                b"eol".as_slice(),
                b"filter".as_slice(),
                b"ident".as_slice(),
                b"working-tree-encoding".as_slice(),
                b"crlf".as_slice(),
            ]
            .contains(&triple[1])
            {
                conversions.insert(bytes_path(triple[0])?);
            }
        }
        if !triples.remainder().is_empty() {
            return Err(Error::new(1, "invalid Git attribute response"));
        }
    }
    Ok(conversions)
}

fn post_checkout(root: &Path) -> Result<()> {
    let out = git_s(root, &["rev-parse", "HEAD"], 1)?;
    let head = String::from_utf8_lossy(&out.stdout);
    let head = head.trim();
    // Ordinary worktree add passes a null old OID, the new OID and branch=1.
    // Match the repository's object format, including SHA-256 repositories.
    let old = "0".repeat(head.len());
    git_s(
        root,
        &[
            "hook",
            "run",
            "--ignore-missing",
            "post-checkout",
            "--",
            &old,
            head,
            "1",
        ],
        1,
    )?;
    Ok(())
}

/// Register only through Git. Returns success after checkout and its hook.
/// Donor is also the repository in which Git registers the destination.
pub fn worktree_add(
    donor: &Path,
    dest: &Path,
    commit: &str,
    opts: &Options,
) -> Result<WorktreeReport> {
    check_cancel()?;
    let donor = fs::canonicalize(donor)?;
    let root = git_s(&donor, &["rev-parse", "--show-toplevel"], 4)?;
    let donor = fs::canonicalize(bytes_path(
        root.stdout.strip_suffix(b"\n").unwrap_or(&root.stdout),
    )?)?;
    let parent = fs::canonicalize(
        dest.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    let dest = parent.join(
        dest.file_name()
            .ok_or_else(|| Error::new(2, "destination needs a name"))?,
    );
    if fs::symlink_metadata(&dest).is_ok() {
        return Err(Error::new(4, "destination already exists"));
    }
    if commit.starts_with('-') {
        return Err(Error::new(2, "commit-ish cannot be an option"));
    }
    // Hold the shared locks through checkout and seeding, including fallback.
    let locks = if opts.seed_target {
        Some(target::DonorLocks::acquire(&donor.join("target"))?)
    } else {
        None
    };
    git_s(
        &donor,
        &["rev-parse", "--verify", &format!("{commit}^{{commit}}")],
        4,
    )?;

    let donor_tree = entries(&donor, "HEAD")?;
    let wanted: std::collections::HashMap<_, _> = donor_tree
        .iter()
        .map(|e| (&e.path, (&e.oid, &e.mode)))
        .collect();
    let dirty = dirty(&donor)?;
    let capability = if opts.force_no_cow {
        Probe {
            cow: "none".into(),
            detail: "forced none by caller".into(),
        }
    } else {
        probe(&parent)?
    };
    let mut args: Vec<OsString> = vec!["worktree".into(), "add".into(), "--no-checkout".into()];
    if let Some(branch) = &opts.branch {
        args.push("-b".into());
        args.push(branch.into());
    }
    args.push("--".into());
    args.push(dest.as_os_str().into());
    args.push(commit.into());
    // No cancellation check between successful registration and arming guard.
    check_cancel()?;
    let o = git_command(&donor)
        .args(&args)
        .output()
        .map_err(|e| Error::new(4, e.to_string()))?;
    if !o.status.success() {
        check_cancel()?;
        return Err(Error::new(4, String::from_utf8_lossy(&o.stderr).trim()));
    }
    let mut registration = Registration {
        donor: donor.clone(),
        dest: dest.clone(),
        armed: true,
    };
    check_cancel()?;
    let tree = entries(&dest, "HEAD")?;
    git_s(&dest, &["read-tree", "HEAD"], 1)?;
    let mut report = WorktreeReport {
        fallback: if capability.cow == "none" {
            "git-checkout"
        } else {
            "none"
        }
        .into(),
        cloned_files: 0,
        checkout_files: tree.len() as u64,
        hashed_mismatches: 0,
        target: None,
        target_skipped: None,
    };
    let stage = unique_dir(&parent, dest.file_name().unwrap())?;
    let mut clones = Vec::new();
    if capability.cow != "none" {
        let conversions = checkout_conversions(&dest, &tree)?;
        for entry in &tree {
            check_cancel()?;
            if !["100644", "100755"].contains(&entry.mode.as_str())
                || dirty.contains(&entry.path)
                || conversions.contains(&entry.path)
                || wanted.get(&entry.path) != Some(&(&entry.oid, &entry.mode))
            {
                continue;
            }
            if ignored(&donor, &entry.path)? {
                continue;
            }
            let Ok(m) = regular(&donor, &entry.path) else {
                continue;
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = m.permissions().mode() & 0o7777;
                let expected = if entry.mode == "100755" { 0o755 } else { 0o644 };
                if mode != expected {
                    continue;
                }
            }
            #[cfg(not(unix))]
            let _ = m;
            let to = stage.path.join(&entry.path);
            fs::create_dir_all(to.parent().unwrap())?;
            if cow::clone_file(&donor.join(&entry.path), &to).is_err() {
                // EXDEV or any partial clone failure: remove our clones, then
                // perform one normal checkout. Never silently byte-copy.
                let _ = fs::remove_file(&to);
                for p in &clones {
                    fs::remove_file(p)?;
                }
                clones.clear();
                report.cloned_files = 0;
                report.fallback = "git-checkout".into();
                break;
            }
            let hash = git(
                &dest,
                &[
                    OsStr::new("hash-object"),
                    OsStr::new("--no-filters"),
                    OsStr::new("--"),
                    to.as_os_str(),
                ],
                1,
            );
            match hash {
                Ok(hash) if String::from_utf8_lossy(&hash.stdout).trim() == entry.oid => {
                    let published = dest.join(&entry.path);
                    fs::create_dir_all(published.parent().unwrap())?;
                    cow::rename_new(&to, &published)?;
                    clones.push(published);
                    report.cloned_files += 1;
                }
                Ok(_) => {
                    fs::remove_file(to)?;
                    report.hashed_mismatches += 1;
                }
                Err(e) if e.code == 130 => return Err(e),
                Err(_) => {
                    fs::remove_file(to)?;
                    for p in &clones {
                        fs::remove_file(p)?;
                    }
                    clones.clear();
                    report.cloned_files = 0;
                    report.fallback = "git-checkout".into();
                    break;
                }
            }
        }
    }
    // Refresh hashes and stat data for existing entries. Missing paths are
    // expected (checkout fills them), so status 1 here is not a Git failure.
    check_cancel()?;
    let refresh = git_command(&dest)
        .args(["update-index", "--refresh"])
        .output()?;
    if !matches!(refresh.status.code(), Some(0 | 1)) {
        return Err(Error::new(1, "index stat refresh failed"));
    }
    check_cancel()?;
    #[cfg(unix)]
    let clone_inodes = clones
        .iter()
        .map(|p| {
            use std::os::unix::fs::MetadataExt;
            fs::metadata(p).map(|m| (p, m.dev(), m.ino()))
        })
        .collect::<io::Result<Vec<_>>>()?;
    git_s(&dest, &["reset", "--hard", "HEAD"], 1)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        report.cloned_files = clone_inodes
            .iter()
            .filter(|(p, dev, ino)| {
                fs::metadata(p).is_ok_and(|m| m.dev() == *dev && m.ino() == *ino)
            })
            .count() as u64;
    }
    report.checkout_files = tree.len() as u64 - report.cloned_files;
    if opts.seed_target {
        if report.fallback != "none" {
            report.target_skipped = Some("cow-unavailable".into());
        } else if !donor.join("Cargo.toml").is_file() || !donor.join("target").is_dir() {
            report.target_skipped = Some("layout-unknown".into());
        } else {
            report.target = Some(target::seed_locked(
                &donor.join("target"),
                &dest.join("target"),
                locks.as_ref().unwrap(),
            )?);
        }
    }
    check_cancel()?;
    // --no-checkout suppresses this hook at registration, and reset --hard
    // does not run it. Capture its output to preserve the CLI JSON protocol.
    post_checkout(&dest)?;
    let admin = git_s(
        &dest,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "pwrgit-share.json",
        ],
        1,
    )?;
    let record = bytes_path(admin.stdout.strip_suffix(b"\n").unwrap_or(&admin.stdout))?;
    write_record(&record, report.cloned_files, report.checkout_files)?;
    registration.armed = false;
    Ok(report)
}
