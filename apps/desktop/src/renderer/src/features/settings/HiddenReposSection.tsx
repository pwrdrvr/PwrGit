import { useState } from "react";
import type { HiddenRepo } from "@pwrgit/shared";
import { unhideRepo, useHiddenRepos } from "../../state/useHiddenRepos";
import { SettingsSection } from "./SettingsLayout";

/** Entries grouped under their profile, in the order main lists them. */
export function groupHiddenByProfile(
  hidden: HiddenRepo[]
): { profileId: string; profileName: string; entries: HiddenRepo[] }[] {
  const groups = new Map<string, { profileId: string; profileName: string; entries: HiddenRepo[] }>();
  for (const entry of hidden) {
    const group = groups.get(entry.profileId) ?? {
      profileId: entry.profileId,
      profileName: entry.profileName,
      entries: []
    };
    group.entries.push(entry);
    groups.set(entry.profileId, group);
  }
  return [...groups.values()];
}

/**
 * Settings → Profiles › Hidden repositories: every profile's hide list in one
 * place, since the Settings window is shared by all of them. An entry whose
 * folder is gone can only be forgotten — there is nothing left to unhide.
 */
export function HiddenReposSection({ activeProfileId }: { activeProfileId: string | null }) {
  const { hidden } = useHiddenRepos(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const release = async (entry: HiddenRepo): Promise<void> => {
    const key = `${entry.profileId}:${entry.path}`;
    setPending(key);
    setError(null);
    const failure = await unhideRepo(entry);
    setPending(null);
    if (failure !== null) setError(failure);
  };

  return (
    <SettingsSection
      sectionId="hidden"
      eyebrow="Profiles"
      title="Hidden repositories"
      description="Repositories that stay in a scanned folder but out of that profile's window, search, bulk sync and agent results. Hide one from its row menu in the sidebar."
      chip={`${hidden.length} hidden`}
    >
      {hidden.length === 0 ? (
        <p className="settings-empty">No hidden repositories.</p>
      ) : (
        <div className="settings-hidden-repos">
          {groupHiddenByProfile(hidden).map((group) => (
            <section
              key={group.profileId}
              className="settings-hidden-repos__group"
              aria-label={`Hidden in ${group.profileName}`}
            >
              <div className="settings-hidden-repos__profile">
                {group.profileName}
                {group.profileId === activeProfileId ? (
                  <span className="settings-card__chip settings-card__chip--ok">Active</span>
                ) : null}
              </div>
              {group.entries.map((entry) => {
                const key = `${entry.profileId}:${entry.path}`;
                return (
                  <div key={key} className="settings-hidden-repos__row">
                    <div className="settings-hidden-repos__body">
                      <span className="settings-hidden-repos__name">{entry.name}</span>
                      <span className="settings-hidden-repos__meta">
                        {entry.missing
                          ? "Not found on disk. It was moved or deleted."
                          : entry.worktreeCount > 1
                            ? `${entry.path} · ${entry.worktreeCount - 1} ${entry.worktreeCount === 2 ? "worktree" : "worktrees"}`
                            : entry.path}
                      </span>
                    </div>
                    <button
                      className="settings-button"
                      type="button"
                      disabled={pending === key}
                      aria-label={`${entry.missing ? "Forget" : "Unhide"} ${entry.name}`}
                      onClick={() => void release(entry)}
                    >
                      {entry.missing ? "Forget" : "Unhide"}
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
      {error !== null ? (
        <p className="settings-hidden-repos__error" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
