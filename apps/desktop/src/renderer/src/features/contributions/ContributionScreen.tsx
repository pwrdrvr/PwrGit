import { useEffect, useMemo, useRef, useState } from "react";
import {
  aggregateAuthorFlow,
  aggregateContributions,
  contributionCsv,
  contributionRows,
  contributionWindow,
  defaultContributionDates,
  CONTRIBUTION_CAPABILITIES,
  localContributionDate,
  type ContributionIdentity,
  type ContributionMetric,
  type ContributionOptions,
  type ContributionSnapshot,
  type ForgeHostRow
} from "@pwrgit/shared";
import { dispatchOrThrow } from "../../lib/pwrgit";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { downloadFile } from "./download";
import { ShareImageDialog } from "./ShareImageDialog";
import "./contributions.css";

const metricLabels: Record<ContributionMetric, string> = {
  merged: "PRs merged by me",
  authored: "My PRs that were merged",
  overlap: "Authored and merged by me",
  created: "PRs created by me"
};
const color = (index: number) => `var(--lane-${(index % 8) + 1})`;
export function ContributionChart({
  data,
  label,
  onBucket
}: {
  data: ReturnType<typeof aggregateContributions>;
  label: string;
  onBucket: (date: string) => void;
}) {
  const width = 1100,
    height = 270,
    left = 42,
    baseline = 225,
    plot = width - left - 16;
  const max = Math.max(1, ...data.buckets.map((b) => b.total));
  const step = plot / data.buckets.length;
  return (
    <svg
      className="contributions__chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}. ${data.total} pull requests. Exact values in the data table below.`}
    >
      <title>{label}</title>
      <text x={left} y={17} fill="var(--text-primary)" fontSize="13">
        {label}
      </text>
      {[0, 0.5, 1].map((fraction) => (
        <g key={fraction}>
          <line
            x1={left}
            x2={width - 16}
            y1={baseline - fraction * 190}
            y2={baseline - fraction * 190}
            stroke="var(--border-subtle)"
          />
          <text
            x={left - 8}
            y={baseline - fraction * 190 + 4}
            textAnchor="end"
            fill="var(--text-secondary)"
            fontSize="12"
          >
            {Math.round(max * fraction)}
          </text>
        </g>
      ))}
      {data.buckets.map((bucket, index) => {
        let accumulated = 0;
        return (
          <g key={bucket.date}>
            {data.series.map((series, seriesIndex) => {
              const value = bucket.values[series.key] ?? 0,
                barHeight = (value / max) * 190;
              const y = baseline - ((accumulated + value) / max) * 190;
              accumulated += value;
              return value ? (
                <rect
                  key={series.key}
                  x={left + index * step + 1}
                  y={y}
                  width={Math.max(1, step - 2)}
                  height={barHeight}
                  fill={color(seriesIndex)}
                  onClick={() => onBucket(bucket.date)}
                >
                  <title>
                    {bucket.date}: {series.label}, {value} PRs
                  </title>
                </rect>
              ) : null;
            })}
            {index % Math.max(1, Math.ceil(data.buckets.length / 8)) === 0 && (
              <text
                x={left + index * step}
                y={247}
                fill="var(--text-secondary)"
                fontSize="12"
              >
                {bucket.date.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function AuthorFlowChart({
  flow
}: {
  flow: ReturnType<typeof aggregateAuthorFlow>;
}) {
  let creates = 0,
    merges = 0;
  const points = flow.days.map((day) => {
    creates += day.created;
    merges += day.merged;
    return { created: creates, merged: merges };
  });
  const max = Math.max(1, creates, merges),
    baseline = 190,
    left = 40,
    width = 1060;
  const path = (field: "created" | "merged") =>
    points
      .map(
        (point, index) =>
          `${index ? "L" : "M"}${left + (index / Math.max(1, points.length - 1)) * (width - left - 20)},${baseline - (point[field] / max) * 165}`
      )
      .join(" ");
  return (
    <>
      <svg
        className="contributions__chart"
        viewBox={`0 0 ${width} 220`}
        role="img"
        aria-label={`Cumulative author flow: ${flow.created} PRs created, ${flow.merged} authored PRs merged by anyone. Exact daily values in author flow table.`}
      >
        <title>
          Cumulative created and authored-merged PR flows; their gap is not open
          backlog
        </title>
        <line
          x1={left}
          x2={width - 20}
          y1={baseline}
          y2={baseline}
          stroke="var(--border-subtle)"
        />
        <text x={4} y={baseline} fill="var(--text-secondary)" fontSize="12">
          0
        </text>
        <text x={4} y={25} fill="var(--text-secondary)" fontSize="12">
          {max}
        </text>
        <path
          d={path("created")}
          fill="none"
          stroke="var(--lane-1)"
          strokeWidth="2.5"
        />
        <path
          d={path("merged")}
          fill="none"
          stroke="var(--lane-2)"
          strokeWidth="2.5"
          strokeDasharray="6 4"
        />
        <text x={left} y={212} fill="var(--text-secondary)" fontSize="12">
          {flow.days[0]?.date}
        </text>
        <text
          x={width - 20}
          y={212}
          textAnchor="end"
          fill="var(--text-secondary)"
          fontSize="12"
        >
          {flow.days.at(-1)?.date}
        </text>
      </svg>
      <ul className="contributions__legend">
        <li>
          <span style={{ background: "var(--lane-1)" }} />
          Created in range · solid line
        </li>
        <li>
          <span style={{ background: "var(--lane-2)" }} />
          Authored PRs merged in range · dashed line
        </li>
      </ul>
    </>
  );
}

export function ContributionScreen({
  profileId,
  onClose
}: {
  profileId: string;
  onClose: () => void;
}) {
  const [hosts, setHosts] = useState<ForgeHostRow[]>([]);
  const [host, setHost] = useState("");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [dates, setDates] = useState(() =>
    defaultContributionDates(Intl.DateTimeFormat().resolvedOptions().timeZone)
  );
  const [identity, setIdentity] = useState<ContributionIdentity | null>(null);
  const [snapshot, setSnapshot] = useState<ContributionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [options, setOptions] = useState<ContributionOptions>({
    metric: "merged",
    group: "org",
    interval: "day",
    topN: 6
  });
  const [drillDate, setDrillDate] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [sharing, setSharing] = useState(false);
  const generation = useRef(0);
  const scope = useMemo(
    () =>
      identity
        ? {
            profileId,
            host: identity.host,
            viewerId: identity.id,
            ...dates,
            timezone
          }
        : null,
    [profileId, identity, dates, timezone]
  );
  let windowError: string | null = null;
  try {
    contributionWindow(dates.startDate, dates.endDate, timezone);
  } catch (cause) {
    windowError =
      cause instanceof Error
        ? cause.message
        : "Choose a valid range and timezone.";
  }
  const collecting = snapshot?.status === "collecting";
  const busy = working || collecting;
  const current =
    snapshot &&
    snapshot.window.startDate === dates.startDate &&
    snapshot.window.endDate === dates.endDate &&
    snapshot.window.timezone === timezone
      ? snapshot
      : null;
  const data = useMemo(
    () =>
      current
        ? aggregateContributions(
            current.records,
            current.identity.id,
            current.window,
            options
          )
        : null,
    [current, options]
  );
  const rows = useMemo(
    () =>
      current
        ? contributionRows(
            current.records,
            current.identity.id,
            current.window,
            options
          )
        : [],
    [current, options]
  );
  const orgTotals = useMemo(
    () =>
      current
        ? aggregateContributions(
            current.records,
            current.identity.id,
            current.window,
            { ...options, group: "org" }
          ).totals
        : [],
    [current, options]
  );
  const repoTotals = useMemo(
    () =>
      current
        ? aggregateContributions(
            current.records,
            current.identity.id,
            current.window,
            { ...options, group: "repo" }
          ).totals
        : [],
    [current, options]
  );
  const flow = useMemo(
    () =>
      current
        ? aggregateAuthorFlow(
            current.records,
            current.identity.id,
            current.window,
            options
          )
        : null,
    [current, options]
  );
  useEffect(() => {
    heading.current?.focus();
    let alive = true;
    void dispatchOrThrow("forge:hosts", {})
      .then((result) => {
        if (!alive) return;
        const available = result.hosts.filter(
          (row) => row.enabled && CONTRIBUTION_CAPABILITIES[row.kind]
        );
        setHosts(available);
        setHost(available[0]?.host ?? "");
      })
      .catch((cause) => {
        if (alive) setError(String(cause.message ?? cause));
      });
    return () => {
      alive = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (!scope || windowError) return;
    const token = ++generation.current;
    const read = async () => {
      try {
        const value = await dispatchOrThrow("contribution:read", scope);
        if (token !== generation.current) return;
        setSnapshot(value);
      } catch (cause) {
        if (token === generation.current)
          setError(
            cause instanceof Error ? cause.message : "Could not read analytics."
          );
      }
    };
    void read();
    return () => {
      generation.current++;
    };
  }, [scope, windowError]);
  // Poll only local checkpoints. No network request occurs on chart/filter renders.
  useEffect(() => {
    if (!collecting || !scope) return;
    let alive = true;
    const timer = setInterval(() => {
      void dispatchOrThrow("contribution:read", scope)
        .then((value) => {
          if (alive) setSnapshot(value);
        })
        .catch((cause) => {
          if (alive) setError(cause.message);
        });
    }, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [collecting, scope]);
  const action = async (run: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await run();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Analytics request failed."
      );
    } finally {
      setWorking(false);
    }
  };
  const verify = () =>
    void action(async () => {
      const result = await dispatchOrThrow("contribution:verify", {
        profileId,
        host,
        ...dates,
        timezone
      });
      setIdentity(result.identity);
      setSnapshot(result.snapshot);
    });
  // Ask the CLI who is signed in as soon as there is a host: one identity
  // read, no PR metadata. It is what puts a cached chart on screen at once,
  // and a screen that waits for a click to say anything reads as broken.
  // Once per host, so a failure or "Reconnect account" does not loop.
  const autoVerified = useRef(new Set<string>());
  useEffect(() => {
    if (!host || identity || windowError || autoVerified.current.has(host))
      return;
    autoVerified.current.add(host);
    verify();
    // verify reads the current dates and timezone; host is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, identity, windowError]);
  const sync = (refresh: boolean) =>
    void action(async () => {
      if (!scope || windowError || collecting) return;
      setSnapshot(
        await dispatchOrThrow("contribution:sync", { ...scope, refresh })
      );
    });
  const selectedLabel = metricLabels[options.metric ?? "merged"];
  const chartLabel = `${selectedLabel}, ${dates.startDate} through ${dates.endDate}, ${timezone}${current?.status !== "complete" && current ? " · incomplete" : ""}${current?.window.partialDay ? " · today partial" : ""}`;
  const setFilter = (field: "ownerId" | "repoId", value: string) => {
    setOptions((previous) => {
      const next = { ...previous };
      if (value) next[field] = value;
      else delete next[field];
      if (field === "ownerId") delete next.repoId;
      return next;
    });
    setDrillDate(null);
  };
  const exportData = (format: "csv" | "json") => {
    if (!current || !data) return;
    const report = {
      identity: current.identity,
      window: current.window,
      coverage: {
        status: current.status,
        inventoryComplete: current.inventoryComplete,
        authoredInventory: current.authoredInventory,
        mergerScope:
          "Affiliated repositories plus own PRs in external projects; other-author external mergers unverified",
        reposCovered: current.repoIndex,
        reposDiscovered: current.repos.length,
        issues: current.issues,
        refreshedAt: current.refreshedAt,
        attribution:
          "Current owner; direct affiliated and lifetime authored inventories"
      },
      options,
      totals: data.totals,
      days: data.days,
      buckets: data.buckets,
      authorFlow: flow,
      records: rows
    };
    if (format === "json")
      downloadFile(
        "pwrgit-contributions.json",
        JSON.stringify(report, null, 2),
        "application/json"
      );
    else
      downloadFile(
        "pwrgit-contributions.csv",
        contributionCsv(
          [
            "date",
            "timezone",
            "metric",
            "coverage",
            "total",
            ...data.series.map((s) => s.label)
          ],
          data.buckets.map((bucket) => [
            bucket.date,
            timezone,
            selectedLabel,
            current.status,
            bucket.total,
            ...data.series.map((series) => bucket.values[series.key] ?? 0)
          ])
        ),
        "text/csv;charset=utf-8"
      );
  };
  const drillRows =
    drillDate && current
      ? rows.filter((row) => {
          const day = localContributionDate(
            new Date(
              options.metric === "created"
                ? row.lifecycle!.createdAt
                : row.mergedAt!
            ),
            timezone
          );
          const bucket = data?.buckets.find((item) => item.date === drillDate);
          if (!bucket) return false;
          if (options.interval === "month") return day.startsWith(drillDate);
          if (options.interval === "week")
            return (
              day >= drillDate &&
              day <
                new Date(Date.parse(`${drillDate}T12:00:00Z`) + 7 * 86_400_000)
                  .toISOString()
                  .slice(0, 10)
            );
          return day === drillDate;
        })
      : [];
  return (
    <main
      className="contributions selectable"
      aria-labelledby="contributions-heading"
      onKeyDown={(event) => {
        // A dialog over the screen claims its Escape with preventDefault.
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="contributions__header">
        <div>
          <span className="contributions__eyebrow">Activity</span>
          <h1 id="contributions-heading" tabIndex={-1} ref={heading}>
            Contributions
          </h1>
          <p>Merge activity across your connected GitHub repositories.</p>
        </div>
        <button type="button" onClick={onClose}>
          Back to repositories
        </button>
      </header>
      <section
        className="contributions__controls"
        aria-label="Account and collection range"
      >
        <label>
          Forge host
          <select
            value={host}
            disabled={busy}
            onChange={(event) => {
              setHost(event.target.value);
              setIdentity(null);
              setSnapshot(null);
            }}
          >
            {!hosts.length && <option value="">No enabled GitHub hosts</option>}
            {hosts.map((row) => (
              <option key={row.host} value={row.host}>
                {row.label ?? row.host}
                {row.account ? ` (${row.account})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            value={dates.startDate}
            disabled={busy}
            onChange={(event) =>
              setDates({ ...dates, startDate: event.target.value })
            }
          />
        </label>
        <label>
          Through
          <input
            type="date"
            value={dates.endDate}
            disabled={busy}
            onChange={(event) =>
              setDates({ ...dates, endDate: event.target.value })
            }
          />
        </label>
        <label>
          Timezone
          <input
            value={timezone}
            disabled={busy}
            list="contribution-timezones"
            onChange={(event) => setTimezone(event.target.value)}
          />
          <datalist id="contribution-timezones">
            {[
              ...new Set([
                Intl.DateTimeFormat().resolvedOptions().timeZone,
                "UTC",
                "America/New_York",
                "Europe/London",
                "Asia/Tokyo"
              ])
            ].map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </label>
        <button
          type="button"
          aria-disabled={busy || !!windowError}
          onClick={() => {
            if (!busy && !windowError)
              setDates(defaultContributionDates(timezone));
          }}
        >
          Last six months
        </button>
        <button
          type="button"
          aria-disabled={busy || !!windowError}
          onClick={() => {
            if (busy || windowError) return;
            const today = localContributionDate(new Date(), timezone),
              year =
                Number(today.slice(0, 4)) -
                (Number(today.slice(5, 7)) < 8 ? 1 : 0);
            setDates({ startDate: `${year}-08-01`, endDate: today });
          }}
        >
          Since August 1
        </button>
        {!identity ? (
          <button
            type="button"
            className="contributions__primary"
            disabled={!host || !!windowError}
            aria-busy={working}
            aria-disabled={working}
            onClick={verify}
          >
            {working ? "Checking account…" : "Use active account"}
          </button>
        ) : (
          <button
            type="button"
            className="contributions__primary"
            disabled={!!windowError}
            aria-busy={busy}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) sync(current?.status === "complete");
            }}
          >
            <RefreshGlyph />
            {collecting
              ? "Collecting"
              : current && current.status !== "complete"
                ? "Resume collection"
                : current
                  ? "Refresh"
                  : "Collect activity"}
          </button>
        )}
        {collecting && scope && (
          <button
            type="button"
            aria-disabled={working}
            onClick={() =>
              void action(async () => {
                await dispatchOrThrow("contribution:cancel", scope);
                setSnapshot(await dispatchOrThrow("contribution:read", scope));
              })
            }
          >
            Cancel collection
          </button>
        )}
        {current && current.status !== "complete" && !busy && (
          <button type="button" onClick={() => sync(true)}>
            Restart discovery
          </button>
        )}
      </section>
      {(error || windowError) && (
        <p role="alert" className="contributions__error">
          {error ?? windowError}
        </p>
      )}
      {!hosts.length && (
        <p className="contributions__notice">
          Enable a signed-in GitHub host in Settings → Forges. GitLab and
          GitCafe analytics are not available yet.
        </p>
      )}
      {identity && (
        <p className="contributions__identity">
          Verified account <strong>{identity.login}</strong> on {identity.host}{" "}
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) {
                setIdentity(null);
                setSnapshot(null);
              }
            }}
          >
            Reconnect account
          </button>
        </p>
      )}
      {current && (
        <section
          className="contributions__coverage"
          aria-label="Collection coverage"
        >
          <p role="status">
            <strong>
              {current.status === "complete"
                ? "Finished for visible inventory"
                : current.status === "collecting"
                  ? "Collection in progress"
                  : `Incomplete · ${current.status}`}
            </strong>{" "}
            · {current.repoIndex} of {current.repos.length} repositories covered
            · inventory {current.inventoryReceived}/
            {current.inventoryExpected ?? "unknown"} · {current.pages} pages ·{" "}
            {current.organizations.length} visible organization memberships
            {!current.inventoryComplete
              ? " · repository discovery incomplete"
              : ""}
          </p>
          <p>
            {current.window.startDate} through {current.window.endDate} ·{" "}
            {current.window.timezone} · UTC [{current.window.start},{" "}
            {current.window.end})
          </p>
          {current.window.partialDay && (
            <p>
              <strong>Today is partial.</strong> Frozen as of{" "}
              {current.window.end}. Complete-day averages exclude today;
              inclusive averages count it as one calendar date.
            </p>
          )}
          <p>
            {
              current.repos.filter(
                (repo) => repo.source === "authored_inventory"
              ).length
            }{" "}
            external authored repositories · direct authored inventory{" "}
            {current.authoredInventory.received}/
            {current.authoredInventory.expected ?? "unknown"}
            {current.authoredInventory.complete
              ? " verified"
              : " incomplete"} ·{" "}
            {current.records.filter((row) => row.lifecycle?.complete).length}/
            {current.records.filter((row) => row.lifecycle).length} authored
            lifecycle histories read
          </p>
          <p>
            {current.refreshedAt
              ? `Refreshed ${new Date(current.refreshedAt).toLocaleString()} · `
              : ""}
            Snapshot started {new Date(current.startedAt).toLocaleString()}
            {current.retryAt ? ` · Resume after ${current.retryAt}` : ""}
          </p>
          {current.status !== "complete" && (
            <p>
              All counts below are observed so far. Unread or inaccessible
              repositories are unknown, never zero.
            </p>
          )}
          {current.issues.map((issue, i) => (
            <p key={i} className="contributions__error">
              {issue.message}
            </p>
          ))}
        </section>
      )}
      {!current && (
        <section className="contributions__empty">
          <h2>Your merge activity, kept locally</h2>
          {identity ? (
            <>
              <p>
                Nothing collected yet for {dates.startDate} – {dates.endDate}.
                Collecting reads PR metadata from {identity.host} as{" "}
                <strong>{identity.login}</strong>. A busy account takes a few
                minutes; the chart fills in as it goes, and you can keep
                working.
              </p>
              <button
                type="button"
                className="contributions__primary"
                aria-busy={busy}
                aria-disabled={busy}
                onClick={() => {
                  if (!busy) sync(false);
                }}
              >
                <RefreshGlyph />
                Collect my activity
              </button>
            </>
          ) : (
            <p>
              {working
                ? "Checking which account the GitHub CLI is signed in to…"
                : "Choose a signed-in forge account above. Collection starts only when you ask."}
            </p>
          )}
          <p>
            No PR titles or bodies are collected. Cached metadata stays in this
            profile for up to 30 days.
          </p>
        </section>
      )}
      {current && data && (
        <>
          <section
            className="contributions__filters"
            aria-label="Chart filters"
          >
            <label>
              Measure
              <select
                value={options.metric}
                onChange={(event) => {
                  setOptions({
                    ...options,
                    metric: event.target.value as ContributionMetric
                  });
                  setDrillDate(null);
                }}
              >
                {Object.entries(metricLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Interval
              <select
                value={options.interval}
                onChange={(event) => {
                  setOptions({
                    ...options,
                    interval: event.target.value as "day" | "week" | "month"
                  });
                  setDrillDate(null);
                }}
              >
                <option value="day">Daily</option>
                <option value="week">Weekly (Monday)</option>
                <option value="month">Monthly</option>
              </select>
            </label>
            <label>
              Stack by
              <select
                value={options.group}
                onChange={(event) =>
                  setOptions({
                    ...options,
                    group: event.target.value as "org" | "repo"
                  })
                }
              >
                <option value="org">Organization / personal namespace</option>
                <option value="repo">Repository</option>
              </select>
            </label>
            <label>
              Top series
              <select
                value={options.topN}
                onChange={(event) =>
                  setOptions({ ...options, topN: Number(event.target.value) })
                }
              >
                {[3, 6, 10].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <label>
              Namespace
              <select
                value={options.ownerId ?? ""}
                onChange={(event) => setFilter("ownerId", event.target.value)}
              >
                <option value="">All namespaces</option>
                {[
                  ...new Map(
                    current.repos.map((repo) => [repo.ownerId, repo])
                  ).values()
                ]
                  .sort((a, b) => a.owner.localeCompare(b.owner))
                  .map((repo) => (
                    <option key={repo.ownerId} value={repo.ownerId}>
                      {repo.ownerKind === "user" ? "Personal" : "Org"}:{" "}
                      {repo.owner}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Repository
              <select
                value={options.repoId ?? ""}
                onChange={(event) => setFilter("repoId", event.target.value)}
              >
                <option value="">All repositories</option>
                {current.repos
                  .filter(
                    (repo) =>
                      !options.ownerId || repo.ownerId === options.ownerId
                  )
                  .map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.path}
                    </option>
                  ))}
              </select>
            </label>
          </section>
          <section
            className="contributions__stats"
            aria-label="Activity statistics"
          >
            <div>
              <span>{selectedLabel}</span>
              <strong>{data.total.toLocaleString()}</strong>
              <small>
                {current.status === "complete"
                  ? "Observed in visible inventory"
                  : "Partial count"}
              </small>
            </div>
            <div>
              <span>Per complete day</span>
              <strong>{data.perCompleteDay.toFixed(2)}</strong>
              <small>
                {data.completeTotal} PRs / {data.completeDays} complete days
              </small>
            </div>
            <div>
              <span>Per calendar date</span>
              <strong>{data.perCalendarDay.toFixed(2)}</strong>
              <small>
                {data.calendarDays} dates
                {current.window.partialDay
                  ? ", including partial today"
                  : ", including zero days"}
              </small>
            </div>
            <div>
              <span>Per active day</span>
              <strong>{data.perActiveDay.toFixed(2)}</strong>
              <small>{data.activeDays} active days</small>
            </div>
            <div>
              <span>Busiest day</span>
              <strong>{data.busiest.total}</strong>
              <small>
                {data.total ? data.busiest.date : "No observed activity"}
              </small>
            </div>
          </section>
          <section
            className="contributions__plot"
            aria-labelledby="contributions-chart-heading"
          >
            <div className="contributions__plot-header">
              <div>
                <h2 id="contributions-chart-heading">{selectedLabel}</h2>
                <p>
                  {dates.startDate} — {dates.endDate} · {timezone} ·{" "}
                  {options.interval === "week"
                    ? "Edge weeks include only selected days"
                    : options.interval === "month"
                      ? "Edge months include only selected days"
                      : "Every calendar day"}
                </p>
              </div>
              <div className="contributions__exports">
                <button type="button" onClick={() => exportData("csv")}>
                  Export CSV
                </button>
                <button type="button" onClick={() => exportData("json")}>
                  Export JSON
                </button>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  onClick={() => setSharing(true)}
                >
                  Share image…
                </button>
              </div>
            </div>
            {!data.total && (
              <p>
                No matching PRs observed
                {current.status === "complete"
                  ? " in the visible inventory"
                  : " so far"}
                .
              </p>
            )}
            <ContributionChart
              data={data}
              label={chartLabel}
              onBucket={setDrillDate}
            />
            <ul className="contributions__legend" aria-label="Stacked series">
              {data.series.map((series, i) => (
                <li key={series.key}>
                  <span style={{ background: color(i) }} />
                  <span>{series.label}</span>
                  <strong>{series.total}</strong>
                </li>
              ))}
            </ul>
            <details>
              <summary>
                Data table · {data.buckets.length}{" "}
                {options.interval === "day" ? "days" : "periods"}
              </summary>
              <div className="contributions__table-scroll">
                <table>
                  <caption>
                    {selectedLabel} by {options.interval}; exact chart values
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Period starting</th>
                      <th scope="col">Total</th>
                      {data.series.map((series) => (
                        <th scope="col" key={series.key}>
                          {series.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.buckets.map((bucket) => (
                      <tr key={bucket.date}>
                        <th scope="row">
                          <button
                            type="button"
                            onClick={() => setDrillDate(bucket.date)}
                          >
                            {bucket.date}
                          </button>
                        </th>
                        <td>{bucket.total}</td>
                        {data.series.map((series) => (
                          <td key={series.key}>
                            {bucket.values[series.key] ?? 0}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>
          {drillDate && (
            <section className="contributions__plot">
              <h2>PRs in period starting {drillDate}</h2>
              <button type="button" onClick={() => setDrillDate(null)}>
                Close PR details
              </button>
              <div className="contributions__table-scroll">
                <table>
                  <caption>{drillRows.length} matching pull requests</caption>
                  <thead>
                    <tr>
                      <th scope="col">Repository</th>
                      <th scope="col">PR</th>
                      <th scope="col">
                        {options.metric === "created" ? "Created" : "Merged"} at
                        (UTC)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillRows.map((row) => (
                      <tr key={`${row.repo.id}:${row.id}`}>
                        <td>{row.repo.path}</td>
                        <td>#{row.number}</td>
                        <td>
                          {options.metric === "created"
                            ? row.lifecycle?.createdAt
                            : row.mergedAt}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {flow && (
            <section
              className="contributions__plot"
              aria-labelledby="contributions-flow-heading"
            >
              <h2 id="contributions-flow-heading">
                My authored PRs · creation, merge and backlog
              </h2>
              <p>
                Same author population and selected namespace/repository
                filters. PRs merged by other actors count here. The
                creation-minus-merge gap is a flow comparison, not open backlog.
              </p>
              {current.status !== "complete" || !flow.complete ? (
                <p>
                  Lifecycle collection is incomplete. Historical backlog and
                  cohort statistics are unavailable until all known repositories
                  and lifecycle histories are read.
                </p>
              ) : (
                <>
                  <div className="contributions__stats">
                    <div>
                      <span>Created in range</span>
                      <strong>{flow.created}</strong>
                      <small>{flow.merged} authored PRs merged in range</small>
                    </div>
                    <div>
                      <span>Open backlog</span>
                      <strong>
                        {flow.baseline} → {flow.ending}
                      </strong>
                      <small>At selected start → pinned cutoff</small>
                    </div>
                    <div>
                      <span>Total not yet merged</span>
                      <strong>{flow.unmergedEnding}</strong>
                      <small>
                        Lifetime visible authored stock; {flow.closedEnding}{" "}
                        closed unmerged
                      </small>
                    </div>
                    <div>
                      <span>Creation cohort not merged</span>
                      <strong>{flow.cohortNotMerged}</strong>
                      <small>
                        Created in range; {flow.cohortClosed} closed unmerged
                      </small>
                    </div>
                    <div>
                      <span>Cohort merged by cutoff</span>
                      <strong>{flow.cohortMergePercentage.toFixed(1)}%</strong>
                      <small>
                        {flow.cohortMerged} / {flow.cohortCreated} created in
                        range
                      </small>
                    </div>
                    <div>
                      <span>Lifecycle transitions</span>
                      <strong>
                        {flow.closedUnmerged} / {flow.reopened}
                      </strong>
                      <small>Closed unmerged / reopened in range</small>
                    </div>
                  </div>
                  <p>
                    Recent creation cohorts have had less time to merge. Compare
                    cohorts of similar age when interpreting changes in merge
                    percentage.
                  </p>
                  <AuthorFlowChart flow={flow} />
                  <button
                    type="button"
                    onClick={() =>
                      downloadFile(
                        "pwrgit-author-flow.csv",
                        contributionCsv(
                          [
                            "date",
                            "timezone",
                            "coverage",
                            "created",
                            "authored_merged",
                            "closed_unmerged",
                            "reopened",
                            "open_at_day_cutoff"
                          ],
                          flow.days.map((day) => [
                            day.date,
                            timezone,
                            current.status,
                            day.created,
                            day.merged,
                            day.closedUnmerged,
                            day.reopened,
                            day.open
                          ])
                        ),
                        "text/csv;charset=utf-8"
                      )
                    }
                  >
                    Export author flow CSV
                  </button>
                  <details>
                    <summary>
                      Author flow table · daily open stock and transitions
                    </summary>
                    <div className="contributions__table-scroll">
                      <table>
                        <caption>
                          Authored PR activity; today’s stock uses the pinned
                          partial-day cutoff when applicable
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Date</th>
                            <th scope="col">Created</th>
                            <th scope="col">Merged by anyone</th>
                            <th scope="col">Closed unmerged</th>
                            <th scope="col">Reopened</th>
                            <th scope="col">Open at cutoff</th>
                          </tr>
                        </thead>
                        <tbody>
                          {flow.days.map((day) => (
                            <tr key={day.date}>
                              <th scope="row">{day.date}</th>
                              <td>{day.created}</td>
                              <td>{day.merged}</td>
                              <td>{day.closedUnmerged}</td>
                              <td>{day.reopened}</td>
                              <td>{day.open}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </>
              )}
            </section>
          )}
          <div className="contributions__totals">
            {[
              {
                label: "By namespace",
                rows: orgTotals,
                field: "ownerId" as const
              },
              {
                label: "By repository",
                rows: repoTotals,
                field: "repoId" as const
              }
            ].map((group) => (
              <section key={group.label}>
                <h2>{group.label}</h2>
                <table>
                  <caption>
                    {selectedLabel} · {group.label.toLowerCase()}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">PRs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row) => (
                      <tr key={row.key}>
                        <th scope="row">
                          <button
                            type="button"
                            onClick={() => setFilter(group.field, row.key)}
                          >
                            {row.label}
                          </button>
                        </th>
                        <td>{row.total}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <td>{data.total}</td>
                    </tr>
                  </tfoot>
                </table>
              </section>
            ))}
          </div>
        </>
      )}
      <footer className="contributions__notice">
        <p>
          Authored activity uses the complete visible lifetime
          viewer.pullRequests inventory, with every author ID verified, covering
          personal namespaces and external organization projects. Merger
          activity traverses visible affiliated repositories, including forks
          and archived repositories, and includes your own externally authored
          PRs merged by you. Other-author merges in external projects are
          unverified. SSO, token scope, fine-grained permissions and lost access
          can hide history. Visible organization memberships do not prove access
          to every repository.
        </p>
        <p>
          Counts use the API’s actual merge actor and merge timestamp. Bots,
          auto-merge and merge queues reflect the actor GitHub reports; these
          counts do not imply a manual click. Namespaces use the repository’s
          current owner, which may differ after a transfer. Historical stocks
          use lifecycle events or a provably unchanged state before the selected
          start. Lifetime visible not-yet-merged stock includes terminal closed
          PRs; the creation cohort is reported separately.
        </p>
        <p>
          Metadata cache: four recent ranges/accounts per profile, 30-day
          retention, 10,000 repositories, 20,000 authored/matching PRs, and
          50,000 lifecycle events per range. Collection checkpoints each page;
          resume keeps the original UTC cutoff. Refresh replaces the selected
          snapshot. Collection continues if you return to repositories.
        </p>
        {scope && (
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy)
                void action(async () => {
                  await dispatchOrThrow("contribution:clear", scope);
                  setSnapshot(null);
                });
            }}
          >
            Clear this account’s local analytics cache
          </button>
        )}
      </footer>
      {sharing && current && (
        <ShareImageDialog
          profileId={profileId}
          snapshot={current}
          options={options}
          onClose={() => setSharing(false)}
        />
      )}
    </main>
  );
}
