// Settings › Git's two reads, held above the nav and the pane so a nav dot
// and the card it points at are one answer (as `AiProvidersContext` does for
// AI Providers).
//
// - `git:runtimeStatus` probes every Git it lists (a few short execs each),
//   so it runs on demand: when the Git pane mounts or the Git group unfolds.
// - `gitManaged:status` reads a file and never the network, so it runs on
//   mount. The network check is `check()`, which main throttles unless forced.
// - `gitManaged:progress` pushes an install's progress to every window.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { GitRuntimeStatus, ManagedGitStatus } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

/** What Settings can ask `git:selectRuntime` for. */
export type GitChoice = { path: string | null } | { managed: string };

export type GitSettingsState = {
  runtime: GitRuntimeStatus | null;
  runtimeError: string | null;
  runtimeChecking: boolean;
  /** Probe the Gits (again). Idempotent while one probe is running. */
  requestRuntime: () => void;
  managed: ManagedGitStatus | null;
  managedError: string | null;
  checking: boolean;
  /** Ask main for the release list; `force` skips its cooldown. */
  check: (force: boolean) => Promise<void>;
  /** Download, verify and install. Never selects. Resolves to the failure,
   *  or null; a cancelled install resolves null. */
  install: (version: string) => Promise<string | null>;
  cancel: () => void;
  /** Resolves to the failure, or null. */
  select: (choice: GitChoice) => Promise<string | null>;
  selecting: boolean;
};

const GitSettingsContext = createContext<GitSettingsState | null>(null);

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function GitSettingsProvider(props: { children: ReactNode }) {
  const value = useGitSettingsState();
  return <GitSettingsContext.Provider value={value}>{props.children}</GitSettingsContext.Provider>;
}

/** The window's Git state, or null outside a provider. */
export function useGitSettingsContext(): GitSettingsState | null {
  return useContext(GitSettingsContext);
}

function useGitSettingsState(): GitSettingsState {
  const [runtime, setRuntime] = useState<GitRuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const [managed, setManaged] = useState<ManagedGitStatus | null>(null);
  const [managedError, setManagedError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const alive = useRef(true);
  const runtimeInFlight = useRef(false);
  const cancelled = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const requestRuntime = useCallback((): void => {
    if (runtimeInFlight.current) return;
    runtimeInFlight.current = true;
    setRuntimeError(null);
    setRuntimeChecking(true);
    void dispatch("git:runtimeStatus", undefined)
      .then((result) => {
        if (!alive.current) return;
        if (result.ok) setRuntime(result.value);
        else setRuntimeError(result.error.message);
      })
      .catch((cause: unknown) => {
        if (alive.current) setRuntimeError(message(cause));
      })
      .finally(() => {
        runtimeInFlight.current = false;
        if (alive.current) setRuntimeChecking(false);
      });
  }, []);

  const readManaged = useCallback(async (): Promise<void> => {
    try {
      const result = await dispatch("gitManaged:status", undefined);
      if (!alive.current) return;
      if (result.ok) {
        setManaged(result.value);
        setManagedError(null);
      } else setManagedError(result.error.message);
    } catch (cause) {
      if (alive.current) setManagedError(message(cause));
    }
  }, []);

  useEffect(() => {
    void readManaged();
  }, [readManaged]);

  // Progress is pushed; the status it ends in is read, because an install
  // that finished adds a build (and an Installs row) the push does not carry.
  const hadRuntime = useRef(false);
  hadRuntime.current = runtime !== null;
  useEffect(
    () =>
      subscribe("gitManaged:progress", (progress) => {
        setManaged((current) => (current === null ? current : { ...current, progress }));
        if (progress.phase === "ready" || progress.phase === "failed" || progress.phase === "idle") {
          void readManaged();
          if (progress.phase === "ready" && hadRuntime.current) requestRuntime();
        }
      }),
    [readManaged, requestRuntime]
  );

  const check = useCallback(async (force: boolean): Promise<void> => {
    setChecking(true);
    try {
      const result = await dispatch("gitManaged:check", { force });
      if (!alive.current) return;
      if (result.ok) setManaged(result.value);
      else setManagedError(result.error.message);
    } catch (cause) {
      if (alive.current) setManagedError(message(cause));
    } finally {
      if (alive.current) setChecking(false);
    }
  }, []);

  const install = useCallback(
    async (version: string): Promise<string | null> => {
      cancelled.current = false;
      try {
        const result = await dispatch("gitManaged:install", { version });
        if (!alive.current) return null;
        if (result.ok) {
          setManaged(result.value);
          return null;
        }
        // Cancel is an outcome, not a failure; main already said "idle".
        if (cancelled.current) return null;
        await readManaged();
        return result.error.message;
      } catch (cause) {
        return cancelled.current ? null : message(cause);
      }
    },
    [readManaged]
  );

  const cancel = useCallback((): void => {
    cancelled.current = true;
    void dispatch("gitManaged:cancel", undefined);
  }, []);

  const select = useCallback(
    async (choice: GitChoice): Promise<string | null> => {
      setSelecting(true);
      try {
        const result = await dispatch(
          "git:selectRuntime",
          "managed" in choice ? { path: null, managed: choice.managed } : choice
        );
        if (!result.ok) return result.error.message;
        if (alive.current) setRuntime(result.value);
        // Which build is chosen, and which one rollback offers, moved too.
        await readManaged();
        return null;
      } catch (cause) {
        return message(cause);
      } finally {
        if (alive.current) setSelecting(false);
      }
    },
    [readManaged]
  );

  return useMemo(
    () => ({
      runtime,
      runtimeError,
      runtimeChecking,
      requestRuntime,
      managed,
      managedError,
      checking,
      check,
      install,
      cancel,
      select,
      selecting
    }),
    [runtime, runtimeError, runtimeChecking, requestRuntime, managed, managedError, checking, check, install, cancel, select, selecting]
  );
}
