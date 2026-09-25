# PwrGit design bundle — provenance

This directory is a checked-in copy of the PwrGit project in
[Claude Design](https://claude.ai/design). It exists so that anyone **without**
Claude Design access can read the design from the repo. Being out of date is the
failure mode that matters here — if you change the design, re-export.

**The project is the source of truth; prefer working in it.** The repo copy is
a mirror, not the original. When Claude Design is reachable — and from Claude
Code and Claude Desktop it is, see the next section — a design change belongs
in the project, with this directory updated to match. Hand-authoring a
`.dc.html` here and never pushing it up is how the mirror and the original
drift apart, and the mirror is the one that loses.

## Source

- Project: **PwrGit** — <https://claude.ai/design/p/88030015-bdd6-424d-8202-005feb3cee12>
- Exported: **2026-09-21**.
- Reflects the project's "as built" reconciliation pass of **2026-09-02**, which
  checked the design against `apps/desktop/src/renderer/src/**` and
  `styles/tokens.css` at `main @ bc11343`. The coverage index's sections 2 and
  3 were swept again on **2026-09-20**, against every artboard in the project
  and every renderer component added since, at `main @ 9889543f`; its section 1
  and the baseline artboard were not re-verified.

Sibling projects, for reference — **do not export these here**: PwrSnap
`019deed3-8009-7107-bd1e-68bcd3fd192f`, PwrAgent `019df437-879b-7ea9-89a7-aa689d28f06f`,
and the shared PwrDrvr Design System `019debaf-c070-7afe-98db-4c9bbe10e72b`.

## Reaching the project from Claude Code or Claude Desktop

Use the **`DesignSync`** tool with the project id above. It reads and writes
this project — `get_project` reports `canEdit: true`, `list_files` and
`get_file` pull content down, and `finalize_plan` followed by `write_files`
pushes content up. Both directions work; neither needs a browser or a zip.

Two things mislead people into concluding otherwise, and both have cost real
sessions:

- **`list_projects` does not return PwrGit.** That call is filtered to
  `PROJECT_TYPE_DESIGN_SYSTEM`, and PwrGit is a plain `PROJECT_TYPE_PROJECT`.
  An empty or PwrGit-less listing is not evidence the project is missing or
  unreachable — address it by id and it answers.
- **A session without the `claude-design` MCP server can still reach the
  project.** Where that server is connected (the Claude desktop app's Code tab
  has it), `mcp__claude-design__*` reaches the project by id too: `list_files`,
  `read_file`, `render_preview`, `finalize_plan`, `write_files`. Where it is
  not, a step that names it reads as "Claude Design cannot be reached from this
  session". It can: `DesignSync` by id is the other route, and step 2 of "How
  to re-export" below covers both.

`finalize_plan` wants a `deletes` array even when it is empty, and its
`localDir` is the directory `write_files` may read `localPath` values from —
point it at whatever root actually contains the files you are pushing.

**One prerequisite, once per machine.** `DesignSync` refuses with HTTP 403
until `/design-login` has been run in an *interactive* Claude Code session; a
non-interactive session cannot run it. A 403 means "this machine has not
logged in yet", not "the project is unreachable" — and once it is done, it
stays done.

**A new design goes into the project, not only into this folder.** Adding an
artboard to the existing project is ordinary, supported work — several of the
files listed below arrived exactly that way. See "Authored here first".

The one thing an agent cannot do from here is manipulate the canvas directly:
no dragging, no click-to-select, no properties panel. It authors `.dc.html`
source and syncs it; a person does the visual editing in Claude Design
afterwards. That is a limit on *how* the design is made, not on *where* it can
live.

## Where to start

**[PwrGit As-Built Coverage.dc.html](PwrGit%20As-Built%20Coverage.dc.html)** is
the index. It lists every shipped renderer surface, says which artboard draws it,
records where the retired wireframe disagreed with the code, and names the
artboards, or turns of them, that draw something which has not shipped. Read it
first.

| File | What it is |
|---|---|
| `PwrGit App Baseline.dc.html` | **Current** main window — sidebar, lineage graph, right rail. Interactive. |
| `PwrGit As-Built Coverage.dc.html` | Surface-by-surface coverage map + the wireframe-vs-code drift table + what is drawn but not shipped. |
| `Hunk Lane Staging.dc.html` | Two-lane hunk/line staging gutter. |
| `Image Diff Lightbox.dc.html` | Binary image diff — inline layout rule, lightbox, pixel compare. |
| `Reset to Remote - UX Review.dc.html` | Reset-to-remote findings and redesign. |
| `Reset to Remote - Forks - UX Review.dc.html` | The same dialog on a fork: why it opened on `origin/main` when that was identical to `main`, why "Last fetched moments ago" was true only of `origin` while `upstream/main` was 19 minutes stale, and the fork-source card, per-remote fetch coverage and leased push back to the fork that fix it. Interactive. |
| `Refresh Affordances - Normalization.dc.html` | The six refresh/fetch controls, why they diverged, and the one busy language that replaced them. |
| `Settings Updates.dc.html` | Settings › Updates — the four-slot release matrix, and the two-control layout it replaced. |
| `Settings Forges - UX Review.dc.html` | Settings › Forges — the pane's measured layout defects, and the per-product sections that replace the one interleaved host list. |
| `Focused Lens Stability - UX Review.dc.html` | The Focused lens re-sorting under the pointer &mdash; the ladder rule that fires on click, the options weighed, and a live prototype of the hold. |
| `Fetch Status Popover - UX Review.dc.html` | Why the fetch/pull status card was never seen &mdash; the four gates it stood behind &mdash; and the click-pinned lifecycle that replaces them, with the settled receipt, the countdown rail, and a live prototype of the dismissal rules. Turn&nbsp;4 is the review after use: why the running card is unreadable, and the accumulating phase list that makes the receipt out of it. |
| `Tag Chips and Locate - UX Review.dc.html` | The lineage tag chip and the tag locator — chip vocabulary, the light-theme contrast the accent tint could not hold, and the sidebar action column. |
| `Onboarding Wizard.dc.html` | The first-run wizard — step model, the four steps, the scan explained, and the Done payoff. Interactive. |
| `Branch Switching and Ref Relevance - UX Review.dc.html` | Where "switch my checkout to this branch" was missing, the relevance ladder the six-row branch slices are spent on, the one guarded switch path, and the three answers a dirty checkout can give. |
| `Palette Kind Glyphs - UX Review.dc.html` | The &#8984;K palette's leading kind glyph &mdash; why branch and worktree do not separate at 15&nbsp;px, the channels that survive that size, the labels that shipped, and the redraws offered for worktree and for the remote branch that never had a mark of its own. Interactive. |
| `Change Requests in Refs - UX Review.dc.html` | Why the refs browser cannot find a pull request by its number, the open-change-request cache that fixes it, and the three places PRs could live in the browser: matched on the Branches tab, a Pull requests / Merge requests sibling tab, or both with per-tab match counts. Interactive. |
| `Git Runtime Settings - UX Review.dc.html` | Settings &rsaquo; General &rsaquo; Git runtime &mdash; the read-only card that names which Git and Git LFS PwrGit runs. The card reproduced at shipped size at both the 760&nbsp;px column and the Settings window's own 760&nbsp;px minimum, five findings against it, the redraw, and the state table it should answer. |
| `Agent History Editing - UX Review.dc.html` | A review of open PR #149's agent-assisted rebase &mdash; six findings against its review-only agent panel &mdash; and a counter-proposal: the agent proposes a history, PwrGit proves it (every commit once, a clean isolated replay, an identical tree), you apply it. Squash messages, &#10022;&nbsp;Tidy, the failure paths, and where the agent is chosen. A proposal; nothing in it is built. Interactive. |
| `Multi-Stash Rail - UX Review.dc.html` | The right rail's Stashes tab at its real widths &mdash; the third tab that pushed the collapse button off the rail, the pull-recovery chip that was always ellipsized away, the clipped stat column, the options for fitting the tab strip into 280&nbsp;px, and the behaviour fixes behind them. Interactive. |
| `Fork From Here - UX Review.dc.html` | Why the sidebar's Fork&hellip; opened on an empty search for a checkout you cannot push to, and why nothing else offered to fork it &mdash; a forge lookup never made for a repository added mid-session, and fork verbs that waited on its answer. Then the entry points that no longer wait: the repo row's kebab and right-click menu, the origin row's fork button, the worktree header's &#8942; item, and a seeded Fork&hellip; dialog with a Fork in place bridge. Interactive. |
| `README Header.dc.html` | The repository landing page — download and link chips, the composition on both GitHub surfaces, and what was and was not taken from DockDoor. Reference header for the Pwr family. |
| `PwrGit Icon.dc.html` | App icon, size ladder, tray templates, DMG background. |
| `support.js` | Generated `dc-runtime` bundle every `.dc.html` loads. |
| `github.md` | Provenance note for the icon asset set (matched to PwrSnap's). |
| `assets/logo-pwrgit.svg` | The lineage mark. |
| `assets/tag-locate-{before,after}.png` | Shipped-app captures for the tag chip artboard, from the Playwright tag scenario on contrived fixture repos. |
| `assets/palette-glyph-raster-before.png` | The three shipped palette glyphs rasterised at their true 15&nbsp;px and magnified with nearest-neighbour sampling &mdash; the evidence for the review's first finding. Generated, not a capture. |
| `assets/forges-before.png` | Shipped-app capture of Settings › Forges, from a Playwright scenario against contrived `gh`/`glab` stubs. |
| `assets/branch-switch-{sidebar,browser}-{before,after}.png` | Shipped-app captures of the sidebar ref sections and the refs browser, from one Playwright scenario on a contrived repository, run against the renderer before and after the change. |
| `assets/dirty-switch-prompt.png` | Shipped-app capture of the uncommitted-changes prompt, from the same contrived scenario. |

### History and leftovers

`PwrGit.dc.html` is the **2026-08 wireframe**, superseded by
`PwrGit App Baseline.dc.html`. It is deliberately still here because
[docs/plans/2026-07-05-001-feat-pwrgit-desktop-git-client-plan.md](../docs/plans/2026-07-05-001-feat-pwrgit-desktop-git-client-plan.md)
and [packages/shared/src/types.ts](../packages/shared/src/types.ts) cite it by
path as the spec they were built against. Treat it as history: where it and the
shipped app disagree, the app is right, and the coverage artboard lists every
such disagreement. Do not use it as a target for new work.

`uploads/` is **gone** as of the 2026-09-03 re-export. It held a single pasted
screenshot of that same retired wireframe, referenced by no artboard — so its
only effect was to show the superseded UI sitting next to the artboard that
replaces it. The design project dropped its own `uploads/` in the 2026-09-02
pass on the same reasoning; the repo now matches. Nothing else referenced the
file, and it carried no private content (see below).

`fork-flow/` did not come from this project and is not reproduced by its export.
Its four artboards load `./support.js`, which does not exist in that
subdirectory, so they will not run as checked in — a pre-existing condition, not
something the 2026-09-03 export changed.

## Authored here first

Some artboards were drafted in this repo and pushed **up** into the project
rather than exported down from it. That direction is supported and expected —
`DesignSync` writes as readily as it reads — and it is the right move when the
design is being worked out alongside the code it describes. What it must not
become is an excuse to skip the push: an artboard that only ever exists here is
invisible to everyone working in Claude Design.

Two consequences for whoever re-exports: these files are **normal members of
the bundle**, not foreign matter to drop, and each one must already be in the
project before a re-export runs, or the export will delete it from the mirror.

`Tag Chips and Locate - UX Review.dc.html` and its two `assets/tag-locate-*.png`
captures were written this way during the review of
[#211](https://github.com/pwrdrvr/PwrGit/pull/211).

`Settings Forges - UX Review.dc.html` and `assets/forges-before.png` were
written here the same way, and pushed up the same way. It **supersedes artboard
2a of `Forge Hosts - UX Review.dc.html`**, which drew Settings › Forges as one
interleaved list of every host; the products now get a section each. The rest of
that file still stands — it owns the host row anatomy, the evidence line, and
the rule that a product is chosen and never guessed from a hostname.

`Focused Lens Stability - UX Review.dc.html` was written here and pushed up the
same way, during [#249](https://github.com/pwrdrvr/PwrGit/pull/249). It carries
no screenshots &mdash; the defect and the fix are both *motion*, so a still frame
of the sidebar looks identical either way. Card **2d** is a live `DCLogic`
prototype instead: toggle the hold off and the clicked row leaves from under the
cursor, toggle it on and it stays. Its repository names are invented, not a real
profile.

`Fetch Status Popover - UX Review.dc.html` was written here and pushed up the
same way. It carries no screenshots for the same reason as the Focused Lens
review: the defect is that a card *never appears*, and the fix is a lifecycle
&mdash; both are timing, and a still frame of the toolbar looks identical either
way. Card **1b** draws the timing as a strip instead, and card **2d** is a live
`DCLogic` prototype of the whole lifecycle: press Fetch at 0.9&thinsp;s (the
duration the old age gate could never admit), then try to keep the card. Its
repository names are invented.

**Turn 4 was added after the lifecycle shipped and was used.** It is the second
half of the same defect: the card is now reachable, and what it shows while an
operation runs is unreadable &mdash; five immediate redraws inside a 620&thinsp;ms
pull, a progress block that mounts and unmounts, and a Git-output tail that
rewrites its own last line. Card **4b** is the argument in one picture: the same
six-second pull at three moments, *replacing* on the left and *accumulating* on
the right, where every row readable in the first frame is still there in the
receipt. Card **4d** runs both at both speeds. Turn 4 is a proposal, not a
record of what is built &mdash; the shipped card is turns 1&ndash;3.

That turn shares one `DCLogic` component with turn 2, because an artboard has a
single `data-dc-script` block. `renderVals()` merges two value sets
(`t2Vals()` and `p4Vals()`) rather than one class growing two personalities;
the `p4` prefix is what keeps the bindings from colliding.

`Palette Kind Glyphs - UX Review.dc.html` and `assets/palette-glyph-raster-before.png`
were written here the same way, during the &#8984;K palette glyph review. Unlike the
files above, this one took the route **because Claude Design was unreachable** &mdash;
both the `claude-design` MCP server and the built-in `DesignSync` tool answer
HTTP&nbsp;403 `FIRST_PARTY_AUTH_REJECTED` until `/design-login` has been run in an
interactive session, and a non-interactive one cannot run it. It sat in the repo
only until 2026-09-19, when it and its image were pushed up during the review of
[#149](https://github.com/pwrdrvr/PwrGit/pull/149). The project holds the artboard
at 46,007 bytes and the image at 4,628, both matching this copy, so a re-export no
longer threatens either.

Its specimens are invented (`Demo`, `feature/requested`, `spike/no-checkout`,
`release/1.4`), and its one image is generated rather than captured: the glyphs are
drawn at 15&nbsp;px by headless Chromium and blown up with nearest-neighbour
sampling, which is the whole argument &mdash; vector magnification flatters an icon
and hides the defect. Card **4e** is a live `DCLogic` prototype that swaps the whole
glyph set and blurs it, because the read being argued about is a peripheral one.

`Agent History Editing - UX Review.dc.html` was written here and pushed up the
same way, during the review of [#149](https://github.com/pwrdrvr/PwrGit/pull/149).
It is in the project, byte-identical to this copy. For two days it was in the
project but not on `main`, because its first mirror,
[#293](https://github.com/pwrdrvr/PwrGit/pull/293), was still open, and that
made it look like a file authored in Claude Design. It was not: the project's
one chat is empty. It owns agent-assisted history editing: the six findings
against #149's review-only panel, the proof ledger every plan must pass before
Apply unlocks, Squash messages, Tidy, the three failure paths, and the agent
chip and the Settings › AI Providers and AI Features pages it is chosen from.
It is a proposal: none of that is built. It carries no `assets/`; every frame
is drawn from PwrGit's tokens and markup, and its commits, branches and file
names are invented. Card **4b** is a live `DCLogic` prototype of Tidy &mdash;
keep a fixup separate, run the check, apply.

`Multi-Stash Rail - UX Review.dc.html` was written here and pushed up through the
`claude-design` MCP during the UI review of
[#150](https://github.com/pwrdrvr/PwrGit/pull/150); the upload was checked
byte-for-byte against this copy. It carries no screenshots. Its specimens are
true-size HTML drawn from the shipped stash and rail-tab CSS, and its numbers
come from mounting the real `Rail` and `StashesTab` in headless Chromium against
contrived fixtures (`feat/parser-rewrite`, `parser experiment`, invented
hashes). Card **2d** is a live `DCLogic` prototype of the tab strip: pick a rail
width and watch where the collapse button lands, before and after.

The Tag Chips captures are 100% contrived: fixture repositories built by
`apps/desktop/e2e/fixtures/git-sandbox.ts`, a seeded default profile, and a
`PWRGIT_USER_DATA_DIR` temp dir. Nothing in them came from a real account or a
real repository, which is why they may live under `design/assets/` in a public
repo — the rule the "chats/ and uploads/" section below states.

`Onboarding Wizard.dc.html` was written here too, and pushed up the same way,
in the design pass that followed
[#248](https://github.com/pwrdrvr/PwrGit/pull/248). It owns the first-run
wizard: the step model, the four steps, and the Done screen that draws only
what a fresh scan actually knows. A re-export must not treat it as foreign and
drop it.

Pushing it up was what first turned up the `/design-login` prerequisite now
recorded under "Reaching the project" above.

It carries no `assets/` of its own. Every frame in it is drawn from PwrGit's own
tokens and markup rather than captured, so there is no screenshot to keep in
sync — and the fixture data in it (`northwind-labs`, `atlas-forge`,
`ledger-api`, `dana@example.com`) is invented, not sampled from a real machine.

`Branch Switching and Ref Relevance - UX Review.dc.html` was written here and
pushed up the same way, during
[#255](https://github.com/pwrdrvr/PwrGit/pull/255). It owns the branch-switching
verb: the matrix of every surface that names a branch and what it lets you do
with it, the four-tier relevance ladder the six-row branch and remote previews
are spent on, and the two implementations of "switch" that had drifted apart. A
re-export must not treat it as foreign and drop it.

Turn **5** and `assets/dirty-switch-prompt.png` were added to it during
[#260](https://github.com/pwrdrvr/PwrGit/pull/260), which is stacked on that PR.
It owns the uncommitted-changes decision: the three answers, why "leave them on
the old branch" is deliberately not a fourth, and the two outcomes the carrying
switch owes its callers.

Its five `assets/*.png` captures are **100% contrived**: one
Playwright scenario in `apps/desktop/e2e/design-shots.spec.ts` against a
fixture repository built by `e2e/fixtures/git-sandbox.ts`, the seeded default
profile, and a `PWRGIT_USER_DATA_DIR` temp dir. Every branch name in them is
invented. The before/after pairs come from running that one scenario twice —
the second time with `apps/desktop/src` and `packages` checked out at the base
commit — so the two frames differ only by the change. It uses no selector the
older build lacks, which is what makes that possible; keep it that way.

The project copy lagged this one until 2026-09-21. It predated #255's last
change, the neutral `.sgone` count, so it still drew the branch summary's
`2 gone` in the amber warning tier, without the note explaining why that is
wrong. Its `assets/branch-switch-sidebar-after.png` was the matching earlier
capture. The repo's artboard and image were pushed up to close the gap.

`README Header.dc.html` was written here and pushed up the same way, alongside
the README change that ships the chips it specifies. It is the reference header
for the Pwr family, so PwrAgent and PwrSnap will carry their own version of it;
this one stays PwrGit's. Its first push went up with the **repo** spelling of
the image paths and rendered every chip broken in the project — which is why
the `../` rewrite for it is written down in the next section rather than left
to memory.

`Change Requests in Refs - UX Review.dc.html` was written here and pushed up
through the `claude-design` MCP server's `write_files`, the same session it was
drafted in; the project copy was verified at the same 50,940 bytes. It is a
proposal, not a record of what is built: nothing in the app changed with it.
Turn **1** is the diagnosis (the refs browser filters on name, upstream and
subject, while the only PR data that knows #106 sits in `commit_pr`), turn
**2** draws the three options with **2c** recommended and **2d** a live
`DCLogic` prototype of it, and turn **3** sizes the cache as one open-list call
per repo. Its specimens (`orbit-deploy`, `octo-contrib`, `~/src/orbit-deploy`)
are invented; the one real name in it is the head branch of
[pwrdrvr/microapps-app-release#106](https://github.com/pwrdrvr/microapps-app-release/pull/106),
a public repository, quoted in finding 1a as the report that started it. It
carries no `assets/`.

`Git Runtime Settings - UX Review.dc.html` was written here and pushed up the
same way, during [#296](https://github.com/pwrdrvr/PwrGit/pull/296). It carries no
screenshots: every specimen is the shipped Settings card rebuilt from the real
`app.css` rules, so the before and the after sit at the same size in one frame and
the proposals can be drawn in states the app cannot be put into on demand (a
missing bundled Git, a probe that timed out). The sizes and wrap points the review
asserts &mdash; the 16&nbsp;px value, the 478&nbsp;px and 182&nbsp;px control
columns &mdash; were measured in headless Chromium against the real
`GitRuntimeSettings` component mounted on the app's own stylesheets, not eyeballed
from the artboard. Its version strings are invented; the Git LFS build tail is the
real shape of `git lfs version` output. Turn **1** is the card as #296 builds it;
turns **2&ndash;3**, the redraw and the state table, are a proposal.

`Reset to Remote - Forks - UX Review.dc.html` was written here and pushed up
through the `claude-design` MCP, in the same change that builds what it draws;
the project copy was verified at the same 51,219 bytes. It answers a report
from a fork checkout, where `origin` is the fork, `upstream` the source, and
`main` tracks `origin/main`. Turn **1** is the diagnosis, including the
reflog timeline that showed the reset landing on a tip 19 minutes old. Turns
**2&ndash;4** are the target step, the review step and the outcome, and **2d**
is a live `DCLogic` prototype. It is drawn in the light theme the report came
from. The repository names are the reported ones (`huntharo/diskhound`, a fork
of `tzarebczan/diskhound`), and so are the SHAs and counts in turns 1 and 2b.
The diverged fork in **2c** and **3b** is invented: `3c1a9e0` and its two
commits exist only in the artboard.

`Fork From Here - UX Review.dc.html` was written here and pushed up through the
`claude-design` MCP, in the same change that builds what it draws; the project
copy was verified at the same 47,661 bytes. It answers a report that the
sidebar's Fork&hellip; opened on an empty search while the selected checkout
was one its owner could not push to, and that no other place offered to fork
it. Turn **1** is the diagnosis. The repository was cloned through PwrGit after
the window mounted, and a clone only reloads the list, so its forge identity
was never read; every fork affordance waited on that identity. Turn **2**
draws the entry points that no longer wait, turn **3** seeds the top button
from `origin`'s URL, and **4a** is a live
`DCLogic` prototype of both. Turn **5** is the build list, and unlike most
reviews here it shipped with the artboard. Its names are contrived
(`sparkline`, `octo-labs`, `demo-dev`); `sparkline` stands in for the reported
checkout.

It carries one asset, `assets/github-invertocat-black.svg`: a copy of the app's
own `apps/desktop/src/renderer/src/assets/github/invertocat-black.svg`, drawn as
the forge mark on the origin row. The project lists it at 1,570 bytes against
1,559 here, because Claude Design re-serializes an SVG on write and expands its
one `<path/>` and one `<rect/>` into open/close pairs (6 + 5 bytes). The
drawing is identical; keep the repo's copy.

## Deliberately NOT copied in

**`apps/desktop/**`.** The Claude Design project carries a working copy of
`apps/desktop/build/**` (icons, an `icon.iconset/`, tray PNGs, `dmg-background.png`,
`fonts/Geist-Bold.ttf`) and `apps/desktop/scripts/*` — roughly 1 MB — because the
icon set was authored there. Those files already live in this repo at their real
paths, and the design project's copies have since drifted (it still carries an
`icon.icns` and `icon.iconset/`; the repo ships `icon.icon/` and lets
electron-builder derive the legacy sizes — see `apps/desktop/AGENTS.md`).
Copying them into `design/` would shadow the canonical files with stale
duplicates.

Instead, **`PwrGit Icon.dc.html` is edited on import**: each of its ten image
`src`s is rewritten from `apps/desktop/build/…` to `../apps/desktop/build/…` so
the artboard renders the files the app actually ships, and the five size-ladder
images point at `icon-macos.png` (scaled by their `width`) because the repo no
longer carries an `icon.iconset/`.

**`github.md` is edited on import too**, for the same reason: its screen-map row
reads `icon.png, icon-macos.png, icon.icon/` where the project still says
`icon.icns, icon.iconset/*`. Copying the project's row back would re-assert an
`.icns` the repo has not shipped since
[#196](https://github.com/pwrdrvr/PwrGit/pull/196).

**`README Header.dc.html` takes the same `../` rewrite**, in both directions.
Its seven image `src`s are `docs/assets/buttons/*.png` and
`apps/desktop/build/icon.png` in the project, and `../docs/…` / `../apps/…`
here. Push the repo spelling up by accident — which is exactly what happened
the first time it was written — and every chip in the project renders as a
broken image, silently.

Those three files are the only content differences between the checked-in
copies and the project, and all three are load-bearing — **re-apply them on
every re-export** or the images break and the provenance note goes stale.

Also skipped: `.thumbnail` (already covered by `design/**/.thumbnail` in
`.gitignore`).

**`chats/` and `uploads/`** — design-session transcripts and pasted reference
screenshots. No artboard references either, and both can carry private context:
internal product decisions, local paths, account names, identifying details in a
screenshot. This repo is public, so they are locked out in the top-level
`.gitignore` rather than reviewed case by case on each re-export:

```
design/chats/
design/uploads/
```

The project currently has neither, so nothing is being suppressed today — the
rule is there so a future export cannot quietly reintroduce one. This matches
PwrAgnt (`docs/design/pwragent-v2/SOURCE.md`). If you ever genuinely need a
screenshot committed, put it under `design/assets/` where it is a deliberate,
reviewable choice.

## How to re-export

1. Read `PwrGit As-Built Coverage.dc.html` first so you know what the project
   is supposed to contain.
2. Pull the project's files with `DesignSync` (`list_files`, then `get_file`
   per path) against the project id in "Source". A person without tool access
   can take the zip from the Projects tab at <https://claude.ai/design>
   instead, but that is the fallback, not the first move.

   With the `claude-design` MCP server, the cheapest byte-exact pull of a large
   `.dc.html` is `render_preview`, then a download of its `serve_url`. The
   served page has three lines injected after `<head>` (lines 4&ndash;6: a
   `<style data-omelette-injected>` element, a `<script data-omelette-injected>`
   element that ends on the next line, and a blank line). Delete exactly those
   and the size equals the `list_files` size. A `serve_url` carries a project
   token: never paste one into a file, a commit, or a PR.
3. **Diff before replacing.** Do not `rm -rf` this directory: `PwrGit.dc.html`
   and `fork-flow/` are not produced by the export and would be lost.
4. Skip `apps/desktop/**`. `.thumbnail`, `chats/` and `uploads/` are already
   gitignored, but delete them from your working copy anyway so `git status`
   stays readable.
5. Re-apply all three on-import edits (see above): the `../` rewrite and
   size-ladder repoint in `PwrGit Icon.dc.html`, the `../` rewrite in
   `README Header.dc.html`, and the screen-map row in `github.md`. Then confirm
   every `src` resolves to a real file under `apps/desktop/build/` or
   `docs/assets/buttons/`.
6. Verify each file's byte size against the project listing — a truncated or
   mistranscribed artboard is easy to miss and renders blank. Exactly three
   files are *expected* to differ, all from step 5: `PwrGit Icon.dc.html`
   (5,945 here against 5,990 there), `github.md` (1,211 against 1,210), and
   `README Header.dc.html` (17,833 against 17,773). Do not "correct" those
   three toward the project.

   One more differs for a different reason:
   `assets/github-invertocat-black.svg` (1,559 here against 1,570 there),
   because the project re-serializes an SVG on write. The paragraph on
   `Fork From Here` above has the byte count. Keep the repo's copy.

   **A downloaded PNG never matches by size, and that is not drift.** Claude
   Design stores a PNG as pushed: `list_files` reports the pushed size, and on
   2026-09-21 every image in the project listed at exactly its repo size. What
   it *serves* is stamped: a `caBX` chunk (a signed C2PA content credential,
   "Claude provided this file…") is inserted after `IHDR`, and every other
   chunk is untouched. An earlier version of this note gave 127,302 bytes
   (measured 2026-09-19) for `assets/tag-locate-before.png`, a 121,532-byte
   file. That was a served copy: the gap is the same 5,770-byte chunk measured on
   `branch-switch-sidebar-after.png` (129,953 served against 124,183 listed).
   So compare an image's size against `list_files`, never against a download.
   Compare a downloaded image chunk by chunk with `caBX` excluded, and keep the
   repo's unstamped originals rather than pulling stamped copies down.
7. Update the "Exported" date above.

`support.js` is generated (`dc-runtime`) and is shared byte-for-byte across Pwr
design projects **of the same generation**, but generations differ in their
component contract — this one is `renderVals()`, an older one was `render()`. A
mismatch fails silently: the template paints and every `{{binding}}` renders
empty. Take `support.js` from this project, not from a sibling, unless you have
verified the bytes match.
