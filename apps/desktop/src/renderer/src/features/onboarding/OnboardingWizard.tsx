import { useCallback, useEffect, useMemo, useState } from "react";
import {
  forgeProduct,
  type ForgeKind,
  type GitIdentityRead,
  type Profile,
  type Repo,
  FORGE_KINDS
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { pathLeaf } from "../../lib/platform";
import {
  forgeProductState,
  forgeStateSentence
} from "../settings/ForgeProductSection";
import { useForgeStatuses } from "../settings/useForgeStatuses";
import {
  RAIL_LABELS,
  nextStep,
  previousStep,
  railIndexForStep,
  railLabel,
  type WizardStep
} from "./steps";

export type OnboardingWizardProps = {
  profile: Profile;
  /** The scan's result, for the Done screen. Only what a scan knows is drawn. */
  repos: Repo[];
  /** Help-menu replay: show the wizard without persisting completion. */
  isReplay: boolean;
  pickDirectories: () => Promise<string[]>;
  onSetRoots: (profileId: string, roots: string[]) => Promise<void>;
  onSetIdentity: (
    profileId: string,
    identity: { authorName: string; email: string }
  ) => Promise<void>;
  /** Clear the overlay. `persistCompleted` is false only for a replay. */
  onDismiss: (persistCompleted: boolean) => void;
};

/** Folder names offered when the user has nowhere to point PwrGit yet. The
 *  three spellings people actually use; see the design bundle's turn 4. */
const SUGGESTED_ROOTS = ["projects", "github", "git"] as const;

export function OnboardingWizard(props: OnboardingWizardProps) {
  const { profile, repos, isReplay, onDismiss } = props;
  const [step, setStep] = useState<WizardStep>("welcome");
  const [identity, setIdentity] = useState<GitIdentityRead | null>(null);
  const [authorName, setAuthorName] = useState(profile.authorName ?? "");
  const [email, setEmail] = useState(profile.email);
  const [roots, setRoots] = useState<string[]>(profile.roots);
  const [busy, setBusy] = useState(false);
  const forges = useForgeStatuses();

  // Asked of git, not parsed out of ~/.gitconfig — the seed that filled this
  // profile is not section-aware and does not follow `include`, so it can hold
  // a forge handle, or nothing while git answers fine. Only fills blanks: a
  // value the user has already set for this profile is theirs.
  useEffect(() => {
    let live = true;
    void dispatch("git:readIdentity", undefined).then((result) => {
      if (!live || !result.ok) return;
      setIdentity(result.value);
      setAuthorName((prev) => (prev.trim() === "" ? result.value.name ?? "" : prev));
      setEmail((prev) => (prev.trim() === "" ? result.value.email ?? "" : prev));
    });
    return () => {
      live = false;
    };
  }, []);

  const railIndex = railIndexForStep(step);
  const identityComplete = authorName.trim() !== "" && email.trim() !== "";

  const forgeSummary = useMemo(() => {
    if (forges === undefined) return null;
    const connected = forges
      .filter((f) => forgeProductState(f) === "connected")
      .map((f) => forgeProduct(f.kind).label);
    return connected.length === 0 ? "None" : connected.join(" · ");
  }, [forges]);

  const answers = useMemo(
    () => ({
      authorName: authorName.trim() === "" ? null : authorName.trim(),
      forgeSummary,
      // The rail names folders the way the sidebar groups them — by the added
      // folder's last segment — so "code" in the rail is "CODE" in the sidebar
      // rather than a full path the rail would have to ellipsise anyway.
      roots: roots.map(pathLeaf)
    }),
    [authorName, forgeSummary, roots]
  );

  const finish = useCallback(async () => {
    setBusy(true);
    try {
      if (identityComplete) {
        await props.onSetIdentity(profile.id, {
          authorName: authorName.trim(),
          email: email.trim()
        });
      }
      onDismiss(!isReplay);
    } finally {
      setBusy(false);
    }
  }, [
    authorName,
    email,
    identityComplete,
    isReplay,
    onDismiss,
    profile.id,
    props
  ]);

  const advance = useCallback(() => {
    const next = nextStep(step);
    if (next === null) {
      void finish();
      return;
    }
    setStep(next);
  }, [finish, step]);

  const goBack = useCallback(() => {
    const prev = previousStep(step);
    if (prev !== null) setStep(prev);
  }, [step]);

  // Close and Skip are the same act. A wizard that re-fires because you closed
  // it is a wizard you close harder — so both persist completion, except on a
  // replay, which is a look rather than a run.
  const skip = useCallback(() => {
    onDismiss(!isReplay);
  }, [isReplay, onDismiss]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [skip]);

  const addFolders = useCallback(async () => {
    const picked = await props.pickDirectories();
    if (picked.length === 0) return;
    const merged = [...roots];
    for (const p of picked) if (!merged.includes(p)) merged.push(p);
    setRoots(merged);
    await props.onSetRoots(profile.id, merged);
  }, [profile.id, props, roots]);

  const removeRoot = useCallback(
    async (root: string) => {
      const next = roots.filter((r) => r !== root);
      setRoots(next);
      await props.onSetRoots(profile.id, next);
    },
    [profile.id, props, roots]
  );

  const nextLabel =
    step === "welcome"
      ? "Start"
      : step === "folders-explain"
        ? "Choose folders"
        : step === "folders-pick"
          ? roots.length === 0
            ? "Continue without folders"
            : `Scan ${roots.length} ${roots.length === 1 ? "folder" : "folders"}`
          : step === "folders-scan"
            ? "See the result"
            : step === "done"
              ? "Start working"
              : "Continue";

  return (
    <div
      className="onboarding-wizard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="First-run setup"
    >
      <div className="onboarding-wizard-overlay__scrim" />
      {/* One frame width across every step. PwrAgnt narrowed Welcome and Done
          first and reverted: the jump between a cozy and an expansive canvas
          was jarring as the operator advanced. */}
      <div className="onboarding-wizard">
        <header className="onboarding-wizard__titlebar">
          <span className="onboarding-wizard__eyebrow">Setup</span>
          <span className="onboarding-wizard__sep">/</span>
          <span className="onboarding-wizard__crumb">{crumbFor(step)}</span>
          <span className="onboarding-wizard__spacer" />
          <button
            type="button"
            className="onboarding-wizard__close"
            aria-label="Close setup"
            onClick={skip}
          >
            ✕
          </button>
        </header>

        {railIndex >= 0 && (
          <nav className="onboarding-wizard__rail" aria-label="Setup progress">
            {RAIL_LABELS.map((_, i) => {
              const state =
                i < railIndex ? "done" : i === railIndex ? "current" : "pending";
              return (
                <div
                  key={i}
                  className={`onboarding-wizard__rail-step is-${state}`}
                  {...(state === "current" ? { "aria-current": "step" } : {})}
                >
                  <div className="onboarding-wizard__rail-num">
                    {state === "done"
                      ? `Step ${i + 1} ✓`
                      : i === 3
                        ? "Done"
                        : `Step ${i + 1}`}
                  </div>
                  <div className="onboarding-wizard__rail-label">
                    {railLabel(i, railIndex, answers)}
                  </div>
                </div>
              );
            })}
          </nav>
        )}

        <div className="onboarding-wizard__body">
          {step === "welcome" && <WelcomeStep />}
          {step === "identity" && (
            <IdentityStep
              profileName={profile.name}
              authorName={authorName}
              email={email}
              identity={identity}
              onAuthorName={setAuthorName}
              onEmail={setEmail}
            />
          )}
          {step === "forges" && <ForgesStep forges={forges} />}
          {step === "folders-explain" && <ScanExplainerStep />}
          {step === "folders-pick" && (
            <FolderPickStep
              roots={roots}
              onAdd={() => void addFolders()}
              onRemove={(r) => void removeRoot(r)}
            />
          )}
          {step === "folders-scan" && (
            <ScanResultStep roots={roots} repos={repos} />
          )}
          {step === "done" && <DoneStep roots={roots} repos={repos} />}
        </div>

        <footer className="onboarding-wizard__footer">
          <button
            type="button"
            className="onboarding-wizard__btn onboarding-wizard__btn--link"
            onClick={skip}
          >
            {step === "done" ? "Replay this later from Help" : "Skip setup"}
          </button>
          <span className="onboarding-wizard__spacer" />
          {step !== "welcome" && (
            <button
              type="button"
              className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
              onClick={goBack}
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="onboarding-wizard__btn onboarding-wizard__btn--primary"
            disabled={busy || (step === "identity" && !identityComplete)}
            onClick={() => void advance()}
          >
            {nextLabel} →
          </button>
        </footer>
      </div>
    </div>
  );
}

function crumbFor(step: WizardStep): string {
  if (step === "welcome") return "Welcome";
  if (step === "identity") return "Step 1 — Identity";
  if (step === "forges") return "Step 2 — Forges";
  if (step === "done") return "Done";
  return "Step 3 — Repo folders";
}

function WelcomeStep() {
  return (
    <div className="onboarding-wizard__welcome">
      <div className="onboarding-wizard__brand">
        Pwr<span>Git</span>
      </div>
      <h1 className="onboarding-wizard__title onboarding-wizard__title--center">
        Point PwrGit at your code, and it does the finding.
      </h1>
      <p className="onboarding-wizard__sub onboarding-wizard__sub--center">
        Three short steps: who your commits come from, which forges you are
        signed in to, and which folders hold your repositories. The third one is
        the whole app — PwrGit walks the folders you name and indexes every git
        checkout under them, including every worktree.
      </p>
    </div>
  );
}

function IdentityStep(props: {
  profileName: string;
  authorName: string;
  email: string;
  identity: GitIdentityRead | null;
  onAuthorName: (v: string) => void;
  onEmail: (v: string) => void;
}) {
  const { identity } = props;
  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          Commits from this profile will be signed off as…
        </h1>
        <p className="onboarding-wizard__sub">
          This is the author line git writes on every commit you make in
          PwrGit. It is <b>not</b> your PwrGit profile name — that one is a
          workspace label, and it stays &ldquo;{props.profileName}&rdquo;
          whatever you put here.
        </p>
      </div>
      <div className="onboarding-wizard__field-row">
        <label className="onboarding-wizard__field">
          <span className="onboarding-wizard__field-label">Author name</span>
          <input
            className="onboarding-wizard__input"
            value={props.authorName}
            placeholder="Your name"
            onChange={(e) => props.onAuthorName(e.target.value)}
          />
          <span className="onboarding-wizard__field-sub">
            {identity?.name !== null && identity?.name !== undefined
              ? "from git config --get user.name"
              : "git has no user.name set"}
          </span>
        </label>
        <label className="onboarding-wizard__field">
          <span className="onboarding-wizard__field-label">Author e-mail</span>
          <input
            className="onboarding-wizard__input"
            value={props.email}
            placeholder="you@example.com"
            onChange={(e) => props.onEmail(e.target.value)}
          />
          <span className="onboarding-wizard__field-sub">
            {identity?.email !== null && identity?.email !== undefined
              ? "from git config --get user.email"
              : "git has no user.email set"}
          </span>
        </label>
      </div>
      {identity !== null && identity.conditionalDirs.length > 0 && (
        <div className="onboarding-wizard__notice">
          <span aria-hidden="true">ⓘ</span>
          <div>
            Your <code>~/.gitconfig</code> sets a different identity for
            repositories under{" "}
            {identity.conditionalDirs.map((d, i) => (
              <span key={d}>
                {i > 0 ? ", " : ""}
                <code>{d}</code>
              </span>
            ))}
            . PwrGit does not override it — commits there keep that identity.
            This name and e-mail are the default everywhere else.
          </div>
        </div>
      )}
      <p className="onboarding-wizard__hint">
        Changing these here writes them to this PwrGit profile only. Your global{" "}
        <code>~/.gitconfig</code> is not edited.
      </p>
    </div>
  );
}

function ForgesStep(props: { forges: ReturnType<typeof useForgeStatuses> }) {
  const { forges } = props;
  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          Where PwrGit reads pull and merge requests from.
        </h1>
        <p className="onboarding-wizard__sub">
          Optional. Without a forge, PwrGit still finds, branches, commits and
          pushes — you just will not see change-request state on a row. PwrGit
          reads through the CLIs you already have; it never asks for a token.
        </p>
      </div>
      <div className="onboarding-wizard__forges">
        {FORGE_KINDS.map((kind: ForgeKind) => {
          const status = forges?.find((f) => f.kind === kind);
          const state = forgeProductState(status);
          const product = forgeProduct(kind);
          const sentence = forgeStateSentence(kind, state);
          return (
            <div key={kind} className="onboarding-wizard__forge">
              <span
                className={`onboarding-wizard__forge-dot is-${state}`}
                aria-hidden="true"
              />
              <div className="onboarding-wizard__forge-main">
                <div className="onboarding-wizard__forge-name">
                  {product.label}
                </div>
                <div className="onboarding-wizard__forge-sentence">
                  {sentence ?? `Checking ${product.label}…`}
                </div>
              </div>
              {state === "signedOut" && (
                <code className="onboarding-wizard__forge-cmd">
                  {product.cli} auth login
                </code>
              )}
            </div>
          );
        })}
      </div>
      <p className="onboarding-wizard__hint">
        PwrGit cannot sign you in — <code>gh</code> and <code>glab</code> own
        that. Run the command in a terminal and this updates itself. All of it
        lives in Settings › Forges afterwards.
      </p>
    </div>
  );
}

function ScanExplainerStep() {
  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          You name folders. PwrGit does the finding.
        </h1>
        <p className="onboarding-wizard__sub">
          You will not add repositories one at a time. Point PwrGit at the
          folder your code already lives in and it walks it, indexing every git
          checkout it meets — and every worktree each one owns.
        </p>
      </div>
      <ol className="onboarding-wizard__rules">
        <li>
          <b>It looks five levels down.</b> From the folder you add, PwrGit
          descends up to five levels looking for a <code>.git</code> entry. Once
          it finds one it stops there — it does not walk around inside your
          repositories.
        </li>
        <li>
          <b>Hidden folders are never opened.</b> Anything whose name starts
          with a dot is skipped outright — <code>.ssh</code>,{" "}
          <code>.config</code>, <code>.aws</code>, <code>.gnupg</code>. PwrGit
          does not look in them, so adding your home folder cannot reach your
          keys.
        </li>
        <li>
          <b>It reads folder names, not files.</b> The scan lists directory
          entries and checks for <code>.git</code>. It never opens, reads,
          copies or sends the contents of anything.
        </li>
      </ol>
      <div className="onboarding-wizard__notice">
        <span aria-hidden="true">ⓘ</span>
        <div>
          Also skipped, at every level: <code>node_modules</code>,{" "}
          <code>dist</code>, <code>out</code>, <code>build</code>,{" "}
          <code>target</code>, <code>vendor</code>, <code>.cache</code> and
          macOS <code>Library</code>.
        </div>
      </div>
    </div>
  );
}

