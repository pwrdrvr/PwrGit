# Worktree source sharing and Rust artifact reuse

Status: research and design, 2026-10-27. Implementation is specified below and is opt-in. Nothing in PwrGit enables sharing until that work lands and a person turns it on.

This note separates two costs that show up together and are not one problem:

1. Every linked Git worktree materializes another working tree.
2. Every worktree then compiles Rust dependencies into its own multi-gigabyte `target/` (or Cargo build dir).

Git already shares the object database. That does not share the checked-out source, and it does not share compiler outputs. A tool that only solves one of those leaves the other bill intact.

## Verdict

No mature tool, including the design in the source tweet, solves both problems with concurrent builds on macOS and Linux.

The tweet (Kizuno18, 2026-10-27) is an OverlayFS-plus-`git merge-tree` sketch. It isolates writable source views and proposes a commit path that avoids a shared index lock. It does not implement or measure Cargo reuse. The only Rust mechanism it names is a parenthetical, "shared target/ via sccache or hardlinks." sccache does not by itself share the bytes of each worktree's `target/`. Hardlinking mutable build files is not safe copy-on-write.

Build the smallest missing layer: one Rust library and `pwrgit-share` CLI that PwrGit can call. It reflinks a new Git worktree's clean tracked files, and it reflinks only Cargo units that a freshness test has shown are safe to reuse. It does not wrap `rustc`, does not vendor sccache or Kache, and does not point two worktrees at one live target directory. Compiler caches stay an optional companion the user installs themselves.

## What was read, and what was not

X posts were read on 2026-10-27 with the conversation id `2114990023237923159`. The requested status is `2115005483174051917`. No image or video was attached to that post. Outbound links in the posts below were followed when the post contained one. Kizuno18's post contains no repository URL.

A prior PwrAgent thread titled "Pete's CoW git worktree clones status" (`01a1093b-7d57-7382-85f8-35269c093b6f`) was not loaded on this machine, and a federation metadata search on 2026-10-27 did not find it on a connected peer. Nothing in this note is taken from that thread.

The local Disktree checkout at the path recorded by this machine's project list has a `.git` directory and no working-tree files (listed 2026-10-27). Its `HEAD` is commit `6c8d4ce` (2026-10-04), "Merge pull request #71 from tobi/release-0.11.0", repository `github.com/tobi/disktree`, MIT, copyright 2026 Tobi Lütke. The README at that commit describes a disk-usage treemap. It is not a worktree or Cargo tool. It does record the measurement trap this design has to respect: APFS cloned files are each counted in full, so a total can exceed what deleting them frees, and Time Machine local snapshots sit in the gap between a scan and used space. PwrGit already says the same thing about prune sizes in `apps/desktop/src/main/git/AGENTS.md` (the `diskSpaceNote` paragraph).

Connected Federation peers on 2026-10-27 include Darwin machines only in the connected set. A Linux VM (`ubuntu`, arm64) and a Windows VM (`DESKTOP-17ISFOI`) are known and disconnected. This design does not start them and does not create a new VM. macOS APFS on the machine doing the work is the platform that can be measured. Linux reflink code has to be written and unit-tested behind a probe; a real `FICLONE` run waits until a connected Linux peer exists.

## The posts

Parent, Leo (`@leostera`), 2026-10-27 07:58:10 GMT, status `2114990023237923159`:

