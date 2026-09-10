import type { ReactElement } from "react";

/**
 * The tag mark, for anywhere a tag name is chipped beside other refs.
 *
 * The lineage row used to draw a literal `# ` text node in front of the name.
 * Two things were wrong with that. `PrChip` renders `#412` in the same mono
 * face a chip or two to the left, so `#` before a tag borrowed the one meaning
 * already taken on that line — and as real text it reached assistive tech,
 * which read the chip as "number sign v2.4.0".
 *
 * A glyph also matches how the chip's neighbour is built: `BranchGlyph` +
 * name is what a branch chip is, so a tag chip that is mark + name is the
 * same construction rather than a second one.
 *
 * Geometry is Lucide's `tag`, copied rather than re-drawn. Its 0.5-unit
 * interior dot is dropped: at 9px it lands on a fifth of a device pixel and
 * renders as a smudge next to a 2.4-weight stroke, which reads as an artifact
 * rather than as part of the mark.
 *
 * Stroke scales with `size` for the reason `RefreshGlyph` documents — a fixed
 * width thins as the glyph shrinks, and one shared mark should not change
 * apparent weight per caller.
 */
export function TagGlyph({ size = 9 }: { size?: number } = {}): ReactElement {
  return (
    <svg
      className="tag-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={(2.4 * 9) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
    </svg>
  );
}
