import {
  ASSUMED_FORGE_KIND,
  forgeLabel,
  type ChangeRequestEntry,
  type ChangeRequestView,
  type ChangeRequestViewHead
} from "@pwrgit/shared";

type Ready = Extract<ChangeRequestView, { state: "ready" }>;

/**
 * The line under the PR view's header that says which commit the diff is
 * drawn to, and whether it is the one the forge shows.
 *
 * - `ok`: the head shown is the forge's.
 * - `warn`: the local branch and the forge's head differ; `toggle` shows the
 *   other end.
 * - `busy` / `muted` / `bad`: on the way, nothing to fetch yet, or failed.
 */
export type Provenance = {
  tone: "ok" | "warn" | "busy" | "muted" | "bad";
  text: string;
  /** The other end, when there are two to choose between. */
  toggle?: { label: string; show: "local" | "forge" };
  /** A fetch that would help: the view asks for it. */
  fetch?: string;
};

const short = (oid: string): string => oid.slice(0, 7);

/** Where a head lives, as a person would say it. */
export function holderPhrase(head: ChangeRequestViewHead): string {
  const { holder } = head;
  switch (holder.kind) {
    case "worktree":
      return `Worktree ${holder.branch}`;
    case "local":
      return `Local branch ${holder.branch}`;
    case "remote":
      return holder.name;
    case "fetched":
      return `${holder.source.replace(/^refs\//, "")}, fetched from ${holder.remote}`;
  }
}

const plural = (count: number, one: string): string =>
  `${count} ${one}${count === 1 ? "" : "s"}`;

export function provenanceOf(view: ChangeRequestView): Provenance {
  const forge = forgeLabel(view.entry.pr.forge ?? ASSUMED_FORGE_KIND);
  if (view.state === "needsFetch") {
    return {
      tone: "muted",
      text: `${view.what} is not in this checkout yet. Nothing gets checked out to look at it.`,
      fetch: "Fetch"
    };
  }
  if (view.state === "unavailable") {
    return { tone: "bad", text: view.message, fetch: "Try again" };
  }
  return readyProvenance(view, forge);
}

function readyProvenance(view: Ready, forge: string): Provenance {
  const { relation, head, shown } = view;
  const where = `${holderPhrase(head)} holds ${short(head.oid)}`;
  switch (relation.kind) {
    case "same":
      return { tone: "ok", text: `${where}, the head ${forge} shows.` };
    case "ahead":
      return shown === "local"
        ? {
            tone: "warn",
            text: `${where}: ${plural(relation.count, "commit")} ahead of what ${forge} shows, unpushed.`,
            toggle: { label: `Show ${forge}'s head`, show: "forge" }
          }
        : {
            tone: "warn",
            text: `Showing ${forge}'s head, ${short(head.oid)}. Yours is ${plural(relation.count, "commit")} ahead.`,
            toggle: { label: "Show yours", show: "local" }
          };
    case "behind":
      return shown === "forge"
        ? {
            tone: "warn",
            text: `Showing ${forge}'s head, ${short(head.oid)}. ${
              view.local === null ? "Yours" : holderPhrase(view.local)
            } is ${plural(relation.count, "commit")} behind.`,
            toggle: { label: "Show yours", show: "local" }
          }
        : {
            tone: "warn",
            text: `${where}: ${plural(relation.count, "commit")} behind what ${forge} shows.`,
            toggle: { label: `Show ${forge}'s head`, show: "forge" }
          };
    case "diverged":
      return {
        tone: "warn",
        text: `${shown === "local" ? where : `Showing ${forge}'s head, ${short(head.oid)}`}. Yours and ${forge}'s have diverged: ${relation.ahead} ahead, ${relation.behind} behind.`,
        toggle:
          shown === "local"
            ? { label: `Show ${forge}'s head`, show: "forge" }
            : { label: "Show yours", show: "local" }
      };
    case "unknown": {
      const forgeOid = view.entry.pr.headOid;
      if (view.local !== null && forgeOid !== undefined && forgeOid !== head.oid) {
        return {
          tone: "warn",
          text: `${where}. ${forge} shows ${short(forgeOid)}, which is not fetched here.`,
          toggle: { label: `Fetch ${forge}'s head`, show: "forge" }
        };
      }
      return { tone: "ok", text: `${where}.` };
    }
  }
}

/** What the header's primary verb does, from where the head is now. */
export function primaryVerb(
  entry: ChangeRequestEntry
): { kind: "goto"; worktreeId: string } | { kind: "create" } | null {
  const { location } = entry;
  switch (location.kind) {
    case "worktree":
      return { kind: "goto", worktreeId: location.worktreeId };
    case "local":
    case "remote":
    case "unfetched":
      return { kind: "create" };
    case "fork":
      return location.fetchable ? { kind: "create" } : null;
    case "missing":
      return null;
  }
}
