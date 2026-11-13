import { useEffect, useMemo, useRef, type ReactElement } from "react";
import type { Profile } from "@pwrgit/shared";
import { CloneGlyph } from "../../lib/CloneGlyph";
import { FolderGlyph } from "../../lib/FolderGlyph";
import { SearchGlyph } from "../../lib/SearchGlyph";
import { useModal } from "../../lib/useModal";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { tildeFor, useSuggestedRoots } from "./NewRootPicker";
import { RAIL_LABELS, railIndexForStep, type Unanswered, type WizardStep } from "./steps";
import { RepoSearchView, addFoldersLabel, useRepoSearch, type RepoSearch } from "./RepoSearch";

/**
 * The start screen: what the main pane says when the profile has no
 * repositories (design/New User Journey - UX Review, turn 4). It is a state of
 * the window, not part of the wizard, so it is there after a skip, after
 * removing the last folder, and on a second profile. Drawn from the profile
 * having no repositories, never from the current lens being empty.
 *
 * The doors are the wizard's, so closing the wizard loses nothing. "New
 * repository…" joins them (card 4a's fourth door) once it exists.
 */
export type StartScreenProps = {
  profile: Profile;
  /** The profile's folders are being scanned and nothing has turned up yet. */
  scanning: boolean;
  /** Find my repositories is open in the pane. */
  searching: boolean;
  onSearchingChange: (open: boolean) => void;
  onAddFolders: () => void;
  onClone: () => void;
  onSetRoots: (profileId: string, roots: string[]) => Promise<unknown>;
  /** What setup left unanswered; empty hides Finish setup. */
  unanswered: Unanswered[];
  onFinishSetup: (step: WizardStep) => void;
};

export function StartScreen(props: StartScreenProps): ReactElement {
  const { profile } = props;
  const suggested = useSuggestedRoots();
  const tilde = useMemo(() => tildeFor(suggested), [suggested]);
  const search = useRepoSearch(profile.id);
  const { start, reset } = search;
  const idle = search.state.status === "idle";
  // Opening Find (a door, or Add ▾ → Find repositories…) is the click the
  // search waits for; closing it stops a search still running.
  useEffect(() => {
    if (props.searching && idle) start(false);
    if (!props.searching && !idle) reset();
  }, [idle, props.searching, reset, start]);

  if (props.searching) {
    return (
      <div className="start-screen" data-testid="start-screen">
        <div className="start-screen__inner">
          <FindRepositories
            search={search}
            profile={profile}
            onSetRoots={props.onSetRoots}
            onChooseMyself={() => {
              props.onSearchingChange(false);
              props.onAddFolders();
            }}
            onDone={() => props.onSearchingChange(false)}
          />
        </div>
      </div>
    );
  }

  const roots = profile.roots;
  if (props.scanning && roots.length > 0) {
    return (
      <div className="start-screen" data-testid="start-screen">
        <div className="start-screen__inner" role="status" aria-live="polite">
          <h1 className="start-screen__title">
            Looking in {roots.length === 1 ? tilde(roots[0]!) : `${roots.length} folders`}…
          </h1>
        </div>
      </div>
    );
  }

  const find = () => props.onSearchingChange(true);
  const findDoor = (body: string, primary: boolean) => (
    <Door key="find" primary={primary} icon={<SearchGlyph size={15} />} title="Find my repositories" body={body} onClick={find} />
  );
  const addDoor = (body: string) => (
    <Door key="add" icon={<FolderGlyph size={15} />} title="Add folders…" body={body} onClick={props.onAddFolders} />
  );

  // 4b: folders, but nothing in them. Putting something in comes first.
  if (roots.length > 0) {
    const only = roots.length === 1 ? tilde(roots[0]!) : null;
    return (
      <div className="start-screen" data-testid="start-screen">
        <div className="start-screen__inner">
          <h1 className="start-screen__title">
            {only !== null ? `Nothing in ${only} yet` : `Nothing in your ${roots.length} folders yet`}
          </h1>
          <p className="start-screen__sub">
            PwrGit looked five levels into{" "}
            {only !== null ? <code>{only}</code> : "them"} and found no
            repositories. Anything added there appears on its own.
          </p>
          <div className="start-doors">
            <Door
              primary
              icon={<CloneGlyph size={15} />}
              title={only !== null ? `Clone into ${only}…` : "Clone a repository…"}
              body="From GitHub, GitLab, or any URL."
              onClick={props.onClone}
            />
            {findDoor("They may be in another folder.", false)}
            {addDoor("Choose another folder.")}
          </div>
          <FinishSetup unanswered={props.unanswered} onFinishSetup={props.onFinishSetup} />
        </div>
      </div>
    );
  }

  // 4a: no folders yet.
  return (
    <div className="start-screen" data-testid="start-screen">
      <div className="start-screen__inner">
        <h1 className="start-screen__title">Add your repositories</h1>
        <p className="start-screen__sub">
          PwrGit shows the repositories in the folders you give it. Start with
          whichever of these fits.
        </p>
        <div className="start-doors">
          {findDoor("Search your home folder and choose which folders to add.", true)}
          {addDoor("Choose the folders that hold your repositories.")}
          <Door
            icon={<CloneGlyph size={15} />}
            title="Clone a repository…"
            body="From GitHub, GitLab, or any URL."
            onClick={props.onClone}
          />
        </div>
        <FinishSetup unanswered={props.unanswered} onFinishSetup={props.onFinishSetup} />
      </div>
    </div>
  );
}

