//! Registry-only Cargo target seeding.
//!
//! Only units of third-party packages (registry or git sources whose manifest
//! lives under the recipient's CARGO_HOME) are ever cloned. Workspace, path,
//! patched-to-path and vendored units are never candidates. Every staged byte
//! is scanned for the donor's paths; a unit that embeds one is rejected, and so
//! is every package that depends on a rejected or missing one.
use crate::*;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedReport {
    pub units_seeded: u64,
    pub packages_seeded: u64,
    /// Donor units of candidate packages that were left out, by reason.
    pub units_skipped: BTreeMap<String, u64>,
    /// Recipient packages that were not seeded, by reason.
    pub packages_rejected: BTreeMap<String, u64>,
    pub clone_count: u64,
    pub copy_count: u64,
    /// Rustc dep-info files rewritten to name the recipient's target, which is
    /// what a cold build in the recipient writes.
    pub rewritten_count: u64,
    /// "bounded" (default) or "strict".
    pub mode: SeedMode,
    /// Seeded units whose artifacts still name a donor OUT_DIR of a seeded
    /// build script (bounded mode only). Backtraces, panic locations and
    /// debugger paths for that generated code point into the donor's target.
    pub units_seeded_with_donor_out_dir_paths: u64,
    /// Seeded build-script and proc-macro executables whose macOS debug map
    /// (N_OSO) names donor objects (bounded mode only).
    pub units_seeded_with_donor_debug_maps: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}
impl SeedReport {
    pub(crate) fn skipped(reason: &str, detail: Option<String>) -> Self {
        Self {
            reason: Some(reason.into()),
            detail,
            ..Default::default()
        }
    }
}

/// How strictly seeded artifacts may name the donor.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SeedMode {
    /// Strict, plus two bounded exceptions: a seeded build script's OUT_DIR
    /// (verified to be a copy of the donor's), and macOS debug maps inside
    /// build-script and proc-macro executables, which never reach a final
    /// binary.
    #[default]
    Bounded,
    /// No donor path in any seeded artifact beyond what Cargo or rustc
    /// rewrite (root-output, `output`'s own OUT_DIR, dep-info) and a proc
    /// macro's own install name.
    Strict,
}

/// Test-only inputs. Production always inherits CARGO_HOME and requires an
/// exact proven Cargo version.
#[derive(Default)]
pub(crate) struct SeedEnv {
    pub home: Option<PathBuf>,
    #[cfg(test)]
    pub experiment: bool,
}
impl SeedEnv {
    fn experiment(&self) -> bool {
        #[cfg(test)]
        return self.experiment;
        #[cfg(not(test))]
        false
    }
}

