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
        Self(fs::canonicalize(p).unwrap())
    }
    fn repo(&self) -> PathBuf {
        self.repo_with_format("sha1")
    }
    fn repo_with_format(&self, format: &str) -> PathBuf {
        let p = self.0.join("donor");
        fs::create_dir(&p).unwrap();
        git(&p, &["init", "-b", "main", "--object-format", format]);
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
fn busy_donor_is_a_skip_reason_and_the_worktree_still_succeeds() {
    // R6: a donor that is building right now is never waited on and never
    // fails the worktree. Legacy and Cargo 1.96+ lock layouts both count.
    use std::os::fd::AsRawFd;
    for (name, mode) in [
        (".cargo-lock", libc::LOCK_EX),
        (".cargo-build-lock", libc::LOCK_EX),
        (".cargo-artifact-lock", libc::LOCK_EX),
    ] {
        let f = Fixture::new();
        let donor = f.repo();
        fs::write(
            donor.join("Cargo.toml"),
            "[package]\nname='fixture'\nversion='0.1.0'\n",
        )
        .unwrap();
        fs::create_dir_all(donor.join("target/debug")).unwrap();
        // Cargo 1.96+ keeps the legacy lock shared while it builds.
        let legacy = fs::File::create(donor.join("target/debug/.cargo-lock")).unwrap();
        let legacy_mode = if name == ".cargo-lock" {
            mode
        } else {
            libc::LOCK_SH
        };
        assert_eq!(
            unsafe { libc::flock(legacy.as_raw_fd(), legacy_mode | libc::LOCK_NB) },
            0
        );
        let _held = (name != ".cargo-lock").then(|| {
            let current = fs::File::create(donor.join("target/debug").join(name)).unwrap();
            assert_eq!(
                unsafe { libc::flock(current.as_raw_fd(), mode | libc::LOCK_NB) },
                0
            );
            current
        });
        let dest = f.0.join("busy");
        let o = cli(
            &donor,
            &[
                "worktree",
                "add",
                "--seed-target",
                "-b",
                "busy",
                dest.to_str().unwrap(),
                "HEAD",
            ],
        );
        assert!(
            o.status.success(),
            "{name}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        if v["fallback"] == "none" {
            assert_eq!(v["target"]["reason"], "donor-busy", "{name}: {v}");
            assert_eq!(v["target"]["unitsSeeded"], 0);
        } else {
            assert_eq!(v["targetSkipped"], "cow-unavailable");
        }
        assert_eq!(fs::read(dest.join("clean")).unwrap(), b"original\n");
        assert!(!dest.join("target").exists());
        assert!(
            String::from_utf8_lossy(&git(&donor, &["worktree", "list", "--porcelain"]).stdout)
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
                dest.join("target").to_str().unwrap(),
                "--json",
            ],
        );
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["reason"], "donor-busy");
        assert!(!dest.join("target").exists());
    }
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
                "case \"$*\" in *'hash-object'*) while read -r _; do echo 0000000000000000000000000000000000000000; done; exit 0;; esac"
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
fn unproven_mismatched_and_overridden_toolchains_seed_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let donor = f.repo();
    let manifest = "[package]\nname='fixture'\nversion='0.1.0'\n";
    fs::write(donor.join("Cargo.toml"), manifest).unwrap();
    fs::create_dir_all(donor.join("target/debug")).unwrap();
    let recipient = f.0.join("recipient");
    fs::create_dir(&recipient).unwrap();
    fs::write(recipient.join("Cargo.toml"), manifest).unwrap();
    let home = f.0.join("temp-cargo-home");
    fs::create_dir(&home).unwrap();
    // The rustc the seeder will see: the directory's toolchain, not the one
    // rustup exported to this test process.
    let rustc = Command::new("rustc")
        .current_dir(&recipient)
        .env_remove("RUSTUP_TOOLCHAIN")
        .arg("-vV")
        .output()
        .unwrap();
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
    // The recipient directory can pin a different Cargo than the donor's.
    fs::write(
        bin.join("cargo"),
        r#"#!/bin/sh
case "$1" in
  --version) case "$(pwd -P)" in
      */recipient) echo "${FAKE_RECIPIENT_CARGO:-cargo 9.99.9 (unproven)}";;
      *) echo 'cargo 9.99.9 (unproven)';;
    esac;;
  *) exit 91;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(bin.join("cargo"), fs::Permissions::from_mode(0o755)).unwrap();
    let dest = recipient.join("target");
    let invoke = |env: &[(&str, &str)]| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_pwrgit-share"));
        cmd.current_dir(&donor)
            .env("CARGO_HOME", &home)
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
            ]);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let o = cmd.output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["unitsSeeded"], 0);
        assert_eq!(v["copyCount"], 0);
        assert!(!dest.exists());
        v
    };
    let cow = probe(&f.0).unwrap().cow != "none";
    let cases: [(&[(&str, &str)], &str); 3] = [
        (&[], "fingerprint-unproven"),
        (
            &[("FAKE_RECIPIENT_CARGO", "cargo 9.99.8 (recipient pin)")],
            "toolchain-mismatch",
        ),
        (&[("RUSTFLAGS", "--cfg pwrgit_share_probe")], "env-override"),
    ];
    for (env, reason) in cases {
        let v = invoke(env);
        if cow {
            assert_eq!(v["reason"], reason, "{v}");
        }
    }
    fs::write(donor.join("target/.rustc_info.json"), "{}").unwrap();
    let v = invoke(&[]);
    if cow {
        assert_eq!(v["reason"], "toolchain-mismatch");
    }
    // Never seed into, or merge with, an existing target.
    fs::create_dir(&dest).unwrap();
    fs::write(dest.join("keep"), "mine").unwrap();
    let o = cli(
        &donor,
        &[
            "target",
            "seed",
            "--from",
            donor.join("target").to_str().unwrap(),
            "--to",
            dest.to_str().unwrap(),
            "--json",
        ],
    );
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["reason"], "target-exists");
    assert_eq!(fs::read_dir(&dest).unwrap().count(), 1);
}
#[test]
fn inherited_repository_overrides_never_select_the_donor_for_destination_commands() {
    for fallback in [false, true] {
        let f = Fixture::new();
        let donor = f.repo();
        let dest = f.0.join("recipient");
        let index_before = fs::read(donor.join(".git/index")).unwrap();
        let invoke = |args: &[&str]| {
            Command::new(env!("CARGO_BIN_EXE_pwrgit-share"))
                .current_dir(&donor)
                .env("GIT_DIR", donor.join(".git"))
                .env("GIT_WORK_TREE", &donor)
                .env("GIT_COMMON_DIR", donor.join(".git"))
                .env("GIT_INDEX_FILE", donor.join(".git/index"))
                .env("GIT_OBJECT_DIRECTORY", donor.join(".git/objects"))
                .env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", "core.worktree")
                .env("GIT_CONFIG_VALUE_0", &donor)
                .env("PWRGIT_SHARE_FORCE_NONE", if fallback { "1" } else { "0" })
                .args(args)
                .output()
                .unwrap()
        };
        let o = invoke(&[
            "worktree",
            "add",
            "--json",
            "-b",
            "recipient",
            dest.to_str().unwrap(),
            "HEAD",
        ]);
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        assert_eq!(fs::read(donor.join("dirty")).unwrap(), b"private edit\n");
        assert_eq!(fs::read(donor.join(".git/index")).unwrap(), index_before);
        assert_eq!(fs::read(dest.join("dirty")).unwrap(), b"committed\n");
        assert_eq!(fs::read(dest.join("clean")).unwrap(), b"original\n");
        assert!(git(&dest, &["status", "--porcelain"]).stdout.is_empty());
        let report: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        let o = invoke(&["measure", "--json", dest.to_str().unwrap()]);
        assert!(o.status.success());
        let measured: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(measured["cloneCount"], report["clonedFiles"]);
        assert_eq!(measured["skipCount"], report["checkoutFiles"]);
        assert!(
            measured["countsOrigin"]
                .as_str()
                .unwrap()
                .starts_with("recorded")
        );
    }
}

