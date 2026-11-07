import type { ReactNode } from "react";
import type { TagSourceState, TagStatusCounts, TagStatusFilter } from "@pwrgit/shared";

/** "4 min ago" — the strip states the snapshot's real age, never "up to date". */
export function checkedAgo(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * Which remote's tags count as published, how old PwrGit's view of them is,
 * and a way to look again. Every state says what PwrGit will and won't do.
 * Design: design/Published Tags - UX Review.dc.html, 2a and 2b.
 */
export function TagSourceStrip({
  source,
  checking,
  now,
  onRefresh,
  onChoose
}: {
  source: TagSourceState;
  checking: boolean;
  now: number;
  onRefresh: () => void;
  onChoose: (remote: string) => void;
}) {
  const { primary, remotes } = source;
  if (remotes.length === 0) {
    return (
      <div className="refs-tag-source" role="status">
        <span className="refs-tag-source__meta">
          This repository has no remotes, so every tag here is local.
        </span>
      </div>
    );
  }
  const chooser = (
    <select
      className="refs-tag-source__select"
      aria-label="Remote that publishes this repository's tags"
      value={primary ?? ""}
      disabled={checking}
      onChange={(event) => {
        if (event.target.value !== "") onChoose(event.target.value);
      }}
    >
      {primary === null && <option value="">Choose a remote</option>}
      {remotes.map((remote) => (
        <option key={remote} value={remote}>
          {remote}
        </option>
      ))}
    </select>
  );
  if (primary === null) {
    return (
      <div className="refs-tag-source refs-tag-source--warn">
        <span className="refs-tag-source__label">
          Which remote publishes this repository&rsquo;s tags?
        </span>
        {chooser}
        <span className="refs-tag-source__grow" />
        <span className="refs-tag-source__meta">
          Tags below are local only until you choose.
        </span>
      </div>
    );
  }
  const age = source.checkedAt === null ? null : checkedAgo(source.checkedAt, now);
  const optedOut = source.tagOpt === "no-tags";
  let meta: ReactNode;
  if (checking) {
    meta = (
      <>
        <span className="refs-tag-source__spin" aria-hidden="true" />
        <span className="refs-tag-source__meta">Checking {primary}&rsquo;s tags&hellip;</span>
      </>
    );
  } else if (source.error !== null) {
    meta = (
      <span className="refs-tag-source__meta refs-tag-source__meta--error">
        Couldn&rsquo;t reach {primary}.{" "}
        {age === null ? "Its tags have not been checked." : `Showing the check from ${age}.`}
      </span>
    );
  } else if (optedOut) {
    meta = (
      <span className="refs-tag-source__meta">
        {primary} is set to skip tags (<b>tagOpt --no-tags</b>), so PwrGit never checks it on its own.
        {age === null ? "" : ` Last checked ${age}.`}
      </span>
    );
  } else {
    meta = (
      <span className="refs-tag-source__meta">
        {age === null ? (
          "Not checked yet"
        ) : (
          <>
            checked <b>{age}</b> &middot; {source.publishedCount.toLocaleString()} on {primary}
          </>
        )}
      </span>
    );
  }
  const label = source.error !== null ? "Retry" : optedOut ? "Check once" : "Refresh";
  return (
    <div
      className={`refs-tag-source${optedOut && !checking ? " refs-tag-source--warn" : ""}`}
      aria-busy={checking}
    >
      <span className="refs-tag-source__label">Published tags from</span>
      {chooser}
      {meta}
      <span className="refs-tag-source__grow" />
      <button
        className="refs-row-action refs-row-action--quiet refs-tag-source__refresh"
        aria-disabled={checking}
        aria-label={checking ? `${label} — unavailable, already checking ${primary}` : `${label} ${primary}'s tags`}
        onClick={() => {
          if (!checking) onRefresh();
        }}
      >
        {label}
      </button>
    </div>
  );
}

/** Filter chips. Only meaningful once the publisher has been listed. */
export function TagStatusFilters({
  counts,
  primary,
  filter,
  onFilter
}: {
  counts: TagStatusCounts;
  primary: string;
  filter: TagStatusFilter;
  onFilter: (filter: TagStatusFilter) => void;
}) {
  const chips: { value: TagStatusFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: counts.all },
    { value: "differs", label: "Differ", count: counts.differs },
    { value: "remoteOnly", label: `Only on ${primary}`, count: counts.remoteOnly },
    { value: "localOnly", label: "Only local", count: counts.localOnly }
  ];
  return (
    <div className="refs-tag-filters" role="group" aria-label="Tag status">
      {chips.map((chip) => (
        <button
          key={chip.value}
          className={[
            "refs-tag-filter",
            filter === chip.value ? "is-active" : "",
            chip.value === "differs" && chip.count > 0 ? "needs-attention" : ""
          ]
            .filter(Boolean)
            .join(" ")}
          aria-pressed={filter === chip.value}
          onClick={() => onFilter(chip.value)}
        >
          {chip.label} <span>{chip.count.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}
