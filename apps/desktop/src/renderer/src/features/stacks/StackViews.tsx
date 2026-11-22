import { useLayoutEffect, useRef, useState } from "react";
import type { Repo, RepositoryStack, StackAction, StackLayer, StackPosition } from "@pwrgit/shared";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { SectionGlyph, steppedTooltip } from "../sidebar/section-fit";
import { SectionChevron } from "../sidebar/SectionChevron";
import { prefersReducedMotion } from "../../lib/reducedMotion";
import { StackBranchActions } from "./StackToolbar";
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
    {layer.health.needsRestack && <span className="stack-signal--restack" role="img" aria-label="Needs restack"><RefreshGlyph size={10} /></span>}
    {layer.health.needsPush && <span className="stack-signal--push" role="img" aria-label="Needs push">↑</span>}
  </span>;
}

export function StacksSidebar({ repo, stacks, writable = false }: {
  repo: Repo; stacks: RepositoryStack[]; writable?: boolean;
}) {
  const navigation = useStackNavigation();
  const [expanded, setExpanded] = useState(true);
  const tip = useViewportTooltip();
  if (!stacks.length || !navigation) return null;
  const stale = stacks.reduce((count, stack) => count + stack.layers.filter(layer => layer.health.needsRestack).length, 0);
  return <div className="ref-section stack-sidebar">
    <div className="ref-section__head-wrap">
      <button type="button" className="ref-section__head" aria-expanded={expanded}
        {...steppedTooltip(tip, `Stacks · ${stacks.length}`)}
        onClick={event => {
          event.stopPropagation();
          tip.hide();
          setExpanded(value => !value);
        }}>
        <SectionChevron open={expanded} />
        <SectionGlyph kind="stacks" />
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
            {writable && stack.source === "tracked" && <StackBranchActions name={layer.branch}
              onPlan={action => navigation.select({ repoId: repo.id, stack, action })} />}
          </li>)}
          <li className="stack-sidebar__trunk"><span className="stack-sidebar__branch">{stack.trunk.branch}</span><small>Trunk</small></li>
        </ol>
      </div>;
    })}
    {tip.tooltipNode}
  </div>;
}

export function StackView({ stack, repoId, onClose, onShowRail, toolbar, onPlan, runningBranch, fresh }: {
  stack: RepositoryStack; repoId: string; onClose: () => void; onShowRail?: () => void;
  toolbar?: React.ReactNode;
  onPlan?: (action: StackAction) => void;
  runningBranch?: string;
  fresh?: ReadonlySet<string>;
}) {
  const cards = useRef<HTMLOListElement>(null);
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    for (const card of cards.current?.querySelectorAll<HTMLElement>("[data-stack-branch]") ?? []) {
      const branch = card.dataset["stackBranch"]!;
      const top = card.offsetTop;
      const previous = positions.current.get(branch);
      if (previous !== undefined && previous !== top && !prefersReducedMotion()) {
        card.animate([{ transform: `translateY(${previous - top}px)` }, { transform: "none" }], {
          duration: 360, easing: "cubic-bezier(.2, .8, .2, 1)",
        });
      }
      next.set(branch, top);
    }
    positions.current = next;
  }, [stack]);
  return <section className="stack-view" aria-label="Stack" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <header className="stack-view__header">
      <button type="button" className="stack-button" onClick={onClose} aria-label="Back to worktree">←</button>
      <h1>{stack.layers[0].branch}</h1>
      <small>{stack.layers.length} {stack.layers.length === 1 ? "branch" : "branches"}</small>
      {stack.source === "inferred" && <span className="stack-health-badge">Inferred</span>}
      {onShowRail && <button type="button" className="stack-button" onClick={onShowRail}>Show panel</button>}
      {toolbar}
    </header>
    <ol ref={cards} className="stack-view__cards">
      {stack.layers.map((layer, index) => <li key={layer.branch} data-stack-branch={layer.branch}
        className={`stack-card${layer.health.needsRestack ? " is-stale" : ""}${fresh?.has(layer.branch) ? " is-fresh" : ""}`}>
        {runningBranch === layer.branch && <span className="stack-card__scanner" aria-hidden="true" />}
        <div className="stack-card__line">
          <span className="stack-card__ordinal">{index + 1}/{stack.layers.length}</span>
          <strong>{layer.branch}</strong>
          {layer.pr && <PrChip pr={layer.pr} repoId={repoId} />}
          {layer.pr && <span className="stack-card__pr-title">{layer.pr.title}</span>}
          {onPlan && stack.source === "tracked" && <StackBranchActions name={layer.branch} onPlan={onPlan} />}
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
