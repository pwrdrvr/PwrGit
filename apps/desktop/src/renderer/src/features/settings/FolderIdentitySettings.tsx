import { useState } from "react";
import type {
  FolderProfileIdentity,
  FolderRepoIdentity,
  FolderSyncPlan
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { useModal } from "../../lib/useModal";
import {
  differingRepos,
  folderCardChip,
  folderTally,
  overlapText,
  sourceLabel
} from "../identity/folder-view";
import type { FolderIdentityState } from "../identity/useCommitIdentity";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

/** Repos listed per profile before the rest fold into "+N more". */
const LISTED_REPOS = 6;

/**
 * Settings › Profiles › By folder: Git's identity per profile folder, as an
 * `includeIf` PwrGit writes and keeps in step with the profiles
 * (design/Git Identity by Folder, turn 3). Off by default; every write is
 * previewed first, and the answer shown after it is Git's, re-read.
 */
export function FolderIdentitySection({
  folders,
  onEditProfile
}: {
  /** Read once per Settings window (`SettingsWindow`), with the nav row. */
  folders: FolderIdentityState;
  /** Open the profile editor, for a profile whose folders overlap. */
  onEditProfile: (profileId: string) => void;
}) {
  const report = folders.report;
  const [plan, setPlan] = useState<FolderSyncPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState<{ repo: FolderRepoIdentity; profile: FolderProfileIdentity } | null>(
    null
  );
  const chip = folderCardChip(report);
  const enabled = report?.enabled ?? false;

  const askPlan = (next: boolean): void => {
    setPlanning(true);
    setError(null);
    void dispatch("identity:folderPlan", { enabled: next })
      .then((result) => {
        if (result.ok) setPlan(result.value);
        else setError(result.error.message);
      })
      .catch(() => setError("PwrGit couldn’t read Git’s config."))
      .finally(() => setPlanning(false));
  };

  return (
    <SettingsSection
      sectionId="git-folders"
      eyebrow="Git outside PwrGit"
      title="Identity by folder"
      description="Git can use a different identity for repositories under a folder. PwrGit can set that up for each profile’s folders, so Terminal and coding agents commit as the profile does."
      chip={chip.label}
      chipKind={chip.kind}
    >
      <div className="settings-fields">
        <SettingsField
          label="Match Git to each profile"
          sub={
            <>
              An <code>includeIf</code> per profile folder in{" "}
              <code>{report?.globalFile ?? "the global Git config"}</code>
            </>
          }
          help={enabled ? "PwrGit keeps these in step when you edit a profile’s email, name or folders." : undefined}
          error={error}
          control={
            <SettingsSwitch
              checked={enabled}
              busy={planning}
              disabled={report === null}
              label="Match Git to each profile"
              onChange={(next) => {
                if (!planning) askPlan(next);
              }}
            />
          }
        />
        {report !== null && report.profiles.length > 0 && (
          <div className="folder-identity">
            {report.profiles.map((profile) => (
              <FolderProfileRow
                key={profile.profileId}
                profile={profile}
                enabled={enabled}
                onEdit={() => onEditProfile(profile.profileId)}
                onClear={(repo) => setClearing({ repo, profile })}
              />
            ))}
          </div>
        )}
      </div>
      {plan !== null && (
        <FolderSyncDialog
          plan={plan}
          onClose={() => setPlan(null)}
          onApplied={(next) => {
            folders.accept(next);
            setPlan(null);
          }}
        />
      )}
      {clearing !== null && (
        <ClearOverrideDialog
          repo={clearing.repo}
          profile={clearing.profile}
          onClose={() => setClearing(null)}
          onApplied={(next) => {
            folders.accept(next);
            setClearing(null);
          }}
        />
      )}
    </SettingsSection>
  );
}

function FolderProfileRow({
  profile,
  enabled,
  onEdit,
  onClear
}: {
  profile: FolderProfileIdentity;
  enabled: boolean;
  onEdit: () => void;
  onClear: (repo: FolderRepoIdentity) => void;
}) {
  const tally = folderTally(profile);
  const listed = differingRepos(profile, enabled);
  // Counted like the card's chip: every repo that disagrees, listed or not.
  const differ = profile.repos.filter((repo) => !repo.matches).length;
  const overlapped = new Set(profile.overlaps.map((overlap) => overlap.root));
  const repoCount = (root: string): number => {
    const prefix = root.replace(/[\\/]+$/, "");
    return profile.repos.filter(
      (repo) => repo.path === prefix || repo.path.startsWith(`${prefix}/`) || repo.path.startsWith(`${prefix}\\`)
    ).length;
  };
  const tag =
    profile.overlaps.length > 0
      ? { text: "Shared folder", kind: "warn" }
      : tally.tone === "ok"
        ? { text: "Matches", kind: "ok" }
        : tally.tone === "warn"
          ? {
              text: differ > 0 && differ < profile.repos.length ? `${differ} differ` : "Differs",
              kind: "warn"
            }
          : null;

  return (
    <div className="folder-identity__row" data-profile-id={profile.profileId}>
      <span className="settings-profile-row__mono" aria-hidden="true">
        {profile.mono !== "" ? profile.mono : profile.name.slice(0, 2)}
      </span>
      <div className="folder-identity__main">
        <span className="folder-identity__name">{profile.name}</span>
        <span className="folder-identity__who">{profile.email !== "" ? profile.email : "no commit email"}</span>
        {profile.roots.length > 0 && (
          <ul className="folder-identity__roots">
            {profile.roots.map((root) => {
              const overlap = profile.overlaps.find((entry) => entry.root === root);
              const count = repoCount(root);
              return (
                <li key={root} className={overlapped.has(root) ? "is-warn" : undefined}>
                  <code>{root}</code>
                  <span>
                    {overlap !== undefined
                      ? ` · ${overlapText(overlap)} — repos move between the two profiles`
                      : ` · ${count} repo${count === 1 ? "" : "s"}`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <span className={`folder-identity__tally folder-identity__tally--${tally.tone}`}>{tally.text}</span>
        {listed.length > 0 && (
          <ul className="folder-identity__repos" aria-label={`${profile.name} repositories that differ`}>
            {listed.slice(0, LISTED_REPOS).map((repo) => (
              <li key={repo.repoId}>
                <span className="folder-identity__repo-text">
                  <span className="folder-identity__repo-name">{repo.name}</span>
                  <span className="folder-identity__repo-why">
                    {repo.email ?? "no email"} · {sourceLabel(repo)}
                  </span>
                </span>
                {repo.source === "local" && (
                  <button type="button" className="settings-button" onClick={() => onClear(repo)}>
                    Remove override…
                  </button>
                )}
              </li>
            ))}
            {listed.length > LISTED_REPOS && (
              <li className="folder-identity__more">+{listed.length - LISTED_REPOS} more</li>
            )}
          </ul>
        )}
      </div>
      <div className="folder-identity__side">
        {tag !== null && <span className={`settings-card__chip settings-card__chip--${tag.kind}`}>{tag.text}</span>}
        {profile.overlaps.length > 0 && (
          <button type="button" className="settings-button" onClick={onEdit}>
            Edit folders…
          </button>
        )}
      </div>
    </div>
  );
}

/** The exact lines, then Write. Off removes PwrGit's includes and files. */
function FolderSyncDialog({
  plan,
  onClose,
  onApplied
}: {
  plan: FolderSyncPlan;
  onClose: () => void;
  onApplied: (report: NonNullable<FolderIdentityState["report"]>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useModal<HTMLDivElement>({ onClose: () => { if (!busy) onClose(); } });
  const nothing = plan.enabled
    ? plan.add.length === 0
    : plan.remove.length === 0 && plan.deleteFiles.length === 0;

  const apply = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await dispatch("identity:setFolderSync", { enabled: plan.enabled }).catch(() => null);
    setBusy(false);
    if (result === null) {
      setError("PwrGit couldn’t reach Git to write the config.");
      return;
    }
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onApplied(result.value);
  };

  return (
    <div className="overlay-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-sync-title"
        tabIndex={-1}
        className="modal folder-sync"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title" id="folder-sync-title">
          {plan.enabled ? "Match Git to each profile" : "Stop matching Git to profiles"}
        </div>
        <p className="git-identity-setup__lede">
          {plan.enabled
            ? "Repositories under a profile’s folders will commit as that profile, in Terminal, scripts and coding agents too. Existing commits don’t change. Repositories that set their own email keep it."
            : "PwrGit removes the includes it wrote and their files. Repositories go back to Git’s global identity. Includes you wrote yourself stay."}
        </p>
        <div className="folder-sync__diff" aria-label="What will change">
          <p className="folder-sync__file">
            <code>{plan.globalFile}</code>
            {plan.enabled ? " — appended at the end, so they win over [user]" : ""}
          </p>
          <pre>
            {[
              ...plan.remove.map((entry) => `- [includeIf "${entry.condition}"] path = ${entry.path}`),
              ...plan.add.map((entry) => `+ [includeIf "${entry.condition}"]\n+ \tpath = ${entry.path}`)
            ].join("\n") || "  (no change)"}
          </pre>
          {plan.files.map((file) => (
            <div key={file.path}>
              <p className="folder-sync__file">
                <code>{file.path}</code> — {file.exists ? "replaced" : "new"}
              </p>
              <pre>{file.content.trimEnd()}</pre>
            </div>
          ))}
          {plan.deleteFiles.length > 0 && (
            <p className="folder-sync__file">
              Deletes {plan.deleteFiles.map((path, i) => (
                <span key={path}>
                  {i > 0 ? ", " : ""}
                  <code>{path}</code>
                </span>
              ))}
            </p>
          )}
          {plan.enabled && plan.skipped.length > 0 && (
            <p className="folder-sync__skip">
              No include for{" "}
              {plan.skipped
                .map((entry) => `${entry.name} (${entry.reason === "no_email" ? "no commit email" : "no repo folders"})`)
                .join(", ")}
              .
            </p>
          )}
          {plan.enabled && (
            <p className="folder-sync__skip">
              A profile without an author name keeps Git’s user.name. While this is on, PwrGit rewrites these when
              you edit a profile’s email, name or folders.
            </p>
          )}
        </div>
        {error !== null && <p className="settings-field__error" role="alert">{error}</p>}
        <div className="modal__actions">
          <button className="modal__cancel" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal__create"
            type="button"
            disabled={busy || (plan.enabled && nothing)}
            onClick={() => void apply()}
          >
            {busy ? "Writing…" : plan.enabled ? "Write to Git config" : nothing ? "Turn off" : "Remove includes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ClearOverrideDialog({
  repo,
  profile,
  onClose,
  onApplied
}: {
  repo: FolderRepoIdentity;
  profile: FolderProfileIdentity;
  onClose: () => void;
  onApplied: (report: NonNullable<FolderIdentityState["report"]>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useModal<HTMLDivElement>({ onClose: () => { if (!busy) onClose(); } });
  const keys = ["user.email", "author.email"];
  if ((profile.authorName?.trim() ?? "") !== "") keys.push("user.name", "author.name");

  const apply = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await dispatch("identity:clearRepoOverride", { repoId: repo.repoId }).catch(() => null);
    setBusy(false);
    if (result === null || !result.ok) {
      setError(result === null ? "PwrGit couldn’t reach Git." : result.error.message);
      return;
    }
    onApplied(result.value);
  };

  return (
    <div className="overlay-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-override-title"
        tabIndex={-1}
        className="modal folder-sync"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title" id="clear-override-title">Remove {repo.name}’s own email?</div>
        <p className="git-identity-setup__lede">
          This repository sets <code>{repo.email}</code> in its own config, which wins over the {profile.name}{" "}
          profile’s folder identity. Afterwards it commits as <code>{profile.email}</code>.
        </p>
        <div className="folder-sync__diff">
          <p className="folder-sync__file">
            <code>{repo.origin ?? `${repo.path}/.git/config`}</code>
          </p>
          <pre>{keys.map((key) => `git config --local --unset-all ${key}`).join("\n")}</pre>
        </div>
        {error !== null && <p className="settings-field__error" role="alert">{error}</p>}
        <div className="modal__actions">
          <button className="modal__cancel" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="modal__create" type="button" disabled={busy} onClick={() => void apply()}>
            {busy ? "Removing…" : "Remove override"}
          </button>
        </div>
      </div>
    </div>
  );
}
