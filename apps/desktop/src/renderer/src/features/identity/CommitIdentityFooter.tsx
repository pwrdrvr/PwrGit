import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import type { CommitIdentityInspection } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { dispatch } from "../../lib/pwrgit";
import { useDismissable } from "../../lib/useDismissable";
import {
  amendPreview,
  commitTags,
  footerView,
  identityDiagnostics,
  outsideView,
  provisionalFooter,
  pwrgitSourceLine,
  scopeLabel,
  signingLine,
  type FooterView
} from "./identity-view";

function openProfilesSettings(sub: "git-identity" | "list"): void {
  void dispatch("settings:open", { page: "profiles", sub });
}

/**
 * The `as …` line under Commit / Amend, and the details behind it.
 *
 * The line stays where it always was, at the size it always was, and became a
 * quiet button: a chevron is what says it opens something. It reports what
 * Git will record, resolved with the arguments PwrGit commits with, so it is
 * never the profile's value printed back. While Amend is hovered or focused it
 * shows the author Amend keeps instead.
 */
export function CommitIdentityFooter({
  inspection,
  fallbackEmail,
  amendHover
}: {
  inspection: CommitIdentityInspection | null;
  /** The profile's stored email, shown until the first inspection lands. */
  fallbackEmail: string;
  amendHover: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable({ open, onDismiss: close, triggerRef, surfaceRef });
  // A press anywhere else closes it. Not a fixed backdrop: the rail is a
  // size container, which makes it the containing block for `position:
  // fixed`, so a backdrop would cover the rail and miss the rest of the window.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (surfaceRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);
  const popoverId = useId();

  const view: FooterView =
    inspection === null ? provisionalFooter(fallbackEmail) : footerView(inspection);
  const preview = amendHover && inspection !== null ? amendPreview(inspection) : null;

  if (view.kind === "blocked") {
    return (
      <div className="commit-identity commit-identity--blocked" role="alert">
        <span>{view.message}</span>
        <button
          type="button"
          className="commit-identity__fix"
          onClick={() => openProfilesSettings("list")}
        >
          {view.action}
        </button>
        {inspection !== null && (
          <button
            ref={triggerRef}
            type="button"
            className="commit-identity__details"
            aria-expanded={open}
            aria-controls={open ? popoverId : undefined}
            onClick={() => setOpen((v) => !v)}
          >
            Details
          </button>
        )}
        {open && inspection !== null && (
          <IdentityPopover id={popoverId} ref={surfaceRef} inspection={inspection} onClose={close} />
        )}
      </div>
    );
  }

  return (
    <div className="commit-identity">
      <button
        ref={triggerRef}
        type="button"
        className={`commit-identity__line${open ? " is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={
          preview !== null
            ? `Amend keeps author ${preview.author}. Show commit identity details`
            : "Show commit identity details"
        }
        disabled={inspection === null}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="commit-identity__text">
          {preview !== null ? (
            <>
              <span className="commit-identity__row">Amend keeps author {preview.author}</span>
              {preview.committer !== null && (
                <span className="commit-identity__row">
                  <span className="commit-identity__key">committer</span> {preview.committer}
                </span>
              )}
            </>
          ) : view.kind === "split" ? (
            <>
              <span className="commit-identity__row">
                <span className="commit-identity__key">author</span> {view.author}
              </span>
              <span className="commit-identity__row">
                <span className="commit-identity__key">committer</span> {view.committer}
              </span>
            </>
          ) : (
            <span className="commit-identity__row">{view.line}</span>
          )}
        </span>
        <span className="commit-identity__chevron" aria-hidden="true" />
      </button>
      {open && inspection !== null && (
        <IdentityPopover id={popoverId} ref={surfaceRef} inspection={inspection} onClose={close} />
      )}
    </div>
  );
}

function IdentityPopover({
  id,
  ref,
  inspection,
  onClose
}: {
  id: string;
  ref: RefObject<HTMLDivElement | null>;
  inspection: CommitIdentityInspection;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { pwrgit, signing } = inspection;
  const outside = outsideView(inspection.outside, "checkout");
  return (
    <div
      id={id}
      ref={ref}
      className="commit-identity-popover"
      role="dialog"
      aria-label="Commit identity"
      tabIndex={-1}
    >
      <section className="commit-identity-popover__section">
        <h3>PwrGit will record</h3>
        {pwrgit.ok ? (
          <dl>
            <dt>Author</dt>
            <dd>
              <code>{pwrgit.author.name} &lt;{pwrgit.author.email}&gt;</code>
              <span className="commit-identity-popover__src">{pwrgitSourceLine(inspection)}</span>
            </dd>
            <dt>Committer</dt>
            <dd>
              {pwrgit.committer.email === pwrgit.author.email && pwrgit.committer.name === pwrgit.author.name ? (
                "Same as author"
              ) : (
                <code>{pwrgit.committer.name} &lt;{pwrgit.committer.email}&gt;</code>
              )}
            </dd>
            <dt>Signature</dt>
            <dd>{signingLine(signing)}</dd>
          </dl>
        ) : (
          <p className="commit-identity-popover__warn">{pwrgit.message}</p>
        )}
      </section>

      <section className="commit-identity-popover__section">
        <h3>Git outside PwrGit, in this checkout</h3>
        <dl>
          {outside.rows.map((row) => (
            <FragmentRow key={row.label} label={row.label} value={row.value} />
          ))}
        </dl>
        {outside.consequence !== null && (
          <p className="commit-identity-popover__warn">{outside.consequence}</p>
        )}
        {inspection.env.length > 0 && (
          <p className="commit-identity-popover__note">
            PwrGit was started with {inspection.env.map((e) => e.variable).join(", ")} set. It
            removes them from its own commits; a terminal started the same way still applies them.
          </p>
        )}
        {outside.status !== "configured" && (
          <button
            type="button"
            className="commit-identity-popover__action"
            onClick={() => {
              onClose();
              openProfilesSettings("git-identity");
            }}
          >
            Set up Git identity…
          </button>
        )}
      </section>

      {inspection.recent.length > 0 && (
        <section className="commit-identity-popover__section">
          <h3>Recorded in recent commits</h3>
          <ul className="commit-identity-popover__commits">
            {inspection.recent.map((commit) => (
              <li key={commit.hash}>
                <code className="commit-identity-popover__sha">{commit.hash.slice(0, 7)}</code>
                <code className="commit-identity-popover__who">{commit.author.email}</code>
                {commitTags(commit, inspection.profile.email).map((tag) => (
                  <span key={tag} className="commit-identity-popover__tag">
                    {tag}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          <p className="commit-identity-popover__note">
            A commit records who, not how. PwrGit can show that these differ; it can’t say which
            tool chose the address.
          </p>
        </section>
      )}

      <details className="commit-identity-popover__sources">
        <summary>Where these come from</summary>
        {inspection.config.length === 0 && inspection.env.length === 0 ? (
          <p className="commit-identity-popover__note">
            No identity or signing settings in any Git config file.
          </p>
        ) : (
          <table>
            <tbody>
              {inspection.config.map((entry, index) => (
                <tr key={`${entry.key}:${entry.origin}:${index}`}>
                  <td><code>{entry.key}</code></td>
                  <td>{scopeLabel(entry)}</td>
                  <td>
                    <code>{entry.value}</code>
                    {entry.origin !== "" && <span className="commit-identity-popover__src">{entry.origin}</span>}
                  </td>
                </tr>
              ))}
              {inspection.env.map((env) => (
                <tr key={env.variable}>
                  <td><code>{env.variable}</code></td>
                  <td>env</td>
                  <td><code>{env.value}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>

      <div className="commit-identity-popover__foot">
        <button
          type="button"
          className="commit-identity-popover__action"
          onClick={() => {
            onClose();
            openProfilesSettings("list");
          }}
        >
          Edit {inspection.profile.name}…
        </button>
        <button
          type="button"
          className="commit-identity-popover__action"
          onClick={() => {
            void copyText(identityDiagnostics(inspection)).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy diagnostics"}
        </button>
      </div>
    </div>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
