import type { Lens } from "@pwrgit/shared";
import { formatLensCount, LENSES } from "./repo-view";

export function LensFilter({
  lens,
  counts,
  onChange
}: {
  lens: Lens;
  counts: Record<Lens, number>;
  onChange: (lens: Lens) => void;
}) {
  return (
    <div className="lens-filter">
      {LENSES.map((l) => (
        <button
          key={l}
          className={`lens-chip${l === lens ? " is-active" : ""}`}
          onClick={() => onChange(l)}
        >
          {l}
          {counts[l] > 0 && (
            <span
              className="lens-chip__count"
              /* The abbreviated form is lossy, so keep the exact count
                 reachable on hover. No title when nothing was abbreviated —
                 a tooltip that repeats the visible text is just noise. */
              title={
                formatLensCount(counts[l]) === String(counts[l])
                  ? undefined
                  : `${counts[l]}`
              }
            >
              {formatLensCount(counts[l])}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
