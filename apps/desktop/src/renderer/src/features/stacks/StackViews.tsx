import { useState } from "react";
import type { Repo, RepositoryStack, StackLayer, StackPosition } from "@pwrgit/shared";
import { SectionChevron } from "../sidebar/SectionChevron";
import { PrChip } from "../sidebar/PrChip";
import { useStackNavigation } from "./stack-navigation";
import "./stacks.css";

export function branchHealthLabels(layer: StackLayer): string[] {
  const { health } = layer;
  return [
    ...(health.needsRestack ? ["Needs restack"] : []),
    ...(health.needsPush ? ["Needs push"] : []),
    ...(health.parentMerged ? ["Parent merged"] : []),
    ...(health.drift ? ["PR base differs"] : []),
    ...(health.remoteAhead ? ["Remote ahead"] : []),
    ...(health.inSync ? ["In sync"] : []),
  ];
}

export function StackPositionChip({ position, onSelect }: { position: StackPosition; onSelect: () => void }) {
  const { stack, layer, index } = position;
  return <button
    type="button"
    className={`stack-position${layer.health.needsRestack ? " stack-position--stale" : ""}`}
    aria-label={`Open stack for ${layer.branch}, position ${index} of ${stack.layers.length}`}
    onKeyDown={event => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    }}
    onClick={event => { event.stopPropagation(); onSelect(); }}
  >{index}/{stack.layers.length}</button>;
}

function StackSignals({ layer }: { layer: StackLayer }) {
  return <span className="stack-signals">
    {layer.health.needsRestack && <span className="stack-signal--restack" aria-label="Needs restack">⟳</span>}
    {layer.health.needsPush && <span className="stack-signal--push" aria-label="Needs push">↑</span>}
  </span>;
}

export function StacksSidebar({ repo, stacks }: { repo: Repo; stacks: RepositoryStack[] }) {
  const navigation = useStackNavigation();
  const [expanded, setExpanded] = useState(true);
  if (!stacks.length || !navigation) return null;
  const stale = stacks.reduce((count, stack) => count + stack.layers.filter(layer => layer.health.needsRestack).length, 0);
  return <div className="ref-section stack-sidebar">
    <div className="ref-section__head-wrap">
      <button type="button" className="ref-section__head" aria-expanded={expanded} onClick={event => {
        event.stopPropagation(); setExpanded(value => !value);
      }}>
        <SectionChevron open={expanded} />
        <span className="ref-section__label">Stacks</span>
        <span className="ref-section__count">{stacks.length}</span>
      </button>
      {stale > 0 && <span className="stack-health-badge stack-health-badge--stale">{stale} to restack</span>}
    </div>
    {expanded && stacks.map(stack => {
      const selected = navigation.pick?.repoId === repo.id && navigation.pick.stack.id === stack.id;
      return <div key={stack.id} className="stack-sidebar__stack">
        <button type="button" className={`stack-sidebar__title${stack.source === "inferred" ? " is-inferred" : ""}`}
          aria-pressed={selected} data-nav-anchor={`stack:${repo.id}:${stack.id}`}
          onClick={event => { event.stopPropagation(); navigation.select({ repoId: repo.id, stack }); }}>
          <span>{stack.layers[0].branch}</span>
          {stack.source === "inferred" && <small>Inferred</small>}
        </button>
        <ol className="stack-sidebar__spine">
          {stack.layers.map((layer, index) => <li key={layer.branch} className={layer.health.needsRestack ? "is-stale" : undefined}>
            <span className="stack-sidebar__branch">{layer.branch}</span>
            <span className="stack-sidebar__ordinal">{index + 1}/{stack.layers.length}</span>
            <StackSignals layer={layer} />
          </li>)}
          <li className="stack-sidebar__trunk"><span className="stack-sidebar__branch">{stack.trunk.branch}</span><small>Trunk</small></li>
        </ol>
      </div>;
    })}
  </div>;
}

export function StackView({ stack, repoId, onClose, onShowRail }: {
  stack: RepositoryStack; repoId: string; onClose: () => void; onShowRail?: () => void;
}) {
  return <section className="stack-view" aria-label="Stack" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <header className="stack-view__header">
      <button type="button" className="stack-button" onClick={onClose} aria-label="Back to worktree">←</button>
      <h1>{stack.layers[0].branch}</h1>
      <small>{stack.layers.length} {stack.layers.length === 1 ? "branch" : "branches"}</small>
      {stack.source === "inferred" && <span className="stack-health-badge">Inferred</span>}
      {onShowRail && <button type="button" className="stack-button" onClick={onShowRail}>Show panel</button>}
    </header>
    <ol className="stack-view__cards">
      {stack.layers.map((layer, index) => <li key={layer.branch} className={`stack-card${layer.health.needsRestack ? " is-stale" : ""}`}>
        <div className="stack-card__line">
          <span className="stack-card__ordinal">{index + 1}/{stack.layers.length}</span>
          <strong>{layer.branch}</strong>
          {layer.pr && <PrChip pr={layer.pr} repoId={repoId} />}
          {layer.pr && <span className="stack-card__pr-title">{layer.pr.title}</span>}
        </div>
        <div className="stack-card__line stack-card__detail">
          <span>on {layer.parent}</span>
          {layer.head && <code className="selectable">{layer.head.slice(0, 8)}</code>}
          {branchHealthLabels(layer).map(label => <span key={label} className={`stack-health-badge${label === "Needs restack" ? " stack-health-badge--stale" : ""}`}>{label}</span>)}
        </div>
      </li>)}
      <li className="stack-card stack-card--trunk">
        <strong>{stack.trunk.branch}</strong>
        {stack.trunk.head && <code className="selectable">{stack.trunk.head.slice(0, 8)}</code>}
        <small>Trunk</small>
      </li>
    </ol>
  </section>;
}

export function StackRail({ stack, onCollapse }: { stack: RepositoryStack; onCollapse: () => void }) {
  return <aside className="pane pane--rail stack-rail" aria-label="Stack health">
    <div className="rail__bar">
      <strong>Stack health</strong>
      <button type="button" className="icon-btn rail__collapse" onClick={onCollapse} aria-label="Hide panel">→</button>
    </div>
    <ul className="stack-rail__layers">
      {stack.layers.map(layer => <li key={layer.branch}>
        <strong>{layer.branch}</strong>
        {layer.base && <code className="selectable">Recorded parent tip {layer.base.slice(0, 8)}</code>}
        <span>{branchHealthLabels(layer).join(" · ") || "Health unknown"}</span>
      </li>)}
    </ul>
  </aside>;
}
