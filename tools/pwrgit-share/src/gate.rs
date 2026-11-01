//! Offline, real-Cargo freshness gate for registry-only target seeding.
//!
//! The fixture's registry is a Cargo local registry configured in the
//! fixture's own CARGO_HOME, so its sources unpack under CARGO_HOME exactly as
//! crates.io sources do; a `file://` Git dependency covers `git/checkouts`.
//! Positive units must be Fresh in the recipient with the donor's target
//! hidden, every negative fixture must recompile there, and the recipient's
//! test results must survive corrupting and then deleting the donor. Both
//! seed modes run: bounded (the default) and strict.
//!
//! Run under another toolchain with PWRGIT_SHARE_GATE_TOOLCHAINS=1.97.1,1.95.0.
//! A Cargo version enters PROVEN_CARGO only after this passes under it.
use crate::*;
use std::collections::BTreeSet;
use target::SeedMode;

const DATA: &str = "gate fixture v1\n";

struct Fixture {
    root: OwnedDir,
    home: PathBuf,
    toolchain: String,
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// Cargo with the fixture's home and no inherited overrides. RUSTUP_TOOLCHAIN
/// is dropped so the fixture's rust-toolchain.toml decides.
fn cargo_env(dir: &Path, home: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut cmd = Command::new("cargo");
    cmd.current_dir(dir).env("CARGO_HOME", home).args(args);
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy();
        let inherited = k.starts_with("CARGO_")
            || k.starts_with("RUSTUP_TOOLCHAIN")
            || [
                "RUSTFLAGS",
                "RUSTC",
                "RUSTC_WRAPPER",
                "RUSTC_WORKSPACE_WRAPPER",
            ]
            .contains(&k.as_ref());
        if inherited && k != "CARGO_HOME" {
            cmd.env_remove(k.as_ref());
        }
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.output().unwrap()
}
fn cargo(dir: &Path, home: &Path, args: &[&str]) -> Output {
    cargo_env(dir, home, args, &[])
}
fn ok(o: Output, what: &str) -> String {
    let err = String::from_utf8_lossy(&o.stderr).into_owned();
    assert!(o.status.success(), "{what}:\n{err}");
    err
}
fn git_init(dir: &Path) {
    git_s(dir, &["init", "-q", "-b", "main"], 1).unwrap();
    git_s(dir, &["config", "user.email", "fixture@example.invalid"], 1).unwrap();
    git_s(dir, &["config", "user.name", "Fixture"], 1).unwrap();
}

/// One package in the fixture's local registry.
struct Crate {
    name: &'static str,
    manifest: String,
    files: Vec<(&'static str, String)>,
    deps: Vec<&'static str>,
}

const OUT_DIR_CODE: &str = r#"fn main() {
    let out = std::env::var("OUT_DIR").unwrap();
    std::fs::write(format!("{out}/data"), "generated\n").unwrap();
    std::fs::write(
        format!("{out}/gen.rs"),
        "pub fn data_path() -> &'static str { concat!(env!(\"OUT_DIR\"), \"/data\") }\n",
    )
    .unwrap();
    println!("cargo:rerun-if-changed=build.rs");
}
"#;

impl Fixture {
    fn new(toolchain: &str, with_registry: bool) -> Self {
        let root = unique_dir(
            &fs::canonicalize(std::env::temp_dir()).unwrap(),
            std::ffi::OsStr::new("cargo-gate"),
        )
        .unwrap();
        let home = root.path.join("cargo-home");
        fs::create_dir_all(&home).unwrap();
        let f = Self {
            root,
            home,
            toolchain: toolchain.into(),
        };
        if with_registry {
            f.publish_registry();
            f.publish_git();
        }
        f
    }
    fn path(&self, p: &str) -> PathBuf {
        self.root.path.join(p)
    }
    fn publish_registry(&self) {
        let registry = self.path("registry");
        fs::create_dir_all(registry.join("index")).unwrap();
        write(
            &self.home.join("config.toml"),
            &format!(
                "[source.crates-io]\nreplace-with = 'gate-local'\n[source.gate-local]\nlocal-registry = '{}'\n",
                registry.display()
            ),
        );
        let mut table = String::from("pub static TABLE: [u64; 4096] = [\n");
        for n in 0u64..4096 {
            table.push_str(&format!("{},\n", n.wrapping_mul(2654435761)));
        }
        table.push_str("];\n#[cfg(gate_seed_built)]\npub fn value() -> u64 { TABLE[42] }\n");
        let pkg = |name: &str, extra: &str| {
            format!("[package]\nname = '{name}'\nversion = '1.0.0'\nedition = '2021'\n{extra}")
        };
        let proc_macro = "use proc_macro::TokenStream;\n#[proc_macro]\npub fn answer(_: TokenStream) -> TokenStream { \"42u64\".parse().unwrap() }\n";
        let crates = [
            // Positive in both modes: a build script whose outputs pass the
            // scan. It names its OUT_DIR in a link-search line, which Cargo
            // must remap.
            Crate {
                name: "gate-seed",
                manifest: pkg("gate-seed", "build = 'build.rs'\n"),
                files: vec![
                    (
                        "build.rs",
                        "fn main() {\n    let out = std::env::var(\"OUT_DIR\").unwrap();\n    std::fs::write(format!(\"{out}/marker.txt\"), \"seed\").unwrap();\n    println!(\"cargo:rustc-link-search=native={out}\");\n    println!(\"cargo:rustc-check-cfg=cfg(gate_seed_built)\");\n    println!(\"cargo:rustc-cfg=gate_seed_built\");\n    println!(\"cargo:rerun-if-changed=build.rs\");\n}\n".into(),
                    ),
                    ("src/lib.rs", table),
                ],
                deps: vec![],
            },
            // Positive in both modes: a proc macro.
            Crate {
                name: "gate-macro",
                manifest: pkg("gate-macro", "[lib]\nproc-macro = true\n"),
                files: vec![("src/lib.rs", proc_macro.into())],
                deps: vec![],
            },
            // A proc macro the workspace builds with debug info, so its
            // macOS dylib carries a debug map (N_OSO) naming donor objects:
            // bounded only.
            Crate {
                name: "gate-dbg",
                manifest: pkg("gate-dbg", "[lib]\nproc-macro = true\n"),
                files: vec![("src/lib.rs", proc_macro.replace("answer", "dbg_answer"))],
                deps: vec![],
            },
            // Negative in both modes: the donor's workspace root, derived
            // by a registry build script and embedded in the rlib.
            Crate {
                name: "gate-root",
                manifest: pkg("gate-root", "build = 'build.rs'\n"),
                files: vec![
                    (
                        "build.rs",
                        "fn main() {\n    let out = std::env::var(\"OUT_DIR\").unwrap();\n    let root = out.split(\"/target/\").next().unwrap();\n    println!(\"cargo:rustc-env=GATE_ROOT={root}\");\n    println!(\"cargo:rerun-if-changed=build.rs\");\n}\n".into(),
                    ),
                    (
                        "src/lib.rs",
                        "pub const ROOT: &str = env!(\"GATE_ROOT\");\n#[inline(never)]\npub fn root() -> &'static str { ROOT }\n".into(),
                    ),
                ],
                deps: vec![],
            },
            // Negative by fixed point: clean itself, but built against a
            // rejected dependency.
            Crate {
                name: "gate-taint-user",
                manifest: pkg("gate-taint-user", "[dependencies]\ngate-root = '=1.0.0'\n"),
                files: vec![(
                    "src/lib.rs",
                    "pub fn root() -> &'static str { gate_root::root() }\n".into(),
                )],
                deps: vec!["gate-root"],
            },
            // Generated code that opens its own OUT_DIR at runtime. Bounded
            // mode seeds it; the recipient then reads the donor's copy.
            Crate {
                name: "gate-outdir",
                manifest: pkg("gate-outdir", "build = 'build.rs'\n"),
                files: vec![
                    ("build.rs", OUT_DIR_CODE.into()),
                    (
                        "src/lib.rs",
                        "include!(concat!(env!(\"OUT_DIR\"), \"/gen.rs\"));\npub fn read_data() -> std::io::Result<String> { std::fs::read_to_string(data_path()) }\n".into(),
                    ),
                ],
                deps: vec![],
            },
        ];
        let staging = self.path("registry-src");
        for c in crates {
            let dir = staging.join(format!("{}-1.0.0", c.name));
            write(&dir.join("Cargo.toml"), &c.manifest);
            for (p, text) in &c.files {
                write(&dir.join(p), text);
            }
            let file = registry.join(format!("{}-1.0.0.crate", c.name));
            let o = Command::new("tar")
                .env("COPYFILE_DISABLE", "1")
                .arg("-czf")
                .arg(&file)
                .arg("-C")
                .arg(&staging)
                .arg(format!("{}-1.0.0", c.name))
                .output()
                .unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let sum = Command::new("shasum")
                .args(["-a", "256"])
                .arg(&file)
                .output()
                .unwrap();
            let sum = String::from_utf8_lossy(&sum.stdout);
            let cksum = sum.split_whitespace().next().unwrap();
            let deps: Vec<_> = c
                .deps
                .iter()
                .map(|d| serde_json::json!({"name": d, "req": "=1.0.0", "features": [], "optional": false, "default_features": true, "target": null, "kind": "normal"}))
                .collect();
            let entry = serde_json::json!({"name": c.name, "vers": "1.0.0", "deps": deps, "cksum": cksum, "features": {}, "yanked": false});
            let n = c.name;
            let rel = match n.len() {
                1 | 2 => format!("{}/{n}", n.len()),
                3 => format!("3/{}/{n}", &n[..1]),
                _ => format!("{}/{}/{n}", &n[..2], &n[2..4]),
            };
            write(&registry.join("index").join(rel), &format!("{entry}\n"));
        }
    }
    /// A `file://` Git dependency whose build script reads GATE_FLAVOR and
    /// generates code into OUT_DIR, as mbx's freshness test does.
    fn publish_git(&self) {
        let dir = self.path("git-src/gate-git");
        write(
            &dir.join("Cargo.toml"),
            "[package]\nname = 'gate-git'\nversion = '0.1.0'\nedition = '2021'\nbuild = 'build.rs'\n",
        );
        write(
            &dir.join("build.rs"),
            "fn main() {\n    println!(\"cargo:rerun-if-env-changed=GATE_FLAVOR\");\n    println!(\"cargo:rerun-if-changed=build.rs\");\n    let flavor = std::env::var(\"GATE_FLAVOR\").unwrap_or_else(|_| \"plain\".into());\n    let out = std::env::var(\"OUT_DIR\").unwrap();\n    std::fs::write(format!(\"{out}/flavor.rs\"), format!(\"pub const FLAVOR: &str = {flavor:?};\\n\")).unwrap();\n}\n",
        );
        write(
            &dir.join("src/lib.rs"),
            "include!(concat!(env!(\"OUT_DIR\"), \"/flavor.rs\"));\n",
        );
        git_init(&dir);
        commit_all(&dir);
    }
    /// A Git workspace that uses the dependencies, plus every workspace
    /// hazard whole-target cloning got wrong.
    fn workspace(&self, name: &str) -> PathBuf {
        let w = self.path(name);
        write(
            &w.join("rust-toolchain.toml"),
            &format!(
                "[toolchain]\nchannel = '{}'\nprofile = 'minimal'\n",
                self.toolchain
            ),
        );
        write(
            &w.join("Cargo.toml"),
            "[workspace]\nmembers = ['app', 'runtime']\nresolver = '2'\n[profile.dev.package.gate-dbg]\ndebug = true\n",
        );
        write(&w.join(".gitignore"), "target/\n");
        write(&w.join("shared/data.txt"), DATA);
        write(
            &w.join("app/Cargo.toml"),
            &format!(
                "[package]\nname = 'gate-app'\nversion = '0.1.0'\nedition = '2021'\nbuild = 'build.rs'\n[[bin]]\nname = 'x'\npath = 'src/main.rs'\n[dependencies]\ngate-seed = '=1.0.0'\ngate-macro = '=1.0.0'\ngate-dbg = '=1.0.0'\ngate-taint-user = '=1.0.0'\ngate-git = {{ git = 'file://{}' }}\n",
                self.path("git-src/gate-git").display()
            ),
        );
        // Absolute rerun-if-changed, judged against wherever it was built.
        write(
            &w.join("app/build.rs"),
            "fn main() {\n    let dir = std::path::PathBuf::from(std::env::var(\"CARGO_MANIFEST_DIR\").unwrap());\n    let data = dir.join(\"../shared/data.txt\").canonicalize().unwrap();\n    println!(\"cargo:rerun-if-changed={}\", data.display());\n    println!(\"cargo:rustc-env=GATE_BUILD_DATA={}\", std::fs::read_to_string(&data).unwrap().trim());\n}\n",
        );
        // include_str! of a file outside the package.
        write(
            &w.join("app/src/lib.rs"),
            "pub const SHARED: &str = include_str!(\"../../shared/data.txt\");\npub const BUILD_DATA: &str = env!(\"GATE_BUILD_DATA\");\npub fn seed() -> u64 { gate_seed::value() }\npub fn answer() -> u64 { gate_macro::answer!() + gate_dbg::dbg_answer!() - 42 }\npub fn root() -> &'static str { gate_taint_user::root() }\npub fn flavor() -> &'static str { gate_git::FLAVOR }\n",
        );
        write(
            &w.join("app/src/main.rs"),
            "fn main() { println!(\"{} {} {}\", gate_app::SHARED.trim(), gate_app::seed(), gate_app::answer()); }\n",
        );
        // CARGO_MANIFEST_DIR and CARGO_BIN_EXE_x, which Cargo does not
        // fingerprint.
        write(
            &w.join("app/tests/it.rs"),
            r#"use std::path::{Path, PathBuf};
fn here() -> PathBuf { std::env::current_dir().unwrap().canonicalize().unwrap() }
fn target() -> PathBuf { here().parent().unwrap().join("target") }
#[test]
fn manifest_dir_is_this_checkout() {
    assert_eq!(Path::new(env!("CARGO_MANIFEST_DIR")).canonicalize().unwrap(), here());
}
#[test]
fn fixture_read_through_manifest_dir() {
    let data = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../shared/data.txt")).unwrap();
    assert_eq!(data, "gate fixture v1\n");
}
#[test]
fn binary_is_this_checkouts() {
    let exe = Path::new(env!("CARGO_BIN_EXE_x"));
    assert!(exe.starts_with(target()), "{}", exe.display());
    let out = std::process::Command::new(exe).output().unwrap();
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), format!("gate fixture v1 {} 42", gate_app::seed()));
}
#[test]
fn include_str_and_build_script_saw_this_checkout() {
    assert_eq!(gate_app::SHARED, "gate fixture v1\n");
    assert_eq!(gate_app::BUILD_DATA, "gate fixture v1");
}
#[test]
fn registry_root_is_this_checkouts() {
    assert_eq!(Path::new(gate_app::root()), here().parent().unwrap());
}
#[test]
fn seeded_registry_values() {
    assert_eq!(gate_app::seed(), 42u64.wrapping_mul(2654435761));
    assert_eq!(gate_app::answer(), 42);
    assert_eq!(gate_app::flavor(), "plain");
}
"#,
        );
        // Prints where gate-outdir's generated code looks, and what it read.
        write(
            &w.join("runtime/Cargo.toml"),
            "[package]\nname = 'gate-runtime'\nversion = '0.1.0'\nedition = '2021'\n[dependencies]\ngate-outdir = '=1.0.0'\n",
        );
        write(
            &w.join("runtime/src/main.rs"),
            "fn main() {\n    println!(\"{}\", gate_outdir::data_path());\n    match gate_outdir::read_data() {\n        Ok(d) => print!(\"{d}\"),\n        Err(e) => println!(\"error: {e}\"),\n    }\n}\n",
        );
        git_init(&w);
        w
    }
    fn cargo_version(&self, dir: &Path) -> String {
        String::from_utf8_lossy(&cargo(dir, &self.home, &["--version"]).stdout)
            .trim()
            .to_owned()
    }
    fn seed_env(&self, proven: bool) -> target::SeedEnv {
        target::SeedEnv {
            home: Some(self.home.clone()),
            experiment: !proven,
        }
    }
}

