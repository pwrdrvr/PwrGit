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
/// Run one Git process over a whole batch: stdin is fed from a thread so a
/// large tree cannot deadlock on full pipes.
fn git_batch(root: &Path, args: &[&str], input: Vec<u8>, ok: &[i32]) -> Result<Vec<u8>> {
    use std::io::Write;
    use std::process::Stdio;
    check_cancel()?;
    let mut child = git_command(root)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let out = child.wait_with_output()?;
    let _ = writer.join();
    check_cancel()?;
    if !out.status.code().is_some_and(|c| ok.contains(&c)) {
        return Err(Error::new(
            1,
            format!(
                "git {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        ));
    }
    Ok(out.stdout)
}
fn ignored_paths(root: &Path, entries: &[&Entry]) -> Result<HashSet<PathBuf>> {
    if entries.is_empty() {
        return Ok(HashSet::new());
    }
    let mut input = Vec::new();
    for e in entries {
        input.extend_from_slice(e.path.as_os_str().as_encoded_bytes());
        input.push(0);
    }
    // Exit 1 means nothing matched.
    let out = git_batch(
        root,
        &["check-ignore", "--no-index", "-z", "--stdin"],
        input,
        &[0, 1],
    )?;
    out.split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .map(bytes_path)
        .collect()
}
/// Blob IDs of the given files, in order, from one `git hash-object`.
fn hash_paths<'a>(root: &Path, paths: impl Iterator<Item = &'a Path>) -> Result<Vec<String>> {
    let mut input = Vec::new();
    let mut count = 0;
    for p in paths {
        input.extend_from_slice(p.as_os_str().as_encoded_bytes());
        input.push(b'\n');
        count += 1;
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    let out = git_batch(
        root,
        &["hash-object", "--no-filters", "--stdin-paths"],
        input,
        &[0],
    )?;
    let hashes: Vec<String> = String::from_utf8_lossy(&out)
        .lines()
        .map(|l| l.trim().to_owned())
        .collect();
    if hashes.len() != count {
        return Err(Error::new(
            1,
            "git hash-object returned the wrong number of IDs",
        ));
    }
    Ok(hashes)
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
    // Checkout only rewrites line endings when the output EOL is CRLF. With no
    // eol attribute, text files take core.eol (native: LF except on Windows).
    let core_eol = git_command(root)
        .args(["config", "--get", "core.eol"])
        .output()?;
    check_cancel()?;
    if !matches!(core_eol.status.code(), Some(0 | 1)) {
        return Err(Error::new(1, "cannot read core.eol"));
    }
    let core_eol = String::from_utf8_lossy(&core_eol.stdout)
        .trim()
        .to_ascii_lowercase();
    let native_lf = match core_eol.as_str() {
        "lf" => true,
        "" | "native" => !cfg!(windows),
        _ => false,
    };
    let mut attrs: std::collections::HashMap<PathBuf, Vec<Attr>> = std::collections::HashMap::new();
    // --cached reads the target's attributes from read-tree's index, even
    // before .gitattributes has been checked out. NUL-delimited input and
    // output preserve arbitrary Git path bytes.
    // One process for the whole tree: paths go in on stdin, NUL-delimited.
    let mut input = Vec::new();
    for e in tree {
        input.extend_from_slice(e.path.as_os_str().as_encoded_bytes());
        input.push(0);
    }
    let out = if tree.is_empty() {
        Vec::new()
    } else {
        git_batch(
            root,
            &["check-attr", "--cached", "-z", "--all", "--stdin"],
            input,
            &[0],
        )?
    };
    if !out.is_empty() {
        let bytes = out
            .strip_suffix(b"\0")
            .ok_or_else(|| Error::new(1, "invalid Git attribute response"))?;
        let fields = bytes.split(|b| *b == 0).collect::<Vec<_>>();
        let mut triples = fields.chunks_exact(3);
        for triple in &mut triples {
            attrs
                .entry(bytes_path(triple[0])?)
                .or_default()
                .push((triple[1].to_vec(), triple[2].to_vec()));
        }
        if !triples.remainder().is_empty() {
            return Err(Error::new(1, "invalid Git attribute response"));
        }
    }
    let mut conversions = HashSet::new();
    for (path, list) in attrs {
        if converts_on_checkout(&list, native_lf) {
            conversions.insert(path);
        }
    }
    Ok(conversions)
}

/// One clone worker's staged files and why it stopped early, if it did.
type Staged<'a> = (Vec<(&'a Entry, PathBuf)>, Option<Error>);

/// One `git check-attr` name/value pair.
type Attr = (Vec<u8>, Vec<u8>);

/// Whether Git's checkout would write bytes other than the blob's. --all
/// omits unspecified attributes. Any filter, ident, encoding or legacy crlf
/// attribute stays with Git, even when unset: the CLI renders -filter and a
/// driver literally named "unset" identically. Line endings are only
/// rewritten when the output EOL is CRLF, so LF output keeps the clone.
fn converts_on_checkout(list: &[Attr], native_lf: bool) -> bool {
    let get = |name: &[u8]| {
        list.iter()
            .find(|(n, _)| n.as_slice() == name)
            .map(|(_, v)| v.as_slice())
    };
    let always = [
        b"filter".as_slice(),
        b"ident".as_slice(),
        b"working-tree-encoding".as_slice(),
        b"crlf".as_slice(),
    ];
    if always.iter().any(|name| get(name).is_some()) {
        return true;
    }
    match get(b"eol") {
        Some(b"lf") => false,
        Some(_) => true,
        None => match get(b"text") {
            None | Some(b"unset") => false,
            Some(_) => !native_lf,
        },
    }
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
/// Target seeding never fails the worktree: a busy donor or a failed check
/// is reported as a reason with zero units.
pub fn worktree_add(
    donor: &Path,
    dest: &Path,
    commit: &str,
    opts: &Options,
) -> Result<WorktreeReport> {
    worktree_add_with(donor, dest, commit, opts, &target::SeedEnv::default())
}
pub(crate) fn worktree_add_with(
    donor: &Path,
    dest: &Path,
    commit: &str,
    opts: &Options,
    seed: &target::SeedEnv,
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
    // A donor that is building right now is skipped, not waited for.
    let locks = if opts.seed_target {
        match target::DonorLocks::acquire(&donor.join("target")) {
            Err(e) if e.code == 130 => return Err(e),
            r => Some(r),
        }
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
        let mut candidates = Vec::new();
        for entry in &tree {
            check_cancel()?;
            if !["100644", "100755"].contains(&entry.mode.as_str())
                || dirty.contains(&entry.path)
                || conversions.contains(&entry.path)
                || wanted.get(&entry.path) != Some(&(&entry.oid, &entry.mode))
                // hash-object --stdin-paths is line-based; Git checks these out.
                || entry.path.as_os_str().as_encoded_bytes().contains(&b'\n')
            {
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
            candidates.push(entry);
        }
        // One check-ignore and one hash-object for the whole tree, not one
        // Git process per file.
        let ignored = ignored_paths(&donor, &candidates)?;
        candidates.retain(|e| !ignored.contains(&e.path));
        // Clone, hash and publish in parallel chunks: one hash-object process
        // per chunk, never one Git process per file.
        let workers = std::thread::available_parallelism()
            .map_or(4, |n| n.get())
            .clamp(1, 8);
        let size = candidates.len().div_ceil(workers).max(1);
        let chunks: Vec<&[&Entry]> = candidates.chunks(size).collect();
        let stage_root = &stage.path;
        let cloned: Vec<Staged> = std::thread::scope(|s| {
            let handles: Vec<_> = chunks
                .iter()
                .map(|chunk| {
                    let donor = &donor;
                    s.spawn(move || {
                        let mut staged = Vec::new();
                        for entry in chunk.iter() {
                            if let Err(e) = check_cancel() {
                                return (staged, Some(e));
                            }
                            let to = stage_root.join(&entry.path);
                            let ok = fs::create_dir_all(to.parent().unwrap()).is_ok()
                                && cow::clone_file(&donor.join(&entry.path), &to).is_ok();
                            if !ok {
                                let _ = fs::remove_file(&to);
                                return (staged, Some(Error::new(1, "clone failed")));
                            }
                            staged.push((*entry, to));
                        }
                        (staged, None)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let stop = cloned.iter().find_map(|(_, e)| e.as_ref().map(|e| e.code));
        if let Some(code) = stop {
            // EXDEV or any partial clone failure: remove our clones, then
            // perform one normal checkout. Never silently byte-copy.
            for (staged, _) in &cloned {
                for (_, to) in staged {
                    let _ = fs::remove_file(to);
                }
            }
            if code == 130 {
                return Err(Error::new(130, "cancelled"));
            }
            report.fallback = "git-checkout".into();
        } else {
            let dest_ref = &dest;
            let hashed: Vec<Result<(Vec<PathBuf>, u64)>> = std::thread::scope(|s| {
                let handles: Vec<_> = cloned
                    .iter()
                    .map(|(staged, _)| {
                        s.spawn(move || -> Result<(Vec<PathBuf>, u64)> {
                            let hashes = match hash_paths(
                                dest_ref,
                                staged.iter().map(|(_, to)| to.as_path()),
                            ) {
                                Ok(h) => h,
                                Err(e) => {
                                    for (_, to) in staged {
                                        let _ = fs::remove_file(to);
                                    }
                                    return Err(e);
                                }
                            };
                            let mut published = Vec::new();
                            let mut mismatches = 0;
                            for ((entry, to), hash) in staged.iter().zip(hashes) {
                                if hash == entry.oid {
                                    let target = dest_ref.join(&entry.path);
                                    fs::create_dir_all(target.parent().unwrap())?;
                                    cow::rename_new(to, &target)?;
                                    published.push(target);
                                } else {
                                    fs::remove_file(to)?;
                                    mismatches += 1;
                                }
                            }
                            Ok((published, mismatches))
                        })
                    })
                    .collect();
                handles.into_iter().map(|h| h.join().unwrap()).collect()
            });
            if let Some(Err(e)) = hashed.iter().find(|r| r.is_err()) {
                for (published, _) in hashed.iter().flatten() {
                    for p in published {
                        let _ = fs::remove_file(p);
                    }
                }
                if e.code == 130 {
                    return Err(Error::new(130, "cancelled"));
                }
                report.cloned_files = 0;
                report.fallback = "git-checkout".into();
            } else {
                for (published, mismatches) in hashed.into_iter().flatten() {
                    report.cloned_files += published.len() as u64;
                    report.hashed_mismatches += mismatches;
                    clones.extend(published);
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
            report.target = Some(match locks.as_ref().unwrap() {
                Err(e) => target::lock_skip(e),
                Ok(locks) => match target::seed_locked(
                    &donor.join("target"),
                    &dest.join("target"),
                    locks,
                    seed,
                ) {
                    Ok(r) => r,
                    Err(e) if e.code == 130 => return Err(e),
                    Err(e) => target::SeedReport::skipped("seed-error", Some(e.detail)),
                },
            });
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
