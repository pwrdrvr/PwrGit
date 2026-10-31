import { useEffect, useState } from "react";
import { forgeAllHostsOff, forgeProduct, parseArtifactsRemote, type ArtifactsAccountStatus, type ArtifactsCredentialStatus, type ForgeKind, type ForgeStatus } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { SettingsField, SettingsSection } from "./SettingsLayout";

/** Repo tokens are entered once and never returned by a read command. */
export function ArtifactsSettingsSection({ kind, blocked, forgeStatus, onSetAccountEnabled }: { kind: ForgeKind; blocked: boolean; forgeStatus: ForgeStatus | undefined; onSetAccountEnabled?: (hostname: string, enabled: boolean) => void }) {
  const [status, setStatus] = useState<ArtifactsCredentialStatus | null>(null);
  const [accounts, setAccounts] = useState<ArtifactsAccountStatus | null>(null);
  const [checkingAccount, setCheckingAccount] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [remote, setRemote] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const product = forgeProduct(kind);
  // Re-check and status pushes replace this snapshot. Read expiry metadata
  // again so the card and the live navigation cannot disagree. Cleanup
  // retires an older read that lands after a newer probe.
  useEffect(() => {
    let active = true;
    void dispatch("artifacts:credentials", undefined).then((result) => {
      if (!active) return;
      if (result.ok) setStatus(result.value); else setError(result.error.message);
    }).catch(() => { if (active) setError("PwrGit could not read credential metadata. Reopen Settings and retry."); });
    void dispatch("artifacts:accounts", {}).then((result) => {
      if (active && result.ok) setAccounts(result.value);
    }).catch(() => { if (active) setAccountError("PwrGit could not check Wrangler. Re-check the account."); });
    return () => { active = false; };
  }, [forgeStatus]);
  const checkAccount = async () => {
    setCheckingAccount(true); setAccountError(null);
    try {
      const result = await dispatch("artifacts:accounts", { force: true });
      if (result.ok) setAccounts(result.value); else setAccountError(result.error.message);
    } catch { setAccountError("PwrGit could not check Wrangler. Reopen Settings and retry."); }
    finally { setCheckingAccount(false); }
  };
  const save = async () => {
    if (busy || blocked) return;
    setBusy(true); setError(null);
    try {
      const result = await dispatch("artifacts:saveCredential", { remote, token });
      if (result.ok) { setStatus(result.value); setToken(""); setRemote(""); }
      else setError(result.error.message);
    } catch { setError("PwrGit could not update the connection. Reopen Settings and retry."); }
    finally { setBusy(false); }
  };
  const remove = async (savedRemote: string) => {
    if (busy || blocked) return;
    setBusy(true); setError(null);
    try {
      const result = await dispatch("artifacts:removeCredential", { remote: savedRemote });
      if (result.ok) setStatus(result.value); else setError(result.error.message);
    } catch { setError("PwrGit could not update the connection. Reopen Settings and retry."); }
    finally { setBusy(false); }
  };
  const open = (url: string) => { void dispatch("shell:openExternal", { url }); };
  return (
    <SettingsSection sectionId={kind} title={product.label} eyebrow="Integrations"
      description="Git over HTTPS with Wrangler or repository-scoped tokens. Requires an existing Workers Paid account."
      chip={forgeStatus !== undefined && forgeAllHostsOff(forgeStatus) ? "Off" : accounts?.loggedIn ? "Wrangler connected" : status === null ? "Checking…" : status.credentials.some((entry) => !entry.expired) ? "Tokens saved" : "Add token"}
    >
      <p className="settings-empty">Connect Wrangler to browse namespaces and repositories in Clone. Git operations issue a fresh read or write token through Wrangler. Saved repository tokens work when Wrangler is not connected. No fork, pull-request or author-account API, SSH, partial clone or Git LFS support.</p>
      <SettingsField label="Wrangler account" sub={accounts === null ? "Checking Wrangler…" : !accounts.installed ? "Install Wrangler with npm install -g wrangler, then restart PwrGit." : accounts.loggedIn ? "Wrangler manages your Cloudflare login. Repository tokens are issued in memory and expire after one hour." : "Run wrangler login in a terminal, then re-check here."}
        control={<button className="settings-inline-button" type="button" disabled={blocked || checkingAccount} onClick={() => void checkAccount()}>{checkingAccount ? "Checking…" : "Re-check Wrangler"}</button>}
        help="PwrGit never reads Wrangler's credential files or saves your Cloudflare API/OAuth token. Artifacts access requires the appropriate Cloudflare permissions."
      />
      {(accounts?.accounts ?? []).map((account) => <SettingsField key={account.hostname} label={account.name} sub={account.hostname}
        control={<label><input type="checkbox" aria-label={`Enable ${account.name}`} disabled={blocked || onSetAccountEnabled === undefined} checked={forgeStatus?.hosts?.find((entry) => entry.host === account.hostname)?.enabled !== false} onChange={(event) => onSetAccountEnabled?.(account.hostname, event.target.checked)} /> Enabled</label>}
      />)}
      <SettingsField label="Cloudflare setup" sub="Copy the exact Git remote and issue a repository token in Cloudflare. Read tokens allow clone, fetch and pull; write tokens also allow push."
        control={<div className="settings-field__actions">
          <button className="settings-inline-button" type="button" onClick={() => open("https://dash.cloudflare.com/")}>Open Cloudflare dashboard</button>
          <button className="settings-inline-button" type="button" onClick={() => open("https://developers.cloudflare.com/artifacts/guides/authentication/")}>Token guide</button>
        </div>}
      />
      {status?.secureStorageAvailable === false && <p className="settings-field__error" role="alert">Secure OS credential storage is unavailable. Unlock or configure your OS keyring and reopen this pane. Plaintext storage is refused.</p>}
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <SettingsField label="Repository remote" sub="Use the credential-free remote returned by the API or copied from the dashboard."
          control={<input className="settings-input" aria-label="Artifacts repository remote" value={remote} onChange={(event) => setRemote(event.target.value)} placeholder="https://<account-id>.artifacts.cloudflare.net/git/default/my-repo.git" autoComplete="off" spellCheck={false} disabled={busy || blocked} />}
        />
        <SettingsField label="Repository token" sub="Paste the full art_v1_…?expires=… token. A Cloudflare API token cannot authenticate Git."
          control={<input className="settings-input" aria-label="Artifacts repository token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" spellCheck={false} disabled={busy || blocked} />}
          help="PwrGit encrypts the token using OS credential storage in a separate credential file. It never saves the token in settings or the Git remote. Saved tokens are not verified against Cloudflare."
        />
        <SettingsField label="Save connection" sub="After saving, paste this remote into Clone, or add it to an existing repository. Renew expired or revoked tokens in Cloudflare and replace them here."
          control={<button type="submit" className="settings-button" disabled={busy || blocked || !remote.trim() || !token.trim() || status?.secureStorageAvailable === false}>{busy ? "Saving…" : "Save repo token"}</button>}
        />
      </form>
      {error !== null && <p className="settings-field__error" role="alert">{error}</p>}
      {accountError !== null && <p className="settings-field__error" role="alert">{accountError}</p>}
      {status?.credentials.map((entry) => {
        const repository = parseArtifactsRemote(entry.remote);
        return <SettingsField key={entry.remote} label={repository === null ? "Saved repository" : `${repository.namespace}/${repository.repo}`}
          sub={`${entry.expired ? "Expired" : "Expires"} ${new Date(entry.expiresAt).toLocaleString()}.`}
          control={<>
            <input className="settings-input" aria-label={`Saved remote for ${repository?.repo ?? "repository"}`} value={entry.remote} readOnly />
            <button className="settings-inline-button" type="button" disabled={busy || blocked} onClick={() => void remove(entry.remote)}>Forget token</button>
          </>}
        />;
      })}
    </SettingsSection>
  );
}
