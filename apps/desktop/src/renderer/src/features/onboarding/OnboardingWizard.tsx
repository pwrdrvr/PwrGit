import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  SUGGESTED_ROOTS,
  forgeProduct,
  type GitIdentityRead,
  type NewRootChoice,
  type Profile,
  type Repo,
  type SuggestedRoot
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { pathLeaf } from "../../lib/platform";
import { forgeProductState } from "../settings/ForgeProductSection";
import { useForgeStatuses } from "../settings/useForgeStatuses";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import {
  RAIL_LABELS,
  nextStep,
  previousStep,
  railIndexForStep,
  railLabel,
  type RepoChoice,
  type WizardStep
} from "./steps";
import { ForgesStep } from "./ForgesStep";
import { CloseGlyph } from "../../lib/CloseGlyph";
import { CheckGlyph } from "../../lib/CheckGlyph";
import { CloneGlyph } from "../../lib/CloneGlyph";
import { InfoGlyph } from "../../lib/InfoGlyph";
import { WarningGlyph } from "../../lib/WarningGlyph";
import { RepoSearchView, addFoldersLabel, useRepoSearch } from "./RepoSearch";
import { NewRootPicker, tildeFor, useSuggestedRoots } from "./NewRootPicker";

export type OnboardingWizardProps = {
  profile: Profile;
  /** The scan's result, for the Done screen. Only what a scan knows is drawn. */
  repos: Repo[];
  /** Help-menu replay: show the wizard without persisting completion. */
  isReplay: boolean;
  /** Where to open: Welcome, or the first step "Finish setup" named. */
  initialStep?: WizardStep;
  pickDirectories: () => Promise<string[]>;
  onSetRoots: (profileId: string, roots: string[]) => Promise<unknown>;
  onSetIdentity: (
    profileId: string,
    identity: { authorName: string; email: string }
  ) => Promise<void>;
  /** Clear the overlay. `persistCompleted` is false only for a replay. */
  onDismiss: (persistCompleted: boolean) => void;
  /** Done with no repositories: close and open the clone dialog (card 3c). */
  onOpenClone?: () => void;
};

