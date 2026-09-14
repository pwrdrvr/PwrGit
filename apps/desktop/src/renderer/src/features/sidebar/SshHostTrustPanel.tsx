import { useEffect, useRef, useState } from "react";
import type { ForgeKind, SshHostTrustProposal, SshHostVerification } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { copyText } from "../../lib/copyText";

/** The tone a verification state is entitled to.
 *
 *  `published-match` is the one good answer in the set — PwrGit compared the
 *  key the server just offered against the list the forge publishes over
 *  HTTPS and they agree — so it must not keep wearing the failure's red.
 *  `mismatch` is the one actively dangerous answer and keeps it. Everything
 *  else is "we could not tell", which is a caution, not a verdict. */
export function sshTrustTone(verification: SshHostVerification): "ok" | "warn" | "danger" {
  if (verification === "published-match") return "ok";
  if (verification === "mismatch") return "danger";
  return "warn";
}

/** The headline, written as the answer to "may I trust this?" rather than as a
 *  restatement of the git failure the user already read. */
function headline(proposal: SshHostTrustProposal): string {
  switch (proposal.verification) {
    case "published-match":
      return "This key matches the one the forge publishes";
    case "mismatch":
      return "This key contradicts the forge’s published keys";
    case "existing-key":
      return "A key is already trusted for this host";
    case "lookup-failed":
      return "The published key list could not be reached";
    default:
      return "No published key list covers this host";
  }
}

export function SshHostTrustPanel(props: {
  kind: ForgeKind;
  hostname: string;
  onTrusted: () => void;
  /** Lets the surrounding card retone and retitle itself, so the verdict is
   *  carried by the whole block and not by one paragraph inside it. */
  onVerification?: (verification: SshHostVerification | null) => void;
}) {
  const [proposal, setProposal] = useState<SshHostTrustProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [copied, setCopied] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // `copied` is a transient acknowledgement, not a state the button should
  // rest in — without this the label reads "Copied" until the panel unmounts.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const settle = (next: SshHostTrustProposal | null) => {
    setProposal(next);
    props.onVerification?.(next === null ? null : next.verification);
  };
  const inspect = async () => {
    if (busy) return;
    setBusy(true); setError(null); setVerified(false);
    try {
      const result = await dispatch("forge:inspectSshHost", { kind: props.kind, hostname: props.hostname });
      if (!live.current) return;
      if (result.ok) settle(result.value);
      else setError(result.error.message);
    } catch { if (live.current) setError("The host key could not be inspected. Use the terminal command below."); }
    finally { if (live.current) setBusy(false); }
  };
  const trust = async () => {
    if (busy || !proposal || !proposal.canTrust || (proposal.verification !== "published-match" && !verified)) return;
    setBusy(true); setError(null);
    try {
      const result = await dispatch("forge:trustSshHost", { proposalId: proposal.id });
      if (!live.current) return;
      if (result.ok) props.onTrusted();
      else { setError(result.error.message); settle(null); }
    } catch { if (live.current) setError("The host key could not be saved. Inspect the host again."); }
    finally { if (live.current) setBusy(false); }
  };
  const tone = proposal === null ? null : sshTrustTone(proposal.verification);
  const needsAcknowledgement = proposal !== null && proposal.canTrust && proposal.verification !== "published-match";
  return <div className="ssh-trust">
    {proposal === null ? (
      <button
        type="button"
        className="ssh-trust__button ssh-trust__button--primary"
        // Busy is aria-disabled, never `disabled`: Chromium blurs a control the
        // moment it is disabled, so a keyboard activation would throw focus to
        // <body> for the length of the lookup (SC 2.4.3). The handler guards.
        aria-disabled={busy}
        aria-busy={busy}
        onClick={() => void inspect()}
      >{busy ? "Checking host key…" : "Inspect host key"}</button>
    ) : (
      <section className={`ssh-trust__result ssh-trust__result--${tone}`} aria-label="Verify SSH server identity">
        <p className="ssh-trust__headline">{headline(proposal)}</p>
        <div className="ssh-trust__key">
          <div className="ssh-trust__endpoint">
            <strong>{proposal.hostname}:{proposal.port}</strong>
            <span className="ssh-trust__algorithm">{proposal.algorithm}</span>
          </div>
          {/* The one string the user has to compare character by character, so
              it gets the mono token, room to breathe, and a copy of its own —
              `.app` makes chrome unselectable, and a fingerprint you cannot
              select is a fingerprint you cannot check. */}
          <code className="ssh-trust__fingerprint">{proposal.fingerprint}</code>
          <button
            type="button"
            className="ssh-trust__button ssh-trust__button--quiet"
            onClick={() => { void copyText(proposal.fingerprint).then(() => setCopied(true)).catch(() => setCopied(false)); }}
          >{copied ? "Copied" : "Copy fingerprint"}</button>
        </div>
        <p className="ssh-trust__message">{proposal.message}</p>
        {proposal.sourceUrl !== null && <p className="ssh-trust__source">
          Compared with{" "}
          <button
            type="button"
            className="ssh-trust__link"
            /* No hover card: `.ssh-trust__link` sets `overflow-wrap: anywhere`,
               so the URL is fully visible in the button's own text. */
            onClick={() => { void dispatch("shell:openExternal", { url: proposal.sourceUrl! }); }}
          >{proposal.sourceUrl}</button>
        </p>}
        {needsAcknowledgement && <label className="ssh-trust__ack">
          <input type="checkbox" checked={verified} disabled={busy} onChange={(event) => setVerified(event.target.checked)} />
          <span>I verified this fingerprint with the host administrator or another trusted source.</span>
        </label>}
        {proposal.canTrust && <p className="ssh-trust__note">Saves the displayed key in your SSH known_hosts file. SSH will still reject a different key on retry.</p>}
        <div className="ssh-trust__actions">
          {proposal.canTrust && <button
            type="button"
            className="ssh-trust__button ssh-trust__button--primary"
            // Genuinely unavailable until the box is ticked — that one stays a
            // real `disabled`. Only the in-flight state is aria-disabled.
            disabled={needsAcknowledgement && !verified}
            aria-disabled={busy}
            aria-busy={busy}
            onClick={() => void trust()}
          >{busy ? "Saving…" : "Trust and retry"}</button>}
          <button
            type="button"
            className="ssh-trust__button"
            aria-disabled={busy}
            onClick={() => { if (busy) return; settle(null); setVerified(false); }}
          >Cancel</button>
        </div>
      </section>
    )}
    {error !== null && <p className="ssh-trust__error" role="alert">{error}</p>}
  </div>;
}
