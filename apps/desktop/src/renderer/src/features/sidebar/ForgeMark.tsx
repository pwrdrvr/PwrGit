import type { CSSProperties } from "react";
import type { ForgeKind } from "@pwrgit/shared";
import { useBrandTheme, type BrandTheme } from "../../lib/brandTheme";
import invertocatBlackUrl from "../../assets/github/invertocat-black.svg";
import invertocatWhiteUrl from "../../assets/github/invertocat-white.svg";
import tanukiUrl from "../../assets/gitlab/tanuki.svg";
import cafeUrl from "../../assets/gitcafe/favicon.svg";

/**
 * One forge's mark, as that forge publishes it.
 *
 * `themed` is whether the vendor ships per-theme variants this mark has to
 * choose between, and it is what decides whether a given chip subscribes to
 * the theme at all — every repo row in the sidebar draws one of these, so a
 * mark with a single colorway must not hold the document-wide observer open
 * for an answer it ignores.
 */
type Mark = {
  themed: boolean;
  url: (theme: BrandTheme) => string;
};

/**
 * A forge's own mark, at chip size.
 *
 * A logo rather than the product's name: the chip sits on every repo row in a
 * 320px sidebar, and one recognisable shape costs a fraction of what "GitHub"
 * costs the repo name beside it. The name comes back only where the mark
 * cannot answer alone — see `resolveForgeHostDisplays`.
 *
 * These are the **vendors' own files**, unaltered, not transcriptions. Every
 * other glyph in this renderer is hand-transcribed from Lucide, and that is
 * the wrong move for a trademark: GitHub and GitLab both publish their marks
 * and both forbid redrawing them, so a stroke-language lookalike matching the
 * padlock beside it would be our rendition of someone else's logo. What that
 * costs is small and deliberate — the marks do not follow the chip's
 * `--text-muted`, and the tanuki stays full color on both themes.
 * `assets/github/README.md` and `assets/gitlab/README.md` carry the guidance,
 * the provenance, and the re-download recipes.
 *
 * A `Record<ForgeKind, …>`, so a third product is a missing-property type
 * error naming this file — `forge/AGENTS.md`, "Why they are all records".
 */
const MARKS: Record<ForgeKind, Mark> = {
  /**
   * GitHub publishes exactly two colorways of the Invertocat and forbids
   * altering the mark, so this picks between those two files rather than
   * recoloring one: black on light, white on dark.
   */
  github: {
    themed: true,
    url: (theme) => (theme === "light" ? invertocatBlackUrl : invertocatWhiteUrl)
  },
  /** GitLab publishes the tanuki in full color, and it reads on both themes. */
  gitlab: { themed: false, url: () => tanukiUrl },
  gitcafe: { themed: false, url: () => cafeUrl }
};

/**
 * Neither artboard is square — the Invertocat is 98×96 and the tanuki 25×24 —
 * so the box is square and the mark is fitted inside it. Setting `width` and
 * `height` alone would stretch both marks ~2%, which is the "no warping" rule
 * in both vendors' guidance.
 */
const FIT: CSSProperties = {
  display: "inline-block",
  objectFit: "contain",
  verticalAlign: "middle"
};

export function ForgeMark({ kind, size = 12 }: { kind: ForgeKind; size?: number }) {
  const mark = MARKS[kind];
  const theme = useBrandTheme(mark.themed);
  return (
    <img src={mark.url(theme)} width={size} height={size} alt="" style={FIT} draggable={false} />
  );
}