export function OnboardingWizard(props: OnboardingWizardProps) {
  const { profile, repos, isReplay, onDismiss } = props;
  const [step, setStep] = useState<WizardStep>(props.initialStep ?? "welcome");
  const [choice, setChoice] = useState<RepoChoice>("find");
  const [identity, setIdentity] = useState<GitIdentityRead | null>(null);
  const [authorName, setAuthorName] = useState(profile.authorName ?? "");
  const [email, setEmail] = useState(profile.email);
  const [roots, setRoots] = useState<string[]>(profile.roots);
  const [busy, setBusy] = useState(false);
  /** Scans started by this wizard that have not reported yet. */
  const [scansPending, setScansPending] = useState(0);
  const [homeChoice, setHomeChoice] = useState<NewRootChoice>({
    kind: "suggested",
    name: SUGGESTED_ROOTS[0]
  });
  const [homeError, setHomeError] = useState<string | null>(null);
  const forges = useForgeStatuses();
  const search = useRepoSearch(profile.id);
  const suggested = useSuggestedRoots();
  const tilde = useMemo(() => tildeFor(suggested), [suggested]);

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

  /** Save the folders and scan them. The scan step says it is scanning until
   *  this reports. */
  const saveRoots = useCallback(
    async (next: string[]) => {
      setRoots(next);
      setScansPending((n) => n + 1);
      try {
        await props.onSetRoots(profile.id, next);
      } finally {
        setScansPending((n) => n - 1);
      }
    },
    [profile.id, props]
  );

  const finish = useCallback(async () => {
    setBusy(true);
    try {
      // Identity no longer blocks Continue (card 3d), so a half-filled pair is
      // not written: the start screen names what is still missing instead.
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

  const addFolders = useCallback(async () => {
    const picked = await props.pickDirectories();
    if (picked.length === 0) return;
    const merged = [...roots];
    for (const p of picked) if (!merged.includes(p)) merged.push(p);
    await saveRoots(merged);
  }, [props, roots, saveRoots]);

  const removeRoot = useCallback(
    async (root: string) => {
      await saveRoots(roots.filter((r) => r !== root));
    },
    [roots, saveRoots]
  );

  /** Go to one of step 3's answers, doing what its button promised. */
  const enterChoice = useCallback(
    (picked: RepoChoice) => {
      setChoice(picked);
      if (picked === "find") {
        setStep("repos-find");
        search.start(false);
      } else if (picked === "pick") {
        setStep("repos-pick");
        void addFolders();
      } else {
        setStep("repos-home");
      }
    },
    [addFolders, search]
  );

  const createHomeFolder = useCallback(async () => {
    setBusy(true);
    setHomeError(null);
    try {
      const result = await dispatch("profile:createRoot", {
        profileId: profile.id,
        root: homeChoice
      });
      if (!result.ok) {
        setHomeError(result.error.message);
        return;
      }
      setRoots((prev) => (prev.includes(result.value.path) ? prev : [...prev, result.value.path]));
      setStep("done");
    } finally {
      setBusy(false);
    }
  }, [homeChoice, profile.id]);

  const advance = useCallback(() => {
    if (step === "repos-choose") {
      enterChoice(choice);
      return;
    }
    if (step === "repos-find") {
      const add = search.checkedPaths();
      const merged = [...roots];
      for (const p of add) if (!merged.includes(p)) merged.push(p);
      setStep("repos-scan");
      void saveRoots(merged);
      return;
    }
    if (step === "repos-home") {
      void createHomeFolder();
      return;
    }
    const next = nextStep(step, choice);
    if (next === null) {
      void finish();
      return;
    }
    setStep(next);
  }, [choice, createHomeFolder, enterChoice, finish, roots, saveRoots, search, step]);

  const goBack = useCallback(() => {
    const prev = previousStep(step, choice);
    if (prev === null) return;
    if (step === "repos-find") search.reset();
    setStep(prev);
  }, [choice, search, step]);

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

  const scanning = scansPending > 0;
  const noRepos = repos.length === 0 && !scanning;
  const nextLabel = (() => {
    switch (step) {
      case "welcome":
        return "Start";
      case "repos-choose":
        return choice === "find"
          ? "Find my repositories"
          : choice === "pick"
            ? "Choose folders…"
            : "Pick a folder";
      case "repos-find":
        return addFoldersLabel(search.state);
      case "repos-pick":
        return roots.length === 0
          ? "Continue without folders"
          : `Scan ${roots.length} ${roots.length === 1 ? "folder" : "folders"}`;
      case "repos-home":
        return homeActionLabel(homeChoice, suggested, tilde);
      case "repos-scan":
        return "See the result";
      case "done":
        return noRepos ? "Close" : "Start working";
      default:
        return "Continue";
    }
  })();
  const nextDisabled =
    busy ||
    (step === "repos-find" &&
      (search.state.status !== "done" || search.state.checked.size === 0));

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
            <CloseGlyph />
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
                    {state === "done" ? (
                      <>
                        Step {i + 1} <CheckGlyph size={9} />
                      </>
                    ) : i === 3
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
          {step === "repos-choose" && (
            <RepoChoiceStep choice={choice} onChoice={setChoice} onPick={enterChoice} />
          )}
          {step === "repos-find" && (
            <RepoSearchView
              search={search}
              onChooseMyself={() => enterChoice("pick")}
              onNoneYet={() => enterChoice("home")}
            />
          )}
          {step === "repos-pick" && (
            <FolderPickStep
              roots={roots}
              onAdd={() => void addFolders()}
              onRemove={(r) => void removeRoot(r)}
            />
          )}
          {step === "repos-home" && (
            <HomeFolderStep
              suggested={suggested}
              tilde={tilde}
              choice={homeChoice}
              onChoice={(c) => {
                setHomeChoice(c);
                setHomeError(null);
              }}
              pickDirectories={props.pickDirectories}
              error={homeError}
            />
          )}
          {step === "repos-scan" && (
            <ScanResultStep
              roots={roots}
              repos={repos}
              scanning={scanning}
              onFind={() => enterChoice("find")}
            />
          )}
          {step === "done" &&
            (noRepos ? (
              <NoRepositoriesDone
                roots={roots}
                tilde={tilde}
                forgeSummary={forgeSummary}
                {...(props.onOpenClone === undefined
                  ? {}
                  : {
                      onClone: () => {
                        void finish().then(() => props.onOpenClone?.());
                      }
                    })}
              />
            ) : (
              <DoneStep roots={roots} repos={repos} />
            ))}
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
            disabled={nextDisabled}
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
  return "Step 3 — Repositories";
}

/** "Create ~/projects" for a folder that is not there yet, else "Use …". */
function homeActionLabel(
  choice: NewRootChoice,
  suggested: SuggestedRoot[] | null,
  tilde: (path: string) => string
): string {
  if (choice.kind === "picked") return `Use ${tilde(choice.path)}`;
  const root = suggested?.find((s) => s.name === choice.name);
  const display = root?.display ?? `~/${choice.name}`;
  return root !== undefined && root.exists ? `Use ${display}` : `Create ${display}`;
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
          <span className="onboarding-wizard__notice-icon" aria-hidden="true">
            <InfoGlyph />
          </span>
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
        <code>~/.gitconfig</code> is not edited. Leave either blank to set it
        later; the start screen will remind you.
      </p>
    </div>
  );
}

const CHOICES: ReadonlyArray<{
  value: RepoChoice;
  eyebrow: string;
  title: string;
  body: string;
}> = [
  {
    value: "find",
    eyebrow: "Recommended",
    title: "Find them for me",
    body: "Looks through your home folder, three levels down, and shows you the folders that hold repositories. You pick which to add."
  },
  {
    value: "pick",
    eyebrow: "I know where",
    title: "I will choose the folders",
    body: "Opens the folder picker. Add as many as you like."
  },
  {
    value: "home",
    eyebrow: "New here",
    title: "I do not have any on this computer",
    body: "Pick a folder for them to live in. Then clone from your account."
  }
];

/** Step 3 opens on a choice, with the search as the default (card 3a). The
 *  scan's rules, once a page of their own, sit behind a link. */
function RepoChoiceStep(props: {
  choice: RepoChoice;
  onChoice: (choice: RepoChoice) => void;
  onPick: (choice: RepoChoice) => void;
}): ReactElement {
  const [rulesOpen, setRulesOpen] = useState(false);
  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">Where are your repositories?</h1>
        <p className="onboarding-wizard__sub">
          PwrGit works from folders. You name the folders your code lives in,
          and it finds every repository and worktree inside them, now and
          whenever one is added.
        </p>
      </div>
      <div className="repo-choice" role="radiogroup" aria-label="Where are your repositories?">
        {CHOICES.map((c) => (
          <label
            key={c.value}
            className={`repo-choice__card${props.choice === c.value ? " is-selected" : ""}`}
            onDoubleClick={() => props.onPick(c.value)}
          >
            <input
              type="radio"
              name="repo-choice"
              className="repo-choice__input"
              value={c.value}
              checked={props.choice === c.value}
              onChange={() => props.onChoice(c.value)}
            />
            <span className="repo-choice__eyebrow">{c.eyebrow}</span>
            <span className="repo-choice__title">{c.title}</span>
            <span className="repo-choice__body">{c.body}</span>
          </label>
        ))}
      </div>
      <div className="onboarding-wizard__notice">
        <span className="onboarding-wizard__notice-icon" aria-hidden="true">
          <InfoGlyph />
        </span>
        <div>
          <b>The search reads folder names, not your files.</b> It skips hidden
          folders, so it cannot reach <code>.ssh</code> or <code>.aws</code>,
          and it asks before opening Documents, Desktop or Downloads.{" "}
          <button
            type="button"
            className="onboarding-wizard__inline-link"
            aria-expanded={rulesOpen}
            onClick={() => setRulesOpen((open) => !open)}
          >
            What it opens and what it never does
          </button>
        </div>
      </div>
      {rulesOpen && <ScanRules />}
    </div>
  );
}

/** The rules page that used to be a step of its own. */
function ScanRules(): ReactElement {
  return (
    <ol className="onboarding-wizard__rules">
      <li>
        <b>The search looks three levels into your home folder.</b> It lists
        folder names and checks for <code>.git</code>. It proposes the folders
        that hold repositories and adds nothing until you say so.
      </li>
      <li>
        <b>Neither the search nor the scan looks inside a repository.</b> Once
        either finds a <code>.git</code> it stops there, so worktrees and
        submodules kept inside a repository are never opened.
      </li>
      <li>
        <b>Hidden folders are never opened.</b> Anything whose name starts with
        a dot is skipped outright — <code>.ssh</code>, <code>.config</code>,{" "}
        <code>.aws</code>, <code>.gnupg</code> — and so are{" "}
        <code>node_modules</code>, <code>dist</code>, <code>out</code>,{" "}
        <code>build</code>, <code>target</code>, <code>vendor</code> and macOS{" "}
        <code>Library</code>.
      </li>
      <li>
        <b>A folder you add is scanned five levels down</b>, now and whenever
        something is added to it. It reads folder names, not files: it never
        opens, reads, copies or sends the contents of anything.
      </li>
    </ol>
  );
}

function FolderPickStep(props: {
  roots: string[];
  onAdd: () => void;
  onRemove: (root: string) => void;
}) {
  const tip = useViewportTooltip();
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
            <span
              className="onboarding-wizard__root-path"
              {...hoverTooltip(tip, root)}
            >
              {root}
            </span>
            <button
              type="button"
              className="onboarding-wizard__root-remove"
              aria-label={`Remove ${root}`}
              onClick={() => props.onRemove(root)}
            >
              <CloseGlyph />
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
          <span className="onboarding-wizard__notice-icon" aria-hidden="true">
            <WarningGlyph />
          </span>
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
      {tip.tooltipNode}
    </div>
  );
}

/** "I do not have any": pick where they will live (card 3b). */
function HomeFolderStep(props: {
  suggested: SuggestedRoot[] | null;
  tilde: (path: string) => string;
  choice: NewRootChoice;
  onChoice: (choice: NewRootChoice) => void;
  pickDirectories: () => Promise<string[]>;
  error: string | null;
}): ReactElement {
  const { choice, suggested, tilde } = props;
  const chosen =
    choice.kind === "suggested"
      ? suggested?.find((s) => s.name === choice.name)
      : undefined;
  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">Pick a folder for your repositories.</h1>
        <p className="onboarding-wizard__sub">
          PwrGit creates it if it is not there yet, and watches it. Everything
          you clone goes in here unless you say otherwise.
        </p>
      </div>
      <NewRootPicker
        choice={choice}
        onChoice={props.onChoice}
        pickDirectories={props.pickDirectories}
        suggested={suggested}
        tilde={tilde}
        name="home-root"
      />
      <p className="onboarding-wizard__hint" role="status">
        {props.error !== null ? (
          <span className="new-root__error">{props.error}</span>
        ) : choice.kind === "picked" ? (
          <>
            <code>{tilde(choice.path)}</code> will be added to this profile.
          </>
        ) : chosen === undefined ? null : chosen.exists ? (
          <>
            <code>{chosen.display}</code> already exists. PwrGit will add it and
            look inside.
          </>
        ) : (
          <>
            <code>{chosen.display}</code> does not exist yet. PwrGit will create
            it when you continue.
          </>
        )}
      </p>
    </div>
  );
}

