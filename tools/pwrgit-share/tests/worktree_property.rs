//! Promise: sharing changes allocation, never Git's checkout or isolation.
//! Git is the state/checkout oracle; the model replays generated user commands
//! in a shared worktree and an ordinary worktree and compares after every step.
#![cfg(unix)]

use proptest::{
    collection,
    prelude::*,
    test_runner::{Config, RngSeed},
};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    os::unix::{ffi::OsStringExt, fs::MetadataExt, fs::PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pwrgit-share-property-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("home")).unwrap();
        fs::create_dir(root.join("cargo-home")).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn command(&self, program: &str, cwd: &Path) -> Command {
        let mut cmd = Command::new(program);
        // Both oracle and CLI receive a private, ordinary Git configuration.
        // Repository overrides are injected only into the CLI, deliberately.
        cmd.env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("HOME", self.0.join("home"))
            .env("CARGO_HOME", self.0.join("cargo-home"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("LC_ALL", "C")
            .current_dir(cwd);
        cmd
    }
    fn git(&self, cwd: &Path, args: &[&str]) -> Vec<u8> {
        let out = self
            .command("git", cwd)
            .arg("--literal-pathspecs")
            .args(args)
            .output()
            .unwrap();
        success(&out);
        out.stdout
    }
    fn repo(&self) -> PathBuf {
        let repo = self.0.join("donor");
        fs::create_dir(&repo).unwrap();
        self.git(&repo, &["init", "-b", "main"]);
        self.git(&repo, &["config", "user.name", "Fixture"]);
        self.git(&repo, &["config", "user.email", "fixture@example.invalid"]);
        self.git(&repo, &["config", "core.autocrlf", "false"]);
        self.git(
            &repo,
            &["config", "filter.fixture.smudge", "sed s/token/expanded/g"],
        );
        self.git(
            &repo,
            &["config", "filter.fixture.clean", "sed s/expanded/token/g"],
        );
        fs::write(repo.join(".gitignore"), "ignored\n").unwrap();
        fs::write(repo.join(".gitattributes"), "").unwrap();
        repo
    }
    fn oid(&self, repo: &Path) -> String {
        String::from_utf8(self.git(repo, &["rev-parse", "HEAD"]))
            .unwrap()
            .trim()
            .into()
    }
    fn create(
        &self,
        donor: &Path,
        shared: &Path,
        plain: &Path,
        revision: &str,
        fallback: bool,
        overrides: bool,
    ) -> (State, State) {
        let before = self.state(donor);
        self.git(
            donor,
            &[
                "worktree",
                "add",
                "--detach",
                plain.to_str().unwrap(),
                revision,
            ],
        );
        let mut cmd = self.command(env!("CARGO_BIN_EXE_pwrgit-share"), donor);
        cmd.args([
            "worktree",
            "add",
            "--json",
            "--donor",
            donor.to_str().unwrap(),
            shared.to_str().unwrap(),
            revision,
        ]);
        if fallback {
            cmd.env("PWRGIT_SHARE_FORCE_NONE", "1");
        }
        if overrides {
            let admin = self.git(donor, &["rev-parse", "--absolute-git-dir"]);
            let admin = String::from_utf8(admin).unwrap();
            cmd.env("GIT_DIR", admin.trim())
                .env("GIT_WORK_TREE", donor)
                .env("GIT_INDEX_FILE", Path::new(admin.trim()).join("index"));
        }
        let out = cmd.output().unwrap();
        success(&out);
        let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let count = self
            .git(plain, &["ls-tree", "-r", "-z", "HEAD"])
            .iter()
            .filter(|b| **b == 0)
            .count() as u64;
        assert_eq!(
            report["clonedFiles"].as_u64().unwrap() + report["checkoutFiles"].as_u64().unwrap(),
            count
        );
        if fallback {
            assert_eq!(report["clonedFiles"], 0);
            assert_eq!(report["fallback"], "git-checkout");
        }
        let donor_after = self.state(donor);
        let shared_after = self.state(shared);
        assert_eq!(donor_after, before, "creating a worktree changed the donor");
        assert_eq!(shared_after, self.state(plain), "checkout differs from Git");
        (donor_after, shared_after)
    }
    fn state(&self, path: &Path) -> State {
        let files = snapshot(path);
        let head = self.git(path, &["rev-parse", "HEAD"]);
        let index = self.git(path, &["ls-files", "--stage", "-z"]);
        // Compare content-based status, not Git's timing-dependent stat cache.
        // Removing `ident` without changing a blob can leave expanded bytes
        // that a warm index reports clean until its stat cache is invalidated.
        // A private index with zero stat data rehashes every tracked file and
        // preserves staged changes without refreshing the working stat cache.
        let tree = String::from_utf8(self.git(path, &["write-tree"])).unwrap();
        let fresh = self.0.join("oracle-index");
        let _ = fs::remove_file(&fresh);
        let out = self
            .command("git", path)
            .env("GIT_INDEX_FILE", &fresh)
            .args(["read-tree", tree.trim()])
            .output()
            .unwrap();
        success(&out);
        let out = self
            .command("git", path)
            .env("GIT_INDEX_FILE", &fresh)
            .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
            .output()
            .unwrap();
        success(&out);
        fs::remove_file(fresh).unwrap();
        State {
            files,
            head,
            index,
            status: out.stdout,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn success(out: &Output) {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
#[derive(Debug, PartialEq, Eq)]
struct State {
    files: BTreeMap<PathBuf, (Vec<u8>, u32)>,
    head: Vec<u8>,
    index: Vec<u8>,
    status: Vec<u8>,
}
fn snapshot(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, u32)> {
    fn visit(root: &Path, dir: &Path, result: &mut BTreeMap<PathBuf, (Vec<u8>, u32)>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            if entry.file_name() == ".git" {
                continue;
            }
            let path = entry.path();
            let m = fs::symlink_metadata(&path).unwrap();
            if m.is_dir() {
                visit(root, &path, result);
            } else {
                let value = if m.is_symlink() {
                    fs::read_link(&path)
                        .unwrap()
                        .as_os_str()
                        .as_encoded_bytes()
                        .to_vec()
                } else {
                    assert_eq!(m.nlink(), 1, "source hardlinked: {path:?}");
                    fs::read(&path).unwrap()
                };
                result.insert(
                    path.strip_prefix(root).unwrap().into(),
                    (value, m.mode() & 0o170777),
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, root, &mut result);
    result
}

fn name(slot: u8) -> PathBuf {
    // APFS rejects invalid UTF-8 names; generate that valid Git/filesystem
    // shape on Linux, and a second quoted name on macOS.
    let last = if cfg!(target_os = "linux") {
        b"dir/nonutf8-\xff".as_slice()
    } else {
        b"dir/quote\"name".as_slice()
    };
    PathBuf::from(OsString::from_vec(
        [
            b"plain".as_slice(),
            b"dir/file space",
            b"dir/tab\tname",
            b"line\nbreak",
            b"quote\"tail",
            b"carriage\rreturn",
            b"-option",
            "unicode-é".as_bytes(),
            b"dir/back\\slash",
            last,
        ][usize::from(slot)]
        .to_vec(),
    ))
}

fn config() -> Config {
    let mut config = Config {
        cases: 8,
        max_shrink_iters: 128,
        failure_persistence: None,
        ..Config::default()
    };
    if matches!(config.rng_seed, RngSeed::Random) {
        config.rng_seed = RngSeed::Fixed(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64,
        );
    }
    if let RngSeed::Fixed(seed) = config.rng_seed {
        eprintln!(
            "Replay with PROPTEST_RNG_SEED={seed} cargo test --test worktree_property -- --nocapture"
        );
    }
    config
}
fn payload() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        Just(b"token\n$Id$\n".to_vec()),
        Just(b"CRLF\r\nlines\r\n".to_vec()),
        Just(b"binary\0\xff\n".to_vec()),
        collection::vec(any::<u8>(), 0..32),
    ]
}
#[derive(Debug, Clone)]
enum Op {
    Edit(u8, Vec<u8>),
    Stage(u8),
    Reset,
    Switch(bool),
    DonorEdit(u8, Vec<u8>),
    Recreate(bool),
}
fn operation() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0u8..10, payload()).prop_map(|(n, p)| Op::Edit(n, p)),
        (0u8..10).prop_map(Op::Stage),
        Just(Op::Reset),
        any::<bool>().prop_map(Op::Switch),
        (0u8..10, payload()).prop_map(|(n, p)| Op::DonorEdit(n, p)),
        any::<bool>().prop_map(Op::Recreate),
    ]
}
fn write(repo: &Path, slot: u8, payload: &[u8]) {
    let path = repo.join(name(slot));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, payload).unwrap();
}

proptest! {
    #![proptest_config(config())]
    #[test]
    fn generated_worktree_commands_match_git_and_preserve_isolation(
        files in collection::btree_map(0u8..10, (payload(), any::<bool>()), 2..7),
        attrs in prop::sample::select(vec!["", "* text=auto eol=lf\n", "* text eol=crlf\n", "* -text\n", "* ident\n", "* filter=fixture\n"]),
        core_eol in prop::sample::select(vec!["native", "lf", "crlf"]),
        linked in any::<bool>(), packed in any::<bool>(), fallback in any::<bool>(), overrides in any::<bool>(),
        operations in collection::vec(operation(), 0..4),
    ) {
        let f = Fixture::new();
        let repo = f.repo();
        for (&slot, (bytes, executable)) in &files {
            write(&repo, slot, bytes);
            fs::set_permissions(repo.join(name(slot)), fs::Permissions::from_mode(if *executable { 0o755 } else { 0o644 })).unwrap();
        }
        std::os::unix::fs::symlink("plain", repo.join("link")).unwrap();
        f.git(&repo, &["add", "."]); f.git(&repo, &["commit", "-m", "base"]);
        let base = f.oid(&repo);
        fs::write(repo.join(".gitattributes"), attrs).unwrap();
        // Permit the no-attribute case without inventing an impossible commit.
        f.git(&repo, &["add", ".gitattributes"]); f.git(&repo, &["commit", "--allow-empty", "-m", "target attributes"]);
        let target = f.oid(&repo);
        f.git(&repo, &["checkout", "--detach", &base]);
        f.git(&repo, &["config", "core.eol", core_eol]);
        if packed { f.git(&repo, &["pack-refs", "--all"]); }
        let donor = if linked {
            let p = f.0.join("linked-donor"); f.git(&repo, &["worktree", "add", "--detach", p.to_str().unwrap(), &base]); p
        } else { repo.clone() };
        fs::write(donor.join("ignored"), "private ignored bytes").unwrap();
        fs::write(donor.join("untracked"), "private untracked bytes").unwrap();
        let shared = f.0.join("shared"); let plain = f.0.join("plain-checkout");
        let (mut donor_before, mut child_before) = f.create(&donor, &shared, &plain, &target, fallback, overrides);
        let slots = files.keys().copied().collect::<Vec<_>>();
        for (step, op) in operations.iter().enumerate() {
            match op {
                Op::Edit(n, bytes) => { let slot=slots[usize::from(*n) % slots.len()]; write(&shared, slot, bytes); write(&plain, slot, bytes); }
                Op::Stage(n) => {
                    let path=name(slots[usize::from(*n) % slots.len()]);
                    for p in [&shared, &plain] {
                        let out=f.command("git",p).args(["--literal-pathspecs", "add", "--"]).arg(&path).output().unwrap(); success(&out);
                    }
                }
                Op::Reset => { for p in [&shared, &plain] { f.git(p, &["reset", "--hard", "HEAD"]); } }
                Op::Switch(to_target) => { for p in [&shared, &plain] { f.git(p, &["checkout", "--force", "--detach", if *to_target { &target } else { &base }]); } }
                Op::DonorEdit(n, bytes) => { write(&donor, slots[usize::from(*n) % slots.len()], bytes); }
                Op::Recreate(to_target) => {
                    for p in [&shared, &plain] { f.git(&repo, &["worktree", "remove", "--force", p.to_str().unwrap()]); }
                    f.create(&donor, &shared, &plain, if *to_target { &target } else { &base }, fallback, overrides);
                }
            }
            let child_after = f.state(&shared);
            let donor_after = f.state(&donor);
            assert_eq!(child_after, f.state(&plain), "oracle differs after step {step}: {op:?}");
            if matches!(op, Op::DonorEdit(..)) { assert_eq!(child_after, child_before, "donor edit escaped into recipient"); }
            else { assert_eq!(donor_after, donor_before, "recipient operation changed donor"); }
            donor_before = donor_after;
            child_before = child_after;
            assert!(!fs::read_dir(&f.0).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".pwrgit-share-partial")), "staging survived successful operation");
        }
    }
}

