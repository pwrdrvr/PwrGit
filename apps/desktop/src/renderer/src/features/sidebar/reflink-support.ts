import { useEffect, useState } from "react";
import type { GitReflinkStatus } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

/** Whether the Git in use can clone and re-share (`git:reflinkSupport`),
 *  asked once on mount. `answered` turns true on any answer, an error
 *  included; `canReshare` is true only for a Git that said it can. */
export function useReflinkSupport(): {
  support: GitReflinkStatus | null;
  error: string | null;
  answered: boolean;
  canReshare: boolean;
} {
  const [support, setSupport] = useState<GitReflinkStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    let live = true;
    void dispatch("git:reflinkSupport", undefined)
      .then((answer) => {
        if (!live) return;
        setAnswered(true);
        if (answer.ok) setSupport(answer.value);
        else setError(answer.error.message);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setAnswered(true);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, []);
  return { support, error, answered, canReshare: support?.support?.reshare === true };
}

/** Settings › Git › runtime, where PwrGit's Git is chosen. */
export function openGitRuntimeSettings(onError: (message: string) => void): void {
  void dispatch("settings:open", { page: "git", sub: "runtime" }).then((result) => {
    if (!result.ok) onError(result.error.message);
  });
}
