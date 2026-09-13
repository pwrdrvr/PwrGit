import type { ForgeChipView } from "./forge-chip";
import { ForgeMark } from "./ForgeMark";

/**
 * The one forge chip, drawn the same in the repo row and the remotes list.
 *
 * Usually a bare mark — one glyph is what lets the chip sit on every row
 * without costing the repo name beside it. Words appear only where the mark
 * cannot answer alone: two hosts of one product, a name the user typed, or a
 * host no product has a mark for.
 *
 * Not a `title` on some wrapper: the chip is the abbreviation, so the full
 * hostname belongs on the chip itself, where the pointer already is.
 *
 * `aria-hidden` because the row that contains it already states the same facts
 * in its description (`identityDescription`) — announcing "gitlab.com" twice,
 * once as a bare word, is worse than once in a sentence. That is also what
 * makes a glyph-only chip safe: nothing depends on the mark being read.
 *
 * The name and the count are separate spans, because only one of them may be
 * dropped: the name ellipsises when a collision has left it a full hostname,
 * and the `+n` beside it must survive that — it is the part saying the chip is
 * not the whole answer.
 */

/**
 * How big the mark is drawn, in each of the chip's two shapes.
 *
 * A bare mark has no pill around it, so its size is set by the company it
 * keeps: `RepoIdentityMarks` draws the lock, globe and fork at 12px right
 * beside it, and matching them is what makes the group read as one row of
 * glyphs rather than as a logo dropped among icons.
 *
 * Inside a pill it is bounded by the pill instead, and the pill now grows
 * with `--sidebar-chip-size`. So this 11px is only the value at the default
 * notch and the fallback for the img's own attributes: `app.css` sizes the
 * in-pill mark at `1em`, which is that same 11px at "md" and keeps the mark
 * set against the word beside it rather than towering over it — or being
 * towered over — at the notches either side.
 */
const MARK_SIZE = { bare: 12, inPill: 11 } as const;
export function ForgeChip({ chip }: { chip: ForgeChipView }) {
  return (
    <span
      aria-hidden="true"
      className={`forge-chip${chip.name === null ? " forge-chip--mark" : ""}`}
      title={chip.title}
    >
      {chip.kind !== null && (
        <ForgeMark
          kind={chip.kind}
          size={chip.name === null ? MARK_SIZE.bare : MARK_SIZE.inPill}
        />
      )}
      {chip.name !== null && (
        <span className="forge-chip__name">{chip.name}</span>
      )}
      {chip.others > 0 && (
        <span className="forge-chip__more">+{chip.others}</span>
      )}
    </span>
  );
}
