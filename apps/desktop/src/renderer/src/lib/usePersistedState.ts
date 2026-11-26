import { useEffect, useState } from "react";

function readStorage(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore private-mode and quota failures.
  }
}

/**
 * A value that outlives the window, per repository — the same localStorage
 * shape as the Worktrees toggle in RepoRow.
 */
export function usePersistedValue(
  key: string,
  fallback: string
): [string, (value: string) => void] {
  const [state, setState] = useState(() => ({
    key,
    value: readStorage(key, fallback)
  }));
  const value = state.key === key ? state.value : readStorage(key, fallback);
  useEffect(() => {
    if (state.key !== key) {
      setState({ key, value: readStorage(key, fallback) });
    }
  }, [key, fallback, state.key]);
  const setValue = (next: string): void => {
    writeStorage(key, next);
    setState({ key, value: next });
  };
  return [value, setValue];
}

/** A disclosure, stored as "1" / "0". */
export function usePersistedOpen(key: string): [boolean, (open: boolean) => void] {
  const [value, setValue] = usePersistedValue(key, "0");
  return [value === "1", (open) => setValue(open ? "1" : "0")];
}
