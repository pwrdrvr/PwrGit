import type { RendererErrorReport } from "@pwrgit/shared";
import { logMain } from "./logs";

// Renderer errors reach the log through `logs:reportRendererError`. The
// renderer cannot be trusted to rate itself — a component that throws on every
// frame, or a window reloading into the same crash, would otherwise write the
// same stack thousands of times and push everything useful out of the 2 MB
// file. So the budget lives here, per sender, where a reload does not reset it.

/** Reports a window may send back to back before the budget applies. */
const BURST = 10;
/** One more report is allowed per interval once the burst is spent. */
const REFILL_MS = 6_000;
/** Senders tracked at once; windows are few, this only stops slow growth. */
const MAX_SENDERS = 32;

const MAX_MESSAGE_CHARS = 1_000;
const MAX_STACK_CHARS = 4_000;
const MAX_VIEW_CHARS = 100;

const SOURCES = new Set<RendererErrorReport["source"]>([
  "window-error",
  "unhandled-rejection",
  "react-uncaught",
  "react-caught",
  "react-recoverable"
]);

type Budget = { tokens: number; updatedAt: number; suppressed: number };

type Log = (level: "error", scope: string, ...parts: unknown[]) => void;

function clip(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}… (${value.length - max} more chars)`;
}

function optionalText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? clip(value, max)
    : undefined;
}

/** The report, re-shaped from whatever crossed IPC, or null if it is not one. */
export function sanitizeRendererErrorReport(
  value: unknown
): RendererErrorReport | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw["source"] !== "string" ||
    !SOURCES.has(raw["source"] as RendererErrorReport["source"]) ||
    typeof raw["message"] !== "string"
  ) {
    return null;
  }
  const stack = optionalText(raw["stack"], MAX_STACK_CHARS);
  const componentStack = optionalText(raw["componentStack"], MAX_STACK_CHARS);
  const view = optionalText(raw["view"], MAX_VIEW_CHARS);
  return {
    source: raw["source"] as RendererErrorReport["source"],
    message: clip(raw["message"], MAX_MESSAGE_CHARS),
    ...(stack === undefined ? {} : { stack }),
    ...(componentStack === undefined ? {} : { componentStack }),
    ...(view === undefined ? {} : { view })
  };
}

/** One log entry, multi-line: grep finds the first line, the stacks follow. */
export function formatRendererErrorReport(
  report: RendererErrorReport,
  sender: number | undefined
): string {
  const where = `${report.source} wc=${sender ?? "?"}${
    report.view === undefined ? "" : ` view=${report.view}`
  }`;
  // An Error's stack already starts with its message; don't print it twice.
  const body =
    report.stack !== undefined && report.stack.includes(report.message)
      ? report.stack
      : [report.message, report.stack].filter((part) => part !== undefined).join("\n");
  const component =
    report.componentStack === undefined
      ? ""
      : `\ncomponent stack:${report.componentStack.startsWith("\n") ? "" : "\n"}${report.componentStack}`;
  return `renderer error (${where}): ${body}${component}`;
}

export function createRendererErrorLog({
  now = Date.now,
  log = logMain
}: { now?: () => number; log?: Log } = {}) {
  const budgets = new Map<number | undefined, Budget>();

  const budgetFor = (sender: number | undefined): Budget => {
    const existing = budgets.get(sender);
    const at = now();
    if (existing === undefined) {
      if (budgets.size >= MAX_SENDERS) {
        const oldest = budgets.keys().next().value;
        budgets.delete(oldest);
      }
      const fresh = { tokens: BURST, updatedAt: at, suppressed: 0 };
      budgets.set(sender, fresh);
      return fresh;
    }
    const earned = Math.floor((at - existing.updatedAt) / REFILL_MS);
    if (earned > 0) {
      existing.tokens = Math.min(BURST, existing.tokens + earned);
      existing.updatedAt += earned * REFILL_MS;
    }
    // Spent tokens are what's left to earn back; a full bucket has nothing
    // to accrue, so its clock starts from now.
    if (existing.tokens === BURST) existing.updatedAt = at;
    return existing;
  };

  return {
    /** Log the report unless this sender has spent its budget. */
    report(report: RendererErrorReport, sender: number | undefined): boolean {
      const budget = budgetFor(sender);
      if (budget.tokens === 0) {
        budget.suppressed += 1;
        return false;
      }
      budget.tokens -= 1;
      if (budget.suppressed > 0) {
        log(
          "error",
          "renderer",
          `suppressed ${budget.suppressed} renderer error report(s) from wc=${sender ?? "?"} (rate limit: ${BURST} burst, then 1 per ${REFILL_MS / 1000}s)`
        );
        budget.suppressed = 0;
      }
      log("error", "renderer", formatRendererErrorReport(report, sender));
      return true;
    }
  };
}