function Door(props: {
  title: string;
  body: string;
  icon: ReactElement;
  primary?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={`start-door${props.primary === true ? " is-primary" : ""}`}
      onClick={props.onClick}
    >
      <span className="start-door__icon">{props.icon}</span>
      <span className="start-door__title">{props.title}</span>
      <span className="start-door__body">{props.body}</span>
    </button>
  );
}

/** "No commit author and no forge sign-in yet." — only when something is
 *  unanswered, naming it, reopening the wizard at the first such step. */
function FinishSetup(props: {
  unanswered: Unanswered[];
  onFinishSetup: (step: WizardStep) => void;
}): ReactElement | null {
  const tip = useViewportTooltip();
  const first = props.unanswered[0];
  if (first === undefined) return null;
  const labels = props.unanswered.map((u) => u.label);
  const sentence = `${labels.join(" and ")} yet.`;
  const stepName = RAIL_LABELS[railIndexForStep(first.step)] ?? "setup";
  return (
    <div className="start-screen__setup">
      <span className="start-screen__setup-text">
        {sentence.charAt(0).toUpperCase() + sentence.slice(1)}
      </span>
      <button
        type="button"
        className="onboarding-wizard__btn"
        onClick={() => props.onFinishSetup(first.step)}
        {...hoverTooltip(tip, `Reopens setup at ${stepName}`)}
      >
        Finish setup
      </button>
      {tip.tooltipNode}
    </div>
  );
}

/** The search, its checklist, and the button that adds what is checked. */
function FindRepositories(props: {
  search: RepoSearch;
  profile: Profile;
  onSetRoots: (profileId: string, roots: string[]) => Promise<unknown>;
  onChooseMyself: () => void;
  onDone: () => void;
}): ReactElement {
  const { search, profile } = props;
  const add = () => {
    const merged = [...profile.roots];
    for (const path of search.checkedPaths()) if (!merged.includes(path)) merged.push(path);
    props.onDone();
    void props.onSetRoots(profile.id, merged);
  };
  const ready = search.state.status === "done" && search.state.checked.size > 0;
  return (
    <>
      <RepoSearchView search={search} onChooseMyself={props.onChooseMyself} />
      <div className="start-screen__actions">
        <button type="button" className="onboarding-wizard__btn onboarding-wizard__btn--ghost" onClick={props.onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--primary"
          disabled={!ready}
          onClick={add}
        >
          {addFoldersLabel(search.state)}
        </button>
      </div>
    </>
  );
}

/**
 * Add ▾ → Find repositories… on a profile that already has repositories:
 * "how someone with twelve folders finds the thirteenth" (card 4d). The same
 * search and checklist as the start screen, in a dialog.
 */
export function FindRepositoriesDialog(props: {
  profile: Profile;
  onSetRoots: (profileId: string, roots: string[]) => Promise<unknown>;
  onChooseMyself: () => void;
  onClose: () => void;
}): ReactElement {
  const search = useRepoSearch(props.profile.id);
  const started = useRef(false);
  const { start } = search;
  useEffect(() => {
    // The menu item is the click the search waits for.
    if (started.current) return;
    started.current = true;
    start(false);
  }, [start]);
  const modalRef = useModal<HTMLDivElement>({ onClose: props.onClose });
  return (
    <div className="overlay-backdrop" onClick={props.onClose}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Find repositories"
        tabIndex={-1}
        className="modal find-repos"
        onClick={(e) => e.stopPropagation()}
      >
        <FindRepositories
          search={search}
          profile={props.profile}
          onSetRoots={props.onSetRoots}
          onChooseMyself={() => {
            props.onClose();
            props.onChooseMyself();
          }}
          onDone={props.onClose}
        />
      </div>
    </div>
  );
}