function FolderPickStep(props: {
  roots: string[];
  onAdd: () => void;
  onRemove: (root: string) => void;
}) {
  const homeish = props.roots.some((r) => /^([A-Za-z]:)?[/\\]?Users?[/\\][^/\\]+[/\\]?$/.test(r));
  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          Which folders hold your repositories?
        </h1>
        <p className="onboarding-wizard__sub">
          Add as many as you like. Most people have one; a work machine often
          has two. Nesting is expected — <code>~/github/org/repo</code> all
          comes from adding <code>~/github</code> once.
        </p>
      </div>
      <ul className="onboarding-wizard__roots">
        {props.roots.map((root) => (
          <li key={root} className="onboarding-wizard__root">
            <span className="onboarding-wizard__root-path" title={root}>
              {root}
            </span>
            <button
              type="button"
              className="onboarding-wizard__root-remove"
              aria-label={`Remove ${root}`}
              onClick={() => props.onRemove(root)}
            >
              ✕
            </button>
          </li>
        ))}
        {props.roots.length === 0 && (
          <li className="onboarding-wizard__roots-empty">
            No folders yet. Add one below — PwrGit has nothing to show until you
            do.
          </li>
        )}
      </ul>
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
        onClick={props.onAdd}
      >
        + Add a folder…
      </button>
      {homeish && (
        <div className="onboarding-wizard__notice onboarding-wizard__notice--warn">
          <span aria-hidden="true">⚠</span>
          <div>
            <b>Adding your home folder works, and we would not.</b> It holds
            thousands of directories that are not code, and PwrGit walks past
            all of them on every rescan. A dedicated parent —{" "}
            {SUGGESTED_ROOTS.map((s) => (
              <span key={s}>
                <code>~/{s}</code>{" "}
              </span>
            ))}
            — keeps the scan quick and the sidebar honest: the folder you add
            becomes a group heading.
          </div>
        </div>
      )}
    </div>
  );
}

