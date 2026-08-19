import { useEffect, useState } from "react";
import type { CloneRepository, ForgeKind, ProfileId } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

/** How long the box has to settle before a forge is asked anything.
 *
 *  This is the whole point of the hook. Repository search is a network round
 *  trip, so it happens on settled input and nowhere else — never on mount.
 *  The clone dialog used to load every known owner's repositories as it
 *  opened, one CLI call per account, and spent ten seconds on "Loading
 *  repositories…" before the user had typed a character. */
const SEARCH_DEBOUNCE_MS = 300;

/** Refusals the dialogs already explain from `catalog.forges`, in wording that
 *  names the command that fixes them. Repeating the service's version of the
 *  same message in the results list says it twice. */
const AVAILABILITY_CODES = new Set(["forge_cli_missing", "forge_login_required"]);

export type CloneSearch = {
  repositories: CloneRepository[];
  /** True from the keystroke, not from the request — the gap is the debounce,
   *  and a box that looks idle during it reads as "found nothing". */
  searching: boolean;
  error: string | null;
};

const IDLE: CloneSearch = { repositories: [], searching: false, error: null };

/**
 * Repositories matching what is in the search box, from the forge's own
 * search, on debounced input.
 *
 * `enabled` is false until the dialog knows a forge can answer, so a machine
 * with no CLI never spends a round trip to be told to install one.
 */
export function useCloneSearch(input: {
  profileId: ProfileId;
  query: string;
  host: ForgeKind;
  enabled: boolean;
}): CloneSearch {
  const { profileId, query, host, enabled } = input;
  const [state, setState] = useState<CloneSearch>(IDLE);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || trimmed === "") {
      setState(IDLE);
      return;
    }
    setState((previous) => ({ ...previous, searching: true, error: null }));
    let active = true;
    const timeout = window.setTimeout(() => {
      void dispatch("repo:searchCloneSources", {
        profileId,
        query: trimmed,
        host
      }).then((result) => {
        if (!active) return;
        if (result.ok) {
          setState({ repositories: result.value, searching: false, error: null });
        } else {
          setState({
            repositories: [],
            searching: false,
            error: AVAILABILITY_CODES.has(result.error.code)
              ? null
              : result.error.message
          });
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [profileId, query, host, enabled]);

  return state;
}