function ScanResultStep(props: {
  roots: string[];
  repos: Repo[];
  scanning: boolean;
  onFind: () => void;
}) {
  const { roots, repos, scanning } = props;
  const folders = `${roots.length} ${roots.length === 1 ? "folder" : "folders"}`;
  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title" role="status">
          {scanning
            ? `Scanning ${folders}…`
            : roots.length === 0
              ? "No folders added."
              : repos.length === 0
                ? `Nothing found in ${roots.length === 1 ? "that folder" : `those ${folders}`}.`
                : `Found ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}.`}
        </h1>
        <p className="onboarding-wizard__sub">
          {scanning
            ? "PwrGit is looking five levels into each folder for repositories and their worktrees."
            : "Per-repository git state — ahead, behind, uncommitted — is read when you first open a repo, not now. That is why the Focused, Behind and Stale lenses stay empty until you have looked around."}
        </p>
      </div>
      <ul className="onboarding-wizard__roots">
        {roots.map((root) => {
          const count = repos.filter((r) => r.path.startsWith(root)).length;
          return (
            <li key={root} className="onboarding-wizard__root">
              <span className="onboarding-wizard__root-path">{root}</span>
              <span className="onboarding-wizard__root-count">
                {scanning ? "scanning…" : `${count} ${count === 1 ? "repo" : "repos"}`}
              </span>
            </li>
          );
        })}
      </ul>
      {!scanning && repos.length === 0 && (
        <button type="button" className="onboarding-wizard__btn" onClick={props.onFind}>
          Find my repositories instead
        </button>
      )}
    </div>
  );
}

