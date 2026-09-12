import { useCallback, useEffect, useRef, useState } from "react";
import type { ForgeHostRow } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { copyText } from "../../lib/copyText";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

const KIND_LABEL: Record<ForgeHostRow["kind"], string> = {
  github: "GitHub",
  gitlab: "GitLab"
};

/**
 * Settings → Forges → Hosts.
 *
 * Rows come from main, which enumerates what `gh` and `glab` are signed in to.
 * Git remotes are deliberately not a source: a remote is an ssh target, and a
 * NAS or a box on a home network is not a forge — see `forge/AGENTS.md`.
 *
 * The switch is enforced at the transport, not here: a disabled host resolves
 * to null in main, so nothing spawns its CLI or mints its token. This pane only
 * ever writes the setting and re-reads what main says.
 */
export function ForgeHostsSection(props: { saving: boolean }) {
  const [hosts, setHosts] = useState<ForgeHostRow[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | undefined>();
  const mounted = useRef(false);

  const read = useCallback(async (refresh: boolean): Promise<void> => {
    setBusy(true);
    const result = await dispatch("forge:hosts", refresh ? { refresh } : {});
    if (!mounted.current) return;
    if (result.ok) {
      setHosts(result.value.hosts);
      setError(undefined);
    } else {
      setError(result.error.message);
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void read(false);
    return () => {
      mounted.current = false;
    };
  }, [read]);

  const toggle = async (row: ForgeHostRow, next: boolean): Promise<void> => {
    // `null` clears the entry rather than writing today's derived value back,
    // so a host returns to following its sign-in state.
    const patch =
      row.enabledSource === "config" && next === !row.enabled
        ? { [row.host]: null }
        : { [row.host]: { enabled: next } };
    const result = await dispatch("settings:update", {
      patch: { forgeHosts: patch }
    });
    if (!mounted.current) return;
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    await read(false);
  };

  const connected = hosts?.filter((row) => row.enabled).length;

  return (
    <SettingsSection
      title="Hosts"
      eyebrow="Integrations"
      description="Reported by the GitHub and GitLab CLIs. PwrGit only ever talks to a host on this list — a plain ssh remote never appears here."
      chip={
        hosts === undefined
          ? undefined
          : hosts.length === 0
            ? "None"
            : `${connected} of ${hosts.length} on`
      }
      chipKind={hosts !== undefined && connected === 0 ? "warn" : "ok"}
    >
      {error !== undefined && (
        <p className="settings-field__error" role="alert">
          {error}
        </p>
      )}
      {hosts === undefined ? (
        <SettingsField
          label="Checking…"
          control={<span className="settings-card__chip">Reading</span>}
        />
      ) : hosts.length === 0 ? (
        <p className="settings-empty">
          Neither <code>gh</code> nor <code>glab</code> is signed in to a host.
          Sign in from a terminal, then re-check.
        </p>
      ) : (
        hosts.map((row) => (
          <SettingsField
            key={row.host}
            label={row.host}
            sub={describe(row)}
            control={
              <SettingsSwitch
                checked={row.enabled}
                disabled={props.saving || busy}
                label={`Read ${KIND_LABEL[row.kind]} status from ${row.host}`}
                onChange={(next) => void toggle(row, next)}
              />
            }
            help={
              row.origin === "config" ? (
                <>
                  Added by you. <code>{row.cli}</code> holds no account for this
                  host yet — run{" "}
                  <code>{signInCommand(row)}</code>
                  {" "}
                  <button
                    className="settings-inline-button"
                    type="button"
                    onClick={() => {
                      void copyText(signInCommand(row));
                      setCopied(row.host);
                    }}
                  >
                    {copied === row.host ? "Copied" : "Copy"}
                  </button>
                </>
              ) : (
                sourceNote(row)
              )
            }
          />
        ))
      )}
      <SettingsField
        label="Re-check"
        sub="Ask both CLIs again — after signing in from a terminal."
        control={
          <button
            className="settings-button"
            disabled={busy}
            type="button"
            onClick={() => void read(true)}
          >
            {busy ? "Checking…" : "Re-check"}
          </button>
        }
      />
    </SettingsSection>
  );
}

function signInCommand(row: ForgeHostRow): string {
  return `${row.cli} auth login --hostname ${row.host}`;
}

function describe(row: ForgeHostRow): string {
  const parts = [KIND_LABEL[row.kind]];
  if (row.account !== undefined) parts.push(`signed in as ${row.account}`);
  return parts.join(" · ");
}

/** Says WHY the switch reads as it does, so a derived default never looks like
 *  a choice somebody made. */
function sourceNote(row: ForgeHostRow): string {
  if (row.enabledSource === "env") {
    return "Set by an environment variable; the switch cannot change it.";
  }
  if (row.enabledSource === "config") {
    return row.enabled
      ? "On because you turned it on."
      : "Off. PwrGit runs no command and mints no token for this host.";
  }
  const scopes = row.scopes === undefined ? "" : ` · scopes: ${row.scopes.join(", ")}`;
  return `On because ${row.cli} is signed in here${scopes}`;
}
