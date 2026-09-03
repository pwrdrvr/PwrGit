import { useSyncExternalStore } from "react";
import { ResetToRemoteDialog } from "./ResetToRemoteDialog";
import {
  closeResetToRemote,
  currentResetToRemote,
  subscribeResetToRemote
} from "./reset-to-remote";

/**
 * Renders the one reset-to-remote dialog for whichever surface asked for it.
 * Mount once, near the app root — see `reset-to-remote.ts` for why the dialog
 * is not owned by the graph header any more.
 */
export function ResetToRemoteHost() {
  const request = useSyncExternalStore(
    subscribeResetToRemote,
    currentResetToRemote,
    currentResetToRemote
  );
  if (request === null) return null;
  return (
    <ResetToRemoteDialog
      // Remount on a different worktree or target so no state carries across.
      key={`${request.worktree.id}:${request.preselectRef ?? ""}`}
      worktree={request.worktree}
      {...(request.preselectRef === undefined
        ? {}
        : { preselectRef: request.preselectRef })}
      onClose={closeResetToRemote}
      onComplete={(mode, branch) => request.onComplete?.(mode, branch)}
    />
  );
}
