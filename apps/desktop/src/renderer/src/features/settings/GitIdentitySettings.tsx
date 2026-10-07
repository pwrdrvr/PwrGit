import { useState } from "react";
import type { IdentityConfigEntry, MachineGitIdentity, Profile } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { useModal } from "../../lib/useModal";
import { outsideView } from "../identity/identity-view";
import { useMachineIdentity } from "../identity/useCommitIdentity";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";
import type { AppSettingsState } from "./useAppSettings";

/**
 * Settings › Profiles › Git outside PwrGit: the identity Terminal, scripts and
 * coding agents get on this computer, and the one place PwrGit writes Git
 * config — at a click, after showing the file and the values it will write.
 */
export function GitIdentitySection({
  profiles,
  settings
}: {
  profiles: readonly Profile[];
  settings: AppSettingsState;
}) {
  const { machine } = useMachineIdentity();
  const [setup, setSetup] = useState(false);
  const reminder = settings.snapshot?.general.gitIdentityReminder ?? true;
  const view = machine === null ? null : outsideView(machine.outside, "machine");
  const chip =
    view === null
      ? "Checking"
      : view.status === "configured"
        ? "Configured"
        : view.status === "guessed"
          ? "Guessing"
          : "Not configured";

  return (
    <SettingsSection
      sectionId="git-identity"
      eyebrow="Git"
      title="Git outside PwrGit"
      description="The identity Terminal, scripts and coding agents get on this computer. PwrGit’s own commits use each profile’s identity below."
      chip={chip}
      chipKind={view === null ? "default" : view.status === "configured" ? "ok" : "warn"}
    >
      <div className="settings-fields">
        {machine !== null && view !== null && (
          <div className="git-identity-card">
            <dl className="git-identity-card__rows">
              <dt>Name</dt>
              <dd>
                {view.rows[0]?.value}
                <EntryOrigin entry={globalEntry(machine.config, "user.name")} keyName="user.name" />
              </dd>
              <dt>Email</dt>
              <dd>
                {view.rows[1]?.value}
                <EntryOrigin entry={globalEntry(machine.config, "user.email")} keyName="user.email" />
              </dd>
            </dl>
            {view.consequence !== null && (
              <p className="git-identity-card__warn">{view.consequence}</p>
            )}
            <div>
              <button
                type="button"
                className={
                  view.status === "configured"
                    ? "settings-button"
                    : "settings-button settings-button--primary"
                }
                onClick={() => setSetup(true)}
              >
                {view.status === "configured" ? "Change…" : "Set up Git identity…"}
              </button>
            </div>
          </div>
        )}
        <SettingsField
          label="Remind me"
          sub="Notify at launch when Git outside PwrGit has no identity"
          help="This card keeps reporting the state either way."
          control={
            <SettingsSwitch
              checked={reminder}
              busy={settings.saving}
              disabled={settings.snapshot === null}
              label="Notify when Git outside PwrGit has no identity"
              onChange={(next) => void settings.update({ general: { gitIdentityReminder: next } })}
            />
          }
        />
      </div>
      {setup && machine !== null && (
        <GitIdentitySetupDialog
          machine={machine}
          profiles={profiles}
          onClose={() => setSetup(false)}
        />
      )}
    </SettingsSection>
  );
}

function EntryOrigin({ entry, keyName }: { entry: IdentityConfigEntry | undefined; keyName: string }) {
  return (
    <span className="git-identity-card__origin">
      <code>{keyName}</code>
      {entry !== undefined && entry.origin !== "" ? ` · ${entry.origin}` : ""}
    </span>
  );
}

/** The value Git uses: the last one listed, since later scopes win. */
function globalEntry(config: readonly IdentityConfigEntry[], key: string): IdentityConfigEntry | undefined {
  for (let i = config.length - 1; i >= 0; i -= 1) {
    if (config[i]?.key === key) return config[i];
  }
  return undefined;
}

type Seed = { label: string; name: string; email: string };

/** Starting points: what PwrGit already knows, never typed twice. */
export function setupSeeds(machine: MachineGitIdentity, profiles: readonly Profile[]): Seed[] {
  const seeds: Seed[] = [];
  const configuredName =
    machine.outside.kind === "missing" ? "" : machine.outside.author.name;
  for (const profile of profiles) {
    if (profile.email === "") continue;
    const name = profile.authorName?.trim() || configuredName;
    if (seeds.some((seed) => seed.email === profile.email && seed.name === name)) continue;
    seeds.push({ label: `${profile.name} · ${profile.email}`, name, email: profile.email });
  }
  return seeds;
}

