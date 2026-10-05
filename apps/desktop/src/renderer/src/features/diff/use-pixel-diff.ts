import { useEffect, useState } from "react";
import type { DiffPlan } from "./pixel-diff";
import { computePixelDiff } from "./pixel-diff-client";

export type PixelDiff =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "ready"; src: string; png: Blob; changed: number; total: number }
  | { kind: "failed"; reason: string };

/**
 * The pixel comparison as React state.
 *
 * Requests are sequenced and late replies dropped: flipping "Scale to match"
 * mid-run starts a second comparison, and on a large pair the first can still
 * land afterwards. Without the check it would overwrite the answer the user
 * actually asked for.
 */
export function usePixelDiff({
  enabled,
  before,
  after,
  plan
}: {
  enabled: boolean;
  before: Blob | null;
  after: Blob | null;
  plan: DiffPlan | null;
}): PixelDiff {
  const [state, setState] = useState<PixelDiff>({ kind: "idle" });

  const width = plan?.size.w ?? 0;
  const height = plan?.size.h ?? 0;
  const fit = plan?.fit;

  useEffect(() => {
    if (!enabled || before === null || after === null || fit === undefined) {
      setState({ kind: "idle" });
      return;
    }
    let active = true;
    // The PNG's object URL is minted by the run that asked for it and revoked
    // by that run's cleanup — a new comparison, going idle and unmounting all
    // release it, and StrictMode's rehearsal unmount cannot revoke a URL the
    // run after it is still showing. Walking a diff otherwise pinned every
    // PNG it ever computed.
    let src: string | null = null;
    setState({ kind: "working" });
    computePixelDiff({ before, after, width, height, fit }).then(
      (result) => {
        if (!active) return;
        src = URL.createObjectURL(result.png);
        setState({
          kind: "ready",
          src,
          png: result.png,
          changed: result.changed,
          total: result.total
        });
      },
      (error: Error) => {
        if (active) setState({ kind: "failed", reason: error.message });
      }
    );
    return () => {
      active = false;
      if (src !== null) URL.revokeObjectURL(src);
    };
  }, [enabled, before, after, width, height, fit]);

  return state;
}
