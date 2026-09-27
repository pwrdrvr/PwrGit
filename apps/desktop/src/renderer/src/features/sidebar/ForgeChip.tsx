import { dispatch } from "../../lib/pwrgit";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
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
 * The full hostname belongs on the chip itself, where the pointer already is
 * — but through `useViewportTooltip`, not a native `title`. The chip sits one
 * glyph away from marks that draw the house card, and a chip that answers with
 * the OS tooltip instead makes one row speak in two voices. (It is also the
 * only one of these that ever rendered its `title`, which is why the mismatch
 * was visible rather than theoretical.)
 *
 * Linked chips expose their destination to assistive technology.
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
export function ForgeChip({ chip, url = null }: { chip: ForgeChipView; url?: string | null }) {
  const tip = useViewportTooltip();
  const Tag = url === null ? "span" : "a";
  return (
    <Tag
      aria-hidden={url === null ? true : undefined}
      href={url ?? undefined}
      aria-label={url === null ? undefined : `Open repository in browser: ${url}`}
      onClick={url === null ? undefined : (event) => {
        event.preventDefault();
        event.stopPropagation();
        tip.hide();
        void dispatch("shell:openExternal", { url });
      }}
      onKeyDown={url === null ? undefined : (event) => event.stopPropagation()}
      className={`forge-chip${chip.name === null ? " forge-chip--mark" : ""}`}
      {...hoverTooltip(tip, url === null ? chip.title : `${chip.title}. Open repository in browser: ${url}`)}
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
      {tip.tooltipNode}
    </Tag>
  );
}
