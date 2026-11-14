use pwrgit_share::probe;
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
fn cli_shapes_errors_and_no_unknown_passthrough() {
    let f = Fixture::new();
    let donor = f.repo();
    let o = cli(&donor, &["probe", "--json", f.0.to_str().unwrap()]);
    assert!(o.status.success());
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert!(v["cow"].is_string());
    let o = cli(&donor, &["measure", "--json", donor.to_str().unwrap()]);
    assert!(o.status.success());
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert!(v["logicalBytes"].as_u64().unwrap() > 0);
    assert_eq!(v["copyCount"], 0);
    // Git creates worktrees; this tool has no worktree command of its own.
    for args in [
        &["worktree", "add", "-b", "x", "x", "HEAD"][..],
        &["cargo", "seed", "--to", "x"],
        &["cargo", "seed", "--from", "a", "--to", "b", "--copy"],
        &["cargo", "seed", "--from", "a", "--from", "b", "--to", "c"],
        &["target", "seed", "--from", "a", "--to", "b"],
    ] {
        let o = cli(&donor, args);
        assert_eq!(o.status.code(), Some(2), "{args:?}");
    }
    assert!(!donor.join("x").exists());
}
#[test]
#[cfg(unix)]
fn a_symlinked_donor_target_is_never_followed() {
    let f = Fixture::new();
    let donor = f.repo();
    fs::write(
        donor.join("Cargo.toml"),
        "[package]\nname='fixture'\nversion='0.1.0'\n",
    )
    .unwrap();
    let real = f.0.join("elsewhere");
    fs::create_dir_all(real.join("debug")).unwrap();
    std::os::unix::fs::symlink(&real, donor.join("target")).unwrap();
    let dest = f.0.join("recipient");
    fs::create_dir(&dest).unwrap();
    fs::copy(donor.join("Cargo.toml"), dest.join("Cargo.toml")).unwrap();
    let o = cli(
        &donor,
        &[
            "cargo",
            "seed",
            "--from",
            donor.join("target").to_str().unwrap(),
            "--to",
            dest.join("target").to_str().unwrap(),
            "--json",
        ],
    );
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap_or_default();
    assert!(!o.status.success() || v["unitsSeeded"] == 0, "{v}");
    assert!(!dest.join("target").exists());
}
#[test]
#[cfg(unix)]
fn busy_donor_is_a_skip_reason_and_nothing_is_created() {
    // R6: a donor that is building right now is never waited on. Legacy and
    // Cargo 1.96+ lock layouts both count.
    use std::os::fd::AsRawFd;
    for name in [".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock"] {
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
            libc::LOCK_EX
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
                unsafe { libc::flock(current.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
                0
            );
            current
        });
        let dest = f.0.join("busy");
        fs::create_dir(&dest).unwrap();
        fs::copy(donor.join("Cargo.toml"), dest.join("Cargo.toml")).unwrap();
        let o = cli(
            &donor,
            &[
                "cargo",
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
        assert_eq!(v["reason"], "donor-busy", "{name}: {v}");
        assert_eq!(v["unitsSeeded"], 0);
        assert!(!dest.join("target").exists());
    }
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
                "cargo",
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
            "cargo",
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
#[cfg(unix)]
fn seed_mode_flags_reach_the_report() {
    // Bounded is the default; strict must be asked for.
    use std::os::fd::AsRawFd;
    let f = Fixture::new();
    let donor = f.repo();
    fs::write(
        donor.join("Cargo.toml"),
        "[package]\nname='fixture'\nversion='0.1.0'\n",
    )
    .unwrap();
    fs::create_dir_all(donor.join("target/debug")).unwrap();
    let lock = fs::File::create(donor.join("target/debug/.cargo-lock")).unwrap();
    assert_eq!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let recipient = f.0.join("recipient");
    fs::create_dir(&recipient).unwrap();
    fs::copy(donor.join("Cargo.toml"), recipient.join("Cargo.toml")).unwrap();
    for mode in ["bounded", "strict"] {
        let mut args = vec!["cargo", "seed"];
        if mode == "strict" {
            args.push("--strict");
        }
        let to = recipient.join("target");
        let from = donor.join("target");
        args.extend([
            "--from",
            from.to_str().unwrap(),
            "--to",
            to.to_str().unwrap(),
        ]);
        let o = cli(&donor, &args);
        let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["mode"], mode, "{v}");
    }
}
