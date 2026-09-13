import { useEffect, useRef, useState } from "react";
import type { ForgeKind, SshHostTrustProposal } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

export function SshHostTrustPanel(props: { kind: ForgeKind; hostname: string; onTrusted: () => void }) {
  const [proposal, setProposal] = useState<SshHostTrustProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const inspect = async () => {
    setBusy(true); setError(null); setVerified(false);
    try {
      const result = await dispatch("forge:inspectSshHost", { kind: props.kind, hostname: props.hostname });
      if (!live.current) return;
      if (result.ok) setProposal(result.value);
      else setError(result.error.message);
    } catch { if (live.current) setError("The host key could not be inspected. Use the terminal command below."); }
    finally { if (live.current) setBusy(false); }
  };
  const trust = async () => {
    if (!proposal || !proposal.canTrust || (proposal.verification !== "published-match" && !verified)) return;
    setBusy(true); setError(null);
    try {
      const result = await dispatch("forge:trustSshHost", { proposalId: proposal.id });
      if (!live.current) return;
      if (result.ok) props.onTrusted();
      else { setError(result.error.message); setProposal(null); }
    } catch { if (live.current) setError("The host key could not be saved. Inspect the host again."); }
    finally { if (live.current) setBusy(false); }
  };
  return <div>
    {proposal === null ? <p><button type="button" className="settings-button" disabled={busy} onClick={() => void inspect()}>{busy ? "Checking host key…" : "Inspect host key"}</button></p> : <section aria-label="Verify SSH server identity">
      <p><strong>{proposal.hostname}:{proposal.port}</strong> · {proposal.algorithm}</p>
      <p><code>{proposal.fingerprint}</code></p>
      <p>{proposal.message}</p>
      {proposal.sourceUrl !== null && <p>Published source: <button type="button" className="settings-button" onClick={() => { void dispatch("shell:openExternal", { url: proposal.sourceUrl! }); }}>{proposal.sourceUrl}</button></p>}
      {proposal.canTrust && proposal.verification !== "published-match" && <p><label><input type="checkbox" checked={verified} disabled={busy} onChange={(event) => setVerified(event.target.checked)} /> I verified this fingerprint with the host administrator or another trusted source.</label></p>}
      {proposal.canTrust && <p>This saves the displayed key in your SSH known_hosts file. SSH will still reject a different key on retry.</p>}
      <p>{proposal.canTrust && <button type="button" className="settings-button" disabled={busy || (proposal.verification !== "published-match" && !verified)} onClick={() => void trust()}>{busy ? "Saving…" : "Trust and retry"}</button>}{" "}<button type="button" className="settings-button" disabled={busy} onClick={() => { setProposal(null); setVerified(false); }}>Cancel</button></p>
    </section>}
    {error !== null && <p role="alert">{error}</p>}
  </div>;
}