pub(crate) struct DonorLocks {
    _files: Vec<File>,
    profiles: HashSet<PathBuf>,
}
impl DonorLocks {
    pub(crate) fn acquire(target: &Path) -> Result<Self> {
        let mut locks = Self {
            _files: Vec::new(),
            profiles: Default::default(),
        };
        fn walk(root: &Path, path: &Path, depth: usize, locks: &mut DonorLocks) -> Result<()> {
            check_cancel()?;
            let m = fs::symlink_metadata(path)?;
            if m.is_symlink() {
                return Ok(());
            }
            if m.is_dir() {
                // Lock files live in profile directories (target/<profile> or
                // target/<triple>/<profile>); unit directories never hold one.
                if depth > 3 {
                    return Ok(());
                }
                for entry in fs::read_dir(path)? {
                    let p = entry?.path();
                    let skip = p.file_name().is_some_and(|n| {
                        ["incremental", "deps", "build", ".fingerprint", "examples"]
                            .iter()
                            .any(|s| n == *s)
                    });
                    if !skip {
                        walk(root, &p, depth + 1, locks)?;
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
            walk(target, target, 0, &mut locks)?;
        }
        Ok(locks)
    }
}

/// A busy or unreadable donor is a skip reason, never a failure (R6).
pub(crate) fn lock_skip(e: &Error) -> SeedReport {
    let reason = if e.code == 3 {
        "donor-busy"
    } else {
        "donor-lock-failed"
    };
    SeedReport::skipped(reason, Some(e.detail.clone()))
}

pub fn target_seed(from: &Path, to: &Path, mode: SeedMode) -> Result<SeedReport> {
    let locks = match DonorLocks::acquire(from) {
        Ok(locks) => locks,
        Err(e) if e.code == 130 => return Err(e),
        Err(e) => {
            let mut r = lock_skip(&e);
            r.mode = mode;
            return Ok(r);
        }
    };
    seed_locked(from, to, &locks, &SeedEnv::default(), mode)
}

// There is deliberately no public flag or environment variable that bypasses
// the proven-version list. Only this crate's own gate can.
pub(crate) fn seed_locked(
    from: &Path,
    to: &Path,
    locks: &DonorLocks,
    env: &SeedEnv,
    mode: SeedMode,
) -> Result<SeedReport> {
    let mut report = seed_impl(from, to, locks, env, mode)?;
    report.mode = mode;
    Ok(report)
}
fn seed_impl(
    from: &Path,
    to: &Path,
    locks: &DonorLocks,
    env: &SeedEnv,
    mode: SeedMode,
) -> Result<SeedReport> {
    check_cancel()?;
    if fs::symlink_metadata(to).is_ok() {
        // Never seed into, or merge with, a target that already exists.
        return Ok(SeedReport::skipped("target-exists", None));
    }
    if from == to {
        return Err(Error::new(1, "target must be separate from donor"));
    }
    let parent = fs::canonicalize(
        to.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    let name = to
        .file_name()
        .ok_or_else(|| Error::new(1, "target needs a name"))?;
    let to = parent.join(name);
    if probe(&parent)?.cow == "none" {
        return Ok(SeedReport::skipped("cow-unavailable", None));
    }
    if fs::symlink_metadata(from)?.is_symlink() {
        return Err(Error::new(1, "donor target cannot be a symlink"));
    }
    let given_donor = from.parent().map(Path::to_path_buf);
    let from = fs::canonicalize(from)?;
    if !cow_same_device(&from, &parent)? {
        return Ok(SeedReport::skipped("cross-filesystem", None));
    }
    if parent.starts_with(&from) {
        return Err(Error::new(
            1,
            "target destination must be outside the donor target",
        ));
    }
    let Some(donor) = from
        .parent()
        .filter(|p| regular(p, Path::new("Cargo.toml")).is_ok())
    else {
        return Ok(SeedReport::skipped("layout-unknown", None));
    };
    // The recipient is the directory whose target this becomes. Its toolchain
    // file, lockfile and config govern, so every probe runs there.
    let recipient = parent.as_path();
    if regular(recipient, Path::new("Cargo.toml")).is_err() {
        return Ok(SeedReport::skipped("layout-unknown", None));
    }
    if recipient == donor {
        return Err(Error::new(1, "recipient must be separate from donor"));
    }
    if let Some(var) = env_override() {
        return Ok(SeedReport::skipped("env-override", Some(var)));
    }
    let Some(home) = cargo_home(env) else {
        return Ok(SeedReport::skipped("cargo-home-unknown", None));
    };
    // R4: same toolchain, read from the recipient and the donor directories.
    let Some(tool) = toolchain(recipient, &home)? else {
        return Ok(SeedReport::skipped("toolchain-unavailable", None));
    };
    match toolchain(donor, &home)? {
        Some(d) if d == tool => {}
        other => {
            return Ok(SeedReport::skipped(
                "toolchain-mismatch",
                Some(format!(
                    "recipient {:?}, donor {:?}",
                    tool.cargo,
                    other.map(|t| t.cargo)
                )),
            ));
        }
    }
    let info = regular(&from, Path::new(".rustc_info.json"))
        .ok()
        .and_then(|_| fs::read(from.join(".rustc_info.json")).ok());
    if info.is_none_or(|i| memchr::memmem::find(&i, tool.commit.as_bytes()).is_none()) {
        return Ok(SeedReport::skipped(
            "toolchain-mismatch",
            Some("donor target was not built by the recipient's rustc".into()),
        ));
    }
    if !env.experiment() && !PROVEN_CARGO.contains(&tool.cargo.as_str()) {
        return Ok(SeedReport::skipped(
            "fingerprint-unproven",
            Some(tool.cargo.clone()),
        ));
    }
    let roots = [donor, recipient];
    if let Err((reason, detail)) = config_check(donor, recipient, &home, &roots) {
        return Ok(SeedReport::skipped(reason, Some(detail)));
    }
    let meta = match metadata(recipient, &home, &tool.host) {
        Ok(m) => m,
        Err(e) if e.code == 130 => return Err(e),
        Err(e) => return Ok(SeedReport::skipped("metadata-unavailable", Some(e.detail))),
    };
    let graph = Graph::new(&meta, &home)?;
    let mut needles = vec![donor.as_os_str().as_encoded_bytes().to_vec()];
    if let Some(given) = given_donor.filter(|g| g.is_absolute() && g != donor) {
        needles.push(given.as_os_str().as_encoded_bytes().to_vec());
    }
    let ctx = Ctx {
        from: &from,
        to: &to,
        graph: &graph,
        needles,
        mode,
    };
    let units = discover(&ctx, locks)?;
    publish(&ctx, units)
}

/// Internal error code: the filesystem refused a clone mid-seed.
const NO_CLONE: i32 = 75;

// Exact `cargo --version` strings that passed src/gate.rs. Every other
// version reports fingerprint-unproven.
pub(crate) const PROVEN_CARGO: &[&str] = &["cargo 1.97.1 (c980f4866 2026-06-30)"];

/// Environment that changes what Cargo builds or where, which a fingerprint
/// recorded in another worktree cannot be trusted to capture.
fn env_override() -> Option<String> {
    const EXACT: &[&str] = &[
        "RUSTFLAGS",
        "CARGO_ENCODED_RUSTFLAGS",
        "RUSTC",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
    ];
    const PREFIX: &[&str] = &[
        "CARGO_BUILD_",
        "CARGO_TARGET_",
        "CARGO_PROFILE_",
        "CARGO_UNSTABLE_",
    ];
    std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .filter(|k| k != "CARGO_BUILD_JOBS")
        .find(|k| EXACT.contains(&k.as_str()) || PREFIX.iter().any(|p| k.starts_with(p)))
}

fn cargo_home(env: &SeedEnv) -> Option<PathBuf> {
    let home = match &env.home {
        Some(h) => h.clone(),
        None => match std::env::var_os("CARGO_HOME").filter(|h| !h.is_empty()) {
            Some(h) => std::env::current_dir().ok()?.join(h),
            None => PathBuf::from(std::env::var_os("HOME")?).join(".cargo"),
        },
    };
    fs::canonicalize(home).ok()
}

fn tool_command(program: &str, dir: &Path, home: &Path) -> Command {
    let mut cmd = Command::new(program);
    // rustup exports the caller's toolchain to children; drop it so the
    // directory's rust-toolchain.toml decides, as it will for the user.
    cmd.current_dir(dir)
        .env("CARGO_HOME", home)
        .env_remove("RUSTUP_TOOLCHAIN");
    cmd
}

#[derive(Debug, PartialEq)]
struct Toolchain {
    rustc: String,
    cargo: String,
    host: String,
    commit: String,
}
fn toolchain(dir: &Path, home: &Path) -> Result<Option<Toolchain>> {
    let run = |program: &str, arg: &str| -> Result<Option<String>> {
        check_cancel()?;
        let o = tool_command(program, dir, home).arg(arg).output();
        check_cancel()?;
        Ok(o.ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()))
    };
    let (Some(rustc), Some(cargo)) = (run("rustc", "-vV")?, run("cargo", "--version")?) else {
        return Ok(None);
    };
    let field = |name: &str| {
        rustc
            .lines()
            .find_map(|l| l.strip_prefix(name))
            .unwrap_or("")
            .to_owned()
    };
    let (host, commit) = (field("host: "), field("commit-hash: "));
    if host.is_empty() || commit.is_empty() {
        return Ok(None);
    }
    Ok(Some(Toolchain {
        rustc,
        cargo,
        host,
        commit,
    }))
}

/// Cargo config keys that change the toolchain, flags or layout in ways a
/// fingerprint from another directory may not capture.
const DENIED_CONFIG: &[&str] = &[
    "rustflags",
    "rustc",
    "rustc-wrapper",
    "rustc-workspace-wrapper",
    "target-dir",
    "build-dir",
    "paths",
    "unstable",
];

/// Config that differs between the worktrees or embeds either path. In-repo
/// files must match byte-for-byte; files above the repositories (including
/// CARGO_HOME's) must be the same files for both.
fn config_check(
    donor: &Path,
    recipient: &Path,
    home: &Path,
    roots: &[&Path],
) -> std::result::Result<(), (&'static str, String)> {
    fn found(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for dir in root.ancestors() {
            for name in ["config", "config.toml"] {
                let p = dir.join(".cargo").join(name);
                if fs::metadata(&p).is_ok_and(|m| m.is_file()) {
                    out.push(fs::canonicalize(&p).unwrap_or(p));
                }
            }
        }
        out
    }
    let split = |root: &Path| {
        let (inside, outside): (Vec<_>, Vec<_>) =
            found(root).into_iter().partition(|p| p.starts_with(root));
        let inside: Vec<PathBuf> = inside
            .into_iter()
            .map(|p| p.strip_prefix(root).unwrap().to_path_buf())
            .collect();
        (inside, outside)
    };
    let (d_in, d_out) = split(donor);
    let (r_in, r_out) = split(recipient);
    if d_in != r_in || d_out != r_out {
        return Err(("config-differs", "Cargo config files differ".into()));
    }
    let mut files: Vec<PathBuf> = r_in.iter().map(|p| recipient.join(p)).collect();
    for p in &r_in {
        let (a, b) = (fs::read(donor.join(p)), fs::read(recipient.join(p)));
        if a.is_err() || a.ok() != b.ok() {
            return Err(("config-differs", p.display().to_string()));
        }
    }
    files.extend(r_out);
    for name in ["config", "config.toml"] {
        let p = home.join(name);
        if fs::metadata(&p).is_ok_and(|m| m.is_file()) {
            files.push(p);
        }
    }
    for file in files {
        let Ok(text) = fs::read(&file) else {
            return Err(("config-differs", file.display().to_string()));
        };
        if roots
            .iter()
            .any(|r| memchr::memmem::find(&text, r.as_os_str().as_encoded_bytes()).is_some())
        {
            return Err(("config-embeds-worktree-path", file.display().to_string()));
        }
        if let Some(key) = denied_config_key(&String::from_utf8_lossy(&text)) {
            return Err(("config-unsupported", format!("{}: {key}", file.display())));
        }
    }
    Ok(())
}
fn denied_config_key(text: &str) -> Option<&'static str> {
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").to_ascii_lowercase();
        for token in line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
            if let Some(key) = DENIED_CONFIG.iter().find(|k| **k == token) {
                return Some(key);
            }
        }
    }
    None
}

fn metadata(recipient: &Path, home: &Path, host: &str) -> Result<serde_json::Value> {
    // --offline never touches the index or the network; --locked refuses to
    // write the recipient's lockfile.
    let mut cmd = tool_command("cargo", recipient, home);
    cmd.args([
        "metadata",
        "--offline",
        "--locked",
        "--filter-platform",
        host,
        "--format-version",
        "1",
    ]);
    let o = output(&mut cmd, 1)?;
    Ok(serde_json::from_slice(&o.stdout)?)
}