function ScanResultStep(props: { roots: string[]; repos: Repo[] }) {
  const { roots, repos } = props;
  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          {repos.length === 0
            ? "Nothing found yet."
            : `Found ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}.`}
        </h1>
        <p className="onboarding-wizard__sub">
          Per-repository git state — ahead, behind, uncommitted — is read when
          you first open a repo, not now. That is why the Focused, Behind and
          Stale lenses stay empty until you have looked around.
        </p>
      </div>
      <ul className="onboarding-wizard__roots">
        {roots.map((root) => {
          const count = repos.filter((r) => r.path.startsWith(root)).length;
          return (
            <li key={root} className="onboarding-wizard__root">
              <span className="onboarding-wizard__root-path">{root}</span>
              <span className="onboarding-wizard__root-count">
                {count} {count === 1 ? "repo" : "repos"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DoneStep(props: { roots: string[]; repos: Repo[] }) {
  const { roots, repos } = props;
  const worktrees = repos.reduce((n, r) => n + r.worktrees.length, 0);
  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          {repos.length === 0
            ? "No repositories yet."
            : `${repos.length} ${repos.length === 1 ? "repository" : "repositories"}, ${worktrees} ${worktrees === 1 ? "worktree" : "worktrees"}, ${roots.length} ${roots.length === 1 ? "folder" : "folders"}.`}
        </h1>
        <p className="onboarding-wizard__sub">
          This is your sidebar. It rescans on its own once a day, and whenever
          you ask it to.
        </p>
      </div>
      {/* Only what a scan knows. Per-worktree state is computed lazily on
          expand and nothing is pinned by a scan, so the four lenses that
          depend on either are described rather than counted. */}
      <div className="onboarding-wizard__lens-key">
        <div className="onboarding-wizard__choice-eyebrow">
          What the five chips will mean
        </div>
        <ul>
          <li>
            <b>Focused</b> — what you touched, pinned or changed in the last 30
            days. Empty until you start working.
          </li>
          <li>
            <b>Pinned</b> — what you star. Nothing yet; a scan does not pin
            anything for you.
          </li>
          <li>
            <b>Behind</b> — behind its upstream. Known once a repo has been
            opened or fetched.
          </li>
          <li>
            <b>Stale</b> — worktrees safe to prune: clean, merged, untouched for
            two weeks.
          </li>
          <li>
            <b>All</b> — everything the scan found. The one lens that is right
            from the first second, which is why you are standing in it.
          </li>
        </ul>
      </div>
      {roots.length > 0 && (
        <p className="onboarding-wizard__hint">
          Grouped by the folder you added:{" "}
          {roots.map((r, i) => (
            <span key={r}>
              {i > 0 ? ", " : ""}
              <b>{pathLeaf(r).toUpperCase()}</b>
            </span>
          ))}
          .
        </p>
      )}
    </div>
  );
}
