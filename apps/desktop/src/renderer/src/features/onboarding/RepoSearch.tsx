import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  initiallyChecked,
  repositoriesInFolders,
  type ProposedFolder,
  type RepoSearchResult
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { FolderGlyph } from "../../lib/FolderGlyph";
import { SearchGlyph } from "../../lib/SearchGlyph";

/**
 * Find my repositories, as the renderer runs it: one search at a time from
 * this view, started only by a click (the search is a button, never
 * automatic), and nothing added until the host's primary button adds the
 * checked folders. Design: `design/New User Journey - UX Review.dc.html`,
 * cards 2b and 2c. Main decides how many searches run; a second start from
 * this window supersedes the first there too.
 */
export type RepoSearchState =
  | { status: "idle" }
  | {
      status: "running";
      searchId: string;
      foldersOpened: number;
      repositoriesFound: number;
    }
  | {
      status: "done";
      result: RepoSearchResult;
      checked: ReadonlySet<string>;
      /** Repositories and folders as the list opened, for the headline: it
       *  does not jump as boxes are ticked. */
      headline: { repositories: number; folders: number };
    }
  | { status: "error"; message: string };

export type RepoSearch = {
  state: RepoSearchState;
  start: (includeProtected: boolean) => void;
  stop: () => void;
  toggle: (path: string) => void;
  /** The checked folders, in list order. */
  checkedPaths: () => string[];
  reset: () => void;
};

export function useRepoSearch(profileId: string): RepoSearch {
  const [state, setState] = useState<RepoSearchState>({ status: "idle" });
  const current = useRef<string | null>(null);

  useEffect(
    () =>
      subscribe("repo:searchProgress", (event) => {
        if (event.searchId !== current.current) return;
        setState((prev) =>
          prev.status === "running" && prev.searchId === event.searchId
            ? {
                ...prev,
                foldersOpened: event.foldersOpened,
                repositoriesFound: event.repositoriesFound
              }
            : prev
        );
      }),
    []
  );

  // A search still running when its view goes stops, so main is not left
  // walking for nobody.
  useEffect(
    () => () => {
      const id = current.current;
      current.current = null;
      if (id !== null) void dispatch("repo:stopSearch", { searchId: id });
    },
    []
  );

  const start = useCallback(
    (includeProtected: boolean) => {
      const searchId = window.crypto.randomUUID();
      current.current = searchId;
      setState({ status: "running", searchId, foldersOpened: 0, repositoriesFound: 0 });
      void dispatch("repo:searchHome", { searchId, profileId, includeProtected }).then(
        (answer) => {
          if (current.current !== searchId) return;
          current.current = null;
          if (answer.ok) {
            const checked = initiallyChecked(answer.value.folders);
            setState({
              status: "done",
              result: answer.value,
              checked,
              headline: {
                repositories: repositoriesInFolders(answer.value.folders, checked),
                folders: checked.size
              }
            });
          } else if (answer.error.code !== "superseded") {
            setState({ status: "error", message: answer.error.message });
          }
        }
      );
    },
    [profileId]
  );

  const stop = useCallback(() => {
    const id = current.current;
    if (id !== null) void dispatch("repo:stopSearch", { searchId: id });
  }, []);

  const toggle = useCallback((path: string) => {
    setState((prev) => {
      if (prev.status !== "done") return prev;
      const folder = prev.result.folders.find((f) => f.path === path);
      if (folder === undefined || !folder.selectable) return prev;
      const checked = new Set(prev.checked);
      if (checked.has(path)) checked.delete(path);
      else checked.add(path);
      return { ...prev, checked };
    });
  }, []);

  const checkedPaths = useCallback(
    () =>
      state.status === "done"
        ? state.result.folders.filter((f) => state.checked.has(f.path)).map((f) => f.path)
        : [],
    [state]
  );

  const reset = useCallback(() => {
    const id = current.current;
    current.current = null;
    if (id !== null) void dispatch("repo:stopSearch", { searchId: id });
    setState({ status: "idle" });
  }, []);

  return { state, start, stop, toggle, checkedPaths, reset };
}

