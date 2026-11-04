# features/diff — AGENTS.md

Most of this feature is ordinary React. The image diff and the staging gutter
contain decisions that the code does not make obvious.

## The stacking rule lives in two places on purpose

- **When you change a stacking threshold, change both halves.** Keep
  `MIN_SIDE_WIDTH` and the 718px in step, or the row flips axis while images
  load.

1. A container query on `.pane--main` in `app.css` (718px; the comment there
   shows the arithmetic). It is correct at first paint, with no JS.
2. `shouldStack` in [image-layout.ts](image-layout.ts), applied by `ImageDiff`
   as `.diff-image--stacked` after decode. It reads the aspect ratio, which
   width cannot see: a 32:9 banner in a 400px side is 112px tall.

## Zoom and pan are shared because that is the whole feature

- **Only Fit and 100% may move the view.** A refit on item switch makes the
  viewer useless while it looks correct.

`ImageLightbox` frames before, after and the pixel diff in ONE reference box
(`referenceExtent`: the larger revision). The `useZoomPan` view uses that
box's coordinates, so switching item keeps the view. Flipping on the same
pixels at the same zoom shows *what* changed.

## pixelmatch will not compare unequal sizes

- **Never downscale to the smaller revision.** Resampling removes the
  differences the view exists to show.

pixelmatch (ISC, on `ALLOWED_LICENSE_IDS`) needs identical dimensions. A
re-export at 1x is an ordinary commit, so `planDiff` in
[pixel-diff.ts](pixel-diff.ts) maps onto the **larger** box: `stretch` when
the shapes match (a 2x export vs its 1x twin), `anchor` otherwise.

It runs in [pixel-diff.worker.ts](pixel-diff.worker.ts). A retina pair is 6
megapixels per side, and the anti-aliasing pass would freeze the pane on the
renderer thread. `DIFF_OPTIONS` is exported so the test drives the real
library with the same settings. pixelmatch silently ignores unknown keys, so a
renamed key would paint in its default red.

`--diff-changed` and `--diff-aa` in `tokens.css` equal the values the worker
bakes into the PNG, so they do not flip with the theme. They are exempt in
`theme-contract.test.ts`. `pixel-diff.test.ts` pins them to the stylesheet.

## The lightbox has to claim Escape, and take focus

- **An overlay launched from the diff pane must focus itself on open, restore
  focus to its opener on close, and call `preventDefault` on Escape.**
  Otherwise one Escape closes the overlay **and** the file viewer.
- **The scrim dismisses only when both press and release are on it.** A
  `click` fires on the common ancestor, so a pan that ends past the frame
  would otherwise close the view.
- **The chevrons sit inside the stage**, so a near-miss lands on the picture,
  not on the scrim.

`DiffPane` handles Escape only when focus is inside the pane. Otherwise it
waits one tick and stops if something called `preventDefault`. Its keydown
effect comment states the contract.

A lightbox that throws while rendering closes and shows a toast; the window
does not blank. `DiffViewer` wraps it in an `ErrorBoundary` whose `onError`
clears the lightbox state. Unmount cleanup returns focus to the opener. The
root's `onCaughtError` logs the error to `main.log` (`lib/AGENTS.md`).

## The arrows walk the whole diff, and stop at the ends

- **`stepStop` clamps. It does not wrap.** A wrap hides whether the user has
  seen everything.
- **`ImageLightbox` mounts both revisions and hides the inactive one**
  (`display: none` still decodes). A walked-to file was never measured, and
  the pixel comparison needs both dimensions. With one side mounted, the Diff
  tab silently showed nothing. Both mounted also makes switching instant.

[lightbox-sequence.ts](lightbox-sequence.ts) flattens the diff into one list:
each image file's before, after and diff, in viewer order. Non-image files
are skipped.

## Pictures arrive as bytes, and every blob URL has exactly one owner

- **Keep `diff:image` payloads as a raw `Uint8Array`.** Electron IPC
  structured-clones it end to end (preload `invoke` → `ipcMain.handle` →
  `CommandBus`), with no JSON and no base64 (4/3 size, a string concat per
  side). A new transport must not stringify it.
