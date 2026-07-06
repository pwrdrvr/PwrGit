import { useEffect } from "react";

/**
 * PwrGit ships a single warm-dark theme (the design has no light variant yet).
 * This hook centralizes theme application so a light/system option can be
 * added later without touching call sites.
 */
export function useAppearance(): void {
  useEffect(() => {
    document.documentElement.dataset["theme"] = "dark";
  }, []);
}
