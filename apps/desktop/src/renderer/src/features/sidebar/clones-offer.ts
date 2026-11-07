import { useEffect, useRef } from "react";
import type { ClonesOffer } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showInfoToast } from "../../lib/toast";
import { clonesBytes } from "./ClonesPanel";

/** Let launch's own Git work (indexing, state probes) settle before the
 *  background dry run asks Git anything. */
export const CLONES_OFFER_DELAY_MS = 2 * 60 * 1000;
export const CLONES_OFFER_TOAST_KEY = "clones-offer";

/**
 * The offer's words. A number only when Git measured one: "at least" when
 * some worktrees could not be sized, and files instead of bytes when none
 * could. Projected, never "freed" (main/git/AGENTS.md).
 * Design: `design/Clones in Maintenance - UX Review.dc.html`, 2a–2c.
 */
export function clonesOfferCopy(offer: ClonesOffer): { title: string; message: string } {
  const lead =
    offer.kind === "bytes"
      ? `Your worktrees could save ${offer.atLeast ? "at least" : "about"} ${clonesBytes(offer.bytes)} (projected) by sharing unchanged files with their main checkouts.`
      : `${offer.files.toLocaleString("en-US")} unchanged ${offer.files === 1 ? "file" : "files"} in your worktrees could share disk space with their main checkouts.`;
  return {
    title: "Save disk space",
    message: `${lead}\n\nFully compatible with Git and every other tool: files stay ordinary files, and edited or untracked ones aren’t touched.`
  };
}

/**
 * Ask main, once per window and after a pause, for this profile's one-time
 * Clones offer. Main scans and answers with an offer only the first time;
 * every later ask (another launch, a reload) is null. Share files records
 * the answer and calls `onAccept`; × records a dismissal.
 */
export function useClonesOffer(
  profileId: string | undefined,
  onAccept: () => void,
  delayMs = CLONES_OFFER_DELAY_MS
): void {
  const accept = useRef(onAccept);
  accept.current = onAccept;
  useEffect(() => {
    if (profileId === undefined) return;
    let cancelled = false;
    const answer = (value: "accepted" | "dismissed"): void => {
      void dispatch("maintenance:clonesOfferAnswer", { profileId, answer: value }).catch(() => undefined);
    };
    const timer = window.setTimeout(() => {
      void dispatch("maintenance:clonesOffer", { profileId })
        .then((result) => {
          if (cancelled || !result.ok || result.value === null) return;
          const { title, message } = clonesOfferCopy(result.value);
          showInfoToast({
            key: CLONES_OFFER_TOAST_KEY,
            title,
            message,
            sticky: true,
            layout: "stacked",
            action: {
              label: "Share files",
              run: () => {
                answer("accepted");
                accept.current();
              }
            },
            onDismiss: () => answer("dismissed")
          });
        })
        .catch(() => undefined);
    }, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [profileId, delayMs]);
}