- **Mint a blob URL only inside the effect run that revokes it.** StrictMode's
  rehearsal unmount runs cleanup and then the effect again. A disposable store
  built in `useMemo` and disposed in cleanup then serves revoked URLs.
  PwrAgent shipped that bug. StrictMode cases in `ImageDiff.test.tsx` and
  `ImageLightbox.test.tsx` catch it; keep them.

[use-image-revisions.ts](use-image-revisions.ts) wraps the bytes in a `Blob`
and mints one object URL per side. `usePixelDiff` follows the same rule.

- **The lightbox never borrows the row's URL.** It mints its own from the
  row's Blobs, so neither can revoke or blank the other.
- **Work reads the Blob, not the URL.** The pixel diff posts both Blobs to the
  worker (a handle, not a copy) for `createImageBitmap`. The copy menu mints
  and revokes its own URL. Both survive a revoked display URL.
- **jsdom has no `URL.createObjectURL`.** Tests install the ledger in
  [object-urls.ts](../../test-support/object-urls.ts). It records each mint,
  its source Blob, and each revoke.

## Copying goes through a canvas, and through the main process

[image-copy-menu.ts](image-copy-menu.ts) builds one right-click menu for the
inline row and the lightbox. The row runs the same comparison
(`computePixelDiff`, [pixel-diff-client.ts](pixel-diff-client.ts), one shared
worker), so copying the diff needs no viewer.

[image-clipboard.ts](image-clipboard.ts):

- **Re-encode to PNG through a canvas; never pass the original bytes.**
  Electron's `nativeImage` decodes only PNG and JPEG, and images can be webp,
  avif or gif. Decode through an `<img>`, because `createImageBitmap` refuses
  SVG Blobs.
- **The clipboard write is IPC** (`clipboard:writeImage`). The renderer's
  async clipboard API cannot write an image that every app accepts. The PNG
  crosses as chunked base64, because `String.fromCharCode(...bytes)` exceeds
  the argument limit on a large screenshot. A `Uint8Array` transport, as for
  `diff:image`, needs a change to main's input validation; it is not done.

`stripLayout` is pure and tested alone. It matches panels on the **shortest**
height and never scales up, so a 1x export beside its 2x twin stays sharp.

## The staging gutter is two lanes, and neither one is a checkbox

On a selectable patch, `DiffViewer` puts two lanes (16px and 24px) before the
line numbers:

- **Lane 1 stages whole hunks:** a chip at the hunk header, and a `.diff-rail`
  across the hunk's rows (hairline / dim / solid = none / some / all).
- **Lane 2 stages single lines:** a `+` at `opacity: 0` until the row is
  hovered or the button is focused.

No line shows a control at rest. A checkbox column makes a diff read as a
form. The rail shows the hunk's staged share from the pane edge.

- **The row is the pointer target, not the glyph or the lane.** Handlers sit
  on `.diff-row`. `NOT_A_PRESS` excludes `.diff-text` (selectable) and
  `.diff-gutter--blame` (a button; a press would open blame *and* sweep). The
  `+` is only the affordance and keyboard control. The 24px lane alone loses
  five sixths of the target, and a drag drifting out of it stops the sweep.
  WCAG 2.5.8's 24x24 is still not met: the control is bound to the row's
  line-height.
- **The sweep is held in a ref, not only in state**, so
  `press → extend → release` survives any render timing. A fast click would
  otherwise release into a `null` sweep. State only paints the preview.
- **Listen for `mouseover`, not `mouseenter`.** React synthesizes enter/leave
  from delegated `mouseover`, so a dispatched `mouseenter` never arrives and
  tests fail. Bubbling also lets the whole row extend the run.
- **Drop a sweep that sees `buttons === 0`.** Its mouseup went missing (a
  native menu, focus lost mid-drag). It would otherwise grow on plain hover.
- **Intent is fixed at the press.** A press on an unstaged line stages the
  run; on a staged line it clears it. Deciding per row leaves stripes.

Shift-click extends from the anchor with the anchor's state and does **not**
start a sweep: one button-down cannot mean two gestures. The window `mouseup`
listener lives for the file view, so a sweep past the pane bottom still
commits. A selected row has no spine: lane 2's filled control and the rail
already show it, and a third amber line made the edge look broken.