struct Pkg {
    name: String,
    /// Crate name of the lib or proc-macro target, and its canonical root.
    lib: Option<(String, PathBuf)>,
    proc_macro: bool,
    build_script: Option<PathBuf>,
    /// Resolved dependencies and the extern crate name the dependent uses
    /// for each (None when Cargo did not report one).
    deps: Vec<(usize, Option<String>)>,
    /// Some(reason) when R1 excludes the package outright.
    excluded: Option<&'static str>,
}
struct Graph {
    pkgs: Vec<Pkg>,
    by_dir: Vec<(PathBuf, usize)>,
}
impl Graph {
    fn new(meta: &serde_json::Value, home: &Path) -> Result<Self> {
        let bad = || Error::new(1, "invalid Cargo metadata");
        let members: HashSet<&str> = meta["workspace_members"]
            .as_array()
            .ok_or_else(bad)?
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        let packages = meta["packages"].as_array().ok_or_else(bad)?;
        let index: HashMap<&str, usize> = packages
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p["id"].as_str().map(|id| (id, i)))
            .collect();
        let roots = [
            home.join("registry").join("src"),
            home.join("git").join("checkouts"),
        ];
        let mut pkgs = Vec::new();
        let mut by_dir = Vec::new();
        for (i, p) in packages.iter().enumerate() {
            let id = p["id"].as_str().ok_or_else(bad)?;
            let source = p["source"].as_str().unwrap_or("");
            let manifest = p["manifest_path"]
                .as_str()
                .and_then(|m| fs::canonicalize(m).ok());
            let dir = manifest
                .as_ref()
                .and_then(|m| m.parent())
                .map(Path::to_path_buf);
            let canonical =
                |s: &serde_json::Value| s.as_str().and_then(|s| fs::canonicalize(s).ok());
            let mut lib = None;
            let mut proc_macro = false;
            let mut build_script = None;
            let mut odd = false;
            for t in p["targets"].as_array().ok_or_else(bad)? {
                let kinds: Vec<&str> = t["kind"]
                    .as_array()
                    .map(|k| k.iter().filter_map(|v| v.as_str()).collect())
                    .unwrap_or_default();
                if kinds.contains(&"custom-build") {
                    build_script = canonical(&t["src_path"]);
                    odd |= build_script.is_none();
                } else if kinds.iter().any(|k| {
                    ["lib", "rlib", "proc-macro", "dylib", "cdylib", "staticlib"].contains(k)
                }) {
                    // Only plain libraries and proc macros have the proven
                    // layout; other crate types stay with Cargo.
                    odd |= lib.is_some()
                        || !kinds
                            .iter()
                            .all(|k| ["lib", "rlib", "proc-macro"].contains(k));
                    proc_macro = kinds.contains(&"proc-macro");
                    let name = t["name"].as_str().unwrap_or("").replace('-', "_");
                    match canonical(&t["src_path"]) {
                        Some(src) => lib = Some((name, src)),
                        None => odd = true,
                    }
                }
            }
            // R1: the source kind alone is not enough. A replaced (vendored or
            // directory) source still reports registry+, so the manifest must
            // also lie in the recipient's CARGO_HOME.
            let excluded = if members.contains(id) {
                Some("workspace")
            } else if !["registry+", "sparse+", "git+"]
                .iter()
                .any(|s| source.starts_with(s))
            {
                Some("path-source")
            } else if !dir
                .as_ref()
                .is_some_and(|d| roots.iter().any(|r| d.starts_with(r) && d != r))
            {
                Some("outside-cargo-home")
            } else if odd {
                Some("unsupported-target")
            } else {
                None
            };
            if excluded.is_none() {
                by_dir.push((dir.unwrap(), i));
            }
            pkgs.push(Pkg {
                name: p["name"].as_str().unwrap_or("").to_owned(),
                lib,
                proc_macro,
                build_script,
                deps: Vec::new(),
                excluded,
            });
        }
        for node in meta["resolve"]["nodes"].as_array().ok_or_else(bad)? {
            let Some(&i) = node["id"].as_str().and_then(|id| index.get(id)) else {
                return Err(bad());
            };
            // `deps` carries the extern name each dependent compiles against;
            // without it every edge counts as used.
            let mut named = HashMap::new();
            for d in node["deps"].as_array().into_iter().flatten() {
                if let (Some(pkg), Some(name)) = (d["pkg"].as_str(), d["name"].as_str()) {
                    named.insert(pkg, name.to_owned());
                }
            }
            for d in node["dependencies"].as_array().ok_or_else(bad)? {
                let Some((id, &j)) = d.as_str().and_then(|id| index.get_key_value(id)) else {
                    return Err(bad());
                };
                pkgs[i].deps.push((j, named.get(id).cloned()));
            }
        }
        Ok(Self { pkgs, by_dir })
    }
    /// The eligible package that owns this source file.
    fn owner(&self, src: &Path) -> Option<usize> {
        let mut owners = self
            .by_dir
            .iter()
            .filter(|(d, _)| src.starts_with(d))
            .map(|(_, i)| *i);
        let first = owners.next();
        if owners.next().is_some() {
            return None;
        }
        first
    }
}

struct Ctx<'a> {
    from: &'a Path,
    to: &'a Path,
    graph: &'a Graph,
    needles: Vec<Vec<u8>>,
    mode: SeedMode,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Lib,
    BuildCompile,
    BuildRun,
}
struct Unit {
    kind: Kind,
    pkg: usize,
    /// target/<profile>, relative to the donor target.
    profile: PathBuf,
    /// <package>-<hash> directory name, and the hash.
    dir: String,
    hash: String,
    /// Regular files of the unit, relative to the donor target.
    files: Vec<PathBuf>,
    /// Directories that must exist in the stage, relative.
    dirs: Vec<PathBuf>,
    /// Extern names of the dependencies this unit was compiled against.
    uses: HashSet<String>,
}
impl Unit {
    fn display(&self, g: &Graph) -> String {
        format!("{}/{}", g.pkgs[self.pkg].name, self.dir)
    }
}

fn hex16(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

/// The first prerequisite of a Makefile-style rustc dep-info file whose
/// target is `expected`.
fn first_prerequisite(depinfo: &[u8], expected: &Path) -> Option<PathBuf> {
    let mut head = expected.as_os_str().as_encoded_bytes().to_vec();
    head.extend_from_slice(b": ");
    let rest = depinfo.strip_prefix(head.as_slice())?;
    let mut out = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        match rest[i] {
            b'\\' if rest.get(i + 1) == Some(&b' ') => {
                out.push(b' ');
                i += 2;
                continue;
            }
            b' ' | b'\n' | b'\r' => break,
            b => out.push(b),
        }
        i += 1;
    }
    if out.is_empty() {
        return None;
    }
    Some(unsafe_free_path(out))
}
fn unsafe_free_path(bytes: Vec<u8>) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        PathBuf::from(std::ffi::OsString::from_vec(bytes))
    }
    #[cfg(not(unix))]
    PathBuf::from(String::from_utf8_lossy(&bytes).into_owned())
}

/// Files of a fingerprint directory, if it has exactly the layout of one unit
/// of the given kind and name.
fn fingerprint_files(dir: &Path, unit: &str) -> Option<Vec<PathBuf>> {
    let allowed = [
        unit.to_owned(),
        format!("{unit}.json"),
        format!("dep-{unit}"),
        format!("output-{unit}"),
        "invoked.timestamp".to_owned(),
    ];
    let mut files = Vec::new();
    for e in fs::read_dir(dir).ok()? {
        let e = e.ok()?;
        if !e.file_type().ok()?.is_file() || !allowed.iter().any(|a| e.file_name() == a.as_str()) {
            return None;
        }
        files.push(e.path());
    }
    let has = |n: &str| files.iter().any(|f| f.file_name().is_some_and(|x| x == n));
    (has(unit) && has(&format!("{unit}.json"))).then_some(files)
}

/// Every regular file under `dir`, plus its directories. None on a symlink or
/// anything else that is not a plain file or directory.
fn tree(dir: &Path, files: &mut Vec<PathBuf>, dirs: &mut Vec<PathBuf>) -> Option<()> {
    dirs.push(dir.to_path_buf());
    for e in fs::read_dir(dir).ok()? {
        let e = e.ok()?;
        let t = e.file_type().ok()?;
        if t.is_dir() {
            tree(&e.path(), files, dirs)?;
        } else if t.is_file() {
            files.push(e.path());
        } else {
            return None;
        }
    }
    Some(())
}

struct Discovery {
    units: Vec<Unit>,
    /// Packages with a unit that contradicts the package's metadata. The
    /// whole package is rejected.
    broken: HashMap<usize, String>,
    /// Incomplete or unproven units (stale leftovers, RUSTFLAGS builds). Only
    /// the unit is skipped; Cargo rebuilds it if the recipient needs it.
    incomplete: Vec<(usize, String)>,
}