#[test]
fn target_attributes_and_autocrlf_match_an_ordinary_checkout() {
    // Unchanged blob IDs are insufficient when the destination introduces a
    // checkout conversion. The donor intentionally remains at the old commit.
    for case in [
        "filter",
        "filter-unset",
        "filter-unspecified",
        "eol",
        "ident",
        "encoding",
        "autocrlf",
    ] {
        let f = Fixture::new();
        let donor = f.repo();
        git(&donor, &["config", "core.autocrlf", "false"]);
        fs::write(donor.join("clean"), "$Id$\noriginal\n").unwrap();
        git(&donor, &["add", "clean"]);
        git(&donor, &["commit", "-m", "conversion input"]);
        let old = String::from_utf8(git(&donor, &["rev-parse", "HEAD"]).stdout).unwrap();
        let attr = match case {
            "filter" | "filter-unset" | "filter-unspecified" => {
                let driver = case.strip_prefix("filter-").unwrap_or("fixture");
                git(
                    &donor,
                    &[
                        "config",
                        &format!("filter.{driver}.smudge"),
                        "sed s/original/smudged/g",
                    ],
                );
                git(
                    &donor,
                    &[
                        "config",
                        &format!("filter.{driver}.clean"),
                        "sed s/smudged/original/g",
                    ],
                );
                format!("clean filter={driver}\n")
            }
            "eol" => "clean text eol=crlf\n".into(),
            "ident" => "clean ident\n".into(),
            "encoding" => "clean working-tree-encoding=UTF-16LE\n".into(),
            _ => "".into(),
        };
        fs::write(donor.join(".gitattributes"), attr).unwrap();
        git(&donor, &["add", ".gitattributes"]);
        git(&donor, &["commit", "-m", "target attributes"]);
        let target = String::from_utf8(git(&donor, &["rev-parse", "HEAD"]).stdout).unwrap();
        git(&donor, &["checkout", "--detach", old.trim()]);
        if case == "autocrlf" {
            git(&donor, &["config", "core.autocrlf", "true"]);
        }
        let plain = f.0.join("plain");
        git(
            &donor,
            &[
                "worktree",
                "add",
                "--detach",
                plain.to_str().unwrap(),
                target.trim(),
            ],
        );
        let expected = fs::read(plain.join("clean")).unwrap();
        assert_ne!(expected, fs::read(donor.join("clean")).unwrap(), "{case}");
        let dest = f.0.join("converted");
        let report = worktree_add(
            &donor,
            &dest,
            target.trim(),
            &Options {
                branch: Some("converted".into()),
                ..Default::default()
            },
        )
        .unwrap();
        if probe(&f.0).unwrap().cow != "none" && case != "autocrlf" {
            assert!(
                report.cloned_files > 0,
                "unconverted files still clone: {case}"
            );
        }
        assert_eq!(fs::read(dest.join("clean")).unwrap(), expected, "{case}");
        assert!(
            git(&dest, &["status", "--porcelain"]).stdout.is_empty(),
            "{case}"
        );
        assert_eq!(fs::read(donor.join("dirty")).unwrap(), b"private edit\n");
    }
}

