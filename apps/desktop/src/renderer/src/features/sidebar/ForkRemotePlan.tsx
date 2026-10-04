import type { ForkCheckoutPreflight } from "@pwrgit/shared";
import {
  hoverTooltip,
  type ViewportTooltip
} from "../../lib/useViewportTooltip";
import {
  forkPlanRoutes,
  remoteChanges,
  upstreamAnswerIsCurrent
} from "./fork-checkout-dialog";
import { RouteStrip } from "./ForkRoute";

/**
 * What forking a checkout in place changes. With a branch to draw, it is two
 * strips — where the branch pulls from and pushes to now, and after — and
 * the remote layout, exactly as `git remote -v` will show it, moves under
 * "In Git terms". Without one (a branch on no remote yet, or no branch) the
 * layout is the whole answer and stands on its own, as "Afterwards".
 *
 * Shared by `ForkCheckoutDialog` and `ForkRepoDialog`'s in-place mode so the
 * two cannot describe the same operation differently. Renders nothing until
 * every part of it has been answered about the current choices — it is a
 * promise about what will exist, and a stale one is worse than none.
 * Design: `design/Fork Route Graphic - UX Review.dc.html`, 2b.
 */
export function ForkRemotePlan({
  preflight,
  branch,
  target,
  upstream,
  tip
}: {
  preflight: ForkCheckoutPreflight | null;
  /** The branch the strips are drawn for (`routeBranch`), or null for none. */
  branch?: string | null;
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
  const list = (
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
  );
  if (branch == null) {
    return (
      <section className="clone-section">
        <div className="clone-label">
          Afterwards
          <span className="clone-label__hint">
            nothing moves on disk; your branches and changes stay put
          </span>
        </div>
        {list}
      </section>
    );
  }
  const { now, after } = forkPlanRoutes({ preflight, branch, target, upstream });
  return (
    <section className="clone-section fork-remote-plan-route">
      <div className="clone-label">
        Where pushes go
        <span className="clone-label__hint">
          nothing moves on disk; your branches and changes stay put
        </span>
      </div>
      <RouteStrip phase="now" branch={branch} {...now} />
      <RouteStrip phase="after" branch={branch} {...after} />
      <details className="fork-tracking-terms">
        <summary>In Git terms</summary>
        <p>
          Points <code>origin</code> at {target}
          {upstream === null ? (
            ". No remote is kept for the original."
          ) : preflight.upstreamRemote.existing ? (
            <>
              ; <code>{preflight.upstreamRemote.name}</code> already points at{" "}
              {upstream}.
            </>
          ) : (
            <>
              {" "}and adds <code>{preflight.upstreamRemote.name}</code> for{" "}
              {upstream}.
            </>
          )}{" "}
          No branch settings change: a branch that tracks <code>origin</code>{" "}
          follows it to the fork.
        </p>
        {list}
      </details>
    </section>
  );
}
