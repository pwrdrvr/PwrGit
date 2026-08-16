# Changelog

## v0.3.0 - 2026-08-16

- Clone and Sync - Added guided repository cloning with progressive destination and progress feedback, plus recovery from HTTPS pull authentication failures by switching to SSH.
- Branch Recovery - Added safe branch reset to a fetched remote, an isolated rebase dry run, clearer pull phases, and a single action to discard all local changes.
- Worktrees - Improved worktree navigation, ordering, refresh behavior, pinned-repository organization, remote-branch visibility, and a calmer collapsed sidebar by default.
- Commit Graph - Improved remote-only and detached-HEAD history, pull-request landing lanes, branch-stack compaction, and command-palette search for commits and exact SHAs.
- Desktop - Refined the PwrGit sidebar, repository header, palette, Windows window chrome, and WCAG 2.1 AA accessibility behavior.
- Updates - Added Stable and Beta update trains and completed the signed Windows release path alongside the packaged Electron runtime update.

## v0.2.0 - 2026-08-03

- Commit Context - Added proof-backed GitHub identities and cached avatar thumbnails, so commit details can show a trusted GitHub login immediately while retaining local Git authorship as a safe fallback.
- Commit Graph - Improved live commit context, copy and change actions, branch-tip accuracy, and pull-request status updates without requiring a full repository reload.
- Worktrees - Added sidebar refresh for external worktree changes, safer removal alongside active Git state checks, and clearer feedback when a linked-worktree entry is cleaned up.
- Sync - Added an actionable recovery flow for diverged pulls, including a safe choice to rebase local commits or reset to the inspected remote tip after confirmation.
- Search - Added pin controls to the ⌘F overlay and puts pinned repositories first when browsing without a search query.
- Packaging - Added the final PwrGit app, Dock, tray, and DMG artwork, plus bundled MIT and third-party license notices.

## v0.1.0 - 2026-07-29

- Commit Graph - Added focused commit navigation, integrated pull-request and worktree context, and fast full-text search across repository history.
- Repository browsing - Improved branch, checkout, and worktree reconciliation so PwrGit stays accurate when repositories change outside the app.
- Sync - Added progress states, actionable error toasts, and a Logs window for fetch, pull, and push failures.
- Settings - Added General, Profiles, Experimental, and Memory/CPU preference panes.
- Minor - Updated bundled dependencies and refined repository navigation throughout the app.

## v0.0.1-alpha.0 - 2026-07-27

First packaged pre-release of PwrGit — a cross-platform Electron git client in
the Pwr family.

- Repository browsing - Commit lineage graph, branch switching, worktree
  management, and working-tree views backed by an embedded git (dugite) and a
  local SQLite state store.
- Diff viewer - File diffs with search and reveal-in-view support.
- Sync - Fetch/pull/push with busy spinners, error toasts, and a Logs window
  for diagnosing silent failures.
- Packaging - Signed + notarized macOS universal DMG/ZIP and a Windows x64
  NSIS installer, published to GitHub Releases as pre-releases.
