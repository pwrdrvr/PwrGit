import { useCallback, useEffect, useRef, useState } from "react";
import {
  FORGE_KINDS,
  resolveForgeHostNames,
  type ForgeHostConfig,
  type ForgeHostRow,
  type ForgeKind,
  type ForgeStatus
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { copyText } from "../../lib/copyText";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { ReadError } from "../shell/ReadError";
import { SettingsPanelHead, SettingsSectionStack } from "./SettingsLayout";
import {
  ForgeProductSection,
  forgeProductState,
  forgeStateSentence,
  signInCommand
} from "./ForgeProductSection";
import { AddForgeHostDialog } from "./AddForgeHostDialog";

/**
 * How often this pane asks main to re-examine its probe while it is open.
 *
 * Main answers most of these from cache without spawning anything: its TTL is
 * what decides when a real probe happens (a minute for a broken forge, five for
 * a working one). Something has to ask, though — main never probes on its own,
 * so without this tick `forge:statusChanged` would have nothing to announce and
 * a terminal-side `gh auth login` would never reach an open pane.
 */
const RECHECK_MS = 30_000;

/**
 * Settings → Forges: one section per hosting product.
 *
 * Sections come from `FORGE_KINDS`, never from a list written here, so a third
 * product is a row in that table and not an edit to this file. Nothing below
 * compares a kind to a literal.
 *
 * This pane used to be two sibling cards — a flat "Hosts" list of every host
 * from both products, sorted by hostname, above a per-product capability
 * summary. That made a reader correlate two lists by eye to answer "which hosts
 * is GitLab actually reading", and it gave the two products one shared empty
 * state ("Neither gh nor glab is signed in") that could only ever be half
 * right. The product is now the section, so each one owns its hosts, its way
 * in, and its own remedy.
 *
 * Both reads live here rather than in the sections, for the same reason the
 * host list is fetched once: `forge:hosts` and `forge:status` each answer for
 * every product at once, and a read per section would spawn N of each on mount
 * — doubled again under StrictMode.
 *
 * Rows come from main, which enumerates what each CLI is signed in to plus the
 * hosts the user added by hand. Git remotes are deliberately not a source: a
 * remote is an ssh target, and a NAS or a box on a home network is not a forge
 * — see `forge/AGENTS.md`. The switch is enforced at the transport, not here: a
 * disabled host resolves to null in main, so nothing spawns its CLI or mints
 * its token. This pane only ever writes the setting and re-reads what main
 * says.
 */
export function ForgesSettings(props: { saving: boolean }) {
  const [hosts, setHosts] = useState<ForgeHostRow[] | undefined>();
  const [forges, setForges] = useState<ForgeStatus[] | undefined>();
  const [hostsError, setHostsError] = useState<string | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | undefined>();
  const [rowError, setRowError] = useState<
    { host: string; message: string } | undefined
  >();
  const [adding, setAdding] = useState<ForgeKind | undefined>();
  const mounted = useRef(false);
  const hostsRequest = useRef(0);
  const statusRequest = useRef(0);
  const pushRef = useRef(0);
  /**
   * In-flight, read synchronously.
   *
   * `busy` cannot gate a write: it is render state, so it is not visible to a
   * second click in the same tick, and `readHosts` only raises it AFTER the
   * write has resolved. `props.saving` cannot either — it belongs to
   * `useAppSettings.update`, and this pane dispatches `settings:update`
   * itself. Without this ref a double-click sent the write twice.
   */
  const writing = useRef(false);

  const readHosts = useCallback(async (refresh: boolean): Promise<void> => {
    // Reads DO overlap — StrictMode mounts twice, a write re-reads, and
    // Re-check can land on top of either — and a plain `mounted` ref does not
    // order them. Without this token the slower response wins and repaints a
    // stale list over a fresh one.
    const request = ++hostsRequest.current;
    setBusy(true);
    try {
      const result = await dispatch("forge:hosts", refresh ? { refresh } : {});
      if (!mounted.current || request !== hostsRequest.current) return;
      if (result.ok) {
        setHosts(result.value.hosts);
        // A latched "Copied" belongs to the row it was clicked on. Rows can be
        // removed and added back, and the label would otherwise reappear on a
        // host nothing was ever copied for.
        setCopied(undefined);
        setHostsError(undefined);
      } else {
        setHostsError(result.error.message);
      }
    } catch (cause) {
      // Without this the rejection escapes past `setBusy(false)` and every
      // control stays disabled on "Checking…" forever, with nothing shown.
      if (mounted.current && request === hostsRequest.current) {
        setHostsError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (mounted.current && request === hostsRequest.current) setBusy(false);
    }
  }, []);

  const readStatus = useCallback(async (): Promise<void> => {
    const request = ++statusRequest.current;
    const startedAfterPush = pushRef.current;
    const result = await dispatch("forge:status", undefined);
    if (
      !mounted.current ||
      request !== statusRequest.current ||
      pushRef.current !== startedAfterPush
    ) {
      return;
    }
    if (result.ok) {
      setForges(result.value.forges);
      setStatusError(undefined);
    } else {
      setStatusError(result.error.message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribe("forge:statusChanged", ({ forges: next }) => {
      // A push is newer than every read currently in flight. Invalidating the
      // request also prevents a late failure from replacing this success.
      pushRef.current += 1;
      statusRequest.current += 1;
      setForges(next);
      setStatusError(undefined);
    });
    void readHosts(false);
    void readStatus();
    const timer = window.setInterval(() => void readStatus(), RECHECK_MS);
    return () => {
      mounted.current = false;
      hostsRequest.current += 1;
      statusRequest.current += 1;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [readHosts, readStatus]);

  // "Copied" is feedback, not a state the row is in. Left latched it never
  // reverts, so a second copy of the same command confirms nothing.
  useEffect(() => {
    if (copied === undefined) return;
    const timer = window.setTimeout(() => setCopied(undefined), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /**
   * Write one host's entry, then refresh the list.
   *
   * Returns the failure message rather than setting it, so each caller can put
   * it where the user is looking — the row for a switch or a Remove, the dialog
   * for an add. `null` means it worked, matching every other write callback in
   * the app.
   *
   * The re-read is deliberately NOT awaited: it is what repaints the list, but
   * a caller that waits on it stays "in flight" until it lands, and the dialog
   * made that visible — a slow `forge:hosts` left it on "Adding…" with Cancel,
   * Escape and the backdrop all refused, after the write had already succeeded.
   * It is never a `refresh` either: a config entry changes nothing either CLI
   * would report, and refreshing spawns a subprocess per product to learn that.
   */
  const writeHost = async (
    host: string,
    value: ForgeHostConfig | null
  ): Promise<string | null> => {
    // A message, not `null`: `null` is this function's SUCCESS value, so
    // returning it for a write that never happened told the dialog the host
    // had been added and let it close over nothing — no row, no error, no
    // trace. The guard is still right (a second write races the re-read); only
    // the way it reports itself was wrong.
    if (writing.current) return "Another change is still saving. Try again.";
    writing.current = true;
    try {
      const result = await dispatch("settings:update", {
        patch: { forgeHosts: { [host]: value } }
      });
      if (!mounted.current) return null;
      if (!result.ok) return result.error.message;
      void readHosts(false);
      return null;
    } catch (cause) {
      if (!mounted.current) return null;
      return cause instanceof Error ? cause.message : String(cause);
    } finally {
      writing.current = false;
    }
  };

  /** A row's own write. Its failure belongs on that row, not on the pane
   *  header, where it named no host. */
  const writeRow = (row: ForgeHostRow, value: ForgeHostConfig | null): void => {
    void writeHost(row.host, value).then((message) => {
      if (!mounted.current) return;
      setRowError(message === null ? undefined : { host: row.host, message });
    });
  };

  /**
   * Every host's short name, resolved here rather than inside a section.
   *
   * The resolution is a property of the whole list: a derived name used by two
   * hostnames is abandoned for the full hostname, and the two can belong to
   * different products (`github.acme.example` and `gitlab.acme.example` both
   * derive "acme"). Per section, each would promise a short name the sidebar
   * will not print.
   *
   * `resolveForgeHostNames`, not `resolveForgeHostDisplays`: what the field
   * needs is the name in full, which is what this returns. The displays half
   * additionally decides whether a MARK can stand in for that name, and a
   * placeholder has no mark to stand in — reading `display.name` here would
   * leave the field empty-looking for every host whose chip is a bare glyph.
   */
  const names = resolveForgeHostNames(
    (hosts ?? []).map((row) => ({ hostname: row.host, host: row.kind }))
  );

  /** Genuinely unavailable, not in-flight — the dialog cannot tell a new host
   *  from one already present until the list has loaded. */
  const loading = hosts === undefined;
  const blocked = props.saving || busy;

  return (
    <SettingsSectionStack aria-label="Forge settings" paneId="forges">
      <SettingsPanelHead
        eyebrow="Integrations"
        title="Forges"
        help="PwrGit reads change-request status through the CLI you already sign in with. It never asks for a password and stores no token of its own."
        action={
          // One control for the pane, not one per section: it asks every CLI,
          // so it was never a property of one product.
          <button
            aria-busy={busy}
            aria-disabled={busy}
            className="settings-button"
            type="button"
            onClick={() => {
              if (busy) return;
              void readHosts(true);
              void readStatus();
            }}
          >
            <RefreshGlyph />
            {busy ? "Checking…" : "Re-check"}
          </button>
        }
      />
      {hostsError !== undefined && (
        <p className="settings-field__error" role="alert">
          {hostsError}
        </p>
      )}
      {statusError !== undefined && forges === undefined && (
        <ReadError
          title="Forge connections couldn’t be checked"
          message={statusError}
          onRetry={() => void readStatus()}
        />
      )}
      {/* A failure that lands AFTER a first success cannot take the card's
          place — replacing a working list with an error would lose the state
          the user is reading. It still has to be said: silently keeping a
          snapshot that stopped updating shows confident, stale status with no
          hint the probe has given up. */}
      {statusError !== undefined && forges !== undefined && (
        <p className="settings-field__error" role="alert">
          Forge status stopped updating: {statusError}
        </p>
      )}
      {/* The one live region for the pane.
          Each section's chip cannot be one: it renders inside the disclosure
          header's `role="button"`, and ARIA treats a button's children as
          presentational, so a nested `role="status"` is never announced. Out
          here it is a plain sibling and works — and one region for every
          product is right anyway, since a single probe pass can move both. */}
      <p aria-live="polite" className="a11y-sr-only" role="status">
        {forges === undefined
          ? ""
          : FORGE_KINDS.map((kind) =>
              forgeStateSentence(
                kind,
                forgeProductState(forges.find((forge) => forge.kind === kind))
              )
            )
              .filter((line) => line !== null)
              .join(". ")}
      </p>
      {FORGE_KINDS.map((kind) => (
        <ForgeProductSection
          key={kind}
          kind={kind}
          // Filtered, not sorted-then-grouped: the row order inside a product
          // is main's, and main already sorts by hostname.
          hosts={hosts?.filter((row) => row.kind === kind)}
          status={forges?.find((forge) => forge.kind === kind)}
          blocked={blocked}
          loading={loading}
          copied={copied}
          names={names}
          rowError={rowError}
          onWrite={writeRow}
          onCopy={(row) => {
            // The command the row RENDERS, from the one function that builds
            // it. Built here a second time, the clipboard and the text above
            // the button drift the first time either changes.
            void copyText(signInCommand(row));
            setCopied(row.host);
          }}
          onAdd={() => setAdding(kind)}
        />
      ))}
      {adding !== undefined && hosts !== undefined && (
        <AddForgeHostDialog
          kind={adding}
          // Every product's hostnames, so adding a GitLab instance cannot
          // silently rewrite the product of a host `gh` already reports.
          listed={hosts.map((row) => row.host)}
          // `enabled: true` and not just `{ kind }`: main merges into the
          // stored entry, so a stale `enabled:false` left behind by a CLI
          // sign-out would survive and the host would arrive switched off,
          // moments after the dialog said PwrGit would talk to it.
          onAdd={(host) => writeHost(host, { kind: adding, enabled: true })}
          onClose={() => setAdding(undefined)}
        />
      )}
    </SettingsSectionStack>
  );
}
