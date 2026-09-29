import type { ReactNode } from "react";

export type ExplainAction = { label: string; onClick: () => void };

/** The L1 template shared by hook receipts and personal ignore rules. */
export function DiscoveryExplainPopover({
  title,
  sentence,
  where,
  scope,
  command,
  actions,
  manual
}: {
  title: string;
  sentence: string;
  where: ReactNode;
  scope: string | string[];
  command: string;
  actions: ExplainAction[];
  manual?: { label: string; onClick: () => void };
}) {
  const scopes = typeof scope === "string" ? [scope] : scope;
  return <div className="discovery-explain">
    <strong>{title}</strong>
    <p>{sentence}</p>
    <dl>
      <dt>Where</dt><dd className="discovery-explain__where">{where}</dd>
      <dt>Scope</dt><dd>{scopes.map((item) => <span key={item} className={`discovery-scope discovery-scope--${item.startsWith("committed") ? "gitignore" : item.startsWith("this clone") ? "exclude" : "global"}`}>{item}</span>)}</dd>
      <dt>Command</dt><dd><code>{command}</code></dd>
    </dl>
    <div className="discovery-explain__actions">
      {actions.map((action) => <button key={action.label} onClick={action.onClick}>{action.label}</button>)}
      {manual !== undefined && <button className="discovery-explain__manual" onClick={manual.onClick}>{manual.label} ↗</button>}
    </div>
  </div>;
}