/** Done, when there are no repositories: next moves, not a key to empty
 *  chips (card 3c). New repository… joins here once it exists. */
function NoRepositoriesDone(props: {
  roots: string[];
  tilde: (path: string) => string;
  forgeSummary: string | null;
  onClone?: () => void;
}): ReactElement {
  const { roots } = props;
  const only = roots.length === 1 ? roots[0]! : null;
  const signedIn =
    props.forgeSummary !== null && props.forgeSummary !== "None"
      ? `Signed in to ${props.forgeSummary}. Search your repositories or paste a URL.`
      : "From GitHub, GitLab, or any URL.";
  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          {only !== null
            ? `${props.tilde(only)} is ready. Put a repository in it.`
            : roots.length > 1
              ? `Nothing in your ${roots.length} folders yet.`
              : "No repositories yet."}
        </h1>
        <p className="onboarding-wizard__sub">
          {roots.length > 0
            ? `Whatever lands in ${roots.length === 1 ? "this folder" : "these folders"} shows up in the sidebar on its own.`
            : "The start screen keeps every way to add them, whenever you are ready."}
        </p>
      </div>
      {props.onClone !== undefined && (
        <div className="start-doors">
          <button type="button" className="start-door is-primary" onClick={props.onClone}>
            <span className="start-door__icon"><CloneGlyph size={15} /></span>
            <span className="start-door__title">Clone a repository…</span>
            <span className="start-door__body">{signedIn}</span>
          </button>
        </div>
      )}
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
          {`${repos.length} ${repos.length === 1 ? "repository" : "repositories"}, ${worktrees} ${worktrees === 1 ? "worktree" : "worktrees"}, ${roots.length} ${roots.length === 1 ? "folder" : "folders"}.`}
        </h1>
        <p className="onboarding-wizard__sub">
          This is your sidebar. A repository added to these folders shows up
          on its own, and Rescan folders in the Add menu looks right away.
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
