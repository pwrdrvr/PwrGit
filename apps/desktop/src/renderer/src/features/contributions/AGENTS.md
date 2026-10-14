# features/contributions — AGENTS.md

`docs/contribution-analytics.md` describes the product; this is what to keep
true when changing the code.

## The share image never sees a name the user masked

- **Resolve names in shared, then draw.** `contributionShareChart`
  (`packages/shared/src/contribution-share.ts`) turns owners and repositories
  into final labels — shown, masked (`Org A`, `Org A/repo 1`, `User A`), or
  none — and the picture is built from that result only. Don't pass a
  `ContributionRecord`, a repo path or an aggregate label into
  `share-image.ts`; that is how a masked name ends up in the PNG.
- **Never build the picture from the DOM.** The on-screen chart carries
  per-bar `<title>` tooltips naming every series. The old "Export chart"
  cloned it, so its file named every org while showing no legend.
  `shareImageSvg` emits text and rects only; its tests reject `<title>`,
  `<desc>`, `<metadata>` and `data-` attributes.
- **The preview is the export.** The dialog's `<img>` shows the exact SVG
  that `shareImagePng` rasterizes. Don't add a second renderer for the preview.
- **Masked by default.** An owner with no stored choice falls to
  `defaultShareNameMode`: shown only for the viewer's own personal namespace.
  Storage only ever records what the user explicitly changed.
- Colors in `share-image.ts` are literals on purpose (the image leaves the
  app), and its fonts are system faces (an SVG drawn as an image cannot reach
  the document's web fonts).

## Escape

`ContributionScreen` closes itself on Escape, so it ignores an Escape a dialog
already claimed (`event.defaultPrevented`). Any new overlay on this screen
goes through `useModal`/`useDismissable`, which claim it.
