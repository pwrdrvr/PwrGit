# GitLab brand asset

`tanuki.svg` is the **official, unaltered** full-color GitLab mark from
[GitLab's SVG repository](https://gitlab.com/gitlab-org/gitlab-svgs/-/blob/main/illustrations/gitlab_logo.svg),
downloaded from the corresponding raw URL on 2026-09-11. Copied byte-for-byte
from PwrAgnt, which documents the same source; verify with `shasum -a 256`
against a sibling checkout before re-downloading.

## What it identifies here

PwrGit draws this mark to say **which forge a repository's remotes are on**: on
the repo row in the sidebar, on each remote under Refs, and in Settings →
Forges. It is the same identity the `glab` CLI carries. It does not imply
endorsement by GitLab.

## Usage rules — do not alter this file

- **No recoloring.** GitLab publishes this mark in full color and PwrGit renders
  it as published, on both themes. [`ForgeMark.tsx`](../../features/sidebar/ForgeMark.tsx)
  renders it as an `<img>` for that reason — it never applies `currentColor` or
  a CSS filter, which is why it does not follow the chip's `--text-muted` the
  way the outline glyphs beside it do.
- **No redrawing, warping, cropping, or effects.** The artboard is 25×24, not
  square, so the `<img>` is sized with `object-fit: contain`.

## Updating this file

Re-download rather than editing in place:

```bash
curl -sSL -o apps/desktop/src/renderer/src/assets/gitlab/tanuki.svg \
  "https://gitlab.com/gitlab-org/gitlab-svgs/-/raw/main/illustrations/gitlab_logo.svg"
```
