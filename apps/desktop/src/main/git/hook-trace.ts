import { basename } from "node:path";
import type { HookRun } from "@pwrgit/shared";

type TraceEvent = {
  event?: string;
  sid?: string;
  child_id?: number;
  child_class?: string;
  hook_name?: string;
  argv?: string[];
  code?: number;
  t_rel?: number;
};

/** Pair by session as well as child ID: a hook may launch another Git whose
 * trace events append to the same file and reuse child_id 0. */
export function parseHookTrace(trace: string): HookRun[] {
  const starts = new Map<string, { name: string; path: string }>();
  const runs: HookRun[] = [];
  for (const line of trace.split("\n")) {
    if (line === "") continue;
    let event: TraceEvent;
    try {
      event = JSON.parse(line) as TraceEvent;
    } catch {
      continue;
    }
    if (typeof event.sid !== "string" || typeof event.child_id !== "number") continue;
    const key = `${event.sid}:${event.child_id}`;
    if (event.event === "child_start" && (event.child_class === "hook" || typeof event.hook_name === "string")) {
      // Older bundled Git builds mark the child as a hook but omit hook_name.
      // Its argv[0] is the exact executable Git invoked, so the basename is
      // still evidence from Git rather than a guess from files on disk.
      const name = event.hook_name || (event.argv?.[0] === undefined ? null : basename(event.argv[0]));
      if (name === null) continue;
      starts.set(key, {
        name,
        path: event.argv?.[0] ?? name
      });
    } else if (event.event === "child_exit") {
      const start = starts.get(key);
      if (start === undefined || typeof event.code !== "number" || typeof event.t_rel !== "number") continue;
      starts.delete(key);
      runs.push({
        ...start,
        exitCode: event.code,
        elapsedMs: Math.max(0, Math.round(event.t_rel * 1_000))
      });
    }
  }
  return runs;
}