fn discover(ctx: &Ctx, locks: &DonorLocks) -> Result<Discovery> {
    let g = ctx.graph;
    let from = ctx.from;
    let mut out = Discovery {
        units: Vec::new(),
        broken: HashMap::new(),
        incomplete: Vec::new(),
    };
    let mut runs = Vec::new();
    // Package-id hashes Cargo records for a package's own build script, learnt
    // from that package's attributed library units.
    let mut build_hash: HashMap<u64, HashSet<usize>> = HashMap::new();
    let mut profiles: Vec<PathBuf> = Vec::new();
    for e in fs::read_dir(from)? {
        let e = e?;
        // Host profiles only: target/<profile>. Cross targets
        // (target/<triple>/<profile>) are left to Cargo.
        if e.file_type()?.is_dir() && locks.profiles.contains(&e.path()) {
            profiles.push(e.path());
        }
    }
    profiles.sort();
    for profile in profiles {
        let rel_profile = profile.strip_prefix(from).unwrap().to_path_buf();
        let fp_root = profile.join(".fingerprint");
        if !fs::symlink_metadata(&fp_root).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        // deps/ holds every unit's artifacts; index it once by unit hash.
        let mut deps_index: HashMap<String, Vec<(String, bool)>> = HashMap::new();
        if let Ok(rd) = fs::read_dir(profile.join("deps")) {
            for e in rd {
                let e = e?;
                let Ok(n) = e.file_name().into_string() else {
                    continue;
                };
                let stem = n.split('.').next().unwrap_or("");
                if let Some((_, h)) = stem.rsplit_once('-').filter(|(_, h)| hex16(h)) {
                    let file = e.file_type()?.is_file();
                    deps_index.entry(h.to_owned()).or_default().push((n, file));
                }
            }
        }
        let mut entries: Vec<_> = fs::read_dir(&fp_root)?.collect::<io::Result<_>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            check_cancel()?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(dir) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some((pkgname, hash)) = dir.rsplit_once('-') else {
                continue;
            };
            if !hex16(hash) {
                continue;
            }
            let fp = entry.path();
            let names: Vec<String> = fs::read_dir(&fp)?
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect();
            let lib_name = names
                .iter()
                .find_map(|n| n.strip_prefix("lib-").filter(|n| !n.contains('.')))
                .map(str::to_owned);
            let kind = if names
                .iter()
                .any(|n| n == "run-build-script-build-script-build")
            {
                Kind::BuildRun
            } else if names.iter().any(|n| n == "build-script-build-script-build") {
                Kind::BuildCompile
            } else if lib_name.is_some() {
                Kind::Lib
            } else {
                // Tests, binaries, docs, workspace-only kinds: never seeded.
                continue;
            };
            let unit_name = match kind {
                Kind::Lib => format!("lib-{}", lib_name.as_deref().unwrap()),
                Kind::BuildCompile => "build-script-build-script-build".into(),
                Kind::BuildRun => "run-build-script-build-script-build".into(),
            };
            let fp_files = fingerprint_files(&fp, &unit_name);
            let json: Option<serde_json::Value> = fp
                .join(format!("{unit_name}.json"))
                .exists()
                .then(|| fs::read(fp.join(format!("{unit_name}.json"))).ok())
                .flatten()
                .and_then(|b| serde_json::from_slice(&b).ok());
            let rel = |p: &Path| p.strip_prefix(from).unwrap().to_path_buf();
            match kind {
                Kind::Lib => {
                    let crate_name = lib_name.unwrap();
                    let deps = profile.join("deps");
                    let d = deps.join(format!("{crate_name}-{hash}.d"));
                    let Some(src) = regular(from, &rel(&d))
                        .ok()
                        .and_then(|_| fs::read(&d).ok())
                        .and_then(|b| first_prerequisite(&b, &d))
                    else {
                        continue;
                    };
                    let Some(pkg) = g.owner(&src) else {
                        continue;
                    };
                    let p = &g.pkgs[pkg];
                    let Some((lib, root)) = &p.lib else {
                        out.broken.insert(pkg, format!("{dir}: no library target"));
                        continue;
                    };
                    if *lib != crate_name || *root != src || p.name != pkgname {
                        out.broken
                            .insert(pkg, format!("{dir}: unit does not match package"));
                        continue;
                    }
                    let (Some(fp_files), Some(json)) = (fp_files, json) else {
                        out.incomplete
                            .push((pkg, format!("{dir}: fingerprint layout")));
                        continue;
                    };
                    let a = format!("lib{crate_name}-{hash}.");
                    let b = format!("{crate_name}-{hash}.");
                    let mut files = fp_files;
                    let mut ok = true;
                    for (n, file) in deps_index.get(hash).into_iter().flatten() {
                        if !(n.starts_with(&a) || n.starts_with(&b)) {
                            continue;
                        }
                        let ext = n.rsplit('.').next().unwrap_or("");
                        ok &= *file && ["rlib", "rmeta", "dylib", "so", "d", "o"].contains(&ext);
                        files.push(deps.join(n));
                    }
                    let has = |ext: &str| {
                        files
                            .iter()
                            .any(|f| f.file_name().is_some_and(|n| *n == *format!("{a}{ext}")))
                    };
                    // A build leaves rlib + rmeta; `cargo check` leaves rmeta.
                    ok &= if p.proc_macro {
                        has(std::env::consts::DLL_EXTENSION)
                    } else {
                        has("rmeta")
                    };
                    if !ok || !fingerprint_ok(&json) {
                        out.incomplete
                            .push((pkg, format!("{dir}: artifact layout")));
                        continue;
                    }
                    for dep in json["deps"].as_array().into_iter().flatten() {
                        if dep[1] == "build_script_build"
                            && let Some(h) = dep[0].as_u64()
                        {
                            build_hash.entry(h).or_default().insert(pkg);
                        }
                    }
                    out.units.push(Unit {
                        kind,
                        pkg,
                        profile: rel_profile.clone(),
                        dir: dir.clone(),
                        hash: hash.into(),
                        files: files.iter().map(|f| rel(f)).collect(),
                        dirs: vec![rel(&fp), rel(&deps)],
                        uses: uses(&json),
                    });
                }
                Kind::BuildCompile => {
                    let bdir = profile.join("build").join(&dir);
                    let d = bdir.join(format!("build_script_build-{hash}.d"));
                    let Some(src) = regular(from, &rel(&d))
                        .ok()
                        .and_then(|_| fs::read(&d).ok())
                        .and_then(|b| first_prerequisite(&b, &d))
                    else {
                        continue;
                    };
                    let Some(pkg) = g.owner(&src) else {
                        continue;
                    };
                    let p = &g.pkgs[pkg];
                    if p.build_script.as_ref() != Some(&src) || p.name != pkgname {
                        out.broken
                            .insert(pkg, format!("{dir}: unit does not match package"));
                        continue;
                    }
                    let (Some(mut files), Some(json)) = (fp_files, json) else {
                        out.incomplete
                            .push((pkg, format!("{dir}: fingerprint layout")));
                        continue;
                    };
                    let mut dirs = vec![fp.clone()];
                    let mut built = Vec::new();
                    let ok = tree(&bdir, &mut built, &mut dirs).is_some()
                        && dirs.len() == 2
                        && built.iter().all(|f| {
                            f.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                                n == "build-script-build"
                                    || n.starts_with(&format!("build_script_build-{hash}"))
                            })
                        })
                        && fingerprint_ok(&json);
                    if !ok {
                        out.incomplete
                            .push((pkg, format!("{dir}: build script layout")));
                        continue;
                    }
                    files.extend(built);
                    out.units.push(Unit {
                        kind,
                        pkg,
                        profile: rel_profile.clone(),
                        dir: dir.clone(),
                        hash: hash.into(),
                        files: files.iter().map(|f| rel(f)).collect(),
                        dirs: dirs.iter().map(|d| rel(d)).collect(),
                        uses: uses(&json),
                    });
                }
                Kind::BuildRun => runs.push((rel_profile.clone(), dir.clone(), fp, fp_files, json)),
            }
        }
    }
    // A build-script run names no source file. Attribute it through the
    // package-id hash its package's own library units recorded for it.
    for (rel_profile, dir, fp, fp_files, json) in runs {
        check_cancel()?;
        let (pkgname, hash) = dir.rsplit_once('-').unwrap();
        let entries = json
            .as_ref()
            .and_then(|j| j["deps"].as_array())
            .cloned()
            .unwrap_or_default();
        let [entry] = entries.as_slice() else {
            continue;
        };
        let Some(owners) = entry[0].as_u64().and_then(|h| build_hash.get(&h)) else {
            continue;
        };
        if entry[1] != "build_script_build" || owners.len() != 1 {
            continue;
        }
        let pkg = *owners.iter().next().unwrap();
        if g.pkgs[pkg].name != pkgname {
            out.broken
                .insert(pkg, format!("{dir}: unit does not match package"));
            continue;
        }
        let profile = from.join(&rel_profile);
        let bdir = profile.join("build").join(&dir);
        let (Some(mut files), Some(json)) = (fp_files, json) else {
            out.incomplete
                .push((pkg, format!("{dir}: fingerprint layout")));
            continue;
        };
        let rel = |p: &Path| p.strip_prefix(from).unwrap().to_path_buf();
        let mut dirs = vec![fp.clone()];
        let mut built = Vec::new();
        let ok = tree(&bdir, &mut built, &mut dirs).is_some()
            && ["output", "root-output"]
                .iter()
                .all(|n| built.contains(&bdir.join(n)))
            && fingerprint_ok(&json);
        if !ok {
            out.incomplete
                .push((pkg, format!("{dir}: build output layout")));
            continue;
        }
        files.extend(built);
        out.units.push(Unit {
            kind: Kind::BuildRun,
            pkg,
            profile: rel_profile,
            dir: dir.clone(),
            hash: hash.into(),
            files: files.iter().map(|f| rel(f)).collect(),
            dirs: dirs.iter().map(|d| rel(d)).collect(),
            uses: uses(&json),
        });
    }
    Ok(out)
}

