use pwrgit_share::{Error, Options, Result};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};
const HELP: &str = "pwrgit-share — reflink-only Git worktrees (MIT, PwrDrvr LLC)\n\n  probe --json <directory>\n  worktree add [-b <branch>] [--seed-target] [--donor <worktree>] [--json] [--] <path> <commit-ish>\n  target seed --from <donor-target> --to <dest-target> --json\n  measure --json <path>\n\nUnsupported filesystems use a normal Git checkout; targets are never copied or\nhardlinked. Cargo seeding currently returns zero units with fingerprint-unproven: the\npinned stable Cargo fails the relocated-source freshness gate. Targets are always private.\n\nFor compiler-level reuse, users may install sccache or Kache themselves. This\ntool does not configure or spawn either. Smaller debug info (line-tables-only)\nand a faster linker are separate user-side options. There is no --copy flag.";
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
        Some("worktree") if a.get(1).is_some_and(|v| v == "add") => {
            let mut opts = Options {
                force_no_cow: std::env::var_os("PWRGIT_SHARE_FORCE_NONE").is_some_and(|v| v == "1"),
                ..Default::default()
            };
            let mut donor = std::env::current_dir()?;
            let mut pos = Vec::new();
            let mut end = false;
            let mut i = 2;
            while i < a.len() {
                if end {
                    pos.push(a[i].clone());
                } else {
                    match a[i].to_str() {
                        Some("--") => end = true,
                        Some("--json") => {}
                        Some("--seed-target") => opts.seed_target = true,
                        Some("--donor") => donor = PathBuf::from(value(&a, &mut i)?),
                        Some("-b") => {
                            opts.branch = Some(
                                value(&a, &mut i)?
                                    .into_string()
                                    .map_err(|_| bad("branch must be UTF-8"))?,
                            )
                        }
                        Some(s) if s.starts_with('-') => {
                            return Err(bad("unknown worktree flag (including --detach/--force)"));
                        }
                        _ => pos.push(a[i].clone()),
                    }
                }
                i += 1;
            }
            if pos.len() != 2 {
                return Err(bad("expected <path> <commit-ish>"));
            }
            let commit = pos[1].to_str().ok_or_else(|| bad("commit must be UTF-8"))?;
            json(pwrgit_share::worktree_add(
                &donor,
                Path::new(&pos[0]),
                commit,
                &opts,
            )?)
        }
        Some("target") if a.get(1).is_some_and(|v| v == "seed") => {
            let mut from = None;
            let mut to = None;
            let mut i = 2;
            while i < a.len() {
                match a[i].to_str() {
                    Some("--json") => {}
                    Some("--from") if from.is_none() => {
                        from = Some(PathBuf::from(value(&a, &mut i)?))
                    }
                    Some("--to") if to.is_none() => to = Some(PathBuf::from(value(&a, &mut i)?)),
                    _ => return Err(bad("unknown or duplicate target seed flag")),
                }
                i += 1;
            }
            json(pwrgit_share::target_seed(
                &from.ok_or_else(|| bad("--from required"))?,
                &to.ok_or_else(|| bad("--to required"))?,
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
