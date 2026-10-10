import { useEffect, useState } from "react";
import {
  comparableRoot,
  findRootOverlaps,
  foldsPathCase,
  rootOverlapMessage,
  type CreateProfileRequest,
  type Profile,
  type ProfileThemeOverride,
  type UpdateProfileRequest
} from "@pwrgit/shared";
import { currentPlatform } from "../../lib/platform";
import { SettingsSegmented } from "../settings/SettingsLayout";
import { PlusGlyph } from "../../lib/PlusGlyph";
import { dispatch } from "../../lib/pwrgit";
import { useModal } from "../../lib/useModal";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { CloseGlyph } from "../../lib/CloseGlyph";

type ProfileThemeChoice = "inherit" | ProfileThemeOverride;

const PROFILE_THEMES: Array<{ value: ProfileThemeChoice; label: string }> = [
  { value: "inherit", label: "App setting" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" }
];

/**
 * Create or edit a profile: window palette, identity fields, and the set of
 * repo folders scanned for this profile. Roots are edited locally and committed
 * on Save (a single rescan) — in create mode via the new profile, in edit mode
 * via setRoots.
 */
export function ProfileModal({
  mode,
  profile,
  profiles = [],
  onCreate,
  onUpdate,
  onSetRoots,
  pickDirectories,
  onClose
}: {
  mode: "create" | "edit";
  profile?: Profile | undefined;
  /** Every profile, so a folder another profile owns is refused as it is
   *  added rather than at Save. Main refuses it either way. */
  profiles?: readonly Profile[];
  onCreate: (req: CreateProfileRequest) => Promise<string | null>;
  onUpdate: (req: UpdateProfileRequest) => Promise<string | null>;
  onSetRoots: (profileId: string, roots: string[]) => Promise<string | null>;
  pickDirectories: () => Promise<string[]>;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  const [name, setName] = useState(profile?.name ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [authorName, setAuthorName] = useState(profile?.authorName ?? "");
  const [org, setOrg] = useState(profile?.org ?? "");
  const [theme, setTheme] = useState<ProfileThemeChoice>(
    profile?.theme ?? "inherit"
  );
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

  // A repository belongs to one profile and its folder identity to one
  // email, so a folder that equals, holds or sits in another profile's is
  // refused. Only additions: an overlap saved before this rule can still be
  // saved while it is untangled.
  const caseInsensitive = foldsPathCase(currentPlatform());
  const savedRoots = new Set((profile?.roots ?? []).map((root) => comparableRoot(root, caseInsensitive)));
  const overlaps = findRootOverlaps(
    roots.filter((root) => !savedRoots.has(comparableRoot(root, caseInsensitive))),
    profiles.filter((other) => other.id !== profile?.id),
    caseInsensitive
  );
  const overlapRoots = new Set(overlaps.map((overlap) => overlap.root));

  // Settings › Profiles › By folder: while on, saving rewrites this
  // profile's include, so the editor says so.
  const [folderSync, setFolderSync] = useState(false);
  useEffect(() => {
    let live = true;
    void dispatch("settings:read", undefined)
      .then((result) => {
        if (live && result.ok) setFolderSync(result.value.general.gitIdentityByFolder);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const canSave = name.trim() !== "" && email.trim() !== "" && overlaps.length === 0;

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
      if (theme !== "inherit") req.theme = theme;
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
      org: org.trim(),
      theme: theme === "inherit" ? null : theme
    });
    if (msg !== null) {
      setBusy(false);
      setError(msg);
      return;
    }
    const rootsError = rootsChanged ? await onSetRoots(id, roots) : null;
    setBusy(false);
    if (rootsError !== null) {
      setError(rootsError);
      return;
    }
    onClose();
  };

  const modalRef = useModal<HTMLDivElement>({ onClose });

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div ref={modalRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="modal modal--profile" onClick={(e) => e.stopPropagation()}>
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
            placeholder="e.g. Acme or Personal"
          />
        </label>

        <div className="field">
          <span className="field__label">
            Window theme{" "}
            <span className="field__hint">
              · App setting follows General → Color theme
            </span>
          </span>
          <SettingsSegmented
            aria-label="Profile color theme"
            disabled={busy}
            options={PROFILE_THEMES}
            value={theme}
            onChange={setTheme}
          />
        </div>

        <label className="field">
          <span className="field__label">
            Commit email{" "}
            <span className="field__hint">· used for commits made in PwrGit</span>
          </span>
          <input
            className="modal__input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </label>
        {folderSync && (
          <p className="profile-modal__git-note">
            <strong>Git outside PwrGit follows this profile.</strong>{" "}
            {mode === "create" ? "Creating it adds" : "Saving updates"} the include PwrGit keeps in your
            global Git config, so Terminal and coding agents in these folders commit as this email too.
          </p>
        )}

        <div className="field-row">
          <label className="field">
            <span className="field__label">
              Author name{" "}
              <span className="field__opt">optional · falls back to Git’s user.name</span>
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
              placeholder="e.g. acme-inc"
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
              <div className={`rootlist__item${overlapRoots.has(r) ? " is-overlap" : ""}`} key={r}>
                <span className="rootlist__path" {...hoverTooltip(tip, r)}>
                  {r}
                </span>
                <button
                  className="rootlist__x"
                  onClick={() => removeRoot(r)}
                  aria-label={`Remove ${r}`}
                  {...hoverTooltip(tip, "Remove folder")}
                >
                  <CloseGlyph />
                </button>
              </div>
            ))}
          </div>
          {overlaps[0] !== undefined && (
            <p className="rootlist__error" role="alert">
              {rootOverlapMessage(overlaps[0])} Choose another folder, or remove it from “
              {overlaps[0].profileName}” first.
            </p>
          )}
          <button className="rootlist__add" onClick={() => void addFolders()}>
            <PlusGlyph /> Add folders…
          </button>
        </div>

        {/* AI settings are per profile, but they live in the Settings window
            with everything else — this is the way in that already knows which
            profile is meant. Edit only: a profile being created has no id to
            point Settings at yet. */}
        {mode === "edit" && profile !== undefined && (
          <div className="field">
            <span className="field__label">
              AI agents{" "}
              <span className="field__hint">
                · which agent, model and sign-in this profile uses
              </span>
            </span>
            <button
              className="profile-modal__link"
              type="button"
              onClick={() => {
                void dispatch("settings:open", {
                  page: "ai-providers",
                  profileId: profile.id
                }).then((result) => {
                  if (!result.ok) setError(result.error.message);
                });
              }}
            >
              Open AI settings…
            </button>
          </div>
        )}

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
      {tip.tooltipNode}
    </div>
  );
}
