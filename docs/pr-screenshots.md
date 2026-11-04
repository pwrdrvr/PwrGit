# PR screenshots

Root `AGENTS.md` requires before/after screenshots on any PR that changes
visible UI. This file covers how to make them without driving the live app,
and how to attach them with `gh` so the links actually render.

## Making them

None of these routes needs the dev app on screen. "The app wasn't launched"
is not a reason to ship without screenshots.

| Route | Use it for | How |
|---|---|---|
| Harness page | One component or layout, at fixed widths | `apps/desktop/e2e/harness/<name>/` mounts real renderer components against a fake preload bridge, in a window that is never shown. Copy `harness/section-headings` and its spec; `PWRGIT_HARNESS_SHOTS=<dir>` writes the PNGs. Build "before" from `origin/main` in a second worktree. See [e2e/AGENTS.md › Harness pages](../apps/desktop/e2e/AGENTS.md#harness-pages). |
| `design-shots.spec.ts` | Whole windows and dialogs in the built app | Add a case, then from `apps/desktop`: `pnpm build && PWRGIT_DESIGN_SHOTS=1 PWRGIT_DESIGN_SHOTS_DIR=/tmp/shots npx playwright test -c playwright.config.ts design-shots.spec.ts`. Forge CLIs are stubbed, so no real account reaches the image. Without `PWRGIT_DESIGN_SHOTS_DIR` it writes into `design/assets/`. |
| An e2e spec | A state a spec already reaches | `page.screenshot({ path })` from a spec that runs against the built app and the sandbox repos. |

Recent PRs that did this well: #494–#496 and #476–#477 (harness renders),
#478 (built app driven by e2e).

Rules for the images:

- **Use 100% contrived data**: invented repo names, paths, accounts and counts.
- **If any image is not contrived, show it to the operator and wait for
  approval before attaching.** Redact secrets, tokens, customer data, private
  thread text and account identifiers.
- Say in the PR body which route produced each image ("harness render of the
  real `Sidebar`, not a capture of the running app").
- If no route can show the change, say why in the PR body and ask the operator
  before merging. Don't treat it as optional.

## Attaching them with `gh --attach`

GitHub CLI 2.99+ (`gh` v2.99.0) can attach images and videos with the
repeatable `--attach` flag on `gh pr create`, `gh pr edit`, and
`gh pr comment`. Reference the local path in the Markdown body so `gh`
rewrites it to the uploaded URL in place. Unreferenced attachments are
appended at the end.

```bash
gh pr create \
  --title "fix(desktop): tighten sidebar padding" \
  --body-file /tmp/pr-body.md \
  --attach ./before.png \
  --attach ./after.png
```

```markdown
## Before
![sidebar before](./before.png)

## After
![sidebar after](./after.png)
```

Alt text can also follow the path after `#`, as in
`--attach './after.png#sidebar after'`. The `#alt` suffix is not part of the
path `gh` matches on.

Three ways this fails silently. `gh` exits 0 in every one of them:

- **The match is a literal string comparison.** `gh` rewrites `](path)` only
  when `path` is byte-identical to what `--attach` was given. So
  `--attach /tmp/shots/after.png` against `![after](./after.png)` does not
  match. The upload still happens, the broken relative link stays where it was,
  and a second copy is appended at the end. Pass the same spelling in both
  places, absolute or relative, and keep paths short enough to retype exactly.
- **After the upload, edit the live body, never your draft.** The rewrite
  exists only in the uploaded body. Your local file keeps the local paths. For
  every later edit, run `gh pr view <n> --json body -q .body > <file>` and edit
  that copy. Re-sending the original draft replaces the live `user-attachments`
  URLs with dead local paths. To add an image later, pass `--attach` for the
  new file only. Existing `user-attachments` URLs match no `--attach` path, so
  `gh` leaves them alone. Attaching an already-uploaded image again appends a
  duplicate at the end.
- **Check the rendered PR before calling it done.** Finding `user-attachments`
  URLs in `gh pr view --json body` is not enough, because after a mismatch they
  are present but in the wrong place. Check that every image link in the body
  is a `user-attachments` URL, and that each asset returns HTTP 200 with the
  local file's byte count. To recover from a mismatch without re-uploading,
  copy those URLs out of the body and `gh pr edit --body-file` with them
  placed where you wanted them.