#[test]
fn large_trees_clone_through_batched_git_calls() {
    // More paths and hashes than a pipe buffer holds: Git is driven in a few
    // batches, not once per file, and must not deadlock on full pipes.
    let f = Fixture::new();
    let donor = f.repo();
    for d in 0..30 {
        let dir = donor.join(format!("dir{d}"));
        fs::create_dir_all(&dir).unwrap();
        for n in 0..100 {
            fs::write(
                dir.join(format!("file-with-a-long-name-{n}.txt")),
                format!("{d}/{n}\n"),
            )
            .unwrap();
        }
    }
    git(&donor, &["add", "."]);
    git(&donor, &["commit", "-m", "many files"]);
    let head = String::from_utf8(git(&donor, &["rev-parse", "HEAD"]).stdout).unwrap();
    let dest = f.0.join("many");
    let report = worktree_add(&donor, &dest, head.trim(), &Options::default()).unwrap();
    if probe(&f.0).unwrap().cow != "none" {
        assert!(report.cloned_files >= 3000, "{report:?}");
    }
    assert_eq!(
        fs::read(dest.join("dir29/file-with-a-long-name-99.txt")).unwrap(),
        b"29/99\n"
    );
    assert!(git(&dest, &["status", "--porcelain"]).stdout.is_empty());
}

#[test]
fn lf_line_ending_attributes_still_clone() {
    // `* text=auto eol=lf` (PwrRoute's .gitattributes) and plain `text` with
    // LF output leave checkout bytes equal to the blob, so they must clone.
    for attr in [
        "* text=auto eol=lf\n",
        "* text\n",
        "* eol=lf\n",
        "* -text\n",
    ] {
        let f = Fixture::new();
        let donor = f.repo();
        git(&donor, &["config", "core.autocrlf", "false"]);
        fs::write(donor.join(".gitattributes"), attr).unwrap();
        fs::write(donor.join("clean"), "line one\nline two\n").unwrap();
        git(&donor, &["add", ".gitattributes", "clean"]);
        git(&donor, &["commit", "-m", "lf attributes"]);
        let head = String::from_utf8(git(&donor, &["rev-parse", "HEAD"]).stdout).unwrap();
        let plain = f.0.join("plain");
        git(
            &donor,
            &[
                "worktree",
                "add",
                "--detach",
                plain.to_str().unwrap(),
                head.trim(),
            ],
        );
        let dest = f.0.join("shared");
        let report = worktree_add(&donor, &dest, head.trim(), &Options::default()).unwrap();
        if probe(&f.0).unwrap().cow != "none" {
            assert!(report.cloned_files >= 2, "{attr:?}: {report:?}");
        }
        for name in ["clean", ".gitattributes"] {
            assert_eq!(
                fs::read(dest.join(name)).unwrap(),
                fs::read(plain.join(name)).unwrap(),
                "{attr:?} {name}"
            );
        }
        assert!(
            git(&dest, &["status", "--porcelain"]).stdout.is_empty(),
            "{attr:?}"
        );
    }
}

