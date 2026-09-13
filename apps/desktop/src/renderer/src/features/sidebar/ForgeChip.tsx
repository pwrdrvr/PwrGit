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
export function ForgeChip({ chip }: { chip: ForgeChipView }) {
  return (
    <span
      aria-hidden="true"
      className={`forge-chip${chip.name === null ? " forge-chip--mark" : ""}`}
      title={chip.title}
    >
      {chip.kind !== null && <ForgeMark kind={chip.kind} />}
      {chip.name !== null && (
        <span className="forge-chip__name">{chip.name}</span>
      )}
      {chip.others > 0 && (
        <span className="forge-chip__more">+{chip.others}</span>
      )}
    </span>
  );
}