fn commit_all(dir: &Path) {
    git_s(dir, &["add", "."], 1).unwrap();
    git_s(dir, &["commit", "-q", "-m", "fixture"], 1).unwrap();
}

/// (unit, Fresh?) for every Fresh/Compiling line of a verbose build.
fn states(log: &str) -> Vec<(String, bool)> {
    log.lines()
        .filter_map(|l| {
            let l = l.trim_start();
            let (fresh, rest) = if let Some(r) = l.strip_prefix("Fresh ") {
                (true, r)
            } else if let Some(r) = l.strip_prefix("Compiling ") {
                (false, r)
            } else {
                return None;
            };
            Some((rest.split_whitespace().next()?.to_owned(), fresh))
        })
        .collect()
}
fn fresh(log: &str, name: &str) -> bool {
    let s: Vec<_> = states(log).into_iter().filter(|(n, _)| n == name).collect();
    assert!(!s.is_empty(), "{name} not built:\n{log}");
    s.iter().all(|(_, f)| *f)
}
fn compiled(log: &str, name: &str) -> bool {
    let s: Vec<_> = states(log).into_iter().filter(|(n, _)| n == name).collect();
    assert!(!s.is_empty(), "{name} not built:\n{log}");
    s.iter().all(|(_, f)| !*f)
}
fn compile_count(log: &str) -> usize {
    states(log).iter().filter(|(_, f)| !*f).count()
}
/// Test names and outcomes from `cargo test`, in a comparable form.
fn results(dir: &Path, home: &Path) -> (bool, BTreeSet<String>) {
    let o = cargo(dir, home, &["test", "-p", "gate-app", "--offline"]);
    let out = String::from_utf8_lossy(&o.stdout);
    let lines = out
        .lines()
        .filter(|l| l.starts_with("test ") && (l.ends_with(" ok") || l.ends_with("FAILED")))
        .map(str::to_owned)
        .collect();
    (o.status.success(), lines)
}
/// gate-runtime's output: the path its generated code opens, then the data
/// or the error.
fn runtime(dir: &Path, home: &Path) -> (String, String) {
    let o = cargo(dir, home, &["run", "-q", "-p", "gate-runtime", "--offline"]);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let out = String::from_utf8_lossy(&o.stdout).into_owned();
    let (path, rest) = out.split_once('\n').unwrap();
    (path.to_owned(), rest.trim().to_owned())
}
/// Every file a seed published, relative to the recipient target.
fn seeded_files(target: &Path) -> Vec<String> {
    fn walk(root: &Path, p: &Path, out: &mut Vec<String>) {
        for e in fs::read_dir(p).unwrap() {
            let e = e.unwrap();
            if e.file_type().unwrap().is_dir() {
                walk(root, &e.path(), out);
            } else {
                out.push(e.path().strip_prefix(root).unwrap().display().to_string());
            }
        }
    }
    let mut out = Vec::new();
    walk(target, target, &mut out);
    out
}
/// Content of every file under `dir`, for "did this change" checks.
fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<_> = seeded_files(dir)
        .into_iter()
        .map(|f| {
            let b = fs::read(dir.join(&f)).unwrap();
            (f, b)
        })
        .collect();
    files.sort();
    files
}
/// The single `<profile>/build/<name>-<hash>` directory holding an `out/`.
fn run_dir(target: &Path, name: &str) -> PathBuf {
    let build = target.join("debug/build");
    let mut dirs: Vec<_> = fs::read_dir(&build)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .strip_prefix(name)
                .is_some_and(|r| r.len() == 17 && r.starts_with('-'))
                && p.join("out").is_dir()
        })
        .collect();
    assert_eq!(dirs.len(), 1, "{name}: {dirs:?}");
    dirs.pop().unwrap()
}

