import type { McpAuthorization } from "./access-policy.js";
import type { LiveStatusSnapshot, LiveEventKind, ReviewSummary } from "./types.js";
export const LIVE_EVENT_CONTRACT_VERSION = "2.0" as const;
type EventDescriptor = { kind: LiveEventKind; review?: ReviewSummary };
const comparable = (value: unknown): string => JSON.stringify(value);

export function changedEvents(
  previous: LiveStatusSnapshot | undefined,
  current: LiveStatusSnapshot
): EventDescriptor[] {
  if (previous === undefined) return [{ kind: "snapshot" }];
  const events: EventDescriptor[] = [];
  if (
    comparable(previous.local) !== comparable(current.local) ||
    comparable(previous.identity) !== comparable(current.identity) ||
    previous.providerAvailable !== current.providerAvailable
  ) {
    events.push({ kind: "repository.status" });
  }
  if (comparable(previous.ci) !== comparable(current.ci)) {
    events.push({ kind: "ci.status" });
  }
  if (previous.mergeConflict !== current.mergeConflict) {
    events.push({ kind: "merge.conflict" });
  }
  if (
    comparable(previous.changeRequest) !== comparable(current.changeRequest)
  ) {
    events.push({ kind: "change_request.state" });
  }
  const previousReviewIds = new Set(previous.reviews.latest.map((review) => review.id));
  for (const review of current.reviews.latest) {
    if (!previousReviewIds.has(review.id)) {
      events.push({ kind: "review.submitted", review });
    }
  }
  if (
    previous.reviews.blocking !== current.reviews.blocking ||
    previous.reviews.blockingReason !== current.reviews.blockingReason
  ) {
    events.push({ kind: "review.blocking" });
  }
  return events;
}

/** No out-of-band listener: subscriptions share the approved MCP connection. */
export function liveStatusCapabilities(authorization: McpAuthorization, supportsSubscriptions = true) {
  return {
    contract: "pwrgit.live-status", version: LIVE_EVENT_CONTRACT_VERSION,
    authorization: {
      protocol: "pwrgit.mcp-policy/v1", required: true,
      sessionId: authorization.sessionId, sessionName: authorization.sessionName,
      roleId: authorization.roleId, roleName: authorization.roleName,
      permissions: [...authorization.capabilities], repositoryRoots: authorization.repositoryRoots
    },
    eventKinds: [
      "snapshot",
      "repository.status",
      "ci.status",
      "merge.conflict",
      "review.submitted",
      "review.blocking",
      "change_request.state"
    ],
    states: {
      ci: [
        "success",
        "failure_with_running",
        "terminal_failure",
        "running",
        "pending",
        "none",
        "unknown"
      ],
      reviewBlockingReasons: [
        "changes_requested",
        "approval_required",
        "blocking_discussion"
      ],
      changeRequest: ["open", "merged", "closed"]
    },

    privacy: { remoteCredentialsReturned: false, changedFilePathsReturned: false, boundedRepositoryList: true },
    mcp: {
      primary: "subscribable_status_resource",
      resourceSubscriptions: {
        supported: supportsSubscriptions, resourceTemplate: "pwrgit://status/v1/{watchId}",
        updateNotification: "notifications/resources/updated",
        behavior: supportsSubscriptions ? "Subscribe and re-read after notifications/resources/updated." : "Read status resources on demand."
      }
    }
  } as const;
}
export type LiveEventCapabilities = ReturnType<typeof liveStatusCapabilities>;
