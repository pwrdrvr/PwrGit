import { useEffect, useState, type ReactElement } from "react";
import { SUGGESTED_ROOTS, type NewRootChoice, type SuggestedRoot } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { FolderGlyph } from "../../lib/FolderGlyph";

/*
 * Choosing a repository folder that may not exist yet: the wizard's "I do not
 * have any" (design/New User Journey - UX Review, card 3b) and Clone or Fork
 * on a profile with no folder (card 5a). Main creates or adds the folder only
 * when the step that uses it runs, and only by a suggested name under home or
 * a path the system picker returned (`main/profiles/new-root.ts`).
 */

/** Show a path under home as `~/…`. Home is read off the suggested folders,
 *  which main answers as absolute paths one level under it. */
export function tildeFor(suggested: SuggestedRoot[] | null): (path: string) => string {
  const first = suggested?.[0];
  if (first === undefined) return (path) => path;
  const home = first.path.slice(0, first.path.length - first.name.length - 1);
  const sep = first.path.charAt(home.length);
  return (path) =>
    path === home ? "~" : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** The suggested folders as main sees them: absolute paths, and which exist. */
export function useSuggestedRoots(enabled = true): SuggestedRoot[] | null {
  const [roots, setRoots] = useState<SuggestedRoot[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void dispatch("profile:suggestedRoots", undefined).then((result) => {
      if (live && result.ok) setRoots(result.value);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return roots;
}

/**
 * The three suggested folder names and "Choose another folder…", as one radio
 * group. Shared by the wizard's 3b and the clone and fork destination with no
 * folder (card 5a). A picked folder joins the group as a fourth option.
 */
export function NewRootPicker(props: {
  choice: NewRootChoice;
  onChoice: (choice: NewRootChoice) => void;
  pickDirectories: () => Promise<string[]>;
  suggested: SuggestedRoot[] | null;
  tilde: (path: string) => string;
  /** The radio group's name, unique per surface. */
  name: string;
  /** Per-row meta, e.g. "create and add to Personal". */
  meta?: (root: SuggestedRoot | { path: string }, selected: boolean) => string | null;
  layout?: "chips" | "rows";
}): ReactElement {
  const { choice, suggested, layout = "chips" } = props;
  const options: Array<{ key: string; label: string; value: NewRootChoice; root: SuggestedRoot | { path: string } }> =
    (suggested ?? SUGGESTED_ROOTS.map((name) => ({ name, path: `~/${name}`, display: `~/${name}`, exists: false })))
      .map((root) => ({
        key: root.name,
        label: root.display,
        value: { kind: "suggested" as const, name: root.name },
        root
      }));
  if (choice.kind === "picked") {
    options.push({ key: choice.path, label: props.tilde(choice.path), value: choice, root: { path: choice.path } });
  }
  const isChosen = (value: NewRootChoice): boolean =>
    value.kind === "suggested"
      ? choice.kind === "suggested" && choice.name === value.name
      : choice.kind === "picked" && choice.path === value.path;
  return (
    <div className={`new-root new-root--${layout}`}>
      <div className="new-root__options" role="radiogroup" aria-label="Folder for your repositories">
        {options.map((option) => {
          const meta = props.meta?.(option.root, isChosen(option.value)) ?? null;
          return (
            <label
              key={option.key}
              className={`new-root__option${isChosen(option.value) ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                className="new-root__input"
                name={props.name}
                checked={isChosen(option.value)}
                onChange={() => props.onChoice(option.value)}
              />
              <span className="new-root__path">{option.label}</span>
              {meta !== null && <span className="new-root__meta">{meta}</span>}
            </label>
          );
        })}
      </div>
      <button
        type="button"
        className="onboarding-wizard__btn new-root__choose"
        onClick={() => {
          void props.pickDirectories().then((picked) => {
            const first = picked[0];
            if (first !== undefined) props.onChoice({ kind: "picked", path: first });
          });
        }}
      >
        <FolderGlyph size={13} /> Choose another folder…
      </button>
    </div>
  );
}

