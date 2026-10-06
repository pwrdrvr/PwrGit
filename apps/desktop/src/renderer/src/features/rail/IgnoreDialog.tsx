import { useEffect, useMemo, useState } from "react";
import type { IgnoreDestination, IgnoreOptions, IgnorePatternChoice } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { useModal } from "../../lib/useModal";
import { currentPlatform, thisMachineNoun } from "../../lib/platform";

function description(destination: IgnoreDestination, platform: string): string {
  if (destination === "gitignore") return "Committed with the project. Everyone who clones it gets this rule.";
  if (destination === "exclude") return "This clone only, never committed. Shared by all its worktrees.";
  return `Every repository on this ${thisMachineNoun(platform)}, in PwrGit and in your terminal.`;
}

export function IgnoreDialog({
  worktreeId,
  path,
  directory,
  onClose,
  platform = currentPlatform()
}: {
  worktreeId: string;
  path: string;
  directory: boolean;
  onClose: () => void;
  /** Explicit only in deterministic platform component tests. */
  platform?: string;
}) {
  const [options, setOptions] = useState<IgnoreOptions | null>(null);
  const [choice, setChoice] = useState<IgnorePatternChoice>(directory || path.includes("/") ? "folder" : "file");
  const [destination, setDestination] = useState<IgnoreDestination>("gitignore");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useModal<HTMLDivElement>({ onClose });

  useEffect(() => {
    let active = true;
    void dispatch("changes:ignoreOptions", { worktreeId, path, directory }).then((result) => {
      if (!active) return;
      if (result.ok && result.value !== null) {
        setOptions(result.value);
        setDestination(result.value.suggested);
      } else setError(result.ok ? "Could not load ignore choices." : result.error.message);
    });
    return () => { active = false; };
  }, [worktreeId, path, directory]);

  const selectedPattern = useMemo(() => options?.patterns.find((item) => item.choice === choice) ?? options?.patterns[0], [options, choice]);
  const selectedDestination = options?.destinations.find((item) => item.destination === destination);

  const submit = async (): Promise<void> => {
    if (busy || selectedPattern === undefined || selectedDestination === undefined) return;
    setBusy(true);
    const result = await dispatch("changes:ignore", { worktreeId, path, directory, pattern: selectedPattern.choice, destination });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      showErrorToast({ title: "Could not add ignore rule", message: result.error.message, subject: { worktreeId } });
      return;
    }
    showInfoToast({
      title: result.value.added.length === 0 ? "Rule already present" : "Ignore rule added",
      message: `${selectedPattern.pattern} · ${selectedDestination.displayPath} · ${selectedDestination.scope}`,
      subject: { worktreeId }
    });
    onClose();
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div ref={modalRef} role="dialog" aria-modal="true" aria-label={`Ignore ${path}`} tabIndex={-1} className="modal discovery-ignore" onClick={(event) => event.stopPropagation()}>
        <div className="discovery-ignore__header">
          <h2>Ignore <code>{path}{directory ? "/" : ""}</code></h2>
          <p>Ignoring only hides untracked files. Files already committed are never affected.</p>
        </div>
        <div className="discovery-ignore__body">
          <div className="discovery-ignore__section">
            <span className="discovery-ignore__label">Pattern</span>
            <div className="discovery-ignore__patterns">
              {options?.patterns.map((item) => (
                <button key={item.choice} type="button" className={item.choice === choice ? "is-selected" : ""} onClick={() => setChoice(item.choice)}>
                  <code>{item.pattern}</code><small>{item.count} file{item.count === 1 ? "" : "s"}</small>
                </button>
              )) ?? <span className="discovery-ignore__loading">Reading untracked files…</span>}
            </div>
          </div>
          <div className="discovery-ignore__section">
            <span className="discovery-ignore__label">Write it to</span>
            {options?.destinations.map((item) => (
              <button key={item.destination} type="button" className={`discovery-ignore__destination${item.destination === destination ? " is-selected" : ""}`} onClick={() => setDestination(item.destination)}>
                <span className="discovery-ignore__radio" />
                <span className="discovery-ignore__destination-copy"><code title={item.path}>{item.displayPath}</code><small>{description(item.destination, platform)}</small></span>
                <span className="discovery-ignore__destination-meta"><span className={`discovery-scope discovery-scope--${item.destination}`}>{item.scope}</span>{item.destination === options.suggested && <small>suggested</small>}</span>
              </button>
            ))}
          </div>
          {selectedPattern !== undefined && selectedDestination !== undefined && (
            <div className="discovery-ignore__preview">
              <code title={selectedDestination.path}>{selectedDestination.displayPath}</code>
              <code>+ {selectedPattern.pattern}</code>
              <span>{destination === "gitignore" ? "This becomes a change to commit for the team." : destination === "exclude" ? `Takes effect in all ${options?.worktreeCount ?? 1} worktrees of this clone. Nothing to commit.` : `Every repository on this ${thisMachineNoun(platform)} will ignore it. Nothing to commit.`}</span>
            </div>
          )}
          {error !== null && <div className="modal__error">{error}</div>}
        </div>
        <div className="discovery-ignore__footer"><button className="modal__cancel" onClick={onClose}>Cancel</button><button className="modal__create" disabled={busy || selectedPattern === undefined} onClick={() => void submit()}>{busy ? "Adding…" : "Add ignore rule"}</button></div>
      </div>
    </div>
  );
}