/** `git config --global` as someone would type it, for the preview. */
export function setupCommands(name: string, email: string): string[] {
  return [
    `git config --global user.name ${shellQuote(name)}`,
    `git config --global user.email ${shellQuote(email)}`
  ];
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9@._+-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function GitIdentitySetupDialog({
  machine,
  profiles,
  onClose
}: {
  machine: MachineGitIdentity;
  profiles: readonly Profile[];
  onClose: () => void;
}) {
  const seeds = setupSeeds(machine, profiles);
  const current = {
    name: globalEntry(machine.config, "user.name")?.value ?? null,
    email: globalEntry(machine.config, "user.email")?.value ?? null
  };
  const first = seeds[0];
  const [name, setName] = useState(current.name ?? first?.name ?? "");
  const [email, setEmail] = useState(current.email ?? first?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useModal<HTMLDivElement>({ onClose: () => { if (!busy) onClose(); } });
  const trimmed = { name: name.trim(), email: email.trim() };
  const unchanged = trimmed.name === current.name && trimmed.email === current.email;
  const canWrite = trimmed.name !== "" && trimmed.email.includes("@") && !unchanged && !busy;

  const write = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await dispatch("identity:writeGlobal", trimmed).catch(() => null);
    setBusy(false);
    if (result === null) {
      setError("PwrGit couldn’t reach Git to write the identity.");
      return;
    }
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    // Verified, not assumed: Git is asked again after the write, and a value
    // that still does not resolve (a system config overriding it, say) is
    // reported rather than papered over by closing.
    const outside = result.value.outside;
    if (
      outside.kind === "configured" &&
      outside.author.name === trimmed.name &&
      outside.author.email.toLowerCase() === trimmed.email.toLowerCase()
    ) {
      onClose();
      return;
    }
    setError(
      outside.kind === "configured"
        ? `Written, but Git still resolves ${outside.author.name} <${outside.author.email}>. Another config file overrides it.`
        : "Written, but Git still doesn’t resolve an identity."
    );
  };

  return (
    <div className="overlay-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-identity-setup-title"
        tabIndex={-1}
        className="modal git-identity-setup"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__title" id="git-identity-setup-title">Set up Git identity</div>
        <p className="git-identity-setup__lede">
          Used by Git everywhere on this computer, unless a repository sets its own. Existing
          commits do not change.
        </p>

        {seeds.length > 0 && (
          <div className="field">
            <span className="field__label">Start from</span>
            <div className="git-identity-setup__seeds">
              {seeds.map((seed) => (
                <button
                  key={seed.label}
                  type="button"
                  className={`git-identity-setup__seed${seed.email === trimmed.email && seed.name === trimmed.name ? " is-active" : ""}`}
                  aria-pressed={seed.email === trimmed.email && seed.name === trimmed.name}
                  onClick={() => {
                    if (seed.name !== "") setName(seed.name);
                    setEmail(seed.email);
                  }}
                >
                  {seed.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="modal__input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your Name"
          />
        </label>
        <label className="field">
          <span className="field__label">
            Email{" "}
            <span className="field__hint">· a forge’s noreply address keeps your email private</span>
          </span>
          <input
            className="modal__input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </label>

        <div className="git-identity-setup__preview" aria-label="What will be written">
          <p className="git-identity-setup__file">
            Writes <code>{machine.globalFile}</code>, the file <code>git config --global</code> uses here
          </p>
          <table>
            <tbody>
              <PreviewRow keyName="user.name" from={current.name} to={trimmed.name} />
              <PreviewRow keyName="user.email" from={current.email} to={trimmed.email} />
            </tbody>
          </table>
          <p className="git-identity-setup__same">Same as</p>
          <pre>{setupCommands(trimmed.name, trimmed.email).join("\n")}</pre>
          <p className="git-identity-setup__same">
            Repositories that set their own identity keep it. PwrGit’s profiles are unchanged.
          </p>
        </div>

        {error !== null && (
          <p className="settings-field__error" role="alert">{error}</p>
        )}

        <div className="modal__actions">
          <button className="modal__cancel" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal__create"
            type="button"
            disabled={!canWrite}
            onClick={() => void write()}
          >
            {busy ? "Writing…" : "Write to Git config"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewRow({ keyName, from, to }: { keyName: string; from: string | null; to: string }) {
  return (
    <tr>
      <td><code>{keyName}</code></td>
      <td className="git-identity-setup__from">{from ?? "not set"}</td>
      <td aria-hidden="true">→</td>
      <td><code>{to === "" ? "—" : to}</code></td>
    </tr>
  );
}
