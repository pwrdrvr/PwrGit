import { useCallback, useEffect, useRef, useState } from "react";
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
  before: string | null;
  after: string | null;
  plan: DiffPlan | null;
}): PixelDiff {
  const [state, setState] = useState<PixelDiff>({ kind: "idle" });
  // Object URLs outlive the render that made them, so the previous one has to
  // be released by hand or every toggle leaks a multi-megabyte PNG.
  const objectUrl = useRef<string | null>(null);

  const release = useCallback(() => {
    if (objectUrl.current === null) return;
    URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }, []);

  useEffect(() => () => release(), [release]);

  const width = plan?.size.w ?? 0;
  const height = plan?.size.h ?? 0;
  const fit = plan?.fit;

  useEffect(() => {
    if (!enabled || before === null || after === null || fit === undefined) {
      // Going idle drops the last PNG from the UI, so its blob URL has to go
      // too — walking a diff otherwise pins every diff it computed for the
      // whole session, since only unmount used to revoke.
      release();
      setState({ kind: "idle" });
      return;
    }
    let active = true;
    setState({ kind: "working" });
    computePixelDiff({ before, after, width, height, fit }).then(
      (result) => {
        if (!active) return;
        release();
        objectUrl.current = URL.createObjectURL(result.png);
        setState({
          kind: "ready",
          src: objectUrl.current,
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
    };
  }, [enabled, before, after, width, height, fit, release]);

  return state;
}
