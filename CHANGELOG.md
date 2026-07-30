# Changelog

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