#[test]
fn ident_attribute_switch_compares_bytes_instead_of_cached_clean_status() {
    let f = Fixture::new();
    let donor = f.repo();
    write(&donor, 0, b"token\n$Id$\n");
    f.git(&donor, &["add", "."]);
    f.git(&donor, &["commit", "-m", "base"]);
    let base = f.oid(&donor);
    fs::write(donor.join(".gitattributes"), "* ident\n").unwrap();
    f.git(&donor, &["add", ".gitattributes"]);
    f.git(&donor, &["commit", "-m", "ident"]);
    let target = f.oid(&donor);
    f.git(&donor, &["checkout", "--detach", &base]);
    let shared = f.0.join("shared");
    let plain = f.0.join("plain-checkout");
    f.create(&donor, &shared, &plain, &target, false, false);
    for p in [&shared, &plain] {
        f.git(p, &["checkout", "--force", "--detach", &base]);
    }
    assert_eq!(f.state(&shared), f.state(&plain));
    // A newly hashed status must agree with actual Git blob identity, even if
    // ordinary status still has a cached clean result after changing attrs.
    let expected = f.state(&plain);
    let bytes_hash = f.git(&plain, &["hash-object", "--", "plain"]);
    let index_hash = f.git(&plain, &["rev-parse", "HEAD:plain"]);
    assert_eq!(expected.status.is_empty(), bytes_hash == index_hash);
}
