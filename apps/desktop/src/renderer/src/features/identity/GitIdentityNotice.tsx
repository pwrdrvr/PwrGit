import { useEffect, useRef, useState } from "react";
import type { MachineGitIdentity } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

/**
 * The launch notice: "Git outside PwrGit has no identity".
 *
 * Info-toned, because nothing failed inside PwrGit — its own commits carry the
 * profile's identity either way, and the card says so first. Sticky, because
 * the condition stays true until someone acts on it. Main decides which window
 * shows it (one, ever) and whether it was dismissed this launch; this
 * component only asks, and withdraws the card the moment the answer turns.
 */
export function GitIdentityNotice({
  profile
}: {
  /** This window's profile, for the "PwrGit commits as …" line. */
  profile: { name: string; email: string } | null;
}) {
  const [machine, setMachine] = useState<MachineGitIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showing = useRef(false);

  useEffect(() => {
    let live = true;
    let sequence = 0;
    const check = (): void => {
      const request = ++sequence;
      void dispatch("identity:machine", { claimNotice: true })
        .then((result) => {
          if (!live || request !== sequence) return;
          setMachine(result.ok && result.value.notice ? result.value : null);
        })
        .catch(() => {
          if (live && request === sequence) setMachine(null);
        });
    };
    check();
    // Fixed in a terminal while the card stood: settle it on return, rather
    // than leave a sticky card reporting a solved problem. With nothing
    // showing, focus asks nothing.
    const focus = (): void => {
      if (showing.current) check();
    };
    const offIdentity = subscribe("identity:changed", check);
    const offSettings = subscribe("settings:changed", () => {
      if (showing.current) check();
    });
    window.addEventListener("focus", focus);
    return () => {
      live = false;
      offIdentity();
      offSettings();
      window.removeEventListener("focus", focus);
    };
  }, []);

  const visible = machine !== null && machine.outside.kind !== "configured";
  useEffect(() => {
    showing.current = visible;
  }, [visible]);
  if (!visible || machine === null) return null;

  const copy = noticeCopy(machine, profile);
  return (
    <aside className="app-toast app-toast--stacked git-identity-notice" role="status" aria-live="polite">
      <div className="app-toast__content">
        <p className="app-toast__eyebrow app-toast__eyebrow--info">Git identity</p>
        <p className="app-toast__message">{copy.message}</p>
        <p className="app-toast__hint">{copy.hint}</p>
        {error !== null && <p className="app-toast__error" role="alert">{error}</p>}
      </div>
      <div className="app-toast__actions">
        <button
          type="button"
          className="app-toast__button app-toast__button--primary"
          onClick={() => {
            void dispatch("settings:open", { page: "profiles", sub: "git-identity" })
              .then((result) => {
                if (!result.ok) setError(result.error.message);
              })
              .catch(() => setError("Couldn’t open Settings."));
          }}
        >
          Set up in Settings…
        </button>
        <button
          type="button"
          className="app-toast__button"
          onClick={() => {
            setMachine(null);
            void dispatch("identity:dismissNotice", undefined).catch(() => undefined);
          }}
        >
          Not now
        </button>
      </div>
    </aside>
  );
}

export function noticeCopy(
  machine: MachineGitIdentity,
  profile: { name: string; email: string } | null
): { message: string; hint: string } {
  const pwrgit =
    profile !== null && profile.email !== ""
      ? `PwrGit commits as ${profile.email} from your ${profile.name} profile.`
      : null;
  if (machine.outside.kind === "guessed") {
    const guessed = machine.outside.author.email;
    return {
      message: "Git outside PwrGit is guessing your email.",
      hint: `Commits from Terminal or coding agents would record ${guessed}, an address built from this computer’s name that no forge can link to you.${pwrgit === null ? "" : ` ${pwrgit}`}`
    };
  }
  if (pwrgit === null) {
    return {
      message: "Neither PwrGit nor Git outside it has an email to commit with.",
      hint: "Commits from Terminal or coding agents on this computer will fail with “Author identity unknown”. Set up Git’s identity, then give your profile a commit email."
    };
  }
  return {
    message: "Git outside PwrGit has no name or email set.",
    hint: `${pwrgit} Commits from Terminal or coding agents on this computer will fail with “Author identity unknown”.`
  };
}
