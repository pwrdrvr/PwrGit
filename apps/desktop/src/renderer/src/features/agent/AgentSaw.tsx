import { useState } from "react";
import type { AgentInputFile, AgentInputManifest } from "@pwrgit/shared";

const countFormat = new Intl.NumberFormat();

function treatmentLabel(file: AgentInputFile): string {
  switch (file.treatment) {
    case "cut":
      return `${countFormat.format(file.sentLines)} of ${countFormat.format(file.totalLines)} lines`;
    case "lockfile":
      return "lockfile, not sent";
    case "snapshot":
      return "snapshot, not sent";
    case "binary":
      return "binary, not sent";
    case "never_send":
      return "never sent";
    case "sent":
      return file.removed === 0 && file.added > 0
        ? `+${file.added}`
        : `+${file.added} −${file.removed}`;
  }
}

/** "Saw 4 diffs · 3 files · 212 lines" — the one-line summary. */
export function sawSummary(manifest: AgentInputManifest): string {
  const sent = manifest.files.filter(
    (file) => file.treatment === "sent" || file.treatment === "cut"
  ).length;
  const lines = `${countFormat.format(manifest.budget.used)} line${manifest.budget.used === 1 ? "" : "s"}`;
  if (manifest.source === "staged") {
    return `staged changes only · ${sent} file${sent === 1 ? "" : "s"} · ${lines}`;
  }
  return `${manifest.commitCount} diff${manifest.commitCount === 1 ? "" : "s"} · ${sent} file${sent === 1 ? "" : "s"} · ${lines}`;
}

/**
 * What the agent was sent, one click from every draft: each file and how much
 * of it went, what was held back and why, and the line budget.
 */
export function AgentSaw({
  manifest,
  providerName,
  model
}: {
  manifest: AgentInputManifest;
  providerName: string;
  model: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="agent-saw">
        Saw <b>{sawSummary(manifest)}</b>, no repo access, no tools ·{" "}
        <button
          type="button"
          className="agent-link"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide details" : "Details"}
        </button>
      </div>
      {open && (
        <div className="agent-saw__details">
          <div className="agent-saw__head">
            Sent to {providerName}
            {model !== "" ? ` · ${model}` : ""}
          </div>
          {manifest.files.map((file) => (
            <div
              key={file.path}
              className={`agent-saw__row agent-saw__row--${file.treatment}`}
            >
              <span className="agent-saw__path">{file.path}</span>
              <span className="agent-saw__n">{treatmentLabel(file)}</span>
            </div>
          ))}
          <div className="agent-saw__div" />
          {manifest.source === "commits" && (
            <div className="agent-saw__row">
              <span>
                {manifest.commitCount} commit subject
                {manifest.commitCount === 1 ? "" : "s"} and bodies
              </span>
              <span className="agent-saw__n">as data</span>
            </div>
          )}
          <div className="agent-saw__row">
            <span>
              {manifest.styleSubjects} recent subject
              {manifest.styleSubjects === 1 ? "" : "s"}
            </span>
            <span className="agent-saw__n">style only</span>
          </div>
          <div className="agent-saw__row">
            <span>Budget</span>
            <span className="agent-saw__n">
              {countFormat.format(manifest.budget.used)} of{" "}
              {countFormat.format(manifest.budget.limit)} lines
            </span>
          </div>
          <div className="agent-saw__div" />
          <p>
            Scratch workspace, no tools, read-only sandbox, no repository path.
            Commit text and diffs are sent as data; instructions inside them
            are ignored. Lockfiles, snapshots, binaries, keys and{" "}
            <code>.env</code> files are never sent.
          </p>
        </div>
      )}
    </>
  );
}
