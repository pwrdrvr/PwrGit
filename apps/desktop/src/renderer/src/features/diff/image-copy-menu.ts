import { useEffect, useState } from "react";
import type { MenuItem } from "../shell/ContextMenu";
import { composeStrip, copyPngToClipboard, encodePng } from "./image-clipboard";

/** A revision to copy, as its bytes. Not its URL: the display URL belongs to
 *  whoever is showing the picture and can be revoked under an open menu. */
export type CopySource = { label: string; blob: Blob };

/**
 * The right-click menu shared by the inline row and the lightbox, so "copy the
 * after" means the same thing and reads the same wherever you reach for it.
 *
 * The multi-panel entries exist because the single ones are rarely what gets
 * pasted: a review comment wants the pair, and an argument about a regression
 * wants all three. Composing them here rather than asking the reader to paste
 * three times and arrange them is most of the value of the menu.
 */
export function buildImageCopyMenu({
  before,
  after,
  diff,
  onResult
}: {
  before: CopySource | null;
  after: CopySource | null;
  /** Produces the diff PNG, running the comparison if nothing has yet. Null
   *  when the file has only one side and there is nothing to compare. */
  diff: (() => Promise<Blob>) | null;
  onResult: (message: string) => void;
}): MenuItem[] {
  const run = (what: string, work: () => Promise<Blob>) => {
    void (async () => {
      try {
        const copied = await copyPngToClipboard(await work());
        onResult(copied ? `Copied ${what}` : `Could not copy ${what}`);
      } catch {
        onResult(`Could not copy ${what}`);
      }
    })();
  };

  const items: MenuItem[] = [];
  if (before !== null) {
    items.push({
      type: "item",
      label: "Copy before",
      onSelect: () => run("before", () => encodePng(before.blob))
    });
  }
  if (after !== null) {
    items.push({
      type: "item",
      label: "Copy after",
      onSelect: () => run("after", () => encodePng(after.blob))
    });
  }
  if (diff !== null) {
    items.push({
      type: "item",
      label: "Copy diff",
      onSelect: () => run("the diff", diff)
    });
  }

  const pair = before !== null && after !== null;
  if (pair) {
    items.push({ type: "sep" });
    items.push({
      type: "item",
      label: "Copy before + after",
      onSelect: () =>
        run("both revisions", () => composeStrip([before, after]))
    });
    if (diff !== null) {
      items.push({
        type: "item",
        label: "Copy before + after + diff",
        onSelect: () =>
          run("all three", async () =>
            composeStrip([before, after, { label: "diff", blob: await diff() }])
          )
      });
    }
  }
  return items;
}

/**
 * A short-lived confirmation. Copying is otherwise completely silent — the
 * clipboard gives no sign it took anything — and silence is indistinguishable
 * from a menu item that did nothing.
 */
export function useCopyNote(): [string | null, (message: string) => void] {
  // The nonce lets the same message re-arm the timer; copying "before" twice
  // in a row should flash twice, not go quiet after the first.
  const [note, setNote] = useState<{ message: string; nonce: number } | null>(
    null
  );
  useEffect(() => {
    if (note === null) return;
    const timer = window.setTimeout(() => setNote(null), 2000);
    return () => window.clearTimeout(timer);
  }, [note]);
  return [
    note?.message ?? null,
    (message: string) =>
      setNote((prev) => ({ message, nonce: (prev?.nonce ?? 0) + 1 }))
  ];
}
