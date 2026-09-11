import type { RemoteActivity } from "@pwrgit/shared";
import {
  useRemoteActivities,
  useSecondsClock
} from "../../state/useRemoteActivity";
import { RemoteActivityCard } from "./RemoteActivityCard";

/**
 * How long an operation elsewhere must run before it earns a card.
 *
 * A repo refresh from the sidebar is usually over in well under a second, and
 * a card that appears and vanishes in that time is a flicker, not a status.
 * The case these cards exist for — an operation that has quietly gone nowhere
 * — is never a near miss on this threshold.
 */
export const REMOTE_ACTIVITY_TOAST_AFTER_MS = 4_000;

/** An operation the toolbar on screen is not already reporting. */
export function isElsewhere(
  activity: RemoteActivity,
  selectedWorktreeId: string | null
): boolean {
  return (
    activity.worktreeId === null || activity.worktreeId !== selectedWorktreeId
  );
}

export function elsewhereActivities(
  activities: RemoteActivity[],
  selectedWorktreeId: string | null,
  now: number
): RemoteActivity[] {
  return activities.filter(
    (activity) =>
      isElsewhere(activity, selectedWorktreeId) &&
      now - activity.startedAt >= REMOTE_ACTIVITY_TOAST_AFTER_MS
  );
}

/**
 * Operations still running somewhere you are no longer looking.
 *
 * Start a pull in one repository, click into another, and the toolbar there
 * quite correctly shows nothing — which is how a five-minute fetch becomes
 * invisible. These cards keep it visible, and cancellable, from wherever you
 * happen to be.
 *
 * Deliberately NOT shown for the checkout on screen: its own toolbar already
 * carries the status, and a card repeating it would cover the graph for the
 * whole operation.
 */
export function RemoteActivityToast({
  selectedWorktreeId
}: {
  selectedWorktreeId: string | null;
}) {
  const all = useRemoteActivities();
  const watching = all.some((activity) =>
    isElsewhere(activity, selectedWorktreeId)
  );
  const now = useSecondsClock(watching);
  const shown = elsewhereActivities(all, selectedWorktreeId, now);
  if (shown.length === 0) return null;

  return (
    <>
      {shown.map((activity) => (
        // `aria-live: off`: this card appears without the user asking and then
        // changes every second. It is a place to look, not an announcement —
        // announcing it would talk over whatever they came here to do.
        <aside
          key={activity.id}
          className="app-toast app-toast--activity"
          role="group"
          aria-label="Git operation running elsewhere"
          aria-live="off"
        >
          <RemoteActivityCard activity={activity} now={now} compact />
        </aside>
      ))}
    </>
  );
}
