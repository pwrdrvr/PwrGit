import { useState } from "react";
import { AgentGlyph } from "../../lib/AgentGlyph";
import type { MessageDraft } from "./useMessageDraft";
import { draftText } from "./useMessageDraft";

function describeFailure(
  name: string,
  status: Extract<MessageDraft["status"], { kind: "failed" }>
): string {
  if (status.code === "cancelled") return "Draft cancelled";
  if (status.code === "timeout") {
    return `${name} stopped after ${Math.max(1, Math.round(status.afterMs / 1000))} s. Nothing changed.`;
  }
  return status.message;
}

/**
 * One line under a message box saying who wrote what it holds, and the one or
 * two things worth doing about it. Failures are said here, once, in the
 * footer of the thing that failed.
 */
export function DraftFooter({
  draft,
  agentName,
  agentReady,
  fallbackLabel,
  fallbackAction,
  unitLabel,
  onNoAgent
}: {
  draft: MessageDraft;
  agentName: string;
  agentReady: boolean;
  /** What the box started as: "Joined from 4 subjects", or null for an empty box. */
  fallbackLabel: string | null;
  /** The link that puts the fallback back ("Use subjects"), if there is one. */
  fallbackAction: string | null;
  /** "4 diffs", "3 staged files": what a draft is read from. */
  unitLabel: string;
  /** Where "Draft with an agent…" leads when none is set up. */
  onNoAgent: () => void;
}) {
  const [comparing, setComparing] = useState(false);
  const status = draft.status;
  let source: { text: string; tone: "agent" | "quiet" | "warn" };
  const links: {
    label: string;
    quiet?: boolean;
    /** Leads with the agent mark: this link asks a model for something. */
    agent?: boolean;
    onClick: () => void;
  }[] = [];

  if (status.kind === "drafting") {
    source = { text: `${agentName} is reading ${unitLabel}…`, tone: "agent" };
    links.push({ label: "Cancel", quiet: true, onClick: draft.cancel });
  } else if (draft.pending && draft.draft !== null) {
    source = { text: `${agentName} draft ready`, tone: "agent" };
    links.push({
      label: comparing ? "Hide draft" : "Compare",
      onClick: () => setComparing((v) => !v)
    });
    links.push({ label: "Use draft", onClick: draft.acceptDraft });
  } else if (status.kind === "failed") {
    source = {
      text: describeFailure(agentName, status),
      tone: status.code === "cancelled" ? "quiet" : "warn"
    };
    if (agentReady) {
      links.push({
        label: status.code === "cancelled" ? "Draft" : "Retry",
        agent: status.code === "cancelled",
        onClick: draft.request
      });
    }
  } else if (draft.origin === "agent" && draft.draft !== null) {
    source = {
      text: `${draft.draft.providerName}, from ${unitLabel}`,
      tone: "agent"
    };
    links.push({ label: "Regenerate", onClick: draft.request });
    if (fallbackAction !== null) {
      links.push({ label: fallbackAction, quiet: true, onClick: draft.restoreFallback });
    }
  } else if (draft.origin === "user") {
    source = { text: "Edited", tone: "quiet" };
    if (agentReady) links.push({ label: "Draft", agent: true, onClick: draft.request });
  } else {
    source = { text: fallbackLabel ?? "", tone: "quiet" };
    links.push(
      agentReady
        ? { label: "Draft", agent: true, onClick: draft.request }
        : { label: "Draft with an agent…", agent: true, onClick: onNoAgent }
    );
  }
  if (draft.undo !== null && status.kind !== "drafting") {
    links.push({ label: "Undo", quiet: true, onClick: draft.undoReplace });
  }

  return (
    <>
      <div className="msg-foot" role="status">
        {source.tone === "agent" && <AgentGlyph />}
        <span className={`msg-foot__src msg-foot__src--${source.tone}`}>
          {source.text}
        </span>
        <span className="msg-foot__sp" />
        {links.map((link) => (
          <button
            key={link.label}
            type="button"
            className={`agent-link${link.quiet === true ? " agent-link--quiet" : ""}`}
            onClick={link.onClick}
          >
            {link.agent === true && <AgentGlyph size={10} />}
            {link.label}
          </button>
        ))}
      </div>
      {comparing && draft.pending && draft.draft !== null && (
        <div className="msg-compare">
          <div className="msg-compare__head">{agentName}'s draft</div>
          <div className="msg-compare__body">{draftText(draft.draft)}</div>
        </div>
      )}
    </>
  );
}