#[test]
#[cfg(unix)]
fn post_checkout_matches_git_arguments_cwd_and_materialized_files() {
    use std::os::unix::fs::PermissionsExt;
    for (fallback, format) in [
        (false, "sha1"),
        (true, "sha1"),
        (false, "sha256"),
        (true, "sha256"),
    ] {
        let f = Fixture::new();
        let donor = f.repo_with_format(format);
        // Relative core.hooksPath must be resolved in the new worktree.
        fs::create_dir(donor.join("fixture-hooks")).unwrap();
        let hook = donor.join("fixture-hooks/post-checkout");
        fs::write(&hook, "#!/bin/sh\nset -eu\ntest \"$(cat clean)\" = original\ntest \"$(cat dirty)\" = committed\nprintf '%s\\n' \"$PWD\" \"$1\" \"$2\" \"$3\" >> hook-ran\necho hook-output\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        git(&donor, &["add", "fixture-hooks"]);
        git(&donor, &["commit", "-m", "hook fixture"]);
        git(&donor, &["config", "core.hooksPath", "fixture-hooks"]);
        let plain = f.0.join("plain");
        git(
            &donor,
            &[
                "worktree",
                "add",
                "--detach",
                plain.to_str().unwrap(),
                "HEAD",
            ],
        );
        let expected = fs::read_to_string(plain.join("hook-ran")).unwrap();
        let dest = f.0.join("hooked");
        let o = Command::new(env!("CARGO_BIN_EXE_pwrgit-share"))
            .current_dir(&donor)
            .env("GIT_DIR", donor.join(".git"))
            .env("GIT_WORK_TREE", &donor)
            .env("PWRGIT_SHARE_FORCE_NONE", if fallback { "1" } else { "0" })
            .args([
                "worktree",
                "add",
                "--json",
                "-b",
                "hooked",
                dest.to_str().unwrap(),
                "HEAD",
            ])
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        // Hook stdout must not corrupt the CLI's JSON protocol.
        let _: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        let actual = fs::read_to_string(dest.join("hook-ran")).unwrap();
        let mut expected_lines = expected.lines();
        let mut actual_lines = actual.lines();
        assert_eq!(expected_lines.next(), Some(plain.to_str().unwrap()));
        assert_eq!(actual_lines.next(), Some(dest.to_str().unwrap()));
        assert_eq!(
            actual_lines.collect::<Vec<_>>(),
            expected_lines.collect::<Vec<_>>()
        );
        assert!(!donor.join("hook-ran").exists());
        assert_eq!(fs::read(donor.join("dirty")).unwrap(), b"private edit\n");
    }
}

#[test]
#[cfg(unix)]
fn failing_post_checkout_removes_only_its_worktree_and_partial() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let donor = f.repo();
    let hook = donor.join(".git/hooks/post-checkout");
    fs::write(&hook, "#!/bin/sh\nexit 17\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let dest = f.0.join("failed-hook");
    let sentinel = f.0.join("other.pwrgit-share-partial");
    fs::create_dir(&sentinel).unwrap();
    let o = Command::new(env!("CARGO_BIN_EXE_pwrgit-share"))
        .current_dir(&donor)
        .env("GIT_DIR", donor.join(".git"))
        .env("GIT_WORK_TREE", &donor)
        .args([
            "worktree",
            "add",
            "-b",
            "failed-hook",
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
    assert_eq!(fs::read(donor.join("dirty")).unwrap(), b"private edit\n");
}

#[test]
#[cfg(unix)]
fn benchmark_reports_json_when_target_seeding_is_skipped() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let wrapper = f.0.join("force-no-cow");
    fs::write(&wrapper, "#!/bin/sh\nif test \"$1\" = probe; then\n  echo '{\"cow\":\"none\",\"detail\":\"forced fallback regression\"}'\nelse\n  PWRGIT_SHARE_FORCE_NONE=1 exec \"$PWRGIT_SHARE_TEST_BINARY\" \"$@\"\nfi\n").unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let o = Command::new("python3")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/benchmark.py"))
        .arg(wrapper)
        .env(
            "PWRGIT_SHARE_TEST_BINARY",
            env!("CARGO_BIN_EXE_pwrgit-share"),
        )
        .env("CARGO_HOME", f.0.join("temp-cargo-home"))
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let report: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(report["probe"]["cow"], "none");
    let seeded = report["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["run"] == "seeded")
        .unwrap();
    assert_eq!(seeded["report"]["targetSkipped"], "cow-unavailable");
    assert!(seeded["report"].get("target").is_none());
    assert_eq!(
        report["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["run"] == "same-commit")
            .unwrap()["counts"]["registryGit"]["Compiling"],
        2
    );
}
