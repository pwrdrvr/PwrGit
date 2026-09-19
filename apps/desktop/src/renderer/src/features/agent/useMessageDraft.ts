import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentMessageDraft,
  RebaseCommitRef
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { useAgent } from "./agent-store";

export type DraftSource =
  | { kind: "commits"; commits: RebaseCommitRef[] }
  | { kind: "staged" };

export type DraftStatus =
  | { kind: "idle" }
  | { kind: "drafting"; startedAt: number }
  | { kind: "failed"; code: string; message: string; afterMs: number };

export type MessageDraft = {
  text: string;
  /** Who wrote what the box holds right now. */
  origin: "fallback" | "agent" | "user";
  status: DraftStatus;
  /** The latest draft, whether or not it is in the box. */
  draft: AgentMessageDraft | null;
  /** A draft arrived after the operator typed, so it is waiting, not applied. */
  pending: boolean;
  /** The text a one-step replacement overwrote, for Undo. */
  undo: string | null;
  setText: (text: string) => void;
  request: () => void;
  cancel: () => void;
  acceptDraft: () => void;
  restoreFallback: () => void;
  undoReplace: () => void;
  /** Start over from a new fallback (a new selection, or after a commit). */
  reset: (fallback: string) => void;
};

export function draftText(draft: AgentMessageDraft): string {
  return draft.body === "" ? draft.subject : `${draft.subject}\n\n${draft.body}`;
}

/**
 * The message box's agent half. The box starts as `fallback` (Git's joined
 * subjects for Squash, empty for a commit) and works with no agent at all. A
 * draft replaces the box only while the operator has not typed into it; after
 * that it waits behind "Use draft", and replacing is a single undoable step.
 */
export function useMessageDraft({
  worktreeId,
  source,
  fallback,
  autoStart
}: {
  worktreeId: string | null;
  source: DraftSource | null;
  fallback: string;
  /** Ask as soon as an agent is ready (Squash). The commit box waits to be asked. */
  autoStart: boolean;
}): MessageDraft {
  const agent = useAgent();
  const [text, setTextState] = useState(fallback);
  const [origin, setOrigin] = useState<MessageDraft["origin"]>("fallback");
  const [status, setStatus] = useState<DraftStatus>({ kind: "idle" });
  const [draft, setDraft] = useState<AgentMessageDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [undo, setUndo] = useState<string | null>(null);
  const activeRequest = useRef<string | null>(null);
  const originRef = useRef(origin);
  originRef.current = origin;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const choiceRef = useRef(agent.state.choice);
  choiceRef.current = agent.state.choice;

  const cancelActive = useCallback((): void => {
    const requestId = activeRequest.current;
    if (requestId === null) return;
    activeRequest.current = null;
    void dispatch("agent:cancel", { requestId });
  }, []);

  const request = useCallback((): void => {
    const current = sourceRef.current;
    if (worktreeId === null || current === null) return;
    cancelActive();
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    activeRequest.current = requestId;
    setStatus({ kind: "drafting", startedAt });
    const choice = choiceRef.current;
    void dispatch("agent:draftMessage", {
      requestId,
      worktreeId,
      source: current,
      ...(choice.model !== undefined || choice.effort !== undefined
        ? { choice }
        : {})
    }).then((result) => {
      if (activeRequest.current !== requestId) return;
      activeRequest.current = null;
      if (!result.ok) {
        setStatus({
          kind: "failed",
          code: result.error.code,
          message: result.error.message,
          afterMs: Date.now() - startedAt
        });
        return;
      }
      setStatus({ kind: "idle" });
      setDraft(result.value);
      if (originRef.current === "user") {
        setPending(true);
      } else {
        setPending(false);
        setUndo(null);
        setTextState(draftText(result.value));
        setOrigin("agent");
      }
    });
  }, [worktreeId, cancelActive]);

  const reset = useCallback(
    (next: string): void => {
      cancelActive();
      setTextState(next);
      setOrigin("fallback");
      setStatus({ kind: "idle" });
      setDraft(null);
      setPending(false);
      setUndo(null);
    },
    [cancelActive]
  );

  // A new selection is a new message.
  const sourceKey =
    source === null
      ? ""
      : source.kind === "staged"
        ? "staged"
        : source.commits.map((commit) => commit.hash).join(",");
  useEffect(() => {
    reset(fallbackRef.current);
  }, [worktreeId, sourceKey, reset]);

  useEffect(() => {
    if (!autoStart || !agent.ready || source === null || worktreeId === null) return;
    request();
    // Once per selection: a failure or a cancel is the operator's to retry.
  }, [autoStart, agent.ready, worktreeId, sourceKey]);

  useEffect(() => cancelActive, [cancelActive]);

  return {
    text,
    origin,
    status,
    draft,
    pending,
    undo,
    setText: (next) => {
      setTextState(next);
      setOrigin("user");
      setUndo(null);
    },
    request,
    cancel: () => {
      const requestId = activeRequest.current;
      if (requestId !== null) void dispatch("agent:cancel", { requestId });
    },
    acceptDraft: () => {
      if (draft === null) return;
      setUndo(text);
      setTextState(draftText(draft));
      setOrigin("agent");
      setPending(false);
    },
    restoreFallback: () => {
      setUndo(text);
      setTextState(fallbackRef.current);
      setOrigin("fallback");
    },
    undoReplace: () => {
      if (undo === null) return;
      setTextState(undo);
      setOrigin("user");
      setUndo(null);
    },
    reset
  };
}
