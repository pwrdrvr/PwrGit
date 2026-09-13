# GitHub brand assets

The two SVG files in this directory are the **official, unaltered** GitHub
Invertocat mark from GitHub's downloadable logo kit:

- `invertocat-black.svg` — black variant, used on the light theme
- `invertocat-white.svg` — white variant, used on the dark theme

## Source

- Logos page: <https://github.com/logos>
- Logo kit (zip): <https://brand.github.com/GitHub_Logos.zip>

The files come from `GitHub Logos/SVG/` inside that zip. We use the
`GitHub_Invertocat_<variant>.svg` files rather than the `..._Clearspace.svg`
ones so the mark fills the chip — the clearspace variants pad the artboard for
documents and marketing surfaces. Copied byte-for-byte from PwrAgnt, which
downloaded them on 2026-09-02 and documents the same recipe; verify with
`shasum -a 256` against a sibling checkout before re-downloading.

## Why the Invertocat, and what it identifies here

PwrGit draws this mark to say **which forge a repository's remotes are on**: on
the repo row in the sidebar, on each remote under Refs, and in Settings →
Forges. It is the same identity the `gh` CLI carries, and `gh` is GitHub's own
tool. GitHub's logo guidance covers using the mark to refer to GitHub; it does
not cover borrowing another product's application icon, so this is the
Invertocat rather than the GitHub Desktop icon.

## Usage rules — do not alter these files

GitHub's logo guidance forbids modifying the mark. In particular:

- **No recoloring.** Black and white are the two variants GitHub publishes for
  this mark, and picking between them by theme is a variant choice, not a
  recolor. [`ForgeMark.tsx`](../../features/sidebar/ForgeMark.tsx) therefore
  renders the asset as an `<img>` and swaps files on `[data-theme]`; it never
  applies `currentColor` or a CSS filter. This is why the mark does not follow
  the chip's `--text-muted` the way the outline glyphs beside it do.
- **No redrawing, warping, cropping, or effects.** The artboard is 98×96, not
  square, so the `<img>` is sized with `object-fit: contain` — squaring it by
  setting `width` and `height` alone would stretch the mark 2%.
- **Not for endorsement.** The mark names the forge a remote points at. It must
  not appear anywhere that implies GitHub sponsors, endorses, or is affiliated
  with PwrGit.

## Updating these files

Re-download rather than editing in place:

```bash
curl -sSL -o /tmp/GitHub_Logos.zip "https://brand.github.com/GitHub_Logos.zip"
unzip -o -j /tmp/GitHub_Logos.zip \
  "GitHub Logos/SVG/GitHub_Invertocat_Black.svg" \
  "GitHub Logos/SVG/GitHub_Invertocat_White.svg" \
  -d apps/desktop/src/renderer/src/assets/github
cd apps/desktop/src/renderer/src/assets/github
mv GitHub_Invertocat_Black.svg invertocat-black.svg
mv GitHub_Invertocat_White.svg invertocat-white.svg
```

(The zip URL comes from the "Download our logos" link on
<https://github.com/logos>. If it 404s, start from that page.)