/// Dependency names recorded in a unit's fingerprint.
fn uses(json: &serde_json::Value) -> HashSet<String> {
    json["deps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| d[1].as_str().map(str::to_owned))
        .collect()
}

/// The fingerprint shapes the gate covers: no RUSTFLAGS, and only the local
/// freshness kinds Cargo uses for registry packages.
fn fingerprint_ok(json: &serde_json::Value) -> bool {
    json["rustflags"].as_array().is_some_and(|f| f.is_empty())
        && json["deps"].is_array()
        && json["local"].as_array().is_some_and(|l| {
            l.iter().all(|e| {
                e.as_object().is_some_and(|o| {
                    o.len() == 1
                        && o.keys().all(|k| {
                            [
                                "CheckDepInfo",
                                "Precalculated",
                                "RerunIfChanged",
                                "RerunIfEnvChanged",
                            ]
                            .contains(&k.as_str())
                        })
                })
            })
        })
}

/// Why a staged file is unacceptable, if it is.
enum Scan {
    Clean,
    /// Dep-info whose only donor paths are this unit's own outputs or its
    /// package's OUT_DIRs, rewritten to the recipient target.
    Rewrite(Vec<u8>),
    Reject(String),
}

/// What a unit's staged files still say about the donor.
#[derive(Default)]
struct Notes {
    /// `<pkg>-<hash>` build directories whose OUT_DIR the unit names. Each
    /// must belong to a seeded build-script run.
    out_dirs: HashSet<String>,
    /// An artifact (not dep-info, which is rewritten) names a donor OUT_DIR.
    artifact_out_dir: bool,
    /// A Mach-O debug map names donor objects.
    debug_map: bool,
}

fn scan_file(ctx: &Ctx, unit: &Unit, rel: &Path, staged: &Path, notes: &mut Notes) -> Result<Scan> {
    let g = ctx.graph;
    let name = rel.file_name().unwrap().to_string_lossy().into_owned();
    let profile = ctx.from.join(&unit.profile);
    let bytes_of = |p: &Path| p.as_os_str().as_encoded_bytes().to_vec();
    let out_dir = bytes_of(&profile.join("build").join(&unit.dir).join("out"));
    let unit_dir = unit.profile.join("build").join(&unit.dir);
    let in_build = rel.starts_with(unit.profile.join("build"));
    let is_depinfo = name.ends_with(".d")
        && (rel.parent() == Some(&unit.profile.join("deps"))
            || (unit.kind == Kind::BuildCompile && in_build));
    let lib = g.pkgs[unit.pkg].lib.as_ref().map(|(n, _)| n.as_str());
    let dylib = unit.profile.join("deps").join(format!(
        "lib{}-{}.{}",
        lib.unwrap_or(""),
        unit.hash,
        std::env::consts::DLL_EXTENSION
    ));
    let is_own_dylib = unit.kind == Kind::Lib && g.pkgs[unit.pkg].proc_macro && rel == dylib;
    let mut own_dylib = bytes_of(&ctx.from.join(&dylib));
    own_dylib.push(0);
    let is_build_exe = unit.kind == Kind::BuildCompile
        && rel.parent() == Some(&unit_dir)
        && (name == "build-script-build" || name == format!("build_script_build-{}", unit.hash));
    let root_output =
        unit.kind == Kind::BuildRun && name == "root-output" && rel.parent() == Some(&unit_dir);
    let build_output =
        unit.kind == Kind::BuildRun && name == "output" && rel.parent() == Some(&unit_dir);
    if root_output {
        // Cargo reads this to remap the old OUT_DIR in `output` to the new one.
        let b = fs::read(staged)?;
        return Ok(if b == out_dir {
            Scan::Clean
        } else {
            Scan::Reject(format!("{}: unexpected root-output", rel.display()))
        });
    }
    if !(is_depinfo || is_own_dylib || build_output) {
        // Stream first: most files never name the donor.
        match scan_stream(ctx, staged, rel)? {
            Scan::Reject(why) if ctx.mode == SeedMode::Strict => return Ok(Scan::Reject(why)),
            Scan::Reject(_) => {}
            other => return Ok(other),
        }
    }
    let bytes = fs::read(staged)?;
    // Debug-map strings, only in executables that run during the build.
    let oso = (ctx.mode == SeedMode::Bounded && (is_build_exe || is_own_dylib))
        .then(|| macho_oso_strings(&bytes))
        .flatten()
        .unwrap_or_default();
    let deps_dir = bytes_of(&profile.join("deps"));
    let own_build = bytes_of(&ctx.from.join(&unit_dir));
    let from = bytes_of(ctx.from);
    let boundary = |b: Option<&u8>| {
        b.is_none_or(|c| {
            matches!(
                c,
                b'/' | b'\n' | b'\r' | 0 | b' ' | b'"' | b',' | b';' | b':'
            )
        })
    };
    for needle in &ctx.needles {
        for at in memchr::memmem::find_iter(&bytes, needle) {
            let rest = &bytes[at..];
            let ok = if needle.as_slice() != ctx.needles[0].as_slice() {
                false
            } else if build_output {
                // Cargo replaces the generating OUT_DIR with the new one when
                // it reads `output` (the gate checks the recipient's link
                // line). Nothing else may name the donor.
                rest.starts_with(&out_dir) && boundary(rest.get(out_dir.len()))
            } else if is_own_dylib && rest.starts_with(&own_dylib) {
                // macOS records a dylib's own path as its install name.
                true
            } else if is_depinfo {
                depinfo_path_ok(ctx, unit, lib, rest, notes)
            } else if ctx.mode == SeedMode::Strict {
                false
            } else if let Some(dir) = out_dir_ref(ctx, unit, rest) {
                notes.out_dirs.insert(dir);
                notes.artifact_out_dir = true;
                true
            } else if oso.contains(&at)
                && (rest.starts_with(&deps_dir) || rest.starts_with(&own_build))
            {
                notes.debug_map = true;
                true
            } else {
                false
            };
            if !ok {
                return Ok(Scan::Reject(format!("{} names the donor", rel.display())));
            }
        }
    }
    if !is_depinfo {
        return Ok(Scan::Clean);
    }
    let to = bytes_of(ctx.to);
    let mut rewritten = Vec::with_capacity(bytes.len());
    let mut last = 0;
    for at in memchr::memmem::find_iter(&bytes, &from) {
        rewritten.extend_from_slice(&bytes[last..at]);
        rewritten.extend_from_slice(&to);
        last = at + from.len();
    }
    rewritten.extend_from_slice(&bytes[last..]);
    if ctx
        .needles
        .iter()
        .any(|n| memchr::memmem::find(&rewritten, n).is_some())
    {
        return Ok(Scan::Reject(format!("{} names the donor", rel.display())));
    }
    Ok(if rewritten == bytes {
        Scan::Clean
    } else {
        Scan::Rewrite(rewritten)
    })
}

/// `<from>/<profile>/build/<pkg>-<hash>/out` at a path boundary: the
/// `<pkg>-<hash>` directory, if `rest` starts with a donor OUT_DIR.
fn out_dir_ref(ctx: &Ctx, unit: &Unit, rest: &[u8]) -> Option<String> {
    let mut build = ctx
        .from
        .join(&unit.profile)
        .join("build")
        .as_os_str()
        .as_encoded_bytes()
        .to_vec();
    build.push(b'/');
    let tail = rest.strip_prefix(build.as_slice())?;
    let end = tail.iter().position(|c| *c == b'/')?;
    let dir = std::str::from_utf8(&tail[..end]).ok()?;
    let (pkg, hash) = dir.rsplit_once('-')?;
    let after = tail[end..].strip_prefix(b"/out")?;
    let continues = after
        .first()
        .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'));
    (!pkg.is_empty() && hex16(hash) && !continues).then(|| dir.to_owned())
}

/// File offsets of the strings named by N_OSO (debug map) symbols in a thin
/// 64-bit little-endian Mach-O image. None for anything else.
fn macho_oso_strings(b: &[u8]) -> Option<HashSet<usize>> {
    let u32_at = |o: usize| Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?));
    if u32_at(0)? != 0xfeed_facf {
        return None;
    }
    let ncmds = u32_at(16)? as usize;
    let mut at = 32;
    let mut out = HashSet::new();
    for _ in 0..ncmds {
        let (cmd, size) = (u32_at(at)?, u32_at(at + 4)? as usize);
        if cmd == 0x2 {
            // LC_SYMTAB: symoff, nsyms, stroff, strsize.
            let (symoff, nsyms) = (u32_at(at + 8)? as usize, u32_at(at + 12)? as usize);
            let (stroff, strsize) = (u32_at(at + 16)? as usize, u32_at(at + 20)? as usize);
            for i in 0..nsyms {
                let entry = symoff.checked_add(i.checked_mul(16)?)?;
                let strx = u32_at(entry)? as usize;
                // N_OSO: the object file a debug-map stab belongs to.
                if *b.get(entry + 4)? == 0x66 && strx < strsize {
                    out.insert(stroff.checked_add(strx)?);
                }
            }
        }
        if size < 8 {
            return None;
        }
        at = at.checked_add(size)?;
    }
    Some(out)
}

