import { useState } from "react";
import type {
  CreateProfileRequest,
  Profile,
  UpdateProfileRequest
} from "@pwrgit/shared";

/**
 * Create or edit a profile: identity fields (name, commit email, author, default
 * org) plus the set of repo folders scanned for this profile. Roots are edited
 * locally and committed on Save (a single rescan) — in create mode via the new
 * profile, in edit mode via setRoots.
 */
export function ProfileModal({
  mode,
  profile,
  onCreate,
  onUpdate,
  onSetRoots,
  pickDirectories,
  onClose
}: {
  mode: "create" | "edit";
  profile?: Profile | undefined;
  onCreate: (req: CreateProfileRequest) => Promise<string | null>;
  onUpdate: (req: UpdateProfileRequest) => Promise<string | null>;
  onSetRoots: (profileId: string, roots: string[]) => Promise<void>;
  pickDirectories: () => Promise<string[]>;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [authorName, setAuthorName] = useState(profile?.authorName ?? "");
  const [org, setOrg] = useState(profile?.org ?? "");
  const [roots, setRoots] = useState<string[]>(profile?.roots ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const addFolders = async (): Promise<void> => {
    const picked = await pickDirectories();
    if (picked.length === 0) return;
    setRoots((prev) => {
      const next = [...prev];
      for (const p of picked) if (!next.includes(p)) next.push(p);
      return next;
    });
  };

  const removeRoot = (root: string): void =>
    setRoots((prev) => prev.filter((r) => r !== root));

  const canSave = name.trim() !== "" && email.trim() !== "";

  const rootsChanged =
    roots.length !== (profile?.roots.length ?? 0) ||
    roots.some((r, i) => r !== profile?.roots[i]);

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setBusy(true);
    setError(null);

    if (mode === "create") {
      const req: CreateProfileRequest = {
        name: name.trim(),
        email: email.trim(),
        roots
      };
      if (authorName.trim() !== "") req.authorName = authorName.trim();
      if (org.trim() !== "") req.org = org.trim();
      const msg = await onCreate(req);
      setBusy(false);
      if (msg === null) onClose();
      else setError(msg);
      return;
    }

    const id = profile?.id;
    if (id === undefined) {
      setBusy(false);
      return;
    }
    const msg = await onUpdate({
      profileId: id,
      name: name.trim(),
      email: email.trim(),
      authorName: authorName.trim(),
      org: org.trim()
    });
    if (msg !== null) {
      setBusy(false);
      setError(msg);
      return;
    }
    if (rootsChanged) await onSetRoots(id, roots);
    setBusy(false);
    onClose();
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="modal modal--profile" onClick={(e) => e.stopPropagation()}>
        <div className="modal__title">
          {mode === "create"
            ? "New profile"
            : `Edit ${profile?.name ?? "profile"}`}
        </div>

        <label className="field">
          <span className="field__label">
            Profile name{" "}
            <span className="field__hint">
              · a workspace label (window title, Profiles menu) — not your name
            </span>
          </span>
          <input
            className="modal__input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. GIPHY or PwrDrvr"
          />
        </label>

        <label className="field">
          <span className="field__label">Commit email</span>
          <input
            className="modal__input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field__label">
              Author name <span className="field__opt">optional</span>
            </span>
            <input
              className="modal__input"
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              placeholder="Your Name"
            />
          </label>
          <label className="field">
            <span className="field__label">
              Default org <span className="field__opt">optional</span>
            </span>
            <input
              className="modal__input"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="e.g. pwrdrvr"
            />
          </label>
        </div>

        <div className="field">
          <span className="field__label">Repo folders</span>
          <div className="rootlist">
            {roots.length === 0 && (
              <div className="rootlist__empty">
                No folders yet — add the directories that hold this profile's
                repos (each is scanned recursively).
              </div>
            )}
            {roots.map((r) => (
              <div className="rootlist__item" key={r}>
                <span className="rootlist__path" title={r}>
                  {r}
                </span>
                <button
                  className="rootlist__x"
                  onClick={() => removeRoot(r)}
                  aria-label={`Remove ${r}`}
                  title="Remove folder"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button className="rootlist__add" onClick={() => void addFolders()}>
            <span className="new-wt__plus">+</span> Add folders…
          </button>
        </div>

        {error !== null && <div className="modal__error">{error}</div>}

        <div className="modal__actions">
          <button className="modal__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal__create"
            disabled={busy || !canSave}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : mode === "create" ? "Create profile" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
