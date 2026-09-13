import { useSyncExternalStore } from "react";

/**
 * The resolved theme, for brand marks that ship one file per colorway instead
 * of a recolorable glyph.
 *
 * Vendor logo guidance forbids altering the mark, so a brand asset cannot
 * follow `currentColor` the way `LocateGlyph` and friends do — it picks
 * between the variants the vendor itself publishes (see
 * `assets/github/README.md`). That choice needs the live theme, and the theme
 * lives on `<html data-theme>`: `light` when the light theme is active, and
 * the attribute is removed entirely for dark (`lib/appearance.ts`). This
 * module is the one subscription every such mark shares.
 *
 * Ported from PwrAgnt, which resolves its own brand assets the same way.
 */
export type BrandTheme = "light" | "dark";

/**
 * Pass `enabled: false` when the caller has an explicit variant and cannot use
 * the answer. A fixed-variant mark that still subscribed would add a listener
 * to the shared set and hold the document-wide MutationObserver open for a
 * value it ignores — and every repo row in the sidebar draws one of these.
 */
export function useBrandTheme(enabled = true): BrandTheme {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeToNothing,
    readBrandTheme,
    readServerBrandTheme
  );
}

const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function subscribeToNothing(_listener: () => void): () => void {
  return () => undefined;
}

function subscribe(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return subscribeToNothing(listener);
  }

  listeners.add(listener);
  if (observer === undefined) {
    observer = new MutationObserver(() => {
      for (const notify of [...listeners]) notify();
    });
    observer.observe(document.documentElement, {
      attributeFilter: ["data-theme"],
      attributes: true
    });
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}

function readBrandTheme(): BrandTheme {
  return typeof document !== "undefined" &&
    document.documentElement.dataset["theme"] === "light"
    ? "light"
    : "dark";
}

/**
 * Dark owns the bare `:root` block in `tokens.css` and light is the only
 * attributed override, so a render with no DOM to read resolves dark.
 */
function readServerBrandTheme(): BrandTheme {
  return "dark";
}

/** Tests only: drop the shared observer so each case starts unsubscribed. */
export function resetBrandThemeForTests(): void {
  listeners.clear();
  observer?.disconnect();
  observer = undefined;
}