/// A donor path in rustc dep-info may only be one of this unit's own outputs
/// or a file in an OUT_DIR (its package's, or in bounded mode any seeded
/// one). Every OUT_DIR named is recorded and must end up seeded.
fn depinfo_path_ok(
    ctx: &Ctx,
    unit: &Unit,
    lib: Option<&str>,
    rest: &[u8],
    notes: &mut Notes,
) -> bool {
    let profile = ctx.from.join(&unit.profile);
    let b = |p: PathBuf| p.as_os_str().as_encoded_bytes().to_vec();
    let mut own = Vec::new();
    if unit.kind == Kind::Lib {
        let lib = lib.unwrap_or("");
        own.push(b(profile
            .join("deps")
            .join(format!("{lib}-{}.", unit.hash))));
        own.push(b(profile
            .join("deps")
            .join(format!("lib{lib}-{}.", unit.hash))));
    } else {
        own.push(b(profile
            .join("build")
            .join(&unit.dir)
            .join(format!("build_script_build-{}", unit.hash))));
    }
    if own.iter().any(|o| rest.starts_with(o)) {
        return true;
    }
    // rustc names included OUT_DIR files and records OUT_DIR itself as an
    // env-dep; Cargo's own dep-info keeps both target-relative.
    let Some(dir) = out_dir_ref(ctx, unit, rest) else {
        return false;
    };
    let same_package = dir
        .rsplit_once('-')
        .is_some_and(|(pkg, _)| pkg == ctx.graph.pkgs[unit.pkg].name);
    if ctx.mode == SeedMode::Strict && !same_package {
        return false;
    }
    notes.out_dirs.insert(dir);
    true
}

fn scan_stream(ctx: &Ctx, staged: &Path, rel: &Path) -> Result<Scan> {
    use std::io::Read;
    let finders: Vec<_> = ctx
        .needles
        .iter()
        .map(|n| memchr::memmem::Finder::new(n.as_slice()))
        .collect();
    let keep = ctx.needles.iter().map(Vec::len).max().unwrap_or(1) - 1;
    let mut file = File::open(staged)?;
    let mut buf = vec![0u8; 4 << 20];
    let mut have = 0;
    loop {
        check_cancel()?;
        let n = file.read(&mut buf[have..])?;
        let end = have + n;
        if finders.iter().any(|f| f.find(&buf[..end]).is_some()) {
            return Ok(Scan::Reject(format!("{} names the donor", rel.display())));
        }
        if n == 0 {
            return Ok(Scan::Clean);
        }
        let tail = keep.min(end);
        buf.copy_within(end - tail..end, 0);
        have = tail;
    }
}

struct UnitResult {
    clones: u64,
    rewritten: u64,
    reject: Option<String>,
    notes: Notes,
}

fn stage_unit(ctx: &Ctx, stage: &Path, unit: &Unit) -> Result<UnitResult> {
    let mut r = UnitResult {
        clones: 0,
        rewritten: 0,
        reject: None,
        notes: Notes::default(),
    };
    for d in &unit.dirs {
        fs::create_dir_all(stage.join(d))?;
    }
    for rel in &unit.files {
        check_cancel()?;
        if regular(ctx.from, rel).is_err() {
            r.reject = Some(format!("{} is not a regular file", rel.display()));
            return Ok(r);
        }
        let dest = stage.join(rel);
        fs::create_dir_all(dest.parent().unwrap())?;
        if let Err(e) = cow::clone_file(&ctx.from.join(rel), &dest) {
            if matches!(
                e.raw_os_error(),
                Some(libc::EXDEV | libc::ENOTSUP | libc::ENOTTY)
            ) {
                return Err(Error::new(NO_CLONE, "cow-unavailable"));
            }
            return Err(e.into());
        }
        r.clones += 1;
        // Scan the clone, not the donor: these are exactly the bytes that will
        // be published, whatever happens to the donor meanwhile.
        match scan_file(ctx, unit, rel, &dest, &mut r.notes)? {
            Scan::Clean => {}
            Scan::Reject(why) => {
                r.reject = Some(why);
                return Ok(r);
            }
            Scan::Rewrite(bytes) => {
                let m = fs::metadata(&dest)?;
                let tmp = dest.with_extension("d.pwrgit-share-tmp");
                fs::write(&tmp, &bytes)?;
                File::options()
                    .write(true)
                    .open(&tmp)?
                    .set_times(fs::FileTimes::new().set_modified(m.modified()?))?;
                fs::rename(&tmp, &dest)?;
                r.clones -= 1;
                r.rewritten += 1;
            }
        }
    }
    if unit.kind == Kind::BuildRun {
        r.reject = verify_out_dir(ctx, stage, unit)?;
    }
    Ok(r)
}

/// The recipient's OUT_DIR must be an exact copy of the donor's: the same
/// files with the same bytes. Bounded mode lets seeded artifacts keep naming
/// the donor's OUT_DIR on the strength of this.
fn verify_out_dir(ctx: &Ctx, stage: &Path, unit: &Unit) -> Result<Option<String>> {
    use std::io::Read;
    let out = unit.profile.join("build").join(&unit.dir).join("out");
    let changed = || Ok(Some(format!("{}: OUT_DIR changed", out.display())));
    let mut donor = Vec::new();
    let mut dirs = Vec::new();
    if fs::symlink_metadata(ctx.from.join(&out)).is_ok()
        && tree(&ctx.from.join(&out), &mut donor, &mut dirs).is_none()
    {
        return changed();
    }
    let mut donor: Vec<PathBuf> = donor
        .iter()
        .map(|p| p.strip_prefix(ctx.from).unwrap().to_path_buf())
        .collect();
    let mut staged: Vec<PathBuf> = unit
        .files
        .iter()
        .filter(|f| f.starts_with(&out))
        .cloned()
        .collect();
    donor.sort();
    staged.sort();
    if donor != staged {
        return changed();
    }
    let (mut a, mut b) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    for rel in &staged {
        check_cancel()?;
        let mut x = File::open(ctx.from.join(rel))?;
        let mut y = File::open(stage.join(rel))?;
        loop {
            let n = x.read(&mut a)?;
            let mut m = 0;
            while m < n {
                let k = y.read(&mut b[m..n])?;
                if k == 0 {
                    break;
                }
                m += k;
            }
            if m != n || a[..n] != b[..n] {
                return Ok(Some(format!("{}: copy differs", rel.display())));
            }
            if n == 0 {
                if y.read(&mut b[..1])? != 0 {
                    return Ok(Some(format!("{}: copy differs", rel.display())));
                }
                break;
            }
        }
    }
    Ok(None)
}

