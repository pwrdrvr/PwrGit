import type { ForkCheckoutPreflight } from "@pwrgit/shared";
import {
  hoverTooltip,
  type ViewportTooltip
} from "../../lib/useViewportTooltip";
import { remoteChanges, upstreamAnswerIsCurrent } from "./fork-checkout-dialog";

/**
 * The "Afterwards" list for forking a checkout in place: the remote layout the
 * rewire will leave, exactly as `git remote -v` will show it.
 *
 * Shared by `ForkCheckoutDialog` and `ForkRepoDialog`'s in-place mode so the
 * two cannot describe the same operation differently. Renders nothing until
 * every part of it has been answered about the current choices — it is a
 * promise about what will exist, and a stale one is worse than none.
 */
export function ForkRemotePlan({
  preflight,
  target,
  upstream,
  tip
}: {
  preflight: ForkCheckoutPreflight | null;
  /** `owner/name` of the fork, or null while there is no valid one. */
  target: string | null;
  /** The chosen upstream, or null when the user declined one. */
  upstream: string | null;
  tip: ViewportTooltip;
}) {
  if (
    preflight === null ||
    target === null ||
    preflight.fork.blocked !== undefined ||
    !upstreamAnswerIsCurrent(preflight, upstream)
  ) {
    return null;
  }
  const changes = remoteChanges({ preflight, target, upstream });
  return (
    <section className="clone-section">
      <div className="clone-label">
        Afterwards
        <span className="clone-label__hint">
          nothing moves on disk; your branches and changes stay put
        </span>
      </div>
      <ul className="fork-remote-plan">
        {changes.map((change) => (
          <li
            key={change.remote}
            className={`fork-remote-plan__row${
              change.unchanged ? " is-unchanged" : ""
            }`}
          >
            <code className="fork-remote-plan__name">{change.remote}</code>
            <span className="fork-remote-plan__copy">
              <strong>{change.nameWithOwner}</strong>
              <small>{change.note}</small>
            </span>
            <code
              className="fork-remote-plan__url"
              {...hoverTooltip(tip, change.url)}
            >
              {change.url}
            </code>
          </li>
        ))}
      </ul>
    </section>
  );
}
