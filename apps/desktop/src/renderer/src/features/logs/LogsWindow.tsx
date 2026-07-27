import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from "react";
import type { LogEntry } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

// Logs window — ported from PwrAgnt's LogsWindow and adapted to PwrGit's
// command bus. Everything is buffered main-side; level filtering is purely a
// view concern here (no debug-collection toggle round-trip).

const BOTTOM_THRESHOLD_PX = 32;
export const MAX_RENDERED_LOG_ENTRIES = 5000;
const DEFAULT_SELECTED_LEVELS: LogLevel[] = ["error", "warn", "info"];
const LEVEL_FILTERS: Array<{ value: LogLevel; label: string }> = [
  { value: "error", label: "Error" },
  { value: "warn", label: "Warning" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" }
];

type LogLevel = LogEntry["level"];

type LogLinePart = {
  text: string;
  matchIndex?: number | undefined;
  tone?: LogLinePartTone | undefined;
};

type RenderedLogLine = {
  level?: LogLevel | undefined;
  lineNumber: number;
  parts: LogLinePart[];
};

type LogLinePartTone =
  | "timestamp"
  | "level-debug"
  | "level-error"
  | "level-info"
  | "level-warn"
  | "scope";

export function LogsWindow() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const activeMatchRef = useRef<HTMLElement | null>(null);
  const followingRef = useRef(true);
  const entriesRef = useRef<LogEntry[]>([]);
  const lastSequenceRef = useRef(0);
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  const [renderVersion, setRenderVersion] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [logFilePath, setLogFilePath] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [following, setFollowing] = useState(true);
  const [selectedLevels, setSelectedLevels] = useState<LogLevel[]>(
    DEFAULT_SELECTED_LEVELS
  );

  const setFollowingMode = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  }, []);

  useEffect(() => {
    document.title = "PwrGit Logs";
  }, []);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    const result = await dispatch("logs:read", undefined);
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    const value = result.value;
    entriesRef.current = value.entries.slice(-MAX_RENDERED_LOG_ENTRIES);
    lastSequenceRef.current =
      entriesRef.current[entriesRef.current.length - 1]?.sequence ?? 0;
    setLogFilePath(value.logFilePath);
    setTruncated(
      value.truncated || value.entries.length > MAX_RENDERED_LOG_ENTRIES
    );
    setError(undefined);
    setRenderVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    return subscribe("logs:entry", (entry) => {
      // Paused (scrolled up / searching): drop live entries; re-following
      // reloads the snapshot, so nothing is lost.
      if (!followingRef.current) return;
      if (entry.sequence <= lastSequenceRef.current) return;
      lastSequenceRef.current = entry.sequence;
      entriesRef.current.push(entry);
      if (entriesRef.current.length > MAX_RENDERED_LOG_ENTRIES) {
        entriesRef.current.splice(
          0,
          entriesRef.current.length - MAX_RENDERED_LOG_ENTRIES
        );
        setTruncated(true);
      }
      setRenderVersion((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    if (!following) return;
    const element = viewportRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [following, renderVersion]);

  const rendered = useMemo(() => {
    const visible = entriesRef.current.filter((entry) =>
      selectedLevels.includes(entry.level)
    );
    return buildRenderedLogLines(
      visible.map((entry) => entry.line).join("\n"),
      query
    );
    // renderVersion is the invalidation signal for the mutable entries buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, renderVersion, selectedLevels]);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeMatchIndex >= rendered.matchCount) {
      setActiveMatchIndex(Math.max(0, rendered.matchCount - 1));
    }
  }, [activeMatchIndex, rendered.matchCount]);

  useEffect(() => {
    activeMatchRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [activeMatchIndex]);

  const jumpToEnd = useCallback(() => {
    setFollowingMode(true);
    const element = viewportRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
    void loadSnapshot();
  }, [loadSnapshot, setFollowingMode]);

  const handleScroll = useCallback(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const shouldFollow = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
    if (shouldFollow && !followingRef.current) {
      setFollowingMode(true);
      void loadSnapshot();
      return;
    }
    setFollowingMode(shouldFollow);
  }, [loadSnapshot, setFollowingMode]);

  const goToMatch = useCallback(
    (direction: -1 | 1) => {
      if (rendered.matchCount === 0) return;
      setFollowingMode(false);
      setActiveMatchIndex(
        (current) =>
          (current + direction + rendered.matchCount) % rendered.matchCount
      );
    },
    [rendered.matchCount, setFollowingMode]
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (value.trim() !== "") setFollowingMode(false);
    },
    [setFollowingMode]
  );

  const toggleLevel = useCallback((value: LogLevel) => {
    setSelectedLevels((current) =>
      current.includes(value)
        ? current.filter((level) => level !== value)
        : [...current, value]
    );
  }, []);

  const copyLogFilePath = useCallback(() => {
    if (logFilePath === null) return;
    void navigator.clipboard.writeText(logFilePath).then(() => {
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      setCopiedPath(true);
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedPath(false);
        copyResetTimerRef.current = undefined;
      }, 1400);
    });
  }, [logFilePath]);

  const revealLogFile = useCallback(() => {
    if (logFilePath === null) return;
    void dispatch("shell:revealPath", { path: logFilePath });
  }, [logFilePath]);

  const matchLabel =
    rendered.matchCount > 0
      ? `${activeMatchIndex + 1} / ${rendered.matchCount}`
      : "0";

  return (
    <div className="log-window">
      <main className="log-window__content">
        <div className="log-window__toolbar" aria-label="Log controls">
          <label className="log-window__search">
            <span className="log-window__search-label">Search</span>
            <input
              aria-label="Search logs"
              value={query}
              onChange={(event) => handleSearchChange(event.target.value)}
              placeholder="Find in logs"
              spellCheck={false}
            />
          </label>
          <div aria-label="Log levels" className="log-window__level-filter" role="group">
            {LEVEL_FILTERS.map((option) => (
              <button
                key={option.value}
                aria-pressed={selectedLevels.includes(option.value)}
                className="log-window__level-option"
                type="button"
                onClick={() => toggleLevel(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="log-window__match-count" aria-live="polite">
            {matchLabel}
          </span>
          <button
            className="log-window__button"
            disabled={rendered.matchCount === 0}
            type="button"
            onClick={() => goToMatch(-1)}
          >
            Prev
          </button>
          <button
            className="log-window__button"
            disabled={rendered.matchCount === 0}
            type="button"
            onClick={() => goToMatch(1)}
          >
            Next
          </button>
          <button
            aria-pressed={following}
            className="log-window__button"
            type="button"
            onClick={jumpToEnd}
          >
            Follow
          </button>
        </div>

        {logFilePath !== null && (
          <div className="log-window__file" aria-label="Log file path">
            <span className="log-window__file-label">File</span>
            <code className="log-window__file-path" title={logFilePath}>
              {logFilePath}
            </code>
            <button
              className="log-window__file-copy"
              type="button"
              data-copied={copiedPath ? "true" : undefined}
              onClick={copyLogFilePath}
            >
              {copiedPath ? "Copied" : "Copy"}
            </button>
            <button className="log-window__file-copy" type="button" onClick={revealLogFile}>
              Reveal
            </button>
          </div>
        )}

        <div className="log-window__status">
          <span className="log-window__status-text">
            {following ? "Live app log stream" : "Paused app log stream"}
          </span>
          {truncated && <span className="log-window__status-note">Showing tail</span>}
        </div>

        {error !== undefined && (
          <p className="log-window__error" role="alert">
            Could not load logs: {error}
          </p>
        )}

        <div
          ref={viewportRef}
          aria-label="Log viewport"
          className="log-window__viewport"
          onScroll={handleScroll}
        >
          {rendered.lines.length > 0 ? (
            <pre className="log-window__lines" aria-label="Log output">
              {rendered.lines.map((line) => (
                <LogLine
                  key={line.lineNumber}
                  activeMatchIndex={activeMatchIndex}
                  line={line}
                  activeMatchRef={activeMatchRef}
                />
              ))}
            </pre>
          ) : (
            <p className="log-window__empty">
              {loading ? "Loading…" : "No log output yet."}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

function LogLine(props: {
  activeMatchIndex: number;
  activeMatchRef: MutableRefObject<HTMLElement | null>;
  line: RenderedLogLine;
}) {
  const levelClass = props.line.level ? ` log-window__line--${props.line.level}` : "";
  return (
    <span className={`log-window__line${levelClass}`}>
      <span className="log-window__line-number">{props.line.lineNumber}</span>
      <span className="log-window__line-text">
        {props.line.parts.map((part, index) =>
          renderLogLinePart({
            activeMatchIndex: props.activeMatchIndex,
            activeMatchRef: props.activeMatchRef,
            key: `${props.line.lineNumber}-${index}`,
            part
          })
        )}
      </span>
      {"\n"}
    </span>
  );
}

function renderLogLinePart(params: {
  activeMatchIndex: number;
  activeMatchRef: MutableRefObject<HTMLElement | null>;
  key: string;
  part: LogLinePart;
}): ReactNode {
  if (params.part.matchIndex === undefined) {
    return (
      <span key={params.key} className={classNameForLinePart(params.part)}>
        {params.part.text}
      </span>
    );
  }

  const active = params.part.matchIndex === params.activeMatchIndex;
  const className = [
    "log-window__match",
    active ? "log-window__match--active" : undefined,
    classNameForLinePart(params.part)
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <mark
      key={params.key}
      ref={active ? params.activeMatchRef : undefined}
      className={className}
    >
      {params.part.text}
    </mark>
  );
}

function classNameForLinePart(part: LogLinePart): string | undefined {
  return part.tone ? `log-window__part log-window__part--${part.tone}` : undefined;
}

export function buildRenderedLogLines(
  content: string,
  query: string
): { lines: RenderedLogLine[]; matchCount: number } {
  const normalizedQuery = query.trim().toLowerCase();
  let matchCount = 0;
  const sourceLines = content.length > 0 ? content.split(/\r?\n/) : [];
  const lines = sourceLines.map((line, index) => {
    const renderedLine = renderLogLine(line, normalizedQuery, matchCount);
    matchCount += renderedLine.matchCount;
    return {
      level: renderedLine.level,
      lineNumber: index + 1,
      parts: renderedLine.parts
    };
  });

  return { lines, matchCount };
}

function renderLogLine(
  line: string,
  normalizedQuery: string,
  startMatchIndex: number
): { level?: LogLevel | undefined; matchCount: number; parts: LogLinePart[] } {
  const tokens = tokenizeLogLine(line);
  let nextMatchIndex = startMatchIndex;
  const parts: LogLinePart[] = [];
  for (const token of tokens.parts) {
    const tokenParts =
      normalizedQuery !== ""
        ? splitLineMatches(token.text, normalizedQuery, nextMatchIndex, token.tone)
        : [token];
    parts.push(...tokenParts);
    nextMatchIndex += tokenParts.filter((part) => part.matchIndex !== undefined).length;
  }

  return {
    level: tokens.level,
    matchCount: nextMatchIndex - startMatchIndex,
    parts
  };
}

export function tokenizeLogLine(line: string): {
  level?: LogLevel | undefined;
  parts: LogLinePart[];
} {
  const match = line.match(/^(\[[^\]]+\])(\s+)(\[[^\]]+\])(\s+)(\([^)]+\))(\s*)(.*)$/);
  if (!match) {
    return { parts: [{ text: line }] };
  }

  const level = normalizeLogLevel(match[3]);
  return {
    level,
    parts: [
      { text: match[1], tone: "timestamp" },
      { text: match[2] },
      { text: match[3], tone: toneForLogLevel(level) },
      { text: match[4] },
      { text: match[5], tone: "scope" },
      { text: match[6] },
      { text: match[7] }
    ]
  };
}

function normalizeLogLevel(levelToken: string): LogLevel | undefined {
  const value = levelToken.replace(/[[\]\s]/g, "").toLowerCase();
  if (value === "error" || value === "warn" || value === "info" || value === "debug") {
    return value;
  }
  return undefined;
}

function toneForLogLevel(level: LogLevel | undefined): LogLinePartTone | undefined {
  if (level === "error") return "level-error";
  if (level === "warn") return "level-warn";
  if (level === "info") return "level-info";
  if (level === "debug") return "level-debug";
  return undefined;
}

function splitLineMatches(
  line: string,
  normalizedQuery: string,
  startMatchIndex: number,
  tone?: LogLinePartTone
): LogLinePart[] {
  const lowerLine = line.toLowerCase();
  const parts: LogLinePart[] = [];
  let cursor = 0;
  let matchIndex = startMatchIndex;

  while (cursor < line.length) {
    const foundAt = lowerLine.indexOf(normalizedQuery, cursor);
    if (foundAt === -1) {
      parts.push({ text: line.slice(cursor), tone });
      break;
    }
    if (foundAt > cursor) {
      parts.push({ text: line.slice(cursor, foundAt), tone });
    }
    const end = foundAt + normalizedQuery.length;
    parts.push({ text: line.slice(foundAt, end), matchIndex, tone });
    matchIndex += 1;
    cursor = end;
  }

  return parts.length > 0 ? parts : [{ text: line, tone }];
}