/** The primary button's words: it counts what is checked. */
export function addFoldersLabel(state: RepoSearchState): string {
  const n = state.status === "done" ? state.checked.size : 0;
  return `Add ${n} ${n === 1 ? "folder" : "folders"}`;
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** The part of a checkout's path under its proposed folder, `/`-separated. */
function under(folder: string, path: string): string {
  return path.slice(folder.length + 1).replace(/\\/g, "/");
}

function sample(names: string[]): string {
  if (names.length <= 3) {
    return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
  }
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** The count column of one row (card 2b). */
export function folderCount(folder: ProposedFolder): string {
  const repos = folder.repositories.filter((r) => r.indexable).length;
  if (folder.note?.kind === "worktrees-of" || folder.note?.kind === "bare") {
    return plural(folder.worktreeCount, "worktree", "worktrees");
  }
  return plural(repos, "repository", "repositories");
}

/** The detail column of one row: what is in it, or why it starts unchecked. */
export function folderDetail(folder: ProposedFolder, home: string): string {
  const tilde = (p: string): string =>
    p === home ? "~" : p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  switch (folder.note?.kind) {
    case "worktrees-of":
      return folder.note.repositoryFolders.length === 0
        ? "linked worktrees of repositories found elsewhere"
        : `of repositories in ${folder.note.repositoryFolders.map(tilde).join(", ")}, which already brings them in`;
    case "home-repository":
      return "part of the repository in your home folder";
    case "bare":
      return "worktrees of a bare repository, which PwrGit cannot show yet";
    case "added":
      return "already one of this profile’s folders";
    case "other-profile":
      return `overlaps ${tilde(folder.note.otherRoot)}, a folder of “${folder.note.profileName}”`;
    default:
      break;
  }
  if (folder.isRepository) return "this folder is the repository";
  const names = folder.repositories.map((r) =>
    folder.ownerFolders > 0 ? under(folder.path, r.checkouts[0] ?? r.name) : r.name
  );
  return folder.ownerFolders >= 2
    ? `in ${folder.ownerFolders} owner folders: ${sample(names)}`
    : sample(names);
}

export function RepoSearchView(props: {
  search: RepoSearch;
  /** Open the system folder picker instead. */
  onChooseMyself: () => void;
  /** "I do not have any yet", where the host has somewhere to send it. */
  onNoneYet?: () => void;
}): ReactElement {
  const { search, onChooseMyself, onNoneYet } = props;
  const { state } = search;

  if (state.status === "idle") return <></>;

  if (state.status === "running") {
    return (
      <div className="repo-search" aria-busy="true">
        <h1 className="onboarding-wizard__title">Looking in your home folder…</h1>
        <p className="onboarding-wizard__sub" role="status" aria-live="polite">
          {plural(state.foldersOpened, "folder", "folders")} opened,{" "}
          {plural(state.repositoriesFound, "repository", "repositories")} so far.
        </p>
        <div className="repo-search__actions">
          <button type="button" className="onboarding-wizard__btn" onClick={search.stop}>
            Stop and show what was found
          </button>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="repo-search">
        <h1 className="onboarding-wizard__title">The search could not run.</h1>
        <p className="onboarding-wizard__sub">{state.message}</p>
        <div className="repo-search__actions">
          <button type="button" className="onboarding-wizard__btn" onClick={() => search.start(false)}>
            Try again
          </button>
          <button type="button" className="onboarding-wizard__btn" onClick={onChooseMyself}>
            <FolderGlyph size={13} /> Choose folders myself…
          </button>
        </div>
      </div>
    );
  }

  const { result, checked, headline } = state;
  const canAskProtected =
    result.protectedAskFirst && !result.includedProtected && result.protectedSkipped.length > 0;
  const protectedNames = "Documents, Desktop and Downloads";
  const nothing = result.folders.length === 0;

  return (
    <div className="repo-search">
      {nothing ? (
        <>
          <h1 className="onboarding-wizard__title">
            {result.stoppedEarly === null
              ? "No repositories within three folders of home."
              : "No repositories found before the search stopped."}
          </h1>
          <p className="onboarding-wizard__sub">
            {canAskProtected ? `${protectedNames} were not searched. ` : ""}
            If your code is somewhere else, choose the folder.
          </p>
        </>
      ) : (
        <>
          <h1 className="onboarding-wizard__title">
            {headline.folders === 0
              ? `Found ${plural(result.folders.length, "folder", "folders")}, none of them to add.`
              : `Found ${plural(headline.repositories, "repository", "repositories")} in ${plural(headline.folders, "folder", "folders")}.`}
          </h1>
          <p className="onboarding-wizard__sub">
            Nothing is added until you say so. Each folder you add becomes a
            heading in the sidebar, and PwrGit keeps looking in it for new
            repositories.
          </p>
          <ul className="repo-search__list" aria-label="Folders that hold repositories">
            {result.folders.map((folder) => {
              const on = checked.has(folder.path);
              const id = `repo-search-${folder.path}`;
              return (
                <li
                  key={folder.path}
                  className={`repo-search__row${on ? " is-checked" : ""}${folder.selectable ? "" : " is-unavailable"}`}
                >
                  <input
                    id={id}
                    type="checkbox"
                    className="repo-search__check"
                    checked={on}
                    disabled={!folder.selectable}
                    onChange={() => search.toggle(folder.path)}
                  />
                  <label htmlFor={id} className="repo-search__label">
                    <span className="repo-search__path">{folder.display}</span>
                    <span className="repo-search__count">{folderCount(folder)}</span>
                    <span className="repo-search__detail">{folderDetail(folder, result.home)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="repo-search__actions">
        {canAskProtected && (
          <button
            type="button"
            className={`onboarding-wizard__btn${nothing ? " onboarding-wizard__btn--primary" : ""}`}
            onClick={() => search.start(true)}
          >
            <SearchGlyph size={13} /> {nothing ? "Look in" : "Also look in"} {protectedNames}
          </button>
        )}
        <button type="button" className="onboarding-wizard__btn" onClick={onChooseMyself}>
          <FolderGlyph size={13} /> Choose folders myself…
        </button>
        {nothing && onNoneYet !== undefined && (
          <button type="button" className="onboarding-wizard__btn" onClick={onNoneYet}>
            I do not have any yet
          </button>
        )}
      </div>
      <SearchNotes result={result} canAskProtected={canAskProtected && !nothing} />
    </div>
  );
}

function SearchNotes(props: { result: RepoSearchResult; canAskProtected: boolean }): ReactElement | null {
  const { result } = props;
  const leaf = (p: string): string => p.split(/[\\/]/).at(-1) ?? p;
  const lines: ReactElement[] = [];
  if (props.canAskProtected) {
    lines.push(
      <span key="ask">
        macOS asks before PwrGit may open Documents, Desktop or Downloads, once
        for each. That is why they were not searched yet.
      </span>
    );
  }
  if (result.stoppedEarly === "folders") {
    lines.push(
      <span key="stop">
        The search stopped after {result.foldersOpened.toLocaleString()} folders,
        so there may be more.
      </span>
    );
  } else if (result.stoppedEarly === "time") {
    lines.push(
      <span key="stop">
        The search stopped after {result.foldersOpened.toLocaleString()} folders
        because it was taking too long, so there may be more.
      </span>
    );
  } else if (result.stoppedEarly === "stopped") {
    lines.push(<span key="stop">You stopped the search, so there may be more.</span>);
  }
  if (result.refused.length > 0) {
    lines.push(
      <span key="refused">
        macOS did not allow{" "}
        {result.refused.map((p, i) => (
          <span key={p}>
            {i > 0 ? ", " : ""}
            <code>{leaf(p)}</code>
          </span>
        ))}
        ; allow PwrGit under Privacy &amp; Security, Files and Folders, to search{" "}
        {result.refused.length === 1 ? "it" : "them"}.
      </span>
    );
  }
  if (result.cloudSkipped.length > 0) {
    lines.push(
      <span key="cloud">
        Cloud folders were not searched (
        {result.cloudSkipped.map(leaf).join(", ")}); choose one yourself if your
        code is there.
      </span>
    );
  }
  if (lines.length === 0) return null;
  return <p className="repo-search__notes">{lines.map((line, i) => <span key={i}>{i > 0 ? " " : ""}{line}</span>)}</p>;
}
