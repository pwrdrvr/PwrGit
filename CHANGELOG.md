# Changelog

## v0.11.0 - 2026-09-03

- Changes - Refined partial staging with separate hunk and line controls, drag-to-select runs, and clearer indicators of how much of each hunk is staged.
- Image Diff - Added full-size before/after/diff viewing, pixel-level comparisons, shared zoom and pan, and copy actions for image revisions.
- Reset to Remote - Made destructive resets safer by prioritizing the branch's upstream, showing exactly which commits would be left behind, and offering an explicit fresh-fetch action.
- Sync - Added a persistent activity panel and clearer queued, in-progress, and completed states for bulk repository synchronization.
- macOS - Normalized Dock icon padding so PwrGit has a consistent native size across supported macOS releases.
- Desktop - Updated the packaged Electron runtime to 41.10.7 and aligned the release builder with that runtime.
- Packaging - Enforced the seven-day dependency maturity policy in CI and at the start of release packaging, catching immature dependencies before an expensive release build begins.

## v0.10.0 - 2026-08-31

- File History and Blame - Added rename-aware file history, per-revision file viewing, and line-level blame from the Command Palette, changed-file menus, and diffs.
- Changes - Added Git-native hunk and line staging and unstaging, with snapshot checks that safely refresh stale selections instead of applying them to changed content.
- Updates - **Help → Check for Updates** now answers in a toast with a direct **Restart** action when an update is ready; development builds can preview the full flow safely.
- Git LFS - Replaced the recurring banner with an at-a-glance repository header status and targeted repair guidance that does not shift the workspace.
- Repositories - Protected scanned repositories, pins, and custom ordering when a configured scan location is temporarily unavailable or empty.
- Packaging - Added a shipped-dependency license policy gate and embedded-Git source disclosure so an unexpected license change cannot silently pass packaging checks.

## v0.9.0 - 2026-08-30

- Sync - Added profile-wide **Fetch all** and **Try pull all**, with per-repository progress, cancellation, and conservative fast-forwards that only update clean, tracked worktrees.
- Tags - Added fast tag browsing and search, reviewed local and remote tag management, and a direct **Tag this commit…** action in the commit graph.
- Tags - Improved tag creation so you can select `HEAD`, a branch, an existing tag, or another revision and review the resolved commit before creating the tag.
- Git Operations - Added a live rail banner for in-progress merges, rebases, cherry-picks, reverts, and patches, with safe Continue and Abort actions and clearer conflict context.
- Worktrees - Fixed Windows worktree removal so background Git launcher processes do not leave an otherwise removable directory locked.
- Repositories - Fixed dangling remote default-branch references so pruning a deleted upstream branch no longer breaks the commit graph.
- Clone - Made the default clone destination and the exact folder PwrGit will create more obvious before you start.
- Desktop - Improved fresh-install reliability and speed by staging the packaged SQLite binary instead of compiling it locally.

## v0.8.0 - 2026-08-27

- Repositories - Added a Focused lens that brings your current, pinned, recently viewed, and active repositories and worktrees to the front.
- Branches - Added safe local branch rename and deletion actions, with protections for checked-out worktrees, unmerged changes, and remote branches.
- Submodules - Added detailed, read-only submodule status in Changes, including pins, checked-out state, divergence, dirtiness, and configuration drift.
- Profiles - Added safe profile deletion that removes PwrGit's profile data while leaving your Git repositories on disk untouched.
- Appearance - Added System, Dark, and Light themes globally and per profile, including synchronized window chrome.
- Help and Support - Added an About experience with copyable runtime details and direct links to documentation, support, issue reporting, and private security reporting.
- Clone and Fork - Improved cancellation, cleanup, and retry behavior across clone and fork flows.
- Reliability - Added recovery controls for failed profile, repository, and forge reads; concurrent fetches now retry once when another Git process advances a remote-tracking ref.
- Forges - Made private-repository lookup errors clearer, explaining that a 404 can also mean the signed-in account lacks access.
- Windows - Updated keyboard shortcuts, file-manager wording, and path labels to use Windows-native conventions.
- Integrations - Added a read-only MCP server for repository and checkout discovery, plus normalized pull-request, CI, conflict, and review status resources.
- Desktop - Updated the packaged Electron runtime to 41.10.6 and aligned the release build with that runtime.

## v0.7.0 - 2026-08-23

- Updates - Added **Help → Check for Updates**, so you can manually recheck for a new PwrGit release at any time.
- Clone - Added support for cloning local repositories and filesystem paths, including home-relative and Windows/UNC paths; empty repositories now open without history errors.
- Windows - Fixed the Add or Remove Programs entry to show the clean product name rather than repeating the installed version.
- Security - Updated transitive dependencies to resolve known vulnerability alerts.
- Packaging - Pinned the desktop build toolchain for more reproducible signed releases.
- Open Source - Added the project README, contribution and security guidance, community policies, and issue/PR templates.

## v0.6.0 - 2026-08-20

- Repositories - Added forking from inside PwrGit, plus identity marks showing whether each repository is public, private, or internal, and whether it is a fork.
- GitLab - Added merge-request status alongside GitHub pull requests, so change-request state appears whichever host a remote points at.
- Settings - Added a Forges pane that reports each forge's connection state, names the exact command to install it or sign in, and lists what that forge supports.
- Pull Requests - Improved the pull-request card with diff size, commit count, branch names, and timestamps, so hovering a PR chip shows real detail instead of a bare title.
- Clone - Opening the clone dialog is now immediate, searching the forge as you type instead of enumerating every owner up front.
- Commit Graph - Fixed branches that are behind their upstream so the commits they are missing are drawn, not just the trunk's.
- Diff - Improved the diff pane header with a close (✕) control in place of the back button, and Escape now closes the pane.
- Updates - Fixed repeated update checks failing with a GitHub error; release information is now cached and shared across the app, and revalidated without spending the request budget.
- macOS - Fixed the app icon's smallest sizes so PwrGit renders correctly in Finder list view and the sidebar.

## v0.5.0 - 2026-08-18

- Changes - Added image previews, live refresh after staging or external edits, folder grouping, and safe discard for an entire folder.
- Changes - Added **Add to .gitignore** in the right-click menu for untracked files and folders; large change sets now stay responsive, retain accurate totals, and identify the folder most worth ignoring.
- Commit Graph - Added actions for branches directly from Lineage, including creating a branch from any commit.
- Branches and Worktrees - Added Command Palette search for local branches without a worktree, paired the branch list with the selected worktree, and immediately select newly created worktrees.
- Worktrees - Show a worktree's folder name when it differs from its branch name, making linked checkouts easier to distinguish.
- Repositories - Page remote branches instead of loading every ref at once, keeping large repositories responsive.
- Desktop - Remember the selected sidebar lens across restarts and refined pane, sidebar, and title-bar details.
- Updates - Updated the packaged Electron runtime to 41.10.5 and refreshed bundled Git and desktop dependencies.

## v0.4.0 - 2026-08-17

- Remotes - Fixed empty repositories so **Manage remotes and remote branches…** remains available, letting you add the first remote without a workaround.
- Windows - Fixed the title-bar divider so it continues beneath the native window controls, including in auxiliary windows.

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
