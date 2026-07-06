import type { Lens } from "@pwrgit/shared";
import { LENSES } from "./repo-view";

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
          {counts[l] > 0 && <span className="lens-chip__count">{counts[l]}</span>}
        </button>
      ))}
    </div>
  );
}
