use pwrgit_share::{Options, probe, worktree_add};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "pwrgit-share-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn repo(&self) -> PathBuf {
        let p = self.0.join("donor");
        fs::create_dir(&p).unwrap();
        git(&p, &["init", "-b", "main"]);
        git(&p, &["config", "user.email", "fixture@example.invalid"]);
        git(&p, &["config", "user.name", "Fixture"]);
        fs::write(p.join("clean"), "original\n").unwrap();
        fs::write(p.join("dirty"), "committed\n").unwrap();
        fs::write(p.join(".gitignore"), "ignored\ntarget/\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("clean", p.join("link")).unwrap();
        git(&p, &["add", "."]);
        git(&p, &["commit", "-m", "fixture"]);
        fs::write(p.join("dirty"), "private edit\n").unwrap();
        fs::write(p.join("ignored"), "secret\n").unwrap();
        fs::write(p.join("untracked"), "secret\n").unwrap();
        p
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn git(p: &Path, args: &[&str]) -> Output {
    let o = Command::new("git")
        .current_dir(p)
        .args(args)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    o
}
fn cli(p: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_pwrgit-share"))
        .current_dir(p)
        .args(args)
        .output()
        .unwrap()
}
#[test]
fn real_probe_and_source_edit_reset_isolation() {
    let f = Fixture::new();
    let donor = f.repo();
    let dest = f.0.join("other");
    let p = probe(&f.0).unwrap();
    #[cfg(target_os = "macos")]
    assert_eq!(p.cow, "apfs", "{p:?}");
    #[cfg(target_os = "linux")]
    assert!(["none", "ficlone"].contains(&p.cow.as_str()));
    let r = worktree_add(
        &donor,
        &dest,
        "HEAD",
        &Options {
            branch: Some("other".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        r.fallback,
        if p.cow == "none" {
            "git-checkout"
        } else {
            "none"
        }
    );
    if p.cow != "none" {
        assert!(r.cloned_files >= 2);
    }
    assert_eq!(fs::read(dest.join("dirty")).unwrap(), b"committed\n");
    assert!(!dest.join("ignored").exists());
    assert!(!dest.join("untracked").exists());
    assert!(git(&dest, &["status", "--porcelain"]).stdout.is_empty());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_ne!(
            fs::metadata(donor.join("clean")).unwrap().ino(),
            fs::metadata(dest.join("clean")).unwrap().ino()
        );
        assert_eq!(fs::metadata(dest.join("clean")).unwrap().nlink(), 1);
        assert!(
            fs::symlink_metadata(dest.join("link"))
                .unwrap()
                .is_symlink()
        );
    }
    fs::write(dest.join("clean"), "B changed\n").unwrap();
    assert_eq!(fs::read(donor.join("clean")).unwrap(), b"original\n");
    git(&dest, &["reset", "--hard", "HEAD"]);
    assert_eq!(fs::read(donor.join("clean")).unwrap(), b"original\n");
    fs::write(donor.join("clean"), "A changed\n").unwrap();
    assert_eq!(fs::read(dest.join("clean")).unwrap(), b"original\n");
}
#[test]
fn forced_none_is_an_ordinary_checkout() {
    let f = Fixture::new();
    let donor = f.repo();
    let dest = f.0.join("fallback");
    let r = worktree_add(
        &donor,
        &dest,
        "HEAD",
        &Options {
            branch: Some("fallback".into()),
            force_no_cow: true,
            seed_target: true,
        },
    )
    .unwrap();
    assert_eq!(r.fallback, "git-checkout");
    assert_eq!(r.cloned_files, 0);
    assert!(r.target_skipped.is_some());
    assert!(git(&dest, &["status", "--porcelain"]).stdout.is_empty());
}
#[test]
fn cli_shapes_errors_and_no_unknown_passthrough() {
    let f = Fixture::new();
    let donor = f.repo();
    let o = cli(&donor, &["probe", "--json", f.0.to_str().unwrap()]);
    assert!(o.status.success());
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert!(v["cow"].is_string());
    let o = cli(&donor, &["worktree", "add", "--force", "bad", "HEAD"]);
    assert_eq!(o.status.code(), Some(2));
    let o = cli(&donor, &["worktree", "add", "--detach", "bad", "HEAD"]);
    assert_eq!(o.status.code(), Some(2));
    let o = cli(
        &donor,
        &[
            "worktree",
            "add",
            "-b",
            "bad",
            f.0.join("bad").to_str().unwrap(),
            "missing-ref",
        ],
    );
    assert_eq!(o.status.code(), Some(4));
    assert!(!f.0.join("bad").exists());
    let o = cli(&donor, &["measure", "--json", donor.to_str().unwrap()]);
    assert!(o.status.success());
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert!(v["logicalBytes"].as_u64().unwrap() > 0);
    assert_eq!(v["copyCount"], 0);
}
#[test]
#[cfg(unix)]
fn donor_lock_exit_three_leaves_no_checkout() {
    use std::os::fd::AsRawFd;
    let f = Fixture::new();
    let donor = f.repo();
    fs::create_dir_all(donor.join("target/debug")).unwrap();
    let lock = fs::File::create(donor.join("target/debug/.cargo-lock")).unwrap();
    assert_eq!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let dest = f.0.join("locked");
    let o = cli(
        &donor,
        &[
            "worktree",
            "add",
            "--seed-target",
            "-b",
            "locked",
            dest.to_str().unwrap(),
            "HEAD",
        ],
    );
    assert_eq!(
        o.status.code(),
        Some(3),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    assert!(!dest.exists());
    assert!(
        !String::from_utf8_lossy(&git(&donor, &["worktree", "list", "--porcelain"]).stdout)
            .contains(dest.to_str().unwrap())
    );
    let o = cli(
        &donor,
        &[
            "target",
            "seed",
            "--from",
            donor.join("target").to_str().unwrap(),
            "--to",
            f.0.join("target").to_str().unwrap(),
            "--json",
        ],
    );
    assert_eq!(o.status.code(), Some(3));
}
#[cfg(unix)]
fn git_wrapper(f: &Fixture, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let bin = f.0.join("bin");
    fs::create_dir(&bin).unwrap();
    let real = Command::new("/usr/bin/which").arg("git").output().unwrap();
    let real = String::from_utf8(real.stdout).unwrap();
    fs::write(
        bin.join("git"),
        format!("#!/bin/sh\n{body}\nexec '{}' \"$@\"\n", real.trim()),
    )
    .unwrap();
    fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
    bin
}
#[test]
#[cfg(unix)]
fn failed_checkout_removes_own_registration_and_partial_only() {
    let f = Fixture::new();
    let donor = f.repo();
    let dest = f.0.join("failed");
    let sentinel = f.0.join("someone-else.pwrgit-share-partial");
    fs::create_dir(&sentinel).unwrap();
    let bin = git_wrapper(&f, "case \"$*\" in *'reset --hard'*) exit 1;; esac");
    let o = Command::new(env!("CARGO_BIN_EXE_pwrgit-share"))
        .current_dir(&donor)
        .env(
            "PATH",
            format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
        )
        .args([
            "worktree",
            "add",
            "-b",
            "failed",
            dest.to_str().unwrap(),
            "HEAD",
        ])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(!dest.exists());
    assert!(sentinel.exists());
    assert_eq!(
        fs::read_dir(&f.0)
            .unwrap()
            .filter(|e| e
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".pwrgit-share-partial"))
            .count(),
        1
    );
    assert!(
        !String::from_utf8_lossy(&git(&donor, &["worktree", "list", "--porcelain"]).stdout)
            .contains(dest.to_str().unwrap())
    );
}
#[test]
#[cfg(unix)]
fn cancellation_removes_registered_worktree_and_partial() {
    use std::time::{Duration, Instant};
    let f = Fixture::new();
    let donor = f.repo();
    let dest = f.0.join("cancelled");
    let marker = f.0.join("ready");
    let bin = git_wrapper(
        &f,
        &format!(
            "case \"$*\" in *'hash-object'*) touch '{}'; while test -f '{}'; do sleep 0.02; done;; esac",
            marker.display(),
            marker.display()
        ),
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_pwrgit-share"))
        .current_dir(&donor)
        .env(
            "PATH",
            format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
        )
        .args([
            "worktree",
            "add",
            "-b",
            "cancelled",
            dest.to_str().unwrap(),
            "HEAD",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !marker.exists() {
        if probe(&f.0).unwrap().cow == "none" {
            let _ = child.wait();
            return;
        }
        assert!(
            Instant::now() < deadline,
            "did not reach cancellation boundary"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGINT) }, 0);
    fs::remove_file(&marker).unwrap();
    let o = child.wait_with_output().unwrap();
    assert_eq!(
        o.status.code(),
        Some(130),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    assert!(!dest.exists());
    assert!(!fs::read_dir(&f.0).unwrap().any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".pwrgit-share-partial")
    }));
    assert!(
        !String::from_utf8_lossy(&git(&donor, &["worktree", "list", "--porcelain"]).stdout)
            .contains(dest.to_str().unwrap())
    );
}
#[test]
#[cfg(unix)]
fn hash_mismatch_is_checked_out_and_hash_failure_falls_back() {
    for mismatch in [true, false] {
        let f = Fixture::new();
        let donor = f.repo();
        let dest = f.0.join("hashed");
        let bin = git_wrapper(
            &f,
            if mismatch {
                "case \"$*\" in *'hash-object'*) echo 0000000000000000000000000000000000000000; exit 0;; esac"
            } else {
                "case \"$*\" in *'hash-object'*) exit 1;; esac"
            },
        );
        let o = Command::new(env!("CARGO_BIN_EXE_pwrgit-share"))
            .current_dir(&donor)
            .env(
                "PATH",
                format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
            )
            .args([
                "worktree",
                "add",
                "--json",
                "-b",
                "hashed",
                dest.to_str().unwrap(),
                "HEAD",
            ])
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        if probe(&f.0).unwrap().cow != "none" {
            if mismatch {
                assert!(v["hashedMismatches"].as_u64().unwrap() > 0);
            } else {
                assert_eq!(v["fallback"], "git-checkout");
            }
        }
        assert_eq!(fs::read(dest.join("clean")).unwrap(), b"original\n");
        assert!(git(&dest, &["status", "--porcelain"]).stdout.is_empty());
    }
}
#[test]
fn existing_directory_and_symlink_donors_are_not_removed_or_followed() {
    let f = Fixture::new();
    let donor = f.repo();
    let dest = f.0.join("existing");
    fs::create_dir(&dest).unwrap();
    fs::write(dest.join("keep"), "mine").unwrap();
    assert!(worktree_add(&donor, &dest, "HEAD", &Options::default()).is_err());
    assert_eq!(fs::read(dest.join("keep")).unwrap(), b"mine");
    #[cfg(unix)]
    {
        fs::remove_file(donor.join("clean")).unwrap();
        std::os::unix::fs::symlink("untracked", donor.join("clean")).unwrap();
        let dest = f.0.join("safe");
        worktree_add(
            &donor,
            &dest,
            "HEAD",
            &Options {
                branch: Some("safe".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(fs::read(dest.join("clean")).unwrap(), b"original\n");
    }
}
#[test]
fn branch_argument_keeps_gits_branch_semantics() {
    let f = Fixture::new();
    let donor = f.repo();
    git(&donor, &["branch", "available"]);
    let dest = f.0.join("available");
    worktree_add(&donor, &dest, "available", &Options::default()).unwrap();
    assert_eq!(
        String::from_utf8_lossy(&git(&dest, &["symbolic-ref", "--short", "HEAD"]).stdout).trim(),
        "available"
    );
}
#[test]
#[cfg(unix)]
fn unproven_cargo_and_mismatched_toolchain_return_zero_without_target() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let donor = f.repo();
    fs::write(
        donor.join("Cargo.toml"),
        "[package]\nname='fixture'\nversion='0.1.0'\n",
    )
    .unwrap();
    fs::create_dir_all(donor.join("target/debug")).unwrap();
    let rustc = Command::new("rustc").arg("-vV").output().unwrap();
    let rustc = String::from_utf8(rustc.stdout).unwrap();
    let commit = rustc
        .lines()
        .find_map(|s| s.strip_prefix("commit-hash: "))
        .unwrap();
    fs::write(
        donor.join("target/.rustc_info.json"),
        serde_json::json!({"version":commit}).to_string(),
    )
    .unwrap();
    let bin = f.0.join("fake-cargo");
    fs::create_dir(&bin).unwrap();
    let meta = serde_json::json!({"workspace_members":["fixture"],"packages":[{"id":"fixture","name":"fixture","source":null},{"id":"dep","name":"dep","source":"registry+fixture"}]});
    fs::write(bin.join("cargo"),format!("#!/bin/sh\ncase \"$1\" in --version) echo 'cargo 9.99.9 (unproven)';; metadata) echo '{}';; *) exit 1;; esac\n",meta)).unwrap();
    fs::set_permissions(bin.join("cargo"), fs::Permissions::from_mode(0o755)).unwrap();
    let dest = f.0.join("unproven");
    let invoke = || {
        Command::new(env!("CARGO_BIN_EXE_pwrgit-share"))
            .current_dir(&donor)
            .env("CARGO_HOME", f.0.join("temp-cargo-home"))
            .env(
                "PATH",
                format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
            )
            .args([
                "target",
                "seed",
                "--from",
                donor.join("target").to_str().unwrap(),
                "--to",
                dest.to_str().unwrap(),
                "--json",
            ])
            .output()
            .unwrap()
    };
    let o = invoke();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["unitsSeeded"], 0);
    assert_eq!(v["copyCount"], 0);
    assert!(!dest.exists());
    if probe(&f.0).unwrap().cow != "none" {
        assert_eq!(v["reason"], "fingerprint-unproven");
        assert_eq!(v["unitsSkipped"]["fingerprint-unproven"], 1);
    }
    fs::write(donor.join("target/.rustc_info.json"), "{}").unwrap();
    let o = invoke();
    assert!(o.status.success());
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["unitsSeeded"], 0);
    assert!(!dest.exists());
    if probe(&f.0).unwrap().cow != "none" {
        assert_eq!(v["reason"], "toolchain-mismatch");
    }
}