> in case someone's building this: i want a copy-on-write file system where i can enter a view and be sandboxed into it, with serialized flush and rebase operations, so i can have 10 agents working on the same worktree without overlapping or overwriting their changes.
>
> think git worktrees but single branch, mandatory pull --rebase before commit, and reusing as much of the file tree as possible.
>
> for small repos idc, but try this with larger monorepos, bazel, rust, etc. dem build/target dirs are eating my sdd :(

Same author, 08:00:24 GMT, status `2114990584024731667`, the interface sketch: `afs enter`, `afs commit` (rebase first if behind, then publish to all views), `afs leave`, then `git push`.

Requested reply, Kizuno18 (`@Kizuno18`), 2026-10-27 08:59:36 GMT, status `2115005483174051917`. The post asserts three layers and says "we run this pattern." It links no code, no issue, and no benchmark.

1. One OverlayFS mount per agent. Lower dir is the repo, read-only. Upper dir and work dir are per agent. The post says reads hit the base tree "and shared target/ via sccache or hardlinks" with zero copy, and that ten Rust agents use the base repo plus a few megabytes of deltas rather than ten 40 GB target directories.
2. On flush, build a tree from the upper dir with `git write-tree`, merge with `git merge-tree --write-tree` if the base moved, and move the branch with `git update-ref`. The stated reason is that native worktrees die under `.git/index.lock`.
3. When one agent advances the branch, remount the others' lower dirs and keep their upper dirs. Conflicts stop the other agent.

Leo's reply at 09:05:24 GMT (`2115006942221582421`): "cool! i just need this to become a single portable tool."

Other replies in the same conversation, same day:

| Time (GMT) | Author | Status | What they offered |
| --- | --- | --- | --- |
| 08:44:15 | `@vzarytovskii` | `2115001619179864257` | ReFS + ProjFS as a possible Windows shape. No repo. |
| 08:46:13 | `@kartikb753` | `2115002112036024454` | Keep build outputs out of the views. Point views at one shared content-addressed cache, "sccache style." Warns that two agents can rebase cleanly and still break each other. |
| 08:49:30 and 08:53:57 | `@leostera` | `2115002939752513810`, `2115004062307627390` | Says that is what he is doing now, and that it is not a general solution. |
| 09:08:52 | `@DanniFriedland` | `2115007814238454049` | "i think Delta are working on something like that." No link. Not identifiable as a specific project from the post alone. |
| 09:39:20 | `@dysinger` | `2115015479651926025` | "ZFS?" |
| 10:09:11 | `@ChetHusk` | `2115022994187690416` | Says he has not heard of it and wants to try it. No technical claim. |
| 11:17:20 | `@voiys` | `2115040144617349122` | Links `https://github.com/Ephemeral-AI-Lab/layerfs`. |

An earlier Kizuno18 post on 2026-10-26 08:44:36 GMT (`2114639319319069085`) is the useful correction to the 2026-10-27 claim. It says bare mirrors plus worktrees still pay three costs: checkout materialization (a 500k-file monorepo, 8–15 seconds, stated without a published method), stale images inside microVMs, and lock collisions when many worktrees run `git gc` or loose-object writes against one object store. It recommends disabling auto-gc and pinning `extensions.worktreeConfig`. Those are Git-store and checkout problems. They are not a Cargo result.

Another Kizuno18 post on 2026-10-23 (`2113728363147759732`) recommends `git worktree remove` (not `rm -rf`), pnpm's content-addressed store for `node_modules`, and tearing worktrees down after an agent finishes. pnpm is evidence that a content-addressed store plus hardlinks works for immutable package blobs. It is not evidence about Cargo fingerprints.

## Layers, kept apart

| Layer | What it is | What sharing it means | What it does not mean |
| --- | --- | --- | --- |
| Git object storage | Blobs, trees, commits, packs under the common `.git` | Linked worktrees already share this. `git clone --reference` / `--shared` shares it across repos, with different lifetime hazards. | A shared object store does not make the working tree cheap. |
| Checked-out mutable source | Regular files, symlinks, and the index in one worktree | Reflink/clonefile of clean tracked files, or a union mount whose lower dir is read-only. Writes must allocate new blocks or an upper layer. | A second directory listing is not a second copy of the blocks. `du` cannot see that on APFS. |
| Filesystem physical sharing | Extents shared by clonefile, `FICLONE`, or a content-defined chunk store | Two inodes, same physical blocks, until either side writes. | Hardlinks are one inode. A write through either name changes both. That is not copy-on-write. |
| Dependency compilation cache | rustc/sccache/Kache/mbx memory of a compilation | A later compile with the same key does not rerun LLVM. | A cache hit still writes outputs into the local target unless the restore itself reflinks. A hit is not a proof that the linked program is correct. |
| Final target / build output | `deps/*.rlib`, unit `out/`, uplifted binaries, test bins | These are the gigabytes. They are reusable only when Cargo's own freshness check agrees. | Copying a `target/` tree is not reuse until `cargo build -v` reports `Fresh` for those units and `Compiling` for units whose sources differ. |
| Incremental state | `incremental/` and some fingerprint bookkeeping | Private to one compiler session directory. It embeds paths and is rewritten constantly. | Seeding it across worktrees is a way to look fast and be wrong. Leave it out. |
| Linking | The final `rustc` link of the workspace binary | Has to run per worktree whenever the workspace crate is dirty. The output is small next to dependency rlibs. | Skipping the link because dependency rlibs were seeded is a broken binary. |
| Concurrency and locking | Per-worktree index, per-target `.cargo-lock`, ref locks, `gc` locks | Separate target directories let two builds run together. | One shared `CARGO_TARGET_DIR` serializes on `.cargo-lock`. That is safe and slow, and it is not a disk win beyond the first copy. It is also how two branches can observe each other's workspace artifacts. |

## Capability matrix

Evidence class is `shipped` (documented behavior of a released or in-tree tool, with a cited source), `patch` (an open change, not what Git or Cargo does today), or `hypothesis` (a claim in a post with no artifact). "Rust dependency compile reuse" means a second worktree does not recompile unchanged registry/git dependencies. "Build-output physical sharing" means those output bytes are not stored twice. A cache hit without a shared-extent or allocated-byte measurement is reuse of work, not of disk.

| Option | Source sharing | Rust dep compile reuse | Build-output physical sharing | Concurrent builds | OS / filesystem | Constraints and license | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `git worktree add` today | No. Objects are shared; every tracked file is written. PwrGit calls this from `worktreeAdd` in `apps/desktop/src/main/git/git-service.ts`. | No | No | Yes, on different branches. One branch cannot be checked out twice. Each worktree has its own index. | All | Git's own license. PwrGit bundles Git. | Shipped. Confirmed in this repo's worktree lifecycle and in Git's worktree docs as used by the app. |
| Kizuno18 OverlayFS sketch, 2026-10-27 | Logical share of a read-only lower tree. Upper dirs hold writes. | Not shown. Different mount paths plus Cargo freshness make a full rebuild the expected outcome unless something else stabilizes the paths. | Not shown. Writes into `target/` inside the mount copy up whole files. The "few MB" figure is a hypothesis. | Mounts are independent. The commit protocol is a sketch. `index.lock` is the wrong lock to blame for cross-worktree commits: each worktree has its own index. Shared ref updates and `gc` still lock. | Linux OverlayFS. Needs mount privileges or a user namespace. Not macOS, not Windows. | No published code, so no license. | Hypothesis. Post `2115005483174051917`. |
| sccache | None | Yes for invocations whose key matches, after path normalization. Registry deps hit more often than workspace crates. [sccache issue 2595](https://github.com/mozilla/sccache/issues/2595) (opened 2026-02-06) and a 2026-10-18 post by `@CcVylree` (`2111753391458185348`) both say workspace paths break keys. A Zenn article on 2026-10-15 measured 0 hits when only the target dir differed. | No in the default disk cache. A hit decompresses a new copy into `target/`. [sccache PR 2739](https://github.com/mozilla/sccache/pull/2739) proposes `file_clone` reflink restore and is a patch, not the default. | The cache can coalesce identical in-flight compiles. Cargo's target lock is unchanged if the target dir is shared. | Linux, macOS, Windows for the cache. Reflink restore depends on the filesystem. | Apache-2.0. | Shipped cache. Disk sharing is a patch. The Zenn article is one author's measurement, not an upstream benchmark. |
| Kache (`github.com/kunobi-ninja/kache`) | None | Yes when the normalized rustc key matches. The project publishes a Firefox 151 warm-build report (issue 43 comment, 2026-06-19): 25m 34s cold, 2m 34s warm, 4997 hits. | On CoW filesystems, restore reflinks from the cache, so the second tree shares blocks with the cache. That comment reports 13.3 GB reflinked and a free-space delta of 9.2 GB against a 47.2 GB apparent sum. On Linux without reflink, the GitHub Action README says it hardlinks. Hardlinks of compiler outputs are safe only while nothing mutates those inodes. | In-flight compiles with one key are shared. Separate target dirs do not take one Cargo lock. | Linux, macOS, Windows, with Windows limits called out in the docs. Store paths differ per OS. | Apache-2.0. Pages fetched 2026-10-27 show more than one version string (`0.7.0` benchmark, `0.28.0` release notes, `2.0.0-rc.2` in `Cargo.toml` on main). Pin a commit before depending on it. | Shipped tool with a published benchmark. Does not check out source. Hardlink fallback is the wrong default for this design. |
| mbx managed targets (`mr-boxington.jdx.dev/managed-targets`, fetched 2026-10-27) | None. It symlinks `target/` at a cache path outside the checkout. | Yes for registry and git units copied from another managed target, and only on Cargo 1.100 or newer. Path dependencies and workspace members are never copied, because Cargo trusts their mtimes. | Reflink when the managed root and the cache are on one CoW filesystem. Otherwise it copies. | A check lane lets `cargo check` / clippy run beside a build. Two builds of one profile still share `.cargo-lock`. | Documented on Linux and Windows (symlink needs Developer Mode). macOS behavior of the symlink was not separately measured here. | A Cargo wrapper (`mbx build`), not a Git feature. License was not re-verified in this pass; do not vendor it on a guess. | Shipped docs dated by the page content. The Cargo 1.100 unit copy is the best published statement of which units are safe to seed. Adopting the whole wrapper would replace `cargo` for every build and still would not shrink source trees. |
| `cargo-shared-target` / `shared-target-core` 0.1.0 (lib.rs, 2026-09-04, Yutaka Nishimura) | None. The README tells the caller to run `git worktree add` first. | Intended, by seeding a destination `target/` from a donor. | Reflink of the whole tree where the filesystem clones blocks. On ext4 it hardlinks large files under `deps/` and copies everything else. `incremental/` is cloned only when cloning is free, and dropped otherwise. Dep-info is never hardlinked, because Cargo rewrites it and it stores absolute paths. | Refuses to seed while a donor profile holds `.cargo-lock`. Seeded trees are separate, so later builds do not share a lock. | APFS, btrfs, bcachefs, XFS with reflink; ext4 falls through to hardlink/copy. | MIT or Apache-2.0. crates.io lists it as one unstable release, 455 lines. | Shipped 0.1.0. The safety split (hashed `deps/` vs rewritten dep-info vs incremental) is the right split. It is not mature enough to vendor, and its ext4 path hardlinks. This design copies the split and drops the hardlink. |
| `git worktree add --reflink` ([git/git PR 2317](https://github.com/git/git/pull/2317), open as of 2026-10-27; v3 submitted 2026-10-21) | Yes, for files the checkout machinery materializes. Later PR text excludes untracked and ignored files, so `target/` and `node_modules` are not carried. An earlier revision of the same PR said the opposite (untracked files were carried). The open PR is not one stable design. | No | No for build outputs, in the revision that refuses ignored files. | Unchanged Git worktree locking. A second patch in the series discusses shared branches and ephemeral branches. That is a different feature and is out of scope here. | `FICLONE` on Linux, `clonefile` on APFS. A commit message in the PR says reflink is disabled on Windows. Probe, then fall back per file. | Not merged. PwrGit's bundled Git does not have the flag. | Patch. Useful as a design reference. Not something PwrGit can call. |
| `git-cow-worktree` (`github.com/josharian/git-cow-worktree`, README fetched 2026-10-27) | Yes. `git worktree add --no-checkout`, reflink clean tracked files whose tree matches, hash them, write the index stat cache, then let `git checkout` fill the rest. Skips dirty, untracked, ignored, submodules, symlinks, and mode mismatches. | No | No | Same as Git. | APFS directory clone; Linux file-by-file `FICLONE`. Falls back to a normal checkout. | The README says the tool is vibe-coded and "use at your own risk," and that the README below that line is LLM-written. License was not established from the fetched page. | Shipped source of unknown maturity. The index-stat step is the part that keeps Git from rewriting every reflink. Reimplement that idea with tests rather than shelling out to this binary. |
| LayerFS v1.1.0 (`github.com/Ephemeral-AI-Lab/layerfs`, release notes fetched 2026-10-27, tag `v1.1.0` published 24 Oct 2026) | Yes, as its own store plus a per-workspace overlay. Forks are not file copies. The base can include ignored files and prior outputs as immutable objects. | Not a Cargo feature. A build inside a workspace still runs Cargo. Path identity and fingerprints are unchanged by the store. | Identical stored objects can be deduped. Bytes written during a build live in that workspace's overlay until a commit stores them. That is not "ten agents compile and only a few MB hit the SSD" while the compiles are running. | Workspaces are separate overlays. Commit/merge is LayerFS's, not Git's. | Docs describe a FUSE daemon and, in v1.1.0, a worker for macOS and Windows. | MIT. It is a second history and filesystem, with a daemon. Replacing Git worktrees with it is a different product. | Shipped v1.1.0. Right answer to "ephemeral agent views over shared history" if one is willing to leave Git. Wrong drop-in for PwrGit's worktree model. |
| `exp` (`github.com/thebrubaker/exp`, README fetched 2026-10-27) | Clones the whole directory with APFS `clonefile`, including `.git`, `node_modules`, and `target/`. | Only for as long as Cargo accepts the cloned fingerprints. The clone is a new absolute path. | Yes until a file is written, because the whole directory is one APFS clone. | Separate trees, so Cargo locks do not collide. | macOS APFS only. | Not a Git worktree. Two clones that both run `git gc` diverge their object stores by copy-on-write, which spends the disk the clone was meant to save. A dirty donor is cloned dirty. | Shipped macOS tool. Shows that cloning a tree is physically cheap. Does not meet the Git-metadata bar. |
| One shared `CARGO_TARGET_DIR` or `build.build-dir` | None | Registry units often stay fresh because their sources live under the shared Cargo home, and fingerprints are relative to the workspace root rather than the absolute checkout path. A Zenn write-up (2026-10-15) and a Japanese gist on `build.build-dir` (Cargo 1.91 stabilized the separate build dir on 2025-10-30) both saw dependency reuse. | Yes, there is one directory. | No. Cargo holds `.cargo-lock` for the profile. The gist also records the correctness bug: with mtime freshness, a shared build dir reused another worktree's workspace crate without recompiling. `-Z checksum-freshness` is nightly. | Any | Config the user already has. PwrGit must not edit the user's global Cargo config. | Shipped Cargo behavior, plus two independent 2026 write-ups of the stale-workspace-crate failure. Sharing one directory is rejected. |
| ZFS / btrfs snapshot / ReFS block clone | A dataset or subvolume snapshot shares every file, tracked or not. | Same fingerprint hazards as copying `target/`. | Yes, until writes. | Snapshots are independent. | ZFS and btrfs need the checkout to be a dataset. ReFS block cloning is Windows-only and is not what GNU `cp --reflink` calls. ProjFS is a projection API, not a snapshot. | Often needs privileges. A `node_modules` inside a repo is not a subvolume. | Shipped filesystems. Wrong granularity for "add a worktree in this Git repo." |
| pnpm store (mentioned by Kizuno18, 2026-10-23) | Not Git source. | Not Rust. | Hardlinks immutable package files. PwrGit's own prune sizer already de-duplicates those inodes. | Installs can still race on the store. | pnpm's platforms. | Not a Cargo strategy. | Shipped for JavaScript. Cited only as the contrast: immutable blobs can be hardlinked; Cargo fingerprints and incremental files are not those blobs. |
| PwrGit today | No | No | No | Worktree creates and removes are serialized per repo. Removal deletes the directory, then `git worktree remove --force` on the missing path (`worktreeRemove`). | macOS, Linux, Windows | MIT, PwrDrvr LLC, 2026. | Shipped. This is the integration point, not a sharing implementation. |

## What the tweet does and does not do

It handles a Git-shaped isolation story: a read-only lower tree, a private upper tree, and a commit path built from `write-tree`, `merge-tree --write-tree`, and `update-ref`. Those Git commands exist. Using them to avoid a checkout during commit is a real technique. It is not demonstrated in a repository we can read.

It does not handle Rust output reuse. The sentence that mentions Rust names two mechanisms that are not OverlayFS:

- sccache avoids repeating the compiler. The default cache then writes a fresh output into that agent's target directory. Ten agents still store ten outputs. [sccache PR 2739](https://github.com/mozilla/sccache/pull/2739) exists because of that fact.
- Hardlinks share an inode. Cargo rewrites dep-info, fingerprints, and incremental state. A hardlink makes that rewrite visible in every worktree that shares the inode. That fails the isolation test this design requires: editing or rebuilding one tree must not change another tree's bytes.

OverlayFS copy-up makes the "few MB" claim unlikely even before Cargo. The first write to a file copies the whole file into the upper dir. A compile writes a lot of files. If `target/` sits in the lower dir, the upper dir grows toward the size of the files Cargo touches. If `target/` sits outside the mount at a shared path, the agents are back to one Cargo lock and the stale-artifact bug.

The index-lock claim is the wrong layer. `git worktree add` gives each worktree its own index and its own `index.lock`. Commits on different branches do not share that lock. What they do share is the object store, the ref namespace, and maintenance commands. Kizuno18's own post from 2026-10-26 names `gc` and loose-object locks, which is the accurate version. This design does not add a parallel commit protocol and does not disable auto-gc.

Single-branch views with a mandatory rebase, which is what Leo asked for, are also out of scope. Git's "already checked out" rule stays. Agents get different branches, as PwrGit already creates.

## Cargo, in enough detail to avoid a false win

Cargo's build cache (Cargo book, `reference/build-cache.md`, fetched 2026-10-27) stores outputs in the target dir and the build dir. `build.build-dir` / `CARGO_BUILD_BUILD_DIR` has been stable since Cargo 1.91 (2025-10-30) and defaults to the target dir. The book text fetched on 2026-10-27 says the on-disk layout of the build dir changed in Cargo 1.100.0. Nightly `layout.rs` around 2026-10-24 still documents the classic `deps/`, `.fingerprint/`, `incremental/` tree and a newer per-unit `build/<package>/<hash>/` tree behind a layout flag. Both have to be detected from the donor directory. Assuming 1.100 is installed is not acceptable.

Fingerprints record the rustc version (down to the commit), profile, features, target triple, `RUSTFLAGS` / `RUSTDOCFLAGS`, dependency fingerprints, and source identity. Filesystem mtimes are the default freshness check. Content checksums are not the stable default. A unit is fresh only when that record matches.

What differs across worktrees, and what that does:

| Input | Effect on a seeded or shared artifact |
| --- | --- |
| Toolchain / rustc commit | Invalidates every unit. Seeding from a donor built by another toolchain is wasted disk until Cargo deletes or ignores it. Detect and refuse. |
| Profile (`dev` vs `release`, `opt-level`, `lto`, `codegen-units`, `panic`) | Different output directories or different hashes. Seed per profile that exists. Do not point a release build at debug rlibs. |
| Features, `--all-features`, feature unification | Changes the unit hash. Old units sit unused beside the new ones. Leaving them is honest. Deleting them to make a benchmark look smaller is not, and this tool does not garbage-collect Cargo output. |
| Target triple, host vs `--target` | Separate directory trees. Proc-macro and build-script units are host units. Copying only the target triple's tree misses them and then Cargo rebuilds the crates that needed them. |
| `RUSTFLAGS`, `CARGO_ENCODED_RUSTFLAGS`, some `cargo::rustc-env` values | Part of the fingerprint. A seed cannot strip or rewrite this. If the new build's environment differs, Cargo must rebuild. The test for that is a build with an extra flag, which must not stay `Fresh`. |
| Build scripts and `OUT_DIR` | `OUT_DIR` is an absolute path inside the donor target. Dep-info and rerun files remember paths. Copying a build-script unit into a new target dir is safe only if a build with the donor path removed still says `Fresh` or rebuilds that unit cleanly. A result that stays fresh by stating files in the donor is a failed test. |
| Proc-macros | Host artifacts. They follow the same rule as other registry units. A proc-macro built from a path dependency in the workspace is a workspace unit and is not seeded. |
| Path dependencies and workspace members | mtime freshness plus a copied fingerprint can mark another checkout's sources as fresh. mbx refuses to copy these, and so does this design. They recompile. That recompile is the correct result when the branch differs. |
| Absolute checkout path | Experiments cited above (shared build dir across worktrees, 2026) found registry units reusable, which means the unit hash is not the absolute checkout path. Dep-info still contains absolute paths. The implementation has to prove reuse on a fixture, not cite those posts as permission. |
| Incremental directory | Path-keyed, rewritten, large. Not seeded. |
| Clock and mtime | A seed must preserve mtimes of the files it shares. A reflink that stamps "now" onto an output while sources keep their old mtimes, or the reverse, changes freshness. Preserve mtimes. Do not `touch` a seeded file. |

Sharing one directory is not evidence of a safe speed or disk win. It can be a silent wrong-artifact bug, and it forces concurrent builds to queue. The implementation's proof is a second directory, the donor hidden or deleted, then `cargo build -v` on a fixture.

Registry and git dependencies are the units worth seeding. Their sources live under the Cargo home, which does not change when the worktree path changes. Workspace crates are the units that must rebuild when their files differ. The disk win is the dependency rlibs and rmeta, which are the gigabytes. The time win for the workspace crate is only as large as that crate. Say that in the benchmark report. Do not report "the build was fresh" when the fresh units are the seeded registry crates and the workspace crate did not need to change.

## Copy-on-write, without the unsafe shortcut

Use the filesystem's clone primitive:

- macOS: `clonefile(2)` / `cp -c`. Available on APFS. BSD `cp` ignores GNU `--reflink` and silently full-copies. Sandcastle hit this ([sandcastle issue 485](https://github.com/mattpocock/sandcastle/issues/485), 2026-04-29); the fix was `cp -cR` on Darwin.
- Linux: `ioctl(FICLONE)` / `copy_file_range` with reflink, as GNU `cp --reflink=always`. Works on btrfs, XFS created with reflink, and bcachefs. ext4 returns an error. A container filesystem can differ from the host's `df` type. Probe with a real clone of a temporary file in the destination's parent directory. Do not decide from the filesystem name.
- Windows: ReFS block cloning is `FSCTL_DUPLICATE_EXTENTS_TO_FILE`. GNU `cp --reflink` on Windows does not call it ([sandcastle issue 904](https://github.com/mattpocock/sandcastle/issues/904), 2026-07-12). Git PR 2317 disables its reflink path on Windows. Windows support in `pwrgit-share` is a probe that falls back. It is not a release requirement.

Fallback, per destination filesystem, decided once:

- Probe succeeds: reflink.
- Probe returns `EXDEV`, `ENOTSUP`, `EOPNOTSUPP`, `ENOTTY`, or the platform has no primitive: do not hardlink. Source materialization falls back to Git's normal checkout. Target seeding is skipped, not copied, unless the user passed an explicit copy flag. A multi-gigabyte copy is the behavior this tool exists to avoid, so it is not the default.
- A clone that fails halfway: delete the staging directory or `git worktree remove` the incomplete worktree. A half-written `target/` whose fingerprints say fresh is worse than no target. Stage under a name Cargo will not read, then rename.
- Cross-filesystem donor and destination: the probe fails. Report it. Do not copy.

Git metadata:

- Register the worktree with `git worktree add --no-checkout` so Git writes the admin dir, commondir, `HEAD`, and the branch lock. Do not invent a worktree by hand.
- Reflink only clean tracked regular files whose blob id is the blob the destination commit wants. Hash the clone and compare it to that blob. On mismatch, delete the clone and let checkout write the file.
- Write index entries with the resulting stat info before checkout. `git-cow-worktree`'s README is right about why: an empty index makes checkout rewrite every file, which breaks the sharing.
- Then run checkout. It fills files that were not cloned and repairs anything the hash rejected.
- Skip symlinks (a clone must not follow them), gitlinks/submodules, dirty paths, untracked files, and ignored files. Ignored is where `target/` and `.env` live. Carrying them would copy secrets into the new worktree and would couple its build outputs to the donor's dirty state.
- Preserve the executable bit. Do not preserve a setuid bit by accident; if the mode is not a regular 0644/0755-style mode Git would have written, let checkout write the file.
- Do not reflink `.git` of the main repo. The new worktree's `.git` is a gitdir file Git created.
- Cancellation after `--no-checkout` and before a good checkout must remove that worktree registration. Leaving it locks the branch.

Isolation, which the tests have to show on a real APFS volume:

- After seeding, worktree B's file and worktree A's file are different inodes when the platform can say so, or at least different directory entries.
- Writing B does not change A's bytes. `reset --hard` in B does not change A's bytes. Rebuilding B does not change a file in A's `target/`.
- The reverse is also true.
- A hardlink test is included only as a negative: the tool's default path must not create `nlink > 1` on a source file or on a fingerprint file.

PwrGit's prune copy already warns that `du` and `st_blocks` count an APFS clone as a full file (`apps/desktop/src/main/git/AGENTS.md`). Disktree's README at `6c8d4ce` says the same. The measurement command reports clone and copy counts as the proof of sharing. A free-space delta is recorded and labeled noisy. It is not the headline number. `du` totals are labeled logical.

## What still duplicates gigabytes after a dependency cache

Even a perfect registry-unit seed leaves:

- The workspace crate's rlib, rmeta, and incremental directory, once per worktree, and again per feature set and profile that was actually built.
- Uplifted binaries, test binaries, and `deps/` files for the workspace crate. These are smaller than the dependency graph on a large crate graph and are the whole bill on a small one.
- Build-script `OUT_DIR` contents when the absolute path cannot be proven fresh. The tool then omits that unit and Cargo reruns the script. The rerun is the safe outcome.
- Files Cargo rewrites on every build even when the unit is fresh: dep-info sidecars, `invoked.timestamp`. Those are small. Sharing them by hardlink is still forbidden, because Cargo writes them.
- A second profile, a second triple, or a second `RUSTFLAGS` value. Each is another copy of the units that differ. The seed may share the units whose hashes match and must not claim credit for the ones that do not.
- The compiler cache's own store (sccache, Kache), if the user turns one on. That store is one copy plus reflink shares into each target. It is outside this tool's lifetime. PwrGit must not delete it.

Remedies that already exist, and that this tool does not reimplement:

- sccache or Kache, for the case where the unit is dirty and the compiler must run. They save time. Kache additionally reflinks the restored output into the new target. Recommend them in the CLI's long help. Do not set `RUSTC_WRAPPER`, do not write `~/.cargo/config.toml`, and do not spawn them.
- Cargo's separate build dir, so final artifacts can live in the worktree while intermediates live elsewhere. Pointing every worktree at one build dir is the rejected configuration.
- Smaller debug info (`debug = "line-tables-only"`) and a faster linker. Those shrink or speed one target. They do not share it. Mention them only as user-side options, not as features of this change.

## Recommendation

Adopt none of the full products as the implementation.

Compose, by documentation only:

- Git continues to own worktree registration, refs, and the index.
- The user may install sccache or Kache if they want compiler-level reuse when a seeded unit is stale. That is their config. This change does not turn it on.

Build `pwrgit-share`, a separate binary and library, MIT, living in this repository so PwrGit and the CLI share one implementation.

Why this and not "tell people to run `git-cow-worktree` and `cargo-shared-target`":

- `git-cow-worktree` is explicitly unreviewed vibe-coded software, and it does not seed Cargo.
- `cargo-shared-target` 0.1.0 hardlinks on filesystems that cannot clone, and it seeds more of `target/` than the freshness rules allow.
- Kache and sccache do not create worktrees.
- mbx does not create worktrees and wants to be the Cargo entry point.
- Git's own `--reflink` is an open pull request and does not seed ignored build outputs, which is the correct call for source and leaves the Rust problem open.
- LayerFS replaces the history model.

The missing layer is the one that knows both Git's index and Cargo's unit rules, uses reflink only, and refuses to share a unit it has not proved.

## `pwrgit-share`

Crate path: `tools/pwrgit-share`. Library plus a `pwrgit-share` binary. No network in the library. Tests use temporary repositories and temporary Cargo homes (`CARGO_HOME` pointed at the temp dir). They never read or write the user's `~/.cargo`, never set a global config, and never delete a worktree they did not create.

Commands:

```text
pwrgit-share probe --json <directory>
pwrgit-share worktree add [--seed-target] [--donor <worktree>] [--json] [--] <path> <commit-ish>
pwrgit-share target seed --from <donor-target> --to <dest-target> --json
pwrgit-share measure --json <path>
```

`worktree add` accepts the `git worktree add` flags it understands (`-b`, `--detach` is rejected for the seeded path because PwrGit's create flow uses a branch). Anything unknown is an error, not a pass-through that might mean `--force` in a future Git.

`probe` prints `{"cow":"apfs"|"ficlone"|"none","detail":"..."}`.

`worktree add` JSON includes `fallback` (`none` or `git-checkout`), `clonedFiles`, `checkoutFiles`, `hashedMismatches`, and, when `--seed-target` is set, a `target` object or a `targetSkipped` reason. Exit 0 means the worktree exists and is a valid checkout, even when sharing fell back. Exit 3 means the donor target was locked and `--seed-target` was requested; the worktree is removed if this command created it, so a locked donor does not leave a surprise checkout. Exit 4 is a Git failure before any private files were written. Exit 130 is cancellation; staging directories and a worktree this command registered are removed.

`target seed` takes a shared flock on each donor profile `.cargo-lock` it can see, and refuses with exit 3 if the lock is already exclusive. It does not wait. It writes `<dest>.partial` and renames onto `--to` only when the destination does not exist. It records `unitsSeeded`, `unitsSkipped` by reason (`workspace`, `path-dep`, `fingerprint-unproven`, `layout-unknown`, `toolchain-mismatch`), and `cloneCount` / `copyCount`. `copyCount` stays 0 unless a future explicit `--copy` exists. v1 has no `--copy`.

Seeding rules:

- Read the donor `Cargo.toml` / `cargo metadata` from the donor worktree with `--offline` and the temp or the donor's existing Cargo home. Do not update the index.
- Determine the toolchain identity the donor artifacts were built with (rustc commit from `target/**/.rustc_info.json` or the fingerprint Cargo already stores). If the current rustc does not match, skip the seed. Do not delete the donor.
- Seed registry and git dependency units only. Never seed path or workspace units. Never seed `incremental/`. Never seed uplifted final binaries (`target/debug/<bin>` outside the unit directory).
- On the classic layout, a unit is the hashed files under `deps/` whose filename hash matches a registry/git unit, plus the fingerprint directory for that unit only if the freshness test below has passed for this Cargo version. On the per-unit layout, a unit is `build/<pkg>/<hash>/` for those packages.
- Preserve mode and mtime on cloned files.
- The freshness test is part of the crate's tests, run against the Cargo on the builder: create a fixture with one registry dependency (a tiny crate from a local vendor directory using `[patch]` or a path registry stand-in that Cargo treats as non-path — vendoring into `vendor/` and using Cargo's vendored-source identity is the offline way). Build the donor. Seed a second worktree at the same commit. Rename the donor target out of the way. `cargo build -v` in the second worktree must report the dependency `Fresh` and must not read the renamed donor. Then change a workspace source file and confirm the workspace crate recompiles and the dependency stays fresh. Then rebuild the second tree with `RUSTFLAGS=--cfg pwrgit_share_probe` and confirm the dependency is not reused. If the freshness test cannot be made true for this Cargo, `target seed` still exists and still refuses: it returns `unitsSeeded: 0` and reason `fingerprint-unproven` rather than copying bytes that Cargo will ignore or, worse, trust.

That last sentence is the gate. A seed that Cargo ignores is a disk loss. A seed that Cargo trusts incorrectly is a miscompile. Both fail the test. The command's success with zero units is an honest result, not a crash.

Measure:

- `logicalBytes`: sum of file lengths.
- `cloneCount`, `copyCount`, `skipCount`.
- `allocatedBytes`: report only where the platform can distinguish a clone from a copy. On APFS, `st_blocks` cannot (PwrGit and Disktree both already say this). Omit it or label it `not-distinguishable`.
- `freeSpaceDeltaBytes`: optional, noisy, never the number the summary leads with.
- On Linux, when `btrfs filesystem du` or an equivalent shared-extent report is available, include it under `sharedBytes` with the tool name. When it is not available, omit the field.

Cleanup and gc:

- The tool never runs `cargo clean`, `git gc`, or `git worktree prune`.
- It never deletes a donor, a Cargo home, or a worktree it did not create in this process.
- Removing a worktree stays PwrGit's existing delete. Shared extents return to the volume when the last inode that references them is gone. The UI must not say "freeing N bytes" for a reflinked worktree. The existing prune copy already avoids that promise; this feature must not reintroduce it.
- Staging directories that survive a crash are named `*.pwrgit-share-partial` so a later run can see them and a person can delete them. The tool does not sweep other processes' partials.

Trust:

- Reflink does not cross a trust boundary. The donor worktree is local and chosen by path. There is no network fetch of artifacts and no acceptance of a tarball of `target/`.
- A hash mismatch on a source file drops that file. It does not abort the whole checkout unless the hash step itself cannot run (then fall back to a full Git checkout and delete the clones already made, so a mixed tree cannot remain).
- The Cargo seed never disables fingerprinting, never sets `CARGO_BUILD_INCREMENTAL=0` globally, and never writes config.

## PwrGit integration

Default off. Two settings on the existing settings object in `apps/desktop/src/main/settings/settings-service.ts`:

- `worktreeReflink`: `off` (default) or `on`.
- `worktreeSeedCargoTarget`: `off` (default) or `on`. Seeding requires reflink `on`. The UI disables the second control otherwise.

No new dialog copy that claims a disk saving in gigabytes. The settings text says that supported filesystems share unchanged source files and, when seeding is on, unchanged dependency builds; other filesystems keep today's checkout; build outputs that are not safe to reuse are compiled again.

Create path: `worktree-lifecycle-handlers.ts` calls `worktreeAdd`. When reflink is on, resolve `pwrgit-share` from `worktreeShareCommand` if set, otherwise from `PATH`. Invoke `worktree add` with `--seed-target` only when that second setting is on. The donor is the worktree the command was invoked from, which is the repo path the handler already has.

If the binary is missing, or probe says `none`, or the command exits 0 with `fallback: git-checkout`, the handler uses today's `worktreeAdd` when the share command did not itself create the worktree, and it records a one-line notice. A worktree that exists at the end of a fallback is the success case. Do not fail the user's create because sharing was unavailable.

If the share command created the worktree and exited 0, do not call `worktreeAdd` again.

Removal, locks, prune, and "directory missing" behavior do not change. A reflinked worktree is a normal worktree to Git.

Tests in the desktop suite drive a fake `pwrgit-share` on `PATH` inside the test (the existing Git fixture style). They cover: setting off means the fake is not executed; setting on and fake success means Git's `worktree add` is not also called; fake exit with fallback means the normal add runs; fake crash means no registered worktree is left behind and the error is the existing worktree-add error path. A real-binary test is allowed only against a temp repo.

Add a short paragraph to `apps/desktop/src/main/git/AGENTS.md` next to the worktree-remove section: the share command is opt-in, fallback is a normal checkout, hardlinks are not used, and size UI must not promise freed bytes. Link this note. Do not expand the root `AGENTS.md`.

There is no Electron bundling of the binary in v1. Shipping it inside the app installer would put a second release artifact on the signing path. v1 finds it on `PATH` or via the setting. CI uploads the binary as a draft-PR artifact. Publishing a release is out of scope.

## Packaging

- Crate license: MIT, copyright PwrDrvr LLC, the same grant as the repository `LICENSE`.
- `rust-toolchain.toml` in the crate pins a stable toolchain. Do not float nightly to make the freshness test pass. If stable Cargo cannot prove freshness, ship the command as a deliberate no-seed and say so in `BENCHMARK.md`.
- CI workflow `.github/workflows/pwrgit-share.yml` on pull request: `cargo test` on `macos-latest` and `ubuntu-latest`. Ubuntu's root filesystem is often ext4, so the Linux job asserts the probe returns `none` or, if the runner image is CoW, asserts a real clone. It does not fail the job for lack of `FICLONE`. The macOS job asserts `cow: apfs` and runs the isolation and freshness tests.
- Windows job: optional, `continue-on-error: true`, compile and `probe` only. A red Windows probe is a recorded limit, not a merge blocker, until someone has a ReFS measurement.
- No change to `electron-builder`, the desktop release workflow, or `pnpm` dependencies.
- The binary takes no auto-update path.

## Benchmark plan

Run on a fixture, never on a user's repository. The fixture is a workspace of a few local crates plus a vendored registry dependency large enough to see (a repeated table of data compiled into a crate is enough; do not download crates during the benchmark). Record the Cargo version, rustc commit, OS, filesystem probe result, and the `pwrgit-share measure` JSON.

Each row is a separate run. Do not add the rows into one "saved GB" number.

| Run | What to time and count |
| --- | --- |
| Source, plain `git worktree add` | Wall time. Logical bytes of the new tree. Clone count 0. |
| Source, `pwrgit-share worktree add` at the same commit | Wall time. Logical bytes. Clone count. Free-space delta, labeled noisy. Confirm `git status` is clean and `git rev-parse HEAD` matches. |
| Source, destination on another volume or a forced `none` probe | Falls back. Logical bytes match a normal checkout. No clone count presented as a saving. |
| Same commit, second worktree, target seeded | `cargo build -v` counts of `Fresh` vs `Compiling`, split into registry/git units and workspace units. `measure` on both targets. Donor target renamed away before the build. |
| Changed workspace source | Workspace unit compiles. Registry unit stays fresh. Byte count of new files, not of the whole target. |
| Changed features or `RUSTFLAGS` | Those units compile. Report them as not shared. Do not delete the unused seeded units before measuring; report both the unused seeded bytes and the new bytes. |
| Second profile | `target/release` is not a share of `target/debug`. |
| Branch switch inside one worktree | This tool does not special-case it. Record `cargo build -v` after `git checkout` of the other commit. Incremental state was not seeded, so this is ordinary Cargo. |
| Concurrent builds | Two seeded worktrees, different features, built at the same time. Both exit 0. Neither target file's bytes change under the other build (sample a seeded rlib's hash before and after). Wall time compared with a shared-`CARGO_TARGET_DIR` run that is expected to serialize. The serialized run is a baseline, not the design. |
| Edit and reset isolation | Write a source file in B, hash A. `git reset --hard` in B, hash A. |

Rejected summaries: "N worktrees cost 1× disk" based on `du`, and "the cache hit, so the binary is correct."

## Gaps left open

- Linux `FICLONE` and Windows ReFS are implemented as probes and are not measured here. The Linux and Windows Federation VMs were disconnected on 2026-10-27.
- Cargo freshness for a seeded unit is a test gate, not a promise, until that test is green on the pinned stable Cargo.
- Incremental compilation across worktrees is deliberately not solved.
- One live target directory shared by many worktrees is deliberately not offered.
- Single-branch multi-checkout, OverlayFS remounting, and `merge-tree` commit plumbing are Leo's full request and are not this change.
- Kache's hardlink restore and `cargo-shared-target`'s ext4 hardlinks are not used.
- Git PR 2317 is the upstream place for source reflink. If it merges and the bundled Git grows the flag, `pwrgit-share worktree add` should call it for the source half and keep the Cargo seed. Until then the CLI does the source half itself.
- No garbage collection of abandoned `pwrgit-share` artifacts beyond staging dirs this process created. Orphan `*.pwrgit-share-partial` directories are left for a person to delete.
- The Pete CoW thread was not readable. Disktree does not implement this feature; it only corroborates the APFS accounting warning.

## Files this design expects

| Path | Owner |
| --- | --- |
| `tools/pwrgit-share/**` | The CLI and library, tests, `BENCHMARK.md` |
| `.github/workflows/pwrgit-share.yml` | CI for that crate |
| `apps/desktop/src/main/settings/settings-service.ts` and the settings UI that edits it | Opt-in switches |
| `apps/desktop/src/main/git/worktree-lifecycle-handlers.ts` and `git-service.ts` | Call the CLI instead of `worktreeAdd` when the switch is on |
| `apps/desktop/src/main/git/AGENTS.md` | The short warning |

No other package moves. No dependency bump for its own sake.
