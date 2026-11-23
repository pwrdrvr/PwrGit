import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChangeRequestEntry, Repo, RepositoryStack, StackAction, StackPosition, Worktree } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { SectionGlyph, steppedTooltip } from "../sidebar/section-fit";
import { SectionChevron } from "../sidebar/SectionChevron";
import { prefersReducedMotion } from "../../lib/reducedMotion";
import { StackBranchActions } from "./StackToolbar";
import { PrChip } from "../sidebar/PrChip";
import { lastSegment } from "../sidebar/repo-view";
import type { ChangeRequestRow } from "../sidebar/change-request-groups";
import { StackNode, StackPopoverTrigger } from "./StackPopover";
import {
  stackActionAt, stackDestination, stackLayerKey, stackMembers, stackName, stackNextAction,
  stackPositionLabel, stackSource, stackStateLabel, type StackListItem
} from "./stack-presentation";
import { useStackLaneStyle, useStackNavigation } from "./stack-navigation";
import "./stacks.css";

export function StackListGroup({ item, repoId, entries, writable, renderRow }: {
  item: Extract<StackListItem, { kind: "stack" }>; repoId: string; entries: readonly ChangeRequestEntry[];
  writable: boolean; renderRow: (row: ChangeRequestRow, position: StackPosition) => ReactNode;
}) {
  const { stack, rows } = item;
  const next = stackNextAction(stack, writable);
  const laneStyle = useStackLaneStyle(repoId, stack);
  return <div className="stack-group" style={laneStyle}>
    <StackPopoverTrigger repoId={repoId} stack={stack} entries={entries} writable={writable} className="stack-group__caption">
      <SectionGlyph kind="stacks" /><strong>{stackName(stack)}</strong><small>· {stack.layers.length} into {stack.trunk.branch}</small>
      {next && <span className="stack-health-badge stack-health-badge--stale">{next.label}</span>}
    </StackPopoverTrigger>
    {stackMembers(stack).map(position => {
      const { layer, index } = position;
      const row = rows.get(stackLayerKey(position) ?? "");
      return <div key={layer.branch} data-stack-position={index} data-stack-row={row ? "card" : "ghost"}
        className={`stack-group__member stack-track${stackActionAt(position, writable) ? " has-action" : ""}`}>
        <StackNode position={position} />
        {row ? renderRow(row, position) : <StackPopoverTrigger repoId={repoId} stack={stack} entries={entries} writable={writable}
          branch={layer.branch} className="stack-group__ghost"
          label={layer.pr ? `${stackPositionLabel(position)}, ${layer.pr.title}` : stackPositionLabel(position)}>
          {layer.pr && <span>#{layer.pr.number}</span>}
          <span className={layer.pr ? "stack-group__ghost-title is-pr" : "stack-group__ghost-title"}>{layer.pr?.title ?? layer.branch}</span><small>{stackStateLabel(layer)}</small>
        </StackPopoverTrigger>}
      </div>;
    })}
    <div className="stack-group__trunk stack-track"><StackNode /><span>{stack.trunk.branch}</span></div>
  </div>;
}

export function StackLadder({ position, repoId, writable }: { position: StackPosition; repoId: string; writable: boolean }) {
  return <StackPopoverTrigger repoId={repoId} stack={position.stack} writable={writable} current={position.layer.branch}
    className="stack-ladder" label={`${stackMembers(position.stack).map(stackPositionLabel).join("; ")}; trunk ${position.stack.trunk.branch}. Show stack`}>
    {stackMembers(position.stack).map(member => <StackNode key={member.layer.branch} position={member} current={member.index === position.index} />)}
    <StackNode />
  </StackPopoverTrigger>;
}

function StackTrain({ repoId, stack }: { repoId: string; stack: RepositoryStack }) {
  const laneStyle = useStackLaneStyle(repoId, stack);
  return <span className="stack-train" style={laneStyle}><StackNode />{stackMembers(stack).reverse().map(position =>
    <StackNode key={position.layer.branch} position={position} showPosition />)}</span>;
}

export function StacksSidebar({ repo, stacks, shownStacks, writable = false, recoverEmpty }: {
  repo: Repo; stacks: RepositoryStack[]; shownStacks?: ReadonlySet<string>; writable?: boolean; recoverEmpty?: () => void;
}) {
  const navigation = useStackNavigation();
  const [disclosure, setDisclosure] = useState<boolean>();
  const tip = useViewportTooltip();
  const [recovering, setRecovering] = useState(false);
  if (!navigation) return null;
  if (!stacks.length) return recoverEmpty ? <div className="ref-section stack-sidebar">
    <button type="button" className="stack-button" disabled={recovering} onClick={() => {
      setRecovering(true);
      void dispatch("stack:recover", { repoId: repo.id, profileId: repo.profileId }).then(result => {
        if (result.ok) {
          recoverEmpty();
          showInfoToast({ title: "Interrupted stack operation recovered", message: "Local stack state refreshed", subject: { repoId: repo.id } });
        } else showErrorToast({ title: "Could not recover stack", message: result.error.message, subject: { repoId: repo.id } });
      }).finally(() => setRecovering(false));
    }}>Recover stack operation</button>
  </div> : null;
  const noPRs = stacks.some(stack => stack.layers.every(layer => !layer.pr));
  const expanded = noPRs || (disclosure ?? stacks.some(stack => !shownStacks?.has(stack.id)));
  return <div className="ref-section stack-sidebar">
    <div className="ref-section__head-wrap">
      <button type="button" className="ref-section__head" aria-expanded={expanded} aria-disabled={noPRs || undefined}
        {...steppedTooltip(tip, `Stacks · ${stacks.length}`)}
        onClick={event => {
          event.stopPropagation();
          tip.hide();
          if (!noPRs) setDisclosure(!expanded);
        }}>
        <SectionChevron open={expanded} />
        <SectionGlyph kind="stacks" />
        <span className="ref-section__label">Stacks</span>
        <span className="ref-section__count">{stacks.length}</span>
      </button>
    </div>
    {expanded && stacks.map(stack => {
      const selected = navigation.pick?.repoId === repo.id && navigation.pick.stack.id === stack.id;
      const next = stackNextAction(stack, writable);
      const members = stackMembers(stack);
      const summary = `${stackName(stack)} · ${stackDestination(stack)} · ${stackSource(stack)}\n${members.map(position =>
        `${stackPositionLabel(position)} · ${position.layer.pr?.title ?? position.layer.branch}`).join("\n")}\n${stack.trunk.branch} · Trunk`;
      return <button type="button" key={stack.id} className="stack-sidebar__title"
        aria-pressed={selected} data-nav-anchor={`stack:${repo.id}:${stack.id}`}
        {...hoverTooltip(tip, summary)}
        aria-label={`Open stack view for ${stackName(stack)}. ${members.map(stackPositionLabel).join("; ")}; trunk ${stack.trunk.branch}`}
        onClick={event => { event.stopPropagation(); tip.hide(); navigation.select({ repoId: repo.id, stack }); }}>
        <strong>{stackName(stack)}</strong>
        <StackTrain repoId={repo.id} stack={stack} />
        <small>{stack.layers.length}</small>
        {next && <span className="stack-health-badge stack-health-badge--stale">{next.label}</span>}
      </button>;
    })}
    {tip.tooltipNode}
  </div>;
}

export function StackView({ stack, repoId, onClose, onShowRail, toolbar, onPlan, runningBranch, fresh, writable, selectedBranch, onSelectBranch }: {
  stack: RepositoryStack; repoId: string; onClose: () => void; onShowRail?: () => void;
  toolbar?: ReactNode;
  onPlan?: (action: StackAction) => void;
  runningBranch?: string;
  fresh?: ReadonlySet<string>;
  writable?: boolean;
  selectedBranch?: string | undefined;
  onSelectBranch?: (branch: string) => void;
}) {
  const laneStyle = useStackLaneStyle(repoId, stack);
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
  const members = stackMembers(stack);
  return <section className="stack-view" style={laneStyle} aria-label="Stack" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <header className="stack-view__header">
      <div className="stack-view__heading">
        <button type="button" className="stack-button" onClick={onClose} aria-label="Back to worktree">←</button>
        <h1>{stackName(stack)}</h1>
        <small>{stackDestination(stack)}</small>
        <span className="stack-health-badge">{stackSource(stack)}</span>
      </div>
      {(toolbar || onShowRail) && <div className="stack-view__tools">
        {onShowRail && <button type="button" className="stack-button" onClick={onShowRail}>Show panel</button>}
        {toolbar}
      </div>}
    </header>
    {stack.source !== "tracked" && <p className="stack-view__provenance prov">
      {stack.githubNumber !== undefined
        ? `GitHub links these pull requests as ${stackName(stack)}. `
        : "These pull requests target one another. "}
      This clone doesn’t track the stack. Tracking writes to the local gh stack catalog and leaves the forge as it is.
    </p>}
    <ol ref={cards} className="stack-view__cards">
      {members.map(position => {
        const { layer, index } = position;
        const active = (selectedBranch ?? members[0]?.layer.branch) === layer.branch;
        const action = stackActionAt(position, writable ?? Boolean(onPlan));
        const openPr = layer.pr?.state === "open" ? layer.pr : undefined;
        const checks = openPr?.checkState === "failing" || openPr?.checkState === "pending" ? openPr.checkState : undefined;
        return <li key={layer.branch} data-stack-branch={layer.branch} data-stack-position={index}
          className={`stack-card stack-track${action ? " has-action" : ""}${active ? " is-current" : ""}${fresh?.has(layer.branch) ? " is-fresh" : ""}`}>
          <StackNode position={position} current={active} />
          {runningBranch === layer.branch && <span className="stack-card__scanner" aria-hidden="true" />}
          <div className="stack-card__line">
            <button type="button" className="stack-card__title" aria-pressed={active}
              aria-label={`${stackPositionLabel(position)}, ${layer.pr?.title ?? layer.branch}`}
              onClick={() => onSelectBranch?.(layer.branch)}>{layer.pr?.title ?? layer.branch}</button>
            {layer.pr && <PrChip pr={layer.pr} repoId={repoId} stacked />}
            {onPlan && stack.source === "tracked" && <StackBranchActions name={layer.branch} onPlan={onPlan} />}
          </div>
          <div className="stack-card__line stack-card__detail">
            <span className="stack-card__ordinal">{index}/{members.length}</span>
            {layer.pr && <code>{layer.branch}</code>}
            {checks && <span className="stack-health-badge" data-stack-state={checks}>{checks === "failing" ? "checks failing" : "checks running"}</span>}
            {openPr?.mergeState === "conflicting" && <span className="stack-health-badge" data-stack-state="conflicting">merge conflict</span>}
            {action?.label === "Restack" && <span className="stack-health-badge stack-health-badge--stale">Needs restack</span>}
            {layer.health.parentMerged && layer.pr?.state !== "merged" && <span className="stack-health-badge">Parent merged</span>}
            {index === 1 && (layer.behindParent ?? 0) > 0 &&
              <span className="stack-health-badge stack-card__distance">{layer.parent} +{layer.behindParent}</span>}
          </div>
        </li>;
      })}
      <li className="stack-card stack-card--trunk stack-track"><StackNode /><strong>{stack.trunk.branch}</strong><small>trunk</small></li>
    </ol>
  </section>;
}

export function StackRail({ stack, branch, worktrees, writable = false, onCollapse }: {
  stack: RepositoryStack; branch?: string | undefined; worktrees: readonly Worktree[]; writable?: boolean; onCollapse: () => void;
}) {
  const members = stackMembers(stack);
  const position = members.find(({ layer }) => layer.branch === branch) ?? members[0];
  const layer = position?.layer;
  const action = position && stackActionAt(position, writable);
  const pr = layer?.pr;
  const basePr = stack.layers.find(member => member.branch === (pr?.baseRefName ?? layer?.parent))?.pr;
  const worktree = worktrees.find(item => !item.missing && item.branch === layer?.branch);
  const checks = pr?.checkState === "passing" ? "Passing" : pr?.checkState === "failing" ? "Failing"
    : pr?.checkState === "pending" ? "Running" : "Not reported";
  const merge = pr?.state === "merged" ? "Merged" : pr?.state === "closed" ? "Closed without merge"
    : pr?.mergeState === "conflicting" ? "Conflicts with its base" : pr?.mergeState === "mergeable" ? "Mergeable" : "Not reported";
  return <aside className="pane pane--rail stack-rail" aria-label="Stack member">
    <div className="rail__bar">
      <strong>Stack member</strong>
      <button type="button" className="icon-btn rail__collapse" onClick={onCollapse} aria-label="Hide panel">→</button>
    </div>
    {layer && <div className="stack-rail__facts">
      <strong>{layer.pr ? `#${layer.pr.number} · ` : ""}{position.index} of {members.length}</strong>
      <dl>
        <dt>Head branch</dt><dd><code className="selectable">{layer.branch}</code></dd>
        <dt>Base</dt><dd><code className="selectable">{pr?.baseRefName ?? layer.parent}</code>{basePr && <> (#{basePr.number})</>}</dd>
        {pr && <>
          <dt>Checks</dt><dd data-status={pr.checkState}>{checks}{pr.checksStillRunning && pr.checkState !== "pending" ? " · still running" : ""}</dd>
          {pr.state === "open" && <><dt>Review</dt><dd>{pr.isDraft ? "Draft" : "Ready for review"}</dd></>}
          <dt>Merge</dt><dd data-status={pr.mergeState}>{merge}</dd>
        </>}
        <dt>Worktree</dt><dd>{worktree ? lastSegment(worktree.path) : "No local worktree"}</dd>
        {stack.source === "tracked" && layer.base && <><dt>Recorded parent tip</dt><dd><code className="selectable">{layer.base.slice(0, 8)}</code></dd></>}
        {(layer.behindParent ?? 0) > 0 && <><dt>Behind {layer.parent}</dt><dd>{layer.behindParent} commits</dd></>}
      </dl>
      {action && <p>{action.label === "Sync"
        ? "The parent merged. Sync moves this branch and the branches above it onto trunk."
        : "The parent moved. Restack replays this branch and the branches above it onto the updated parent."}</p>}
      {pr && <button type="button" className="stack-button" onClick={() => void dispatch("shell:openExternal", { url: pr.url })}>Open PR #{pr.number}</button>}
    </div>}
  </aside>;
}
