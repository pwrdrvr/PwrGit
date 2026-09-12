import type { ForgeChipView } from "./forge-chip";

/**
 * The one forge chip, drawn the same in the repo row and the remotes list.
 *
 * Not a `title` on some wrapper: the chip is the abbreviation, so the full
 * hostname belongs on the chip itself, where the pointer already is.
 *
 * `aria-hidden` because the row that contains it already states the same facts
 * in its description (`identityDescription`) — announcing "gitlab.com" twice,
 * once as a bare word, is worse than once in a sentence.
 *
 * Two spans, because only one of them may be dropped: the name ellipsises when
 * a collision has left it a full hostname, and the `+n` beside it must survive
 * that — it is the part saying the name is not the whole answer.
 */
export function ForgeChip({ chip }: { chip: ForgeChipView }) {
  return (
    <span aria-hidden="true" className="forge-chip" title={chip.title}>
      <span className="forge-chip__name">{chip.name}</span>
      {chip.others > 0 && (
        <span className="forge-chip__more">+{chip.others}</span>
      )}
    </span>
  );
}
