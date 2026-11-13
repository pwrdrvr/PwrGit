import { useMemo, type ReactElement } from "react";
import type { CloneDestination, NewRootChoice, SuggestedRoot } from "@pwrgit/shared";
import { NewRootPicker } from "../onboarding/NewRootPicker";

/**
 * The destination step of Clone and Fork when the profile has no folder yet
 * (design/New User Journey - UX Review, card 5a). It offers the suggested
 * folders and "Choose another folder…"; the folder is created and added to
 * the profile only when the clone or fork starts (`newRoot` on the request),
 * so cancelling leaves nothing behind. Once a folder exists this section is
 * the usual destination list, unchanged.
 */
export function NoFolderDestination(props: {
  profileName: string;
  choice: NewRootChoice;
  onChoice: (choice: NewRootChoice) => void;
  suggested: SuggestedRoot[] | null;
  tilde: (path: string) => string;
  pickDirectories: () => Promise<string[]>;
  /** The radio group's name, unique per dialog. */
  name: string;
}): ReactElement {
  return (
    <div className="no-folder-destination">
      <div className="no-folder-destination__title">Where should it go?</div>
      <p className="no-folder-destination__sub">
        You have no repository folder yet. Pick one, and PwrGit will create it
        and keep watching it.
      </p>
      <NewRootPicker
        layout="rows"
        name={props.name}
        choice={props.choice}
        onChoice={props.onChoice}
        suggested={props.suggested}
        tilde={props.tilde}
        pickDirectories={props.pickDirectories}
        meta={(root, selected) => {
          const verb = "exists" in root && root.exists ? "add" : "create and add";
          if (!("exists" in root)) return selected ? `add to ${props.profileName}` : "add";
          return selected ? `${verb} to ${props.profileName}` : verb;
        }}
      />
    </div>
  );
}

/** The destination a no-folder choice stands for, in the shape the dialogs'
 *  "Clones to …" line and submit already read. Null until main has said
 *  where home is. */
export function useNoFolderDestination(
  choice: NewRootChoice,
  suggested: SuggestedRoot[] | null
): CloneDestination | null {
  return useMemo(() => {
    const path =
      choice.kind === "picked"
        ? choice.path
        : suggested?.find((s) => s.name === choice.name)?.path;
    return path === undefined ? null : { path, root: path, relativePath: "", repoCount: 0 };
  }, [choice, suggested]);
}