fn toolchains() -> Vec<String> {
    std::env::var("PWRGIT_SHARE_GATE_TOOLCHAINS")
        .unwrap_or_else(|_| "1.97.1".into())
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

#[test]
fn cargo_registry_seed_freshness_gate() {
    for toolchain in toolchains() {
        for mode in [SeedMode::Bounded, SeedMode::Strict] {
            registry_gate(&toolchain, mode);
        }
        vendored_gate(&toolchain);
    }
}

fn registry_gate(toolchain: &str, mode: SeedMode) {
    let f = Fixture::new(toolchain, true);
    if probe(&f.root.path).unwrap().cow == "none" {
        eprintln!("freshness gate: cow-unavailable; nothing seeded");
        return;
    }
    let bounded = mode == SeedMode::Bounded;
    let mac = cfg!(target_os = "macos");
    let donor = f.workspace("donor");
    let version = f.cargo_version(&donor);
    let proven = target::PROVEN_CARGO.contains(&version.as_str());
    eprintln!("gate {toolchain} {mode:?}: {version} (proven: {proven})");
    // Resolves the file:// Git dependency into CARGO_HOME; no network.
    ok(cargo(&donor, &f.home, &["generate-lockfile"]), "lock");
    commit_all(&donor);
    let cold = ok(
        cargo(
            &donor,
            &f.home,
            &["build", "--workspace", "--all-targets", "--offline", "-v"],
        ),
        "donor build",
    );
    for name in [
        "gate-seed",
        "gate-macro",
        "gate-root",
        "gate-git",
        "gate-app",
    ] {
        assert!(compiled(&cold, name));
    }
    assert!(results(&donor, &f.home).0, "donor tests");
    let donor_flavor = run_dir(&donor.join("target"), "gate-git");
    let donor_snapshot = (
        snapshot(&donor_flavor),
        snapshot(&donor.join("target/debug/.fingerprint")),
    );
    let options = |branch: &str, seed: bool| Options {
        branch: Some(branch.into()),
        seed_target: seed,
        seed_strict: !bounded,
        ..Default::default()
    };

    // Production refuses every version the gate has not proven.
    if !proven {
        let unproven = f.path("unproven");
        let report = worktree::worktree_add_with(
            &donor,
            &unproven,
            "HEAD",
            &options("unproven", true),
            &f.seed_env(true),
        )
        .unwrap()
        .target
        .unwrap();
        assert_eq!(report.reason.as_deref(), Some("fingerprint-unproven"));
        assert_eq!(report.units_seeded, 0);
        assert!(!unproven.join("target").exists());
    }

    // Seed inside worktree add, as the CLI does.
    let dest = f.path("recipient");
    let report = worktree::worktree_add_with(
        &donor,
        &dest,
        "HEAD",
        &options("recipient", true),
        &f.seed_env(proven),
    )
    .unwrap();
    let seed = report.target.expect("seed report");
    eprintln!("seed: {}", serde_json::to_string(&seed).unwrap());
    assert_eq!(seed.mode, mode);
    assert!(seed.units_seeded >= 3, "{seed:?}");
    assert_eq!(seed.copy_count, 0);
    // gate-root names the donor root in both modes. In strict mode the
    // OUT_DIR and debug-map units are rejected too.
    let donor_path = if bounded {
        1
    } else if mac {
        4
    } else {
        3
    };
    assert_eq!(
        seed.packages_rejected.get("donor-path"),
        Some(&donor_path),
        "{seed:?}"
    );
    assert_eq!(
        seed.packages_rejected.get("depends-on-rejected"),
        Some(&1),
        "{seed:?}"
    );
    assert_eq!(
        seed.packages_rejected.get("workspace"),
        Some(&2),
        "{seed:?}"
    );
    if bounded {
        // gate-outdir and gate-git keep their donor OUT_DIR paths.
        assert_eq!(seed.units_seeded_with_donor_out_dir_paths, 2, "{seed:?}");
        assert_eq!(
            seed.units_seeded_with_donor_debug_maps, mac as u64,
            "{seed:?}"
        );
    } else {
        assert_eq!(seed.units_seeded_with_donor_out_dir_paths, 0);
        assert_eq!(seed.units_seeded_with_donor_debug_maps, 0);
    }
    // R2: nothing of the workspace, no top-level outputs, incremental state
    // or locks; every seeded file is its own inode.
    let files = seeded_files(&dest.join("target"));
    for file in &files {
        assert!(
            !file.contains("gate-app") && !file.contains("gate_app"),
            "workspace file seeded: {file}"
        );
        assert!(
            !file.contains("gate-root") && !file.contains("gate_root"),
            "{file}"
        );
        assert!(
            !file.contains("incremental") && !file.contains(".cargo-"),
            "{file}"
        );
        let depth = Path::new(file).components().count();
        assert!(
            depth >= 3 || ["CACHEDIR.TAG", ".pwrgit-share.json"].contains(&file.as_str()),
            "top-level output seeded: {file}"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let m = fs::metadata(dest.join("target").join(file)).unwrap();
            assert_eq!(m.nlink(), 1, "{file}");
        }
    }
    let dest_target = dest.join("target");
    let donor_root = donor.to_string_lossy().into_owned();
    let donor_target = format!("{donor_root}/target/debug/");
    for file in &files {
        let bytes = fs::read(dest_target.join(file)).unwrap();
        for at in memchr::memmem::find_iter(&bytes, donor_root.as_bytes()) {
            let rest = String::from_utf8_lossy(&bytes[at..(at + 400).min(bytes.len())]);
            // A build script's OUT_DIR records (which Cargo remaps; checked
            // on the link line below) and a proc macro's own install name
            // are allowed in both modes. Bounded mode also allows seeded
            // OUT_DIRs and debug maps into donor deps/.
            let record = file.ends_with("/root-output") || file.ends_with("/output");
            let install_name =
                file.contains("lib") && file.ends_with(std::env::consts::DLL_EXTENSION);
            let allowed = record
                || (install_name
                    && rest.starts_with(&format!(
                        "{donor_target}deps/{}",
                        file.rsplit('/').next().unwrap()
                    )))
                || (bounded
                    && (rest.starts_with(&format!("{donor_target}build/gate-outdir-"))
                        || rest.starts_with(&format!("{donor_target}build/gate-git-"))
                        || (file.contains("gate_dbg")
                            && rest.starts_with(&format!("{donor_target}deps/")))));
            assert!(allowed, "seeded file names the donor: {file}: {rest}");
        }
    }

    // The recipient builds with the donor's target out of reach.
    let hidden = f.path("donor-target-hidden");
    fs::rename(donor.join("target"), &hidden).unwrap();
    let build = ok(
        cargo(
            &dest,
            &f.home,
            &["build", "--workspace", "--all-targets", "--offline", "-v"],
        ),
        "recipient build",
    );
    eprintln!("recipient build:\n{build}");
    assert!(
        fresh(&build, "gate-seed"),
        "build-script crate must be Fresh"
    );
    assert!(fresh(&build, "gate-macro"), "proc macro must be Fresh");
    assert!(
        compiled(&build, "gate-root"),
        "donor-root crate must recompile"
    );
    assert!(
        compiled(&build, "gate-taint-user"),
        "its dependent must recompile"
    );
    assert!(compiled(&build, "gate-app"), "workspace must recompile");
    assert!(compiled(&build, "gate-runtime"), "workspace must recompile");
    for name in ["gate-outdir", "gate-git", "gate-dbg"] {
        let expect = bounded && (name != "gate-dbg" || mac);
        assert_eq!(fresh(&build, name), expect, "{name} in {mode:?}");
    }
    // Cargo remapped gate-seed's OUT_DIR from root-output: the link line
    // names the recipient's, and nothing names the donor.
    assert!(
        build.contains(&format!(
            "-L native={}/debug/build/gate-seed-",
            dest_target.display()
        )),
        "OUT_DIR was not remapped:\n{build}"
    );
    assert!(
        !build.contains(&donor_root),
        "recipient build names the donor"
    );
    let baseline = results(&dest, &f.home);
    assert!(baseline.0, "recipient tests: {:?}", baseline.1);
    assert_eq!(baseline.1.len(), 6, "{:?}", baseline.1);
    // Generated code that opens its own OUT_DIR at runtime: in bounded mode
    // the seeded rlib still names the donor's (an identical copy, verified
    // at seed time), so the recipient reads the donor's and fails once the
    // donor is gone. Strict mode rebuilt it, so it reads its own.
    let (path, data) = runtime(&dest, &f.home);
    let donor_out = format!("{donor_target}build/gate-outdir-");
    assert_eq!(path.starts_with(&donor_out), bounded, "{path}");
    assert_eq!(
        path.starts_with(&dest_target.to_string_lossy().into_owned()),
        !bounded
    );
    if bounded {
        assert!(data.starts_with("error:"), "donor target is hidden: {data}");
    } else {
        assert_eq!(data, "generated");
    }
    fs::rename(&hidden, donor.join("target")).unwrap();
    if bounded {
        assert_eq!(runtime(&dest, &f.home).1, "generated");
    }

    // An unseeded third checkout compiles everything; the seed must save
    // compilations (mbx's comparison).
    let plain = f.path("plain");
    worktree::worktree_add_with(
        &donor,
        &plain,
        "HEAD",
        &options("plain", false),
        &f.seed_env(proven),
    )
    .unwrap();
    let plain_build = ok(
        cargo(
            &plain,
            &f.home,
            &["build", "--workspace", "--all-targets", "--offline", "-v"],
        ),
        "plain build",
    );
    assert!(
        compile_count(&build) < compile_count(&plain_build),
        "seeded {} vs plain {}",
        compile_count(&build),
        compile_count(&plain_build)
    );
    eprintln!(
        "compilations: seeded {}, plain {}",
        compile_count(&build),
        compile_count(&plain_build)
    );

    // Late seed: the donor builds after the recipient's checkout, then seeds
    // it. No workspace unit may come out Fresh.
    let late = f.path("late");
    worktree::worktree_add_with(
        &donor,
        &late,
        "HEAD",
        &options("late", false),
        &f.seed_env(proven),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let lib = donor.join("app/src/lib.rs");
    let text = fs::read_to_string(&lib).unwrap();
    fs::write(&lib, format!("{text}pub fn late() {{}}\n")).unwrap();
    fs::write(donor.join("shared/data.txt"), "donor edit\n").unwrap();
    ok(
        cargo(
            &donor,
            &f.home,
            &["build", "--workspace", "--all-targets", "--offline"],
        ),
        "late donor build",
    );
    fs::write(&lib, text).unwrap();
    fs::write(donor.join("shared/data.txt"), DATA).unwrap();
    let locks = target::DonorLocks::acquire(&donor.join("target")).unwrap();
    let late_seed = target::seed_locked(
        &donor.join("target"),
        &late.join("target"),
        &locks,
        &f.seed_env(proven),
        mode,
    )
    .unwrap();
    assert!(late_seed.units_seeded > 0, "{late_seed:?}");
    // Never seed again into an existing target.
    let again = target::seed_locked(
        &donor.join("target"),
        &late.join("target"),
        &locks,
        &f.seed_env(proven),
        mode,
    )
    .unwrap();
    assert_eq!(again.reason.as_deref(), Some("target-exists"));
    assert_eq!(again.clone_count, 0);
    drop(locks);
    let late_build = ok(
        cargo(
            &late,
            &f.home,
            &["build", "--workspace", "--all-targets", "--offline", "-v"],
        ),
        "late build",
    );
    for (name, is_fresh) in states(&late_build) {
        if name == "gate-app" || name == "gate-runtime" {
            assert!(
                !is_fresh,
                "workspace unit Fresh after a late seed:\n{late_build}"
            );
        }
    }
    assert!(fresh(&late_build, "gate-seed"));
    assert_eq!(
        results(&late, &f.home),
        baseline,
        "late-seeded results differ"
    );
    // A Git dependency's build script reruns with a changed env var in the
    // recipient; only the recipient's OUT_DIR changes, never the donor's
    // outputs or fingerprints.
    let spicy = ok(
        cargo_env(
            &late,
            &f.home,
            &["build", "-p", "gate-git", "--offline", "-v"],
            &[("GATE_FLAVOR", "spicy")],
        ),
        "rerun gate-git",
    );
    assert!(compiled(&spicy, "gate-git"), "{spicy}");
    let late_flavor =
        fs::read_to_string(run_dir(&late.join("target"), "gate-git").join("out/flavor.rs"))
            .unwrap();
    assert!(late_flavor.contains("spicy"), "{late_flavor}");
    assert_eq!(
        (
            snapshot(&run_dir(&donor.join("target"), "gate-git")),
            snapshot(&donor.join("target/debug/.fingerprint"))
        )
            .0,
        donor_snapshot.0,
        "the donor's OUT_DIR changed"
    );
    assert!(
        fs::read_to_string(donor_flavor.join("out/flavor.rs"))
            .unwrap()
            .contains("plain")
    );

    // Corrupt the donor's fixtures and binaries, then delete the donor. The
    // recipient's results must not move.
    fs::write(donor.join("shared/data.txt"), "CORRUPTED\n").unwrap();
    fn corrupt(dir: &Path) {
        for e in fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            if e.file_type().unwrap().is_dir() {
                corrupt(&e.path());
            } else if e.file_type().unwrap().is_file() {
                fs::write(e.path(), b"corrupted donor output").unwrap();
            }
        }
    }
    corrupt(&donor.join("target/debug/deps"));
    for name in ["x", "libgate_app.rlib"] {
        let p = donor.join("target/debug").join(name);
        if p.exists() {
            fs::write(p, b"corrupted").unwrap();
        }
    }
    assert_eq!(
        results(&dest, &f.home),
        baseline,
        "donor corruption changed results"
    );
    fs::remove_dir_all(&donor).unwrap();
    assert_eq!(
        results(&dest, &f.home),
        baseline,
        "donor deletion changed results"
    );
    let (_, data) = runtime(&dest, &f.home);
    assert_eq!(data.starts_with("error:"), bounded, "{data}");
    // The registry units stay Fresh with no donor at all.
    let after = ok(
        cargo(
            &dest,
            &f.home,
            &["build", "--workspace", "--all-targets", "--offline", "-v"],
        ),
        "post-delete build",
    );
    assert!(fresh(&after, "gate-seed"));
}

/// A vendored, in-repository source reports `registry+` but lives in the
/// worktree. It must never be seeded and must recompile in the recipient.
fn vendored_gate(toolchain: &str) {
    let f = Fixture::new(toolchain, false);
    if probe(&f.root.path).unwrap().cow == "none" {
        return;
    }
    let w = f.path("donor");
    write(
        &w.join("rust-toolchain.toml"),
        &format!("[toolchain]\nchannel = '{toolchain}'\nprofile = 'minimal'\n"),
    );
    write(
        &w.join(".cargo/config.toml"),
        "[source.crates-io]\nreplace-with = 'vendored-sources'\n[source.vendored-sources]\ndirectory = 'vendor'\n",
    );
    write(
        &w.join("vendor/gate-vendored/Cargo.toml"),
        "[package]\nname = 'gate-vendored'\nversion = '1.0.0'\nedition = '2021'\n",
    );
    write(
        &w.join("vendor/gate-vendored/src/lib.rs"),
        "pub fn value() -> u64 { 7 }\n",
    );
    write(
        &w.join("vendor/gate-vendored/.cargo-checksum.json"),
        r#"{"files":{},"package":null}"#,
    );
    write(
        &w.join("Cargo.toml"),
        "[package]\nname = 'gate-vendor-app'\nversion = '0.1.0'\nedition = '2021'\n[dependencies]\ngate-vendored = '=1.0.0'\n",
    );
    write(
        &w.join("src/main.rs"),
        "fn main() { println!(\"{}\", gate_vendored::value()); }\n",
    );
    write(&w.join(".gitignore"), "target/\n");
    git_init(&w);
    ok(
        cargo(&w, &f.home, &["generate-lockfile", "--offline"]),
        "lock",
    );
    commit_all(&w);
    ok(
        cargo(&w, &f.home, &["build", "--offline"]),
        "vendored donor build",
    );
    let meta = cargo(
        &w,
        &f.home,
        &["metadata", "--offline", "--format-version", "1"],
    );
    let meta: serde_json::Value = serde_json::from_slice(&meta.stdout).unwrap();
    assert!(
        meta["packages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "gate-vendored"
                && p["source"].as_str().unwrap_or("").starts_with("registry+"))
    );
    let proven = target::PROVEN_CARGO.contains(&f.cargo_version(&w).as_str());
    let dest = f.path("recipient");
    let report = worktree::worktree_add_with(
        &w,
        &dest,
        "HEAD",
        &Options {
            branch: Some("recipient".into()),
            seed_target: true,
            ..Default::default()
        },
        &f.seed_env(proven),
    )
    .unwrap();
    let seed = report.target.unwrap();
    assert_eq!(seed.units_seeded, 0, "{seed:?}");
    assert_eq!(
        seed.packages_rejected.get("outside-cargo-home"),
        Some(&1),
        "{seed:?}"
    );
    assert!(!dest.join("target").exists());
    let build = ok(
        cargo(&dest, &f.home, &["build", "--offline", "-v"]),
        "vendored recipient",
    );
    assert!(compiled(&build, "gate-vendored"));
}
