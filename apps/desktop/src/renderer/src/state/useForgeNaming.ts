import { useSyncExternalStore } from "react";
import {
  resolveForgeHostDisplays,
  type ForgeHostDisplay,
  type ForgeHostMap,
  type ForgeHostRow
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../lib/pwrgit";

/**
 * What every forge host in this window is called, as one renderer-wide store.
 *
 * Three surfaces ask — the repo rows, the remotes disclosure under each of
 * them, and anything else that grows a chip later — and a hook that fetched
 * per component would dispatch `forge:hosts` once per repo row in the
 * sidebar. One store, one read, one subscription, exactly like
 * `useRemoteActivity`.
 *
 * Kept fresh from two events because two different things change the answer:
 * `settings:changed` carries a renamed host or a flipped switch, and
 * `forge:statusChanged` is CLI enumeration landing a second or two after
 * launch — the window that asked first would otherwise show no chips at all
 * until something else re-rendered it.
 */
export type ForgeNaming = {
  /** Canonical hostname → the mark-and-name a chip should draw. Only hosts
   *  with a settings row appear; callers resolve anything else themselves. */
  displays: ReadonlyMap<string, ForgeHostDisplay>;
  /** The host→kind map main itself resolves with, for parsing a remote URL
   *  the same way main would. */
  overrides: ForgeHostMap;
  /**
   * Whether a forge chip says anything worth the room.
   *
   * More than one forge host switched on. With one, every chip in the window
   * would read the same word — the same reason the repo identity marks draw
   * no "source" badge when almost every repo is one.
   */
  showChips: boolean;
};

const EMPTY: ForgeNaming = {
  displays: new Map(),
  overrides: {},
  showChips: false
};

let naming: ForgeNaming = EMPTY;
let started = false;
/** Reads overlap — two events can land together, and the slower response must
 *  not repaint over the fresher one. Same token `ForgeHostsSection` uses. */
let request = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Identity matters: `useSyncExternalStore` re-renders whenever the snapshot
 *  is a new object, so a poll that rebuilt an equal map every time would
 *  repaint the whole sidebar on every settings write. */
function signature(value: ForgeNaming): string {
  return JSON.stringify([
    [...value.displays].sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(value.overrides).sort(([a], [b]) => a.localeCompare(b)),
    value.showChips
  ]);
}

function apply(rows: ForgeHostRow[], overrides: ForgeHostMap): void {
  const next: ForgeNaming = {
    // Resolved against the whole list, not row by row: two hosts that derive
    // to the same word — or that share a product, and so a mark — have to be
    // told apart, and only the full set knows.
    displays: resolveForgeHostDisplays(
      rows.map((row) => ({
        hostname: row.host,
        host: row.kind,
        ...(row.label === undefined ? {} : { label: row.label })
      }))
    ),
    overrides,
    showChips: rows.filter((row) => row.enabled).length > 1
  };
  if (signature(next) === signature(naming)) return;
  naming = next;
  notify();
}

async function read(): Promise<void> {
  const token = ++request;
  // Never `{ refresh: true }`: that spawns both CLIs, and this runs on a
  // settings write. The cached enumeration is what `forge:statusChanged`
  // already tells us about.
  const result = await dispatch("forge:hosts", {});
  if (token !== request || !result.ok) return;
  apply(result.value.hosts, result.value.overrides);
}

function start(): void {
  if (started) return;
  started = true;
  void read();
  subscribe("settings:changed", () => void read());
  subscribe("forge:statusChanged", () => void read());
}

function subscribeStore(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): ForgeNaming => naming;

/** What the forge hosts in this window are called, and whether saying so
 *  helps. */
export function useForgeNaming(): ForgeNaming {
  return useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
}

/** Test seam: drop the store back to its boot state. Module state outlives a
 *  component tree, so without this one test's hosts leak into the next. */
export function resetForgeNamingForTests(): void {
  naming = EMPTY;
  started = false;
  request = 0;
  listeners.clear();
}
