import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { dispatch } from "../../lib/pwrgit";
import { copyText } from "../../lib/copyText";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { splitStepLine, type StepIssue } from "./maintenance-issues";

/**
 * The shared outcome card from the "Removal Errors" board (turn 5): a mark,
 * a count headline, a sub-line, then one `.maintenance__problem-row` per
 * object. The Worktrees step and the Combined run's Local branches and
 * Garbage collection steps all draw it, so one run never shows two error
 * styles.
 */

/** Lucide icons, exact paths, drawn with currentColor. */
export function Icon({ name }: { name: "alert" | "info" | "log" | "folder" | "retry" | "chev" | "chevd" | "copy" }) {
  const paths: Record<typeof name, ReactNode> = {
    alert: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
    info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
    log: <><path d="M15 12h-5" /><path d="M15 8h-5" /><path d="M19 17V5a2 2 0 0 0-2-2H4" /><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" /></>,
    folder: <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />,
    retry: <><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></>,
    chev: <path d="m9 18 6-6-6-6" />,
    chevd: <path d="m6 9 6 6 6-6" />,
    copy: <><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>
  };
  return (
    <svg className="maintenance__problem-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

/** The sentence, with the lead phrase main chose set in bold. */
export function Reason({ message, lead }: { message: string; lead: string | undefined }) {
  if (lead === undefined || !message.startsWith(lead)) return <p>{message}</p>;
  return (
    <p>
      <b>{lead}</b>
      {message.slice(lead.length)}
    </p>
  );
}

/** Opens a row's raw text (`.maintenance__problem-raw`). */
export function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="maintenance__problem-toggle"
      aria-expanded={open}
      onClick={onToggle}
    >
      <Icon name={open ? "chevd" : "chev"} />
      Details
    </button>
  );
}

/** Puts `text` on the clipboard and says so for a moment. `className`
 *  picks the card head's link style or a row's outlined button. `text` is
 *  built on click, not on every render of the dialog. */
export function CopyButton({ text, label, className }: { text: () => string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={className}
      onClick={() => void copyText(text()).then(() => setCopied(true), () => undefined)}
    >
      <Icon name="copy" />
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}

/** Opens Help › Logs, where main wrote each row too. */
export function ViewLogButton() {
  return (
    <button type="button" className="maintenance__problem-log" onClick={() => void dispatch("logs:openWindow", undefined)}>
      <Icon name="log" />
      View log
    </button>
  );
}

/**
 * The card. `tone="note"` is for what the user chose to keep. `listLabel`
 * makes the row list a labelled, keyboard-scrollable region capped at about
 * four and a half rows, and names the card by its headline; the head never
 * scrolls away.
 */
export function ProblemCard({
  tone = "alert",
  headline,
  sub,
  action,
  listLabel,
  children
}: {
  tone?: "alert" | "note";
  headline: ReactNode;
  sub: ReactNode;
  action?: ReactNode;
  listLabel?: string;
  children: ReactNode;
}) {
  const id = useId();
  const named = listLabel !== undefined;
  // The list is a tab stop only when it scrolls: past about four rows, or
  // when long reasons make fewer rows overflow.
  const list = useRef<HTMLUListElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = list.current;
    setOverflows(element !== null && element.scrollHeight > element.clientHeight);
  });
  const rowCount = Array.isArray(children) ? children.length : 1;
  return (
    <section
      className={`maintenance__problem${tone === "note" ? " is-note" : ""}`}
      role={tone === "note" ? "status" : "alert"}
      aria-labelledby={named ? id : undefined}
    >
      <div className="maintenance__problem-head">
        <span className="maintenance__problem-mark"><Icon name={tone === "note" ? "info" : "alert"} /></span>
        <div>
          <strong id={named ? id : undefined}>{headline}</strong>
          <span>{sub}</span>
        </div>
        {action}
      </div>
      {named ? (
        <ul ref={list} className="maintenance__problem-list" tabIndex={overflows || rowCount > 4 ? 0 : undefined} aria-label={listLabel}>{children}</ul>
      ) : (
        <ul>{children}</ul>
      )}
    </section>
  );
}

/** One branch, repository or worktree a Combined step left behind.
 *  `report` is the row as plain text; with it the row offers Copy. */
export function IssueRow({ issue, report }: { issue: StepIssue; report?: () => string }) {
  const [open, setOpen] = useState(false);
  const tip = useViewportTooltip();
  const exit = issue.exitCode === undefined ? null : `Exit code ${issue.exitCode}${issue.command === undefined ? "" : ` · ${issue.command}`}`;
  const details = [issue.raw, exit].filter((line): line is string => line !== undefined && line !== null).join("\n");
  return (
    <li className="maintenance__problem-row">
      {issue.kind !== "run" && <div className="maintenance__problem-title">
        <strong className="selectable">
          <span>{issue.repo}</span>
          {issue.branch !== undefined && <> · {issue.branch || "detached"}</>}
        </strong>
        {issue.head !== undefined && <code>{issue.head.slice(0, 8)}</code>}
      </div>}
      <Reason message={issue.reason} lead={issue.lead} />
      {(issue.branch === undefined || issue.kind === "worktree") && issue.path !== undefined && (
        <small className="selectable" {...hoverTooltip(tip, issue.path)}>{issue.path}</small>
      )}
      {(report !== undefined || details !== "") && (
        <div className="maintenance__problem-actions">
          {report !== undefined && <CopyButton text={report} label="Copy" />}
          {details !== "" && <DetailsToggle open={open} onToggle={() => setOpen((was) => !was)} />}
        </div>
      )}
      {open && details !== "" && (
        <pre className="maintenance__problem-raw selectable">{details}</pre>
      )}
      {tip.tooltipNode}
    </li>
  );
}

/** A step line with its issue counts in danger ink:
 *  "26 deleted in 1 repository" then "· 1 not deleted". */
export function StepLine({ line }: { line: string }) {
  const { lead, issues } = splitStepLine(line);
  return <>{lead}{issues !== "" && <em className="maintenance__step-issues">{issues}</em>}</>;
}
