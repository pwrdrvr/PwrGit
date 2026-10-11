import { useState } from "react";
import type { ArtifactsAccountStatus, CloneRepository, ForgeStatus } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

/** Explicit browsing keeps opening Clone cheap. All network reads stay in main. */
export function ArtifactsRepositoryBrowser({ disabled, status, onChoose }: {
  disabled: boolean; status: ForgeStatus | undefined; onChoose: (repository: CloneRepository) => void;
}) {
  const [accounts, setAccounts] = useState<ArtifactsAccountStatus | null>(null);
  const [hostname, setHostname] = useState("");
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("");
  const [repos, setRepos] = useState<CloneRepository[]>([]);
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    if (disabled || busy) return;
    setBusy(true); setError(null);
    try { await action(); } catch { setError("Could not contact PwrGit. Reopen Clone and retry."); }
    finally { setBusy(false); }
  };
  const load = () => run(async () => {
    const result = await dispatch("artifacts:accounts", {});
    if (!result.ok) { setError(result.error.message); return; }
    setAccounts(result.value);
    if (!result.value.installed) setError("Install Wrangler with npm install -g wrangler, then run wrangler login and re-check in Settings → Forges.");
    else if (!result.value.loggedIn) setError("Run wrangler login, then re-check in Settings → Forges.");
  });
  const chooseAccount = (next: string) => run(async () => {
    setHostname(next); setNamespace(""); setNamespaces([]); setRepos([]);
    if (!next) return;
    const result = await dispatch("artifacts:namespaces", { hostname: next });
    if (result.ok) setNamespaces(result.value); else setError(result.error.message);
  });
  const chooseNamespace = (next: string) => run(async () => {
    setNamespace(next); setRepos([]);
    if (!next) return;
    const result = await dispatch("artifacts:repos", { hostname, namespace: next });
    if (result.ok) setRepos(result.value); else setError(result.error.message);
  });
  const create = () => run(async () => {
    const result = await dispatch("artifacts:createRepo", { hostname, namespace, name });
    if (result.ok) { setRepos((current) => [...current, result.value]); setName(""); onChoose(result.value); }
    else setError(result.error.message);
  });
  const pick = (repository: CloneRepository) => run(async () => {
    const result = await dispatch("artifacts:repo", { remote: repository.httpsUrl });
    if (result.ok) onChoose(result.value); else setError(result.error.message);
  });
  return <div className="clone-section">
    <button className="settings-inline-button" type="button" disabled={disabled || busy} onClick={() => void load()}>Browse Cloudflare repositories</button>
    {accounts?.loggedIn && <>
      <label className="clone-label">Cloudflare account
        <select className="settings-input" aria-label="Cloudflare account" value={hostname} disabled={disabled || busy} onChange={(event) => void chooseAccount(event.target.value)}>
          <option value="">Choose an account…</option>
          {accounts.accounts.filter((account) => !status?.hosts?.some((entry) => entry.host === account.hostname && !entry.enabled)).map((account) => <option key={account.hostname} value={account.hostname}>{account.name}</option>)}
        </select>
      </label>
      {hostname && <label className="clone-label">Namespace
        <select className="settings-input" aria-label="Artifacts namespace" value={namespace} disabled={disabled || busy} onChange={(event) => void chooseNamespace(event.target.value)}>
          <option value="">{namespaces.length ? "Choose a namespace…" : "No namespaces available"}</option>
          {namespaces.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </label>}
      {namespace && <>
        <input className="settings-input" aria-label="Filter Artifacts repositories" placeholder="Filter repositories" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <div className="clone-source-results" role="listbox" aria-label="Artifacts repositories">
          {repos.filter((repo) => repo.name.toLowerCase().includes(filter.toLowerCase())).map((repo) => <button type="button" role="option" aria-selected={false} className="clone-source-row" key={repo.httpsUrl} disabled={disabled || busy} onClick={() => void pick(repo)}>{repo.nameWithOwner}{repo.viewerCanPush === false ? " · Read only" : ""}</button>)}
        </div>
        {repos.length === 0 && !busy && <p>No repositories in this namespace.</p>}
        <label className="clone-label">Create a repository in {namespace}
          <input className="settings-input" aria-label="New Artifacts repository name" value={name} onChange={(event) => setName(event.target.value)} disabled={disabled || busy} />
        </label>
        <p>Creates an empty repository in the selected Cloudflare account and namespace.</p>
        <button type="button" className="settings-inline-button" disabled={disabled || busy || !name.trim()} onClick={() => void create()}>Create repository</button>
      </>}
    </>}
    {busy && <p role="status">Loading Cloudflare…</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
