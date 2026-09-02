# features/diff — AGENTS.md

Mostly ordinary React. The image-diff half has three decisions that are not
obvious from the code.

## The stacking rule lives in two places on purpose

`.diff-image`'s axis is decided twice: a container query on `.pane--main` in
`app.css` (718px — the arithmetic is in the comment there), and `shouldStack`
in [image-layout.ts](image-layout.ts), which `ImageDiff` applies as
`.diff-image--stacked` once the images decode.

Neither is redundant. The query is right at first paint with no JS, so there is
no flash of the wrong axis — but width cannot see **shape**, and a 32:9 banner
squeezed into a 400px side is 112px tall while a phone screenshot at the same
width is fine. The JS half reads the decoded aspect ratio and catches that.

So: change a threshold, change both, and keep `MIN_SIDE_WIDTH` and the 718px in
step or the two halves will disagree at the boundary and the row will flip axis
as the images load.

## Zoom and pan are shared because that is the whole feature

`ImageLightbox` frames every item — before, after, and the pixel diff — inside
ONE reference box (`referenceExtent`: the larger of the two revisions). The
`useZoomPan` view is expressed in that box's coordinates, so switching item
changes nothing about the view.

That is the point of the thing. Two pictures side by side answer "did anything
change"; only flipping between them on the same pixels at the same
magnification answers "what". A refit on switch would make the viewer useless
while looking like it worked, so nothing but Fit and 100% may move the view.

## pixelmatch will not compare unequal sizes

The library (ISC, and already on `ALLOWED_LICENSE_IDS`) requires two buffers of
identical dimensions, and Playwright's answer to a mismatch is to fail the
comparison. A repository is not a test suite: re-exporting a screenshot at 1x
is an ordinary commit, so `planDiff` in [pixel-diff.ts](pixel-diff.ts) decides
instead — `stretch` when the shapes match (a 2x export against its 1x twin),
`anchor` otherwise, always onto the **larger** box. Never downscale to meet the
smaller revision: that resamples away the differences the view exists to show.

It runs in [pixel-diff.worker.ts](pixel-diff.worker.ts) because a retina pair is
6 megapixels a side and the anti-aliasing pass walks every neighbour of every
differing pixel — long enough on the renderer's thread to freeze the pane
mid-scroll. Only the canvas half needs a browser; `DIFF_OPTIONS` is exported so
the test drives the real library through the same settings. That matters more
than it looks: pixelmatch silently ignores option keys it does not recognise, so
a renamed one would fall back to its defaults and paint in ITS red.

`--diff-changed` / `--diff-aa` in `tokens.css` are the same values the worker
bakes into the PNG, which is why they do not flip with the theme (they are
listed in `theme-contract.test.ts`'s exemptions). `pixel-diff.test.ts` pins the
numbers against the stylesheet.

## The lightbox has to claim Escape, and take focus

`DiffPane` scopes its own Escape to focus being inside the pane, and otherwise
defers a tick and bails if something called `preventDefault` — the contract is
written out on its keydown effect. `ImageLightbox` is opened by a button that
lives inside that pane, so an overlay that leaves focus alone is still "focus
inside the pane": one Escape closed the lightbox **and** the file viewer under
it. It now does both halves — focuses its frame on open (restoring the opener
on close, so the pane's Escape works again afterwards) and calls
`preventDefault`. Any future overlay launched from the diff pane owes the same.

Dismissing on the scrim needs the press *and* the release on the scrim. A
`click` fires on the common ancestor of the two, so a pan that starts on the
image and ends past the frame — routine at any real zoom — otherwise delivers a
click straight to the scrim and throws the view away. For the same reason the
chevrons sit inside the stage rather than at the frame's edge: a near-miss
should land on the picture, not next to the thing that closes everything.

## The arrows walk the whole diff, and stop at the ends

[lightbox-sequence.ts](lightbox-sequence.ts) flattens the diff into one list of
stops — every image file's before, after and diff, in the order the viewer
lists the files — and `stepStop` **clamps**. It does not wrap.

That is deliberate: an arrow that quietly starts you over is how you lose track
of whether you have seen everything, and the whole point of walking a diff is
knowing when you have reached the end of it. Non-image files are not in the
list at all, so the walk skips straight past them.

A file reached by walking was never on screen, so nothing measured it. That is
why `ImageLightbox` mounts **both** revisions and merely hides the inactive one
(`display: none` still decodes): the pixel comparison needs both dimensions
before it can plan anything, and rendering only the visible side meant jumping
to Diff from the tabs produced nothing at all — silently, since the tab is
offered whenever the file has two sides. Keeping both mounted also makes
switching instant instead of a re-decode.

## Copying goes through a canvas, and through the main process

The right-click menu is built once in [image-copy-menu.ts](image-copy-menu.ts)
and used by both the inline row and the lightbox, so "copy the after" means the
same thing wherever you reach for it. The row runs the same comparison the
lightbox does (`computePixelDiff` from
[pixel-diff-client.ts](pixel-diff-client.ts), one shared worker) rather than
making the reader open the viewer to reach the diff.

Two things force the shape of [image-clipboard.ts](image-clipboard.ts):

- **Everything is re-encoded to PNG through a canvas**, never handed over as
  the original bytes. The repository's images can be webp, avif or gif, and
  Electron's `nativeImage` decodes only PNG and JPEG. Chromium already decoded
  the picture to show it, so routing through a canvas means every format the
  pane can preview is a format it can copy.
- **The clipboard write is IPC** (`clipboard:writeImage`), because the
  renderer's async clipboard API cannot put an image on the pasteboard in a way
  every target app accepts. The PNG crosses as base64 — chunked, since
  `String.fromCharCode(...bytes)` blows the argument limit on a multi-megabyte
  screenshot.

`stripLayout` is pure and tested on its own: it matches panels on the
**shortest** height and never scales up, so a 1x export beside its 2x twin
stays sharp instead of interpolated.
