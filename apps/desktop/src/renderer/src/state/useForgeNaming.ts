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
/** The signature of `naming`, kept rather than recomputed: it is known at the
 *  moment the snapshot is stored, and `apply` runs on every settings write and
 *  on every `forge:statusChanged` burst. */
let namingSignature: string | undefined;
let started = false;
/** Reads overlap — two events can land together, and the slower response must
 *  not repaint over the fresher one. Same token `ForgeHostsSection` uses. */
let request = 0;
const listeners = new Set<() => void>();

function notify(): void {
  // Over a copy, like `lib/brandTheme.ts`: a listener that unsubscribes a
  // later one during its own callback would otherwise skip it, leaving that
  // subscriber on a stale snapshot until the next event.
  for (const listener of [...listeners]) listener();
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

/**
 * Every host this window may have to name, settings row or not.
 *
 * `rows` is "what has a settings row", which is deliberately NOT every host —
 * `ForgeHostsView.rows()` and `forge:hosts`'s own doc both say an env
 * allowlist (`PWRGIT_{GITHUB,GITLAB}_HOSTS`) names hosts that get no row.
 * `overrides` is the map main actually classifies with, so it has them.
 *
 * Resolving without them is not merely incomplete, it is WRONG: a host
 * resolved on its own always believes its mark is unambiguous, so an
 * env-only `ghe.acme.example` drew a bare Octocat beside a named `github.com`
 * — the one pair the chip exists to tell apart, with the ambiguous half
 * presented as the certain one.
 */
function namingSet(
  rows: ForgeHostRow[],
  overrides: ForgeHostMap
): Parameters<typeof resolveForgeHostDisplays>[0] {
  const entries = rows.map((row) => ({
    hostname: row.host,
    host: row.kind,
    ...(row.label === undefined ? {} : { label: row.label })
  }));
  const listed = new Set(entries.map((entry) => entry.hostname));
  for (const [hostname, kind] of Object.entries(overrides)) {
    // A host with a row is already here, carrying its label; this only adds
    // the ones the row list left out.
    if (!listed.has(hostname)) entries.push({ hostname, host: kind });
  }
  return entries;
}

function apply(rows: ForgeHostRow[], overrides: ForgeHostMap): void {
  const next: ForgeNaming = {
    // Resolved against the whole set, not row by row: two hosts that derive
    // to the same word — or that share a product, and so a mark — have to be
    // told apart, and only the full set knows.
    displays: resolveForgeHostDisplays(namingSet(rows, overrides)),
    overrides,
    showChips: rows.filter((row) => row.enabled).length > 1
  };
  const nextSignature = signature(next);
  if (nextSignature === (namingSignature ??= signature(naming))) return;
  naming = next;
  namingSignature = nextSignature;
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

/** What `start()` opened, so `resetForgeNamingForTests` can close it. In a
 *  real window these live as long as the window does. */
let unsubscribes: (() => void)[] = [];

function start(): void {
  if (started) return;
  started = true;
  void read();
  unsubscribes = [
    subscribe("settings:changed", () => void read()),
    subscribe("forge:statusChanged", () => void read())
  ];
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
  // The IPC subscriptions too, not just the flag: clearing `started` alone
  // lets the next `start()` open a second pair while the first is still live,
  // so one `settings:changed` fires a `read()` per test that has ever run —
  // inflating dispatch counts and racing a stale mock's rows into `apply`.
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
  naming = EMPTY;
  namingSignature = undefined;
  started = false;
  request = 0;
  listeners.clear();
}