fn publish(ctx: &Ctx, found: Discovery) -> Result<SeedReport> {
    let g = ctx.graph;
    let mut report = SeedReport::default();
    let parent = ctx.to.parent().unwrap();
    let stage = unique_dir(parent, ctx.to.file_name().unwrap())?;
    // Clone and scan every attributed unit in parallel.
    let workers = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(1, 8);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results: Vec<Result<Vec<(usize, UnitResult)>>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                s.spawn(|| {
                    let mut done = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(unit) = found.units.get(i) else {
                            return Ok(done);
                        };
                        done.push((i, stage_unit(ctx, &stage.path, unit)?));
                    }
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut staged = Vec::new();
    for r in results {
        match r {
            Ok(v) => staged.extend(v),
            Err(e) if e.code == NO_CLONE => {
                return Ok(SeedReport::skipped("cow-unavailable", None));
            }
            Err(e) => return Err(e),
        }
    }
    staged.sort_by_key(|(i, _)| *i);
    // Package verdicts: R1 exclusions, broken units, then donor-path scans.
    let mut rejected: HashMap<usize, String> = HashMap::new();
    let mut built: HashSet<usize> = HashSet::new();
    for (i, p) in g.pkgs.iter().enumerate() {
        if let Some(why) = p.excluded {
            rejected.insert(i, why.into());
        }
    }
    for pkg in found.broken.keys() {
        rejected.insert(*pkg, "layout-unknown".into());
    }
    for (i, r) in &staged {
        let unit = &found.units[*i];
        // A package counts as built only with a library unit; a leftover
        // build-script unit alone does not let its dependents through.
        if unit.kind == Kind::Lib {
            built.insert(unit.pkg);
        }
        if r.reject.is_some() {
            rejected
                .entry(unit.pkg)
                .or_insert_with(|| "donor-path".into());
        }
    }
    for i in 0..g.pkgs.len() {
        if !built.contains(&i) {
            rejected.entry(i).or_insert_with(|| "not-built".into());
        }
    }
    // Build-script runs by directory, for OUT_DIR references.
    let runs: HashMap<(&Path, &str), usize> = staged
        .iter()
        .map(|(i, _)| (&found.units[*i], *i))
        .filter(|(u, _)| u.kind == Kind::BuildRun)
        .map(|(u, i)| ((u.profile.as_path(), u.dir.as_str()), i))
        .collect();
    let notes: HashMap<usize, &Notes> = staged.iter().map(|(i, r)| (*i, &r.notes)).collect();
    // R3 fixed point: a unit built against a rejected or unbuilt package
    // would meet different bytes in the recipient, so its whole package is
    // rejected too. Metadata's resolve over-approximates (optional and
    // platform edges the build never used), so an edge counts when the
    // unit's own fingerprint names it, or when Cargo gave no name.
    // A named OUT_DIR must belong to a seeded build-script run, never a
    // workspace or path package's.
    loop {
        let mut more = Vec::new();
        for (i, _) in &staged {
            let u = &found.units[*i];
            if rejected.contains_key(&u.pkg) {
                continue;
            }
            let dep = g.pkgs[u.pkg].deps.iter().any(|(d, name)| {
                rejected.contains_key(d) && name.as_ref().is_none_or(|n| u.uses.contains(n))
            });
            let out = notes[i].out_dirs.iter().any(|d| {
                runs.get(&(u.profile.as_path(), d.as_str()))
                    .is_none_or(|r| rejected.contains_key(&found.units[*r].pkg))
            });
            if dep {
                more.push((u.pkg, "depends-on-rejected"));
            } else if out {
                more.push((u.pkg, "out-dir-not-seeded"));
            }
        }
        if more.is_empty() {
            break;
        }
        for (i, why) in more {
            rejected.entry(i).or_insert_with(|| why.into());
        }
    }
    for why in rejected.values() {
        *report.packages_rejected.entry(why.clone()).or_default() += 1;
    }
    let mut detail = Vec::new();
    let mut seeded_pkgs = HashSet::new();
    for (pkg, why) in &found.incomplete {
        if !rejected.contains_key(pkg) {
            *report
                .units_skipped
                .entry("layout-unknown".into())
                .or_default() += 1;
            detail.push(format!("{}: {why}", g.pkgs[*pkg].name));
        }
    }
    for (i, r) in &staged {
        let unit = &found.units[*i];
        if let Some(why) = rejected.get(&unit.pkg) {
            *report.units_skipped.entry(why.clone()).or_default() += 1;
            if let Some(scan) = &r.reject {
                detail.push(format!("{}: {scan}", unit.display(g)));
            }
            for f in &unit.files {
                let _ = fs::remove_file(stage.path.join(f));
            }
            continue;
        }
        report.units_seeded += 1;
        report.units_seeded_with_donor_out_dir_paths += r.notes.artifact_out_dir as u64;
        report.units_seeded_with_donor_debug_maps += r.notes.debug_map as u64;
        report.clone_count += r.clones;
        report.rewritten_count += r.rewritten;
        seeded_pkgs.insert(unit.pkg);
    }
    report.packages_seeded = seeded_pkgs.len() as u64;
    detail.extend(found.broken.values().cloned());
    detail.sort();
    if detail.len() > 12 {
        let more = detail.len() - 12;
        detail.truncate(12);
        detail.push(format!("{more} more"));
    }
    if !detail.is_empty() {
        report.detail = Some(detail.join("; "));
    }
    if report.units_seeded == 0 {
        report.clone_count = 0;
        report.rewritten_count = 0;
        report.reason = Some("no-eligible-units".into());
        return Ok(report);
    }
    // Drop directories left empty by rejected units, so the published target
    // only has the seeded units in it.
    prune_empty(&stage.path)?;
    // What Cargo writes when it creates a target directory itself.
    if regular(ctx.from, Path::new("CACHEDIR.TAG")).is_ok() {
        cow::clone_file(
            &ctx.from.join("CACHEDIR.TAG"),
            &stage.path.join("CACHEDIR.TAG"),
        )?;
        report.clone_count += 1;
    }
    copy_backup_exclusion(ctx.from, &stage.path);
    check_cancel()?;
    write_record(
        &stage.path.join(".pwrgit-share.json"),
        report.clone_count,
        report.units_skipped.values().sum(),
    )?;
    cow::rename_new(&stage.path, ctx.to)?;
    // The staging path is gone; its guard only removes a failed stage.
    Ok(report)
}

fn prune_empty(dir: &Path) -> Result<bool> {
    let mut empty = true;
    for e in fs::read_dir(dir)? {
        let e = e?;
        if e.file_type()?.is_dir() && prune_empty(&e.path())? {
            fs::remove_dir(e.path())?;
        } else {
            empty = false;
        }
    }
    Ok(empty)
}

/// Cargo marks a new target directory as excluded from Time Machine and File
/// Provider sync on macOS. Carry the donor's marks over, best effort.
fn copy_backup_exclusion(from: &Path, to: &Path) {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let (Ok(src), Ok(dst)) = (
            std::ffi::CString::new(from.as_os_str().as_bytes()),
            std::ffi::CString::new(to.as_os_str().as_bytes()),
        ) else {
            return;
        };
        for name in [
            "com.apple.metadata:com_apple_backup_excludeItem",
            "com.apple.fileprovider.ignore#P",
        ] {
            let Ok(name) = std::ffi::CString::new(name) else {
                continue;
            };
            let mut buf = [0u8; 256];
            let n = unsafe {
                libc::getxattr(
                    src.as_ptr(),
                    name.as_ptr(),
                    buf.as_mut_ptr().cast(),
                    buf.len(),
                    0,
                    libc::XATTR_NOFOLLOW,
                )
            };
            if n > 0 {
                unsafe {
                    libc::setxattr(
                        dst.as_ptr(),
                        name.as_ptr(),
                        buf.as_ptr().cast(),
                        n as usize,
                        0,
                        libc::XATTR_NOFOLLOW,
                    );
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (from, to);
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
    fn scratch(name: &str) -> OwnedDir {
        unique_dir(
            &fs::canonicalize(std::env::temp_dir()).unwrap(),
            std::ffi::OsStr::new(name),
        )
        .unwrap()
    }
    fn package(dir: &Path, name: &str) -> serde_json::Value {
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("Cargo.toml"), "").unwrap();
        fs::write(dir.join("src/lib.rs"), "").unwrap();
        serde_json::json!({
            "id": name, "name": name,
            "manifest_path": dir.join("Cargo.toml"),
            "targets": [{"name": name, "kind": ["lib"], "src_path": dir.join("src/lib.rs")}],
        })
    }
    #[test]
    fn r1_needs_a_third_party_source_and_a_manifest_in_cargo_home() {
        let t = scratch("r1");
        let home = t.path.join("home");
        let reg = home.join("registry/src/index-0123");
        let mut pkgs = vec![
            package(&t.path.join("ws/app"), "app"),
            package(&t.path.join("ws/local"), "local"),
            package(&reg.join("dep-1.0.0"), "dep"),
            // Replaced (vendored/directory) sources still report registry+.
            package(&t.path.join("ws/vendor/vend-1.0.0"), "vend"),
            package(&home.join("git/checkouts/repo-1/abc"), "gitdep"),
            package(&reg.join("uses-1.0.0"), "uses"),
        ];
        let sources = [
            None,
            None,
            Some("registry+https://github.com/rust-lang/crates.io-index"),
            Some("registry+https://github.com/rust-lang/crates.io-index"),
            Some("git+https://example.invalid/repo#abc"),
            Some("sparse+https://example.invalid/index/"),
        ];
        for (p, s) in pkgs.iter_mut().zip(sources) {
            p["source"] = s.into();
        }
        let meta = serde_json::json!({
            "workspace_members": ["app"],
            "packages": pkgs,
            "resolve": {"nodes": [
                {"id": "app", "dependencies": ["local", "dep", "vend", "gitdep", "uses"]},
                {"id": "local", "dependencies": []},
                {"id": "dep", "dependencies": []},
                {"id": "vend", "dependencies": []},
                {"id": "gitdep", "dependencies": []},
                {"id": "uses", "dependencies": ["dep"], "deps": [{"name": "dep_renamed", "pkg": "dep"}]},
            ]},
        });
        let g = Graph::new(&meta, &fs::canonicalize(&home).unwrap()).unwrap();
        let excluded: Vec<_> = g.pkgs.iter().map(|p| p.excluded).collect();
        assert_eq!(
            excluded,
            [
                Some("workspace"),
                Some("path-source"),
                None,
                Some("outside-cargo-home"),
                None,
                None
            ]
        );
        assert_eq!(g.pkgs[5].deps, [(2, Some("dep_renamed".into()))]);
        assert_eq!(g.pkgs[0].deps[0], (1, None));
        let src = fs::canonicalize(reg.join("dep-1.0.0/src/lib.rs")).unwrap();
        assert_eq!(g.owner(&src), Some(2));
        let vendored = fs::canonicalize(t.path.join("ws/vendor/vend-1.0.0/src/lib.rs")).unwrap();
        assert_eq!(g.owner(&vendored), None);
    }
    #[test]
    fn config_must_match_and_never_name_a_worktree_or_change_flags() {
        let t = scratch("config");
        let (donor, recipient, home) = (
            t.path.join("donor"),
            t.path.join("recipient"),
            t.path.join("home"),
        );
        for d in [&donor, &recipient, &home] {
            fs::create_dir_all(d.join(".cargo")).unwrap();
        }
        let check = |d: &str, r: &str| {
            fs::write(donor.join(".cargo/config.toml"), d).unwrap();
            fs::write(recipient.join(".cargo/config.toml"), r).unwrap();
            config_check(&donor, &recipient, &home, &[&donor, &recipient]).map_err(|e| e.0)
        };
        let alias = "[alias]\nxtask = 'run --quiet --package xtask --'\n";
        assert_eq!(check(alias, alias), Ok(()));
        let vendored = "[source.crates-io]\nreplace-with = 'v'\n[source.v]\ndirectory = 'vendor'\n";
        assert_eq!(check(vendored, vendored), Ok(()));
        assert_eq!(check(alias, ""), Err("config-differs"));
        for flags in [
            "[build]\nrustflags = ['-C', 'debuginfo=1']\n",
            "build.rustc-wrapper = 'sccache'\n",
            "[target.aarch64-apple-darwin]\nrustflags = []\n",
            "build = { target-dir = 'elsewhere' }\n",
            "paths = ['../override']\n",
            "[unstable]\nbuild-dir-new-layout = true\n",
        ] {
            assert_eq!(check(flags, flags), Err("config-unsupported"), "{flags}");
        }
        // A comment is not a key.
        let commented = "# rustflags = ['-C', 'x']\n[alias]\nb = 'build'\n";
        assert_eq!(check(commented, commented), Ok(()));
        let named = format!("[env]\nX = '{}'\n", donor.display());
        assert_eq!(check(&named, &named), Err("config-embeds-worktree-path"));
        fs::remove_file(recipient.join(".cargo/config.toml")).unwrap();
        fs::write(donor.join(".cargo/config.toml"), alias).unwrap();
        assert_eq!(
            config_check(&donor, &recipient, &home, &[&donor, &recipient]).map_err(|e| e.0),
            Err("config-differs")
        );
        // CARGO_HOME's config applies to both, but still may not name either.
        fs::remove_file(donor.join(".cargo/config.toml")).unwrap();
        fs::write(
            home.join("config.toml"),
            format!("[env]\nY = '{}'\n", recipient.display()),
        )
        .unwrap();
        assert_eq!(
            config_check(&donor, &recipient, &home, &[&donor, &recipient]).map_err(|e| e.0),
            Err("config-embeds-worktree-path")
        );
    }
    #[test]
    fn out_dir_references_need_an_exact_build_dir_and_a_path_boundary() {
        let graph = Graph {
            pkgs: Vec::new(),
            by_dir: Vec::new(),
        };
        let ctx = Ctx {
            from: Path::new("/d/target"),
            to: Path::new("/r/target"),
            graph: &graph,
            needles: vec![b"/d".to_vec()],
            mode: SeedMode::Bounded,
        };
        let unit = Unit {
            kind: Kind::Lib,
            pkg: 0,
            profile: PathBuf::from("debug"),
            dir: "x-0123456789abcdef".into(),
            hash: "0123456789abcdef".into(),
            files: Vec::new(),
            dirs: Vec::new(),
            uses: HashSet::new(),
        };
        let r = |s: &str| out_dir_ref(&ctx, &unit, s.as_bytes());
        let dir = Some("serde-0123456789abcdef".to_owned());
        assert_eq!(
            r("/d/target/debug/build/serde-0123456789abcdef/out/private.rs"),
            dir
        );
        assert_eq!(r("/d/target/debug/build/serde-0123456789abcdef/out\0"), dir);
        assert_eq!(
            r("/d/target/debug/build/serde-0123456789abcdef/output"),
            None
        );
        assert_eq!(
            r("/d/target/debug/build/serde-0123456789abcdef/build-script-build"),
            None
        );
        assert_eq!(r("/d/target/debug/build/serde-0123/out/x"), None);
        assert_eq!(
            r("/d/target/release/build/serde-0123456789abcdef/out/x"),
            None
        );
        assert_eq!(
            r("/d/target/debug/deps/libserde-0123456789abcdef.rlib"),
            None
        );
        assert_eq!(r("/d/src/lib.rs"), None);
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn debug_map_strings_come_from_the_mach_o_symbol_table() {
        // This test binary is linked from unpacked objects: its debug map
        // names them.
        let me = fs::read(std::env::current_exe().unwrap()).unwrap();
        let oso = macho_oso_strings(&me).expect("thin 64-bit Mach-O");
        assert!(!oso.is_empty());
        for at in oso {
            assert!(me[at..].starts_with(b"/"), "debug-map paths are absolute");
        }
        assert_eq!(macho_oso_strings(b"\x7fELF not mach-o"), None);
        assert_eq!(macho_oso_strings(&me[..40]), None);
    }
    #[test]
    fn dep_info_first_prerequisite_unescapes_and_checks_the_target() {
        let target = Path::new("/t/debug/deps/a-0123456789abcdef.d");
        let text = b"/t/debug/deps/a-0123456789abcdef.d: /h/my\\ crate-1.0.0/src/lib.rs /h/x.rs\n";
        assert_eq!(
            first_prerequisite(text, target),
            Some(PathBuf::from("/h/my crate-1.0.0/src/lib.rs"))
        );
        assert_eq!(first_prerequisite(text, Path::new("/other.d")), None);
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
