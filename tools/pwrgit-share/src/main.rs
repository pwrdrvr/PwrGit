use pwrgit_share::{Error, Result};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};
const HELP: &str = "pwrgit-share — copy-on-write Cargo target seeding (MIT, PwrDrvr LLC)\n\n  cargo seed [--strict] --from <donor-target> --to <dest-target> --json\n  probe --json <directory>\n  measure --json <path>\n\nCreate the worktree with Git first; PwrGit's Git shares its source files with\n`git -c checkout.reflink=true worktree add`. `cargo seed` then clones only\nthird-party units (registry and git dependencies under CARGO_HOME) from the\ndonor's target into the new worktree's target, before that worktree's first\nbuild. It needs the same toolchain, Cargo home and config in both worktrees,\nreflinks every file (never a copy or hardlink), refuses an existing target,\nand runs only on Cargo versions that passed the freshness gate; otherwise it\nreports a reason and seeds nothing. Workspace crates always build in the new\nworktree. The default (bounded) mode also seeds third-party units whose\nartifacts name a seeded build script's OUT_DIR, verified to be an exact copy,\nso their debug and panic paths point into the donor's target. --strict seeds\nnone of those. It never shares other build output or node_modules.";
fn bad(s: &str) -> Error {
    Error::new(2, s)
}
fn value(args: &[OsString], i: &mut usize) -> Result<OsString> {
    *i += 1;
    args.get(*i)
        .cloned()
        .ok_or_else(|| bad("missing option value"))
}
fn json<T: serde::Serialize>(v: T) -> Result<()> {
    println!("{}", serde_json::to_string(&v)?);
    Ok(())
}
fn run() -> Result<()> {
    let a: Vec<OsString> = std::env::args_os().skip(1).collect();
    if a.is_empty() || a == ["--help"] || a == ["-h"] {
        println!("{HELP}");
        return Ok(());
    }
    if a == ["--version"] {
        println!("pwrgit-share {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    match a[0].to_str() {
        Some("probe" | "measure") => {
            let args: Vec<_> = a[1..]
                .iter()
                .filter(|s| s.as_os_str() != "--json")
                .collect();
            if args.len() != 1 || args[0].to_string_lossy().starts_with('-') {
                return Err(bad("expected --json <path>"));
            }
            let path = Path::new(args[0]);
            if a[0] == "probe" {
                json(pwrgit_share::probe(path)?)
            } else {
                json(pwrgit_share::measure(path)?)
            }
        }
        Some("cargo") if a.get(1).is_some_and(|v| v == "seed") => {
            let mut from = None;
            let mut to = None;
            let mut mode = pwrgit_share::SeedMode::Bounded;
            let mut i = 2;
            while i < a.len() {
                match a[i].to_str() {
                    Some("--json") => {}
                    Some("--strict") => mode = pwrgit_share::SeedMode::Strict,
                    Some("--from") if from.is_none() => {
                        from = Some(PathBuf::from(value(&a, &mut i)?))
                    }
                    Some("--to") if to.is_none() => to = Some(PathBuf::from(value(&a, &mut i)?)),
                    _ => return Err(bad("unknown or duplicate cargo seed flag")),
                }
                i += 1;
            }
            json(pwrgit_share::cargo_seed(
                &from.ok_or_else(|| bad("--from required"))?,
                &to.ok_or_else(|| bad("--to required"))?,
                mode,
            )?)
        }
        _ => Err(bad("unknown command; see --help")),
    }
}
fn main() {
    pwrgit_share::install_signal_handlers();
    if let Err(e) = run() {
        eprintln!(
            "{}",
            serde_json::json!({"error":e.detail,"exitCode":e.code})
        );
        std::process::exit(e.code);
    }
}
