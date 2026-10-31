//! Offline, real-Cargo experiment. This is deliberately not a production bypass.
use crate::*;
use std::{io::Write, time::Instant};
struct Fixture {
    root: OwnedDir,
    donor: PathBuf,
    home: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = unique_dir(
            &fs::canonicalize(std::env::temp_dir()).unwrap(),
            std::ffi::OsStr::new("cargo-gate"),
        )
        .unwrap();
        let donor = root.path.join("donor");
        let home = root.path.join("cargo-home");
        let vendor = donor.join("vendor/fixture-registry");
        fs::create_dir_all(donor.join("src")).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(donor.join(".cargo")).unwrap();
        fs::create_dir_all(vendor.join("src")).unwrap();
        fs::write(
            donor.join(".cargo/config.toml"),
            "[source.crates-io]\nreplace-with='fixture'\n[source.fixture]\ndirectory='vendor'\n",
        )
        .unwrap();
        fs::write(vendor.join("Cargo.toml"),"[package]\nname='fixture-registry'\nversion='1.0.0'\nedition='2021'\n[features]\nextra=[]\n").unwrap();
        let mut file = File::create(vendor.join("src/lib.rs")).unwrap();
        writeln!(file, "pub static TABLE: [u64; 131072] = [").unwrap();
        for n in 0u64..131072 {
            writeln!(file, "{},", n.wrapping_mul(2654435761)).unwrap();
        }
        writeln!(file, "]; pub fn value()->u64 {{ TABLE[42] }}").unwrap();
        fs::write(
            vendor.join(".cargo-checksum.json"),
            r#"{"files":{},"package":null}"#,
        )
        .unwrap();
        fs::write(donor.join("Cargo.toml"),"[package]\nname='fixture-workspace'\nversion='0.1.0'\nedition='2021'\n[dependencies]\nfixture-registry='=1.0.0'\n[features]\nextra=['fixture-registry/extra']\n").unwrap();
        fs::write(
            donor.join("src/main.rs"),
            "fn main() { println!(\"{}\", fixture_registry::value()); }\n",
        )
        .unwrap();
        fs::write(donor.join(".gitignore"), "target/\n").unwrap();
        git_s(&donor, &["init", "-b", "main"], 1).unwrap();
        git_s(
            &donor,
            &["config", "user.email", "fixture@example.invalid"],
            1,
        )
        .unwrap();
        git_s(&donor, &["config", "user.name", "Fixture"], 1).unwrap();
        Self { root, donor, home }
    }
    fn build(&self, dir: &Path, flags: Option<&str>) -> String {
        let mut cmd = Command::new("cargo");
        cmd.current_dir(dir)
            .env("CARGO_HOME", &self.home)
            .env_remove("CARGO_TARGET_DIR")
            .env_remove("CARGO_BUILD_TARGET_DIR")
            .env_remove("CARGO_BUILD_BUILD_DIR")
            .env_remove("RUSTC_WRAPPER")
            .env_remove("RUSTC_WORKSPACE_WRAPPER")
            .args(["build", "--offline", "-v"]);
        if let Some(flags) = flags {
            cmd.env("RUSTFLAGS", flags);
        } else {
            cmd.env_remove("RUSTFLAGS");
        }
        let o = output(&mut cmd, 1).unwrap();
        String::from_utf8_lossy(&o.stderr).into_owned()
    }
}
use std::fs::File;
#[test]
fn cargo_donor_independent_freshness_gate() {
    let f = Fixture::new();
    let cold = f.build(&f.donor, None);
    assert!(cold.contains("Compiling fixture-registry"));
    assert!(cold.contains("Compiling fixture-workspace"));
    git_s(&f.donor, &["add", "."], 1).unwrap();
    git_s(&f.donor, &["commit", "-m", "offline fixture"], 1).unwrap();
    let dest = f.root.path.join("recipient");
    worktree_add(
        &f.donor,
        &dest,
        "HEAD",
        &Options {
            branch: Some("recipient".into()),
            ..Default::default()
        },
    )
    .unwrap();
    // Read package identity from the temp home, not the operator's Cargo home.
    let meta = output(
        Command::new("cargo")
            .current_dir(&f.donor)
            .env("CARGO_HOME", &f.home)
            .args(["metadata", "--offline", "--format-version", "1"]),
        1,
    )
    .unwrap();
    let meta: serde_json::Value = serde_json::from_slice(&meta.stdout).unwrap();
    assert!(
        meta["packages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "fixture-registry"
                && p["source"].as_str().unwrap_or("").starts_with("registry+"))
    );
    if probe(&f.root.path).unwrap().cow == "none" {
        eprintln!("freshness gate: cow-unavailable; no candidate bytes seeded");
        return;
    }
    let report = target::seed_locked_with_home(
        &f.donor.join("target"),
        &dest.join("target"),
        &target::DonorLocks::acquire(&f.donor.join("target")).unwrap(),
        Some(&f.home),
    )
    .unwrap();
    assert_eq!(report.units_seeded, 0, "{report:?}");
    assert_eq!(report.reason.as_deref(), Some("fingerprint-unproven"));
    assert_eq!(report.copy_count, 0);
    assert_eq!(report.clone_count, 0);
    assert!(!dest.join("target").exists());
    let candidate = target::experimental_seed(
        &f.donor.join("target"),
        &dest.join("target"),
        &target::DonorLocks::acquire(&f.donor.join("target")).unwrap(),
        &f.home,
    )
    .unwrap();
    assert_eq!(candidate.units_seeded, 1);
    let count = candidate.clone_count;
    assert!(count > 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        for entry in fs::read_dir(dest.join("target/debug/.fingerprint")).unwrap() {
            for file in fs::read_dir(entry.unwrap().path()).unwrap() {
                assert_eq!(file.unwrap().metadata().unwrap().nlink(), 1);
            }
        }
    }
    let hidden = f.root.path.join("donor-hidden-target");
    fs::rename(f.donor.join("target"), &hidden).unwrap();
    let start = Instant::now();
    let seeded = f.build(&dest, None);
    let fresh = seeded.contains("Fresh fixture-registry");
    assert!(seeded.contains("Compiling fixture-registry"));
    eprintln!(
        "rejected experimental seed ({} clones, {:.3}s):\n{}",
        count,
        start.elapsed().as_secs_f64(),
        seeded
    );
    fs::write(
        dest.join("src/main.rs"),
        "fn main() { println!(\"changed {}\", fixture_registry::value()); }\n",
    )
    .unwrap();
    let changed = f.build(&dest, None);
    assert!(changed.contains("Fresh fixture-registry"));
    assert!(changed.contains("Compiling fixture-workspace"));
    let flags = f.build(&dest, Some("--cfg pwrgit_share_probe"));
    assert!(flags.contains("Compiling fixture-registry"));
    // The production gate must agree with the result, never enable an ignored
    // seed merely because a later ordinary build is fresh.
    fs::rename(&hidden, f.donor.join("target")).unwrap();
    let out = output(
        Command::new(env!("CARGO"))
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .env("CARGO_HOME", &f.home)
            .args(["--version"]),
        1,
    )
    .unwrap();
    eprintln!(
        "gate Cargo: {}",
        String::from_utf8_lossy(&out.stdout).trim()
    );
    assert!(
        !fresh,
        "pinned Cargo now proves freshness: review the whole gate before enabling this version"
    );
    let report = target::seed_locked_with_home(
        &f.donor.join("target"),
        &f.root.path.join("public-target"),
        &target::DonorLocks::acquire(&f.donor.join("target")).unwrap(),
        Some(&f.home),
    )
    .unwrap();
    assert_eq!(report.units_seeded, 0, "{report:?}");
    assert_eq!(report.reason.as_deref(), Some("fingerprint-unproven"));
    assert_eq!(report.copy_count, 0);
    assert_eq!(report.clone_count, 0);
    assert!(!f.root.path.join("public-target").exists());
    // Incremental state exists in the donor but never entered the candidate.
    // This test never mutates the process-wide environment.
    assert!(
        !f.donor
            .join("target/debug/incremental")
            .read_dir()
            .unwrap()
            .collect::<Vec<_>>()
            .is_empty()
    );
}
