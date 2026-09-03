# PwrGit design bundle — provenance

This directory is a checked-in copy of the PwrGit project in
[Claude Design](https://claude.ai/design). It exists so that anyone **without**
Claude Design access can read the design from the repo. Being out of date is the
failure mode that matters here — if you change the design, re-export.

## Source

- Project: **PwrGit** — <https://claude.ai/design/p/88030015-bdd6-424d-8202-005feb3cee12>
- Exported: **2026-09-03**
- Reflects the project's "as built" reconciliation pass of **2026-09-02**, which
  checked the design against `apps/desktop/src/renderer/src/**` and
  `styles/tokens.css` at `main @ bc11343`.

Sibling projects, for reference — **do not export these here**: PwrSnap
`019deed3-8009-7107-bd1e-68bcd3fd192f`, PwrAgent `019df437-879b-7ea9-89a7-aa689d28f06f`,
and the shared PwrDrvr Design System `019debaf-c070-7afe-98db-4c9bbe10e72b`.
Note that Claude Design's `list_projects` returns design **systems** only, so
PwrGit will not appear in it; that is not evidence the project is missing.

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
| `PwrGit Icon.dc.html` | App icon, size ladder, tray templates, DMG background. |
| `support.js` | Generated `dc-runtime` bundle every `.dc.html` loads. |
| `github.md` | Provenance note for the icon asset set (matched to PwrSnap's). |
| `assets/logo-pwrgit.svg` | The lineage mark. |

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

## Deliberately NOT copied in

**`apps/desktop/**`.** The Claude Design project carries a working copy of
`apps/desktop/build/**` (icons, `icon.iconset/`, tray PNGs, `dmg-background.png`,
`fonts/Geist-Bold.ttf`) and `apps/desktop/scripts/*` — roughly 1 MB — because the
icon set was authored there. Those files already live in this repo at their real
paths, and the design project's copies have since drifted (its `icon.icns` is
345 KB against the repo's 129 KB). Copying them into `design/` would shadow the
canonical files with stale duplicates.

Instead, **`PwrGit Icon.dc.html` is edited on import**: each of its ten image
`src`s is rewritten from `apps/desktop/build/…` to `../apps/desktop/build/…` so
the artboard renders the files the app actually ships. This is the only content
difference between the checked-in copy and the project, and it is load-bearing —
**re-apply it on every re-export** or all ten images break.

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
2. Pull the project's files (`mcp__claude-design__list_files` / `read_file`, or
   the zip from the Projects tab at <https://claude.ai/design>).
3. **Diff before replacing.** Do not `rm -rf` this directory: `PwrGit.dc.html`
   and `fork-flow/` are not produced by the export and would be lost.
4. Skip `apps/desktop/**`. `.thumbnail`, `chats/` and `uploads/` are already
   gitignored, but delete them from your working copy anyway so `git status`
   stays readable.
5. Re-apply the `../` rewrite to `PwrGit Icon.dc.html` (see above), then confirm
   every `src` resolves to a real file under `apps/desktop/build/`.
6. Verify each file's byte size against the project listing — a truncated or
   mistranscribed artboard is easy to miss and renders blank.
7. Update the "Exported" date above.

`support.js` is generated (`dc-runtime`) and is shared byte-for-byte across Pwr
design projects **of the same generation**, but generations differ in their
component contract — this one is `renderVals()`, an older one was `render()`. A
mismatch fails silently: the template paints and every `{{binding}}` renders
empty. Take `support.js` from this project, not from a sibling, unless you have
verified the bytes match.
