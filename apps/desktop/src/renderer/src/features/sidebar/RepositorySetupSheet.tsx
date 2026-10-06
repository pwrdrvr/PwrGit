import { useEffect, useMemo, useState } from "react";
import type { IgnoreDestination, RepositorySetup, SetupIgnoreTest } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { useModal } from "../../lib/useModal";
import { showErrorToast } from "../../lib/toast";
import { ChevronGlyph } from "../../lib/ChevronGlyph";
import { currentPlatform, thisMachineNoun } from "../../lib/platform";

function layerTitle(destination: IgnoreDestination, platform: string): string {
  if (destination === "gitignore") return "Team rules";
  if (destination === "exclude") return "This clone";
  return `This ${thisMachineNoun(platform)}`;
}
const hookLanes = [
  { name: "Commit", action: "git commit", hooks: ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"] },
  { name: "Push", action: "git push", hooks: ["pre-push"] },
  { name: "Switch", action: "git switch", hooks: ["post-checkout"] },
  { name: "Merge", action: "git merge", hooks: ["pre-merge-commit", "post-merge"] },
  { name: "Rebase", action: "git rebase", hooks: ["pre-rebase", "post-rewrite"] }
] as const;

export function RepositorySetupSheet({ repo, initialPage = "hooks", onClose, platform = currentPlatform() }: {
  repo: { id: string; name: string; path: string };
  initialPage?: "hooks" | "ignore";
  onClose: () => void;
  /** Explicit only in deterministic platform component tests. */
  platform?: string;
}) {
  const modalRef = useModal<HTMLDivElement>({ onClose });
  const [page, setPage] = useState(initialPage);
  const [setup, setSetup] = useState<RepositorySetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [samplesOpen, setSamplesOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [selectedMapHook, setSelectedMapHook] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [excludeDraft, setExcludeDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [testPath, setTestPath] = useState("");
  const [testResult, setTestResult] = useState<SetupIgnoreTest | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void dispatch("repo:setup", { repoId: repo.id }).then((result) => {
      if (!active) return;
      if (result.ok) {
        setSetup(result.value);
        setExcludeDraft(result.value.ignore.find((layer) => layer.destination === "exclude")?.content ?? "");
      } else setError(result.error.message);
    });
    return () => { active = false; };
  }, [repo.id]);

  const exclude = setup?.ignore.find((layer) => layer.destination === "exclude");
  const sampleCount = setup?.hooks.sampleCount ?? 0;
  const activeHooks = setup?.hooks.active ?? [];
  const shadowedHooks = setup?.hooks.shadowed ?? [];
  const lfsShadowed = setup?.hooks.lfsShadowed ?? false;
  const lfsPrePushShadowed = shadowedHooks.some((hook) => hook.name === "pre-push" && /git\s+lfs\s+pre-push/.test(hook.calls));
  const mappedHook = activeHooks.find((hook) => hook.name === selectedMapHook) ?? shadowedHooks.find((hook) => hook.name === selectedMapHook);
  const scope = `this clone · ${setup?.hooks.worktreeCount ?? 1} worktree${setup?.hooks.worktreeCount === 1 ? "" : "s"}`;
  const winner = useMemo(() => {
    if (testResult?.source === null || testResult?.source === undefined) return null;
    return setup?.ignore.find((layer) => layer.path === testResult.source || layer.displayPath === testResult.source || (layer.destination === "gitignore" && testResult.source === ".gitignore"))?.destination ?? null;
  }, [testResult, setup]);

  const saveExclude = async (): Promise<void> => {
    if (exclude === undefined || saving) return;
    setSaving(true);
    const result = await dispatch("repo:saveExclude", { repoId: repo.id, previous: exclude.content, content: excludeDraft });
    setSaving(false);
    if (!result.ok) { setError(result.error.message); return; }
    const refreshed = await dispatch("repo:setup", { repoId: repo.id });
    if (refreshed.ok) setSetup(refreshed.value);
    setEditing(false);
    setError(null);
  };

  const test = async (): Promise<void> => {
    if (testPath.trim() === "") return;
    setTestBusy(true);
    setTestError(null);
    const result = await dispatch("repo:testIgnorePath", { repoId: repo.id, path: testPath.trim() });
    setTestBusy(false);
    if (result.ok) setTestResult(result.value);
    else { setTestResult(null); setTestError(result.error.message); }
  };

  const openPath = async (path: string): Promise<void> => {
    const result = await dispatch("shell:openPath", { path });
    if (!result.ok) showErrorToast({ title: "Could not open file", message: result.error.message, subject: { repoId: repo.id } });
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div ref={modalRef} className="modal repository-setup" role="dialog" aria-modal="true" aria-label={`Repository setup for ${repo.name}`} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <header className="repository-setup__header"><h2>Repository setup</h2><code title={repo.path}>{repo.name} · {repo.path}</code><button type="button" className="modal__cancel" onClick={onClose}>Done</button></header>
        <div className="repository-setup__grid">
          <nav className="repository-setup__nav" aria-label="Repository setup pages">
            <button type="button" className={page === "hooks" ? "is-selected" : ""} onClick={() => setPage("hooks")}>Hooks <span>{activeHooks.length}</span></button>
            <button type="button" className={page === "ignore" ? "is-selected" : ""} onClick={() => setPage("ignore")}>Ignore rules <span>{setup?.ignore.reduce((count, layer) => count + layer.lines.length, 0) ?? 0}</span></button>
          </nav>
          <main className="repository-setup__body">
            {error !== null && <div className="modal__error" role="alert">{error}</div>}
            {setup === null && error === null && <p>Reading repository setup…</p>}
            {setup !== null && page === "hooks" && <>
              <div className="repository-setup__heading"><h3>Hooks</h3><span className="discovery-scope discovery-scope--exclude">{scope}</span></div>
              <p className="repository-setup__intro">Git runs these scripts at fixed points, including commits and pushes. The same hooks directory serves every worktree in this clone.</p>
              <div className="repository-setup__resolved"><span>Git reads hooks from</span><code title={setup.hooks.directory}>{setup.hooks.displayDirectory}</code><span>because</span><code>{setup.hooks.configuredPath === null ? "Git’s default hooks directory" : `core.hooksPath = ${setup.hooks.configuredPath}`}</code><small>{setup.hooks.origin ?? "Git default"}</small></div>
              {shadowedHooks.length > 0 && <div className="repository-setup__warning" role="status"><strong>{shadowedHooks.length} hook{shadowedHooks.length === 1 ? "" : "s"} in <code>.git/hooks</code> {shadowedHooks.length === 1 ? "is" : "are"} not running</strong><p><code>core.hooksPath</code> points elsewhere, so Git does not run them.{lfsPrePushShadowed ? <> The shadowed <code>pre-push</code> calls Git LFS, so LFS files may not upload when you push. Call <code>git lfs pre-push</code> from the active hook to restore it.</> : lfsShadowed ? <> One of these hooks calls Git LFS. Add that call to the active hooks directory to restore it.</> : null}</p></div>}
              <div className="repository-setup__hooks">
                {activeHooks.length === 0 && <p>No executable hooks in <code>{setup.hooks.displayDirectory}</code>.</p>}
                {activeHooks.map((hook) => <div className="repository-setup__hook" key={hook.path}><code>{hook.name}</code><span><code title={hook.path}>{hook.displayPath}</code><span> → </span><code title={hook.calls}>{hook.calls}</code>{hook.lastRun && <small>Last ran {new Date(hook.lastRun.at).toLocaleString()} · {(hook.lastRun.elapsedMs / 1000).toFixed(1)}s</small>}</span><strong className={hook.lastRun?.exitCode === 0 ? "is-ok" : ""}>{hook.lastRun ? hook.lastRun.exitCode === 0 ? "passed" : `exit ${hook.lastRun.exitCode}` : ""}</strong></div>)}
                {shadowedHooks.map((hook) => <div className="repository-setup__hook is-shadowed" key={hook.path}><code>{hook.name}</code><span><code title={hook.path}>{hook.displayPath}</code><span> → </span><code title={hook.calls}>{hook.calls}</code></span><strong>not run</strong></div>)}
              </div>
              {sampleCount > 0 && <div><button type="button" className="repository-setup__samples" onClick={() => setSamplesOpen(!samplesOpen)} aria-expanded={samplesOpen}><ChevronGlyph right={!samplesOpen} /><span>{sampleCount} <code>.sample</code> files · examples Git ships disabled</span></button>{samplesOpen && <p className="repository-setup__intro">Git never runs <code>.sample</code> files. They are templates you can inspect in the hooks directory.</p>}</div>}
              <div className="repository-setup__actions"><button type="button" className="modal__cancel" onClick={() => void openPath(setup.hooks.directory)}>Open hooks directory</button><button type="button" className="modal__cancel" onClick={() => void dispatch("shell:revealPath", { path: setup.hooks.directory })}>Reveal directory</button><button type="button" className="modal__cancel" onClick={() => setMapOpen(!mapOpen)} aria-expanded={mapOpen}>{mapOpen ? "Hide hook map" : "Hook map…"}</button>{setup.hooks.manager !== null && <span>Managed by {setup.hooks.manager}</span>}</div>
              {mapOpen && <div className="repository-setup__map"><p className="repository-setup__intro">The hooks Git can run at each operation. Lit hooks are active in this clone; warning hooks are shadowed.</p>{hookLanes.map((lane) => <div className="repository-setup__lane" key={lane.name}><strong>{lane.name}<small>{lane.action}</small></strong><div>{lane.hooks.map((name) => { const active = activeHooks.some((hook) => hook.name === name); const shadowed = shadowedHooks.some((hook) => hook.name === name); return <button type="button" key={name} className={`${active ? "is-active" : shadowed ? "is-shadowed" : ""}${selectedMapHook === name ? " is-selected" : ""}`} onClick={() => setSelectedMapHook(name)}>{name}</button>; })}</div></div>)}{selectedMapHook !== null && <div className="repository-setup__map-detail"><strong><code>{selectedMapHook}</code></strong>{mappedHook === undefined ? <span>No executable <code>{selectedMapHook}</code> hook in this clone.</span> : <span><code>{mappedHook.displayPath}</code> → <code>{mappedHook.calls}</code>{shadowedHooks.includes(mappedHook) ? " · shadowed, not run" : mappedHook.lastRun ? ` · last ran ${(mappedHook.lastRun.elapsedMs / 1000).toFixed(1)}s, exit ${mappedHook.lastRun.exitCode}` : " · active"}</span>}</div>}</div>}
            </>}
            {setup !== null && page === "ignore" && <>
              <div className="repository-setup__heading"><h3>Ignore rules</h3></div>
              <p className="repository-setup__intro">Git checks these three places in precedence order. Within a file, later matches can override earlier ones. Rules hide untracked files only.</p>
              <div className="repository-setup__tester"><label htmlFor="repository-setup-test">Test a path</label><form onSubmit={(event) => { event.preventDefault(); void test(); }}><input id="repository-setup-test" value={testPath} onChange={(event) => { setTestPath(event.target.value); setTestResult(null); }} placeholder="build/debug.log" spellCheck={false}/><button type="submit" className="modal__cancel" disabled={testBusy || testPath.trim() === ""}>{testBusy ? "Testing…" : "Test"}</button></form>{testError !== null && <p role="alert">{testError}</p>}{testResult !== null && <p role="status">{testResult.ignored ? "Ignored" : "Not ignored"}{testResult.pattern !== null && <> · <code>{testResult.source}:{testResult.line}</code> · <code>{testResult.pattern}</code></>}</p>}</div>
              {setup.ignore.map((layer, index) => <section key={layer.destination} className={`repository-setup__layer${winner === layer.destination ? " is-winning" : ""}`}>
                <header><span className="repository-setup__ordinal">{index + 1}</span><div><strong>{layerTitle(layer.destination, platform)}</strong><code title={layer.path}>{layer.displayPath}</code></div><span className={`discovery-scope discovery-scope--${layer.destination}`}>{layer.scope}</span>{layer.destination === "exclude" ? <button type="button" onClick={() => { setEditing(!editing); setExcludeDraft(layer.content); }}>{editing ? "Cancel" : "Edit inline"}</button> : <button type="button" onClick={() => void openPath(layer.path)}>{layer.destination === "gitignore" ? "Open in editor" : "Open file"}</button>}</header>
                {layer.destination === "exclude" && editing ? <div className="repository-setup__editor"><textarea aria-label="Edit .git/info/exclude" value={excludeDraft} onChange={(event) => setExcludeDraft(event.target.value)} spellCheck={false}/><button type="button" className="modal__create" onClick={() => void saveExclude()} disabled={saving || excludeDraft === layer.content}>{saving ? "Saving…" : "Save rules"}</button></div> : <div className="repository-setup__lines">{layer.lines.length === 0 ? <span>No rules yet</span> : layer.lines.map((line) => <div key={line.number} className={winner === layer.destination && testResult?.line === line.number ? "is-winning" : ""}><span>{line.number}</span><code>{line.text}</code></div>)}</div>}
              </section>)}
            </>}
          </main>
        </div>
      </div>
    </div>
  );
}
