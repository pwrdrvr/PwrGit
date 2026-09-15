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
- Exported: **2026-09-13**.
- Reflects the project's "as built" reconciliation pass of **2026-09-02**, which
  checked the design against `apps/desktop/src/renderer/src/**` and
  `styles/tokens.css` at `main @ bc11343`.

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
- **`mcp__claude-design__*` is not the route here.** That server is not
  available in Claude Code, so a step that names it reads as "Claude Design
  cannot be reached from this session". It can. `DesignSync` by id is the
  route, and step 2 of "How to re-export" below is written against it.

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
and records where the retired wireframe disagreed with the code. Read it first.

| File | What it is |
|---|---|
| `PwrGit App Baseline.dc.html` | **Current** main window — sidebar, lineage graph, right rail. Interactive. |
| `PwrGit As-Built Coverage.dc.html` | Surface-by-surface coverage map + the wireframe-vs-code drift table. |
| `Hunk Lane Staging.dc.html` | Two-lane hunk/line staging gutter. |
| `Image Diff Lightbox.dc.html` | Binary image diff — inline layout rule, lightbox, pixel compare. |
| `Reset to Remote - UX Review.dc.html` | Reset-to-remote findings and redesign. |
| `Refresh Affordances - Normalization.dc.html` | The six refresh/fetch controls, why they diverged, and the one busy language that replaced them. |
| `Settings Updates.dc.html` | Settings › Updates — the four-slot release matrix, and the two-control layout it replaced. |
| `Settings Forges - UX Review.dc.html` | Settings › Forges — the pane's measured layout defects, and the per-product sections that replace the one interleaved host list. |
| `Focused Lens Stability - UX Review.dc.html` | The Focused lens re-sorting under the pointer &mdash; the ladder rule that fires on click, the options weighed, and a live prototype of the hold. |
| `Fetch Status Popover - UX Review.dc.html` | Why the fetch/pull status card was never seen &mdash; the four gates it stood behind &mdash; and the click-pinned lifecycle that replaces them, with the settled receipt, the countdown rail, and a live prototype of the dismissal rules. |
| `Tag Chips and Locate - UX Review.dc.html` | The lineage tag chip and the tag locator — chip vocabulary, the light-theme contrast the accent tint could not hold, and the sidebar action column. |
| `Onboarding Wizard.dc.html` | The first-run wizard — step model, the four steps, the scan explained, and the Done payoff. Interactive. |
| `Branch Switching and Ref Relevance - UX Review.dc.html` | Where "switch my checkout to this branch" was missing, the relevance ladder the six-row branch slices are spent on, the one guarded switch path, and the three answers a dirty checkout can give. |
| `README Header.dc.html` | The repository landing page — download and link chips, the composition on both GitHub surfaces, and what was and was not taken from DockDoor. Reference header for the Pwr family. |
| `PwrGit Icon.dc.html` | App icon, size ladder, tray templates, DMG background. |
| `support.js` | Generated `dc-runtime` bundle every `.dc.html` loads. |
| `github.md` | Provenance note for the icon asset set (matched to PwrSnap's). |
| `assets/logo-pwrgit.svg` | The lineage mark. |
| `assets/tag-locate-{before,after}.png` | Shipped-app captures for the tag chip artboard, from the Playwright tag scenario on contrived fixture repos. |
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

`README Header.dc.html` was written here and pushed up the same way, alongside
the README change that ships the chips it specifies. It is the reference header
for the Pwr family, so PwrAgent and PwrSnap will carry their own version of it;
this one stays PwrGit's. Its first push went up with the **repo** spelling of
the image paths and rendered every chip broken in the project — which is why
the `../` rewrite for it is written down in the next section rather than left
to memory.

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
7. Update the "Exported" date above.

`support.js` is generated (`dc-runtime`) and is shared byte-for-byte across Pwr
design projects **of the same generation**, but generations differ in their
component contract — this one is `renderVals()`, an older one was `render()`. A
mismatch fails silently: the template paints and every `{{binding}}` renders
empty. Take `support.js` from this project, not from a sibling, unless you have
verified the bytes match.
