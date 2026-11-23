import { useFocusTrap } from "../../lib/useFocusTrap";
import { restoreFocus, useDismissable } from "../../lib/useDismissable";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ChangeRequestEntry, RepositoryStack, StackPosition } from "@pwrgit/shared";
import { dismissHoverTooltips } from "../../lib/useViewportTooltip";
import { dispatch } from "../../lib/pwrgit";
import { shortWhen } from "../graph/graph-view";
import { changeRequestPickKey, useChangeRequestSelection } from "../change-request/change-request-selection";
import {
  stackActionAt, stackDestination, stackEntry, stackMembers, stackName, stackNextAction,
  stackPositionLabel, stackSource, stackState, stackStateLabel
} from "./stack-presentation";
import { useStackLaneStyle, useStackNavigation } from "./stack-navigation";
import "./stacks.css";

export function StackNode({ position, current, showPosition }: { position?: StackPosition; current?: boolean; showPosition?: boolean }) {
  const state = position ? stackState(position.layer) : "trunk";
  return <span className={`stack-node-wrap${current ? " is-current" : ""}`} data-stack-position={showPosition ? position?.index : undefined} aria-hidden="true">
    <span className="stack-node" data-stack-state={state} />
  </span>;
}

export function StackPopoverTrigger({
  repoId, stack, entries = [], writable = false, branch, current, className, label, children
}: {
  repoId: string; stack: RepositoryStack; entries?: readonly ChangeRequestEntry[]; writable?: boolean | undefined;
  branch?: string | undefined; current?: string | undefined; className: string; label?: string; children: ReactNode;
}) {
  const navigation = useStackNavigation();
  const laneStyle = useStackLaneStyle(repoId, stack);
  const selection = useChangeRequestSelection();
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const initialFocus = useRef<HTMLButtonElement | null>(null);
  useFocusTrap({ open, containerRef: panel, initialFocusRef: initialFocus });
  useDismissable({ open, onDismiss: () => setOpen(false), triggerRef: anchor, surfaceRef: panel });
  // A closed stack is history, and a trigger with no repository (a PR chip in
  // Lineage) can't route to a stack view: both show the stack and nothing more.
  const navigable = repoId !== "" && !stack.closed;
  const next = open && navigable ? stackNextAction(stack, writable) : undefined;
  const members = open ? stackMembers(stack) : [];

  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return;
    const button = anchor.current;
    const dialog = panel.current;
    const place = () => {
      const rect = button.getBoundingClientRect();
      if (!rect.width || !rect.height) { setOpen(false); return; }
      const width = dialog.offsetWidth;
      const height = dialog.offsetHeight;
      dialog.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      dialog.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - height - 8))}px`;
    };
    place();
    initialFocus.current = dialog.querySelector<HTMLButtonElement>(".stack-popover__member[data-start] button")
      ?? dialog.querySelector<HTMLButtonElement>(".stack-popover__member button");
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !button.contains(event.target) && !dialog.contains(event.target)) setOpen(false);
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const close = () => { restoreFocus(anchor, panel); setOpen(false); };
  // A trigger inside Lineage’s native ref browser belongs to its top layer.
  const host = anchor.current?.closest("[popover]") ?? anchor.current?.closest(".app") ?? anchor.current?.parentElement;
  return <>
    <button type="button" className={className} ref={anchor} aria-label={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
      onDoubleClick={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        if (!open) dismissHoverTooltips();
        setOpen(!open);
      }}>{children}</button>
    {open && host && createPortal(<div className="stack-popover" style={laneStyle} ref={panel} role="dialog" aria-modal="true" aria-label={stackName(stack)}
      id={id} tabIndex={-1} onFocus={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const buttons = Array.from(panel.current!.querySelectorAll<HTMLButtonElement>(".stack-popover__member button"));
        if (!buttons.length) return;
        event.preventDefault();
        event.stopPropagation();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }}>
      <header className="stack-popover__header">
        <strong>{stackName(stack)}</strong>
        <span>{stackDestination(stack)} · {stackSource(stack)}</span>
        <button type="button" className="icon-btn" aria-label="Close stack popover" onClick={close}>×</button>
      </header>
      <ol className="stack-popover__list">
        {members.map(position => {
          const { layer, index } = position;
          const entry = stackEntry(position, entries);
          const active = current !== undefined ? current === layer.branch :
            entry !== undefined && selection.selectedKey === changeRequestPickKey(repoId, entry);
          const action = stackActionAt(position, writable);
          const mergedAge = layer.pr?.mergedAt === undefined ? null : shortWhen(new Date(layer.pr.mergedAt).toISOString(), Date.now());
          const content = <>
            <span className="stack-popover__title">{layer.pr?.title ?? layer.branch}{active && <small>This PR</small>}</span>
            <span className="stack-popover__meta">
              {layer.pr && <span>#{layer.pr.number}</span>}<span>{index}/{members.length}</span>
              {layer.pr && <span className="stack-popover__branch">{layer.branch}</span>}
              <span className="stack-health-badge" data-stack-state={stackState(layer)}>{stackStateLabel(layer)}
                {mergedAge && (mergedAge === "just now" ? " just now" : ` ${mergedAge} ago`)}</span>
              {layer.pr?.mergeState === "conflicting" && stackState(layer) !== "conflicting" && <span>Merge conflict</span>}
              {layer.health.parentMerged && <span>Parent merged</span>}
              {(layer.behindParent ?? 0) > 0 && <span>{index === 1 ? layer.parent : "parent"} +{layer.behindParent}</span>}
              {!layer.pr && layer.commitCount !== undefined && <span>{layer.commitCount} {layer.commitCount === 1 ? "commit" : "commits"}</span>}
              {action && <span className="stack-health-badge stack-health-badge--stale">{action.label}</span>}
            </span>
          </>;
          return <li key={layer.branch} data-stack-position={index} data-start={branch === layer.branch || (!branch && active) ? "" : undefined}
            className={`stack-popover__member stack-track${active ? " is-current" : ""}${action ? " has-action" : ""}`}>
            <StackNode position={position} current={Boolean(active)} />
            {entry ? <button type="button" className="stack-popover__row" aria-current={active ? "true" : undefined}
              aria-label={`${stackPositionLabel(position)}, ${entry.pr.title}${active ? ", this PR" : ""}`}
              onClick={() => {
                close();
                selection.select({ repoId, entry, via: "pointer", manyRemotes: new Set(entries.map(row => row.remote)).size > 1 });
              }}>{content}</button> : <div className="stack-popover__row" data-ghost={branch === layer.branch ? "" : undefined}>{content}</div>}
          </li>;
        })}
        <li className="stack-popover__trunk stack-track"><StackNode /><strong>{stack.trunk.branch}</strong></li>
      </ol>
      <footer className="stack-popover__footer">
        {next && navigation && <button type="button" className="stack-button stack-button--primary" onClick={() => {
          close();
          navigation.select({ repoId, stack, action: next.action, branch: current ?? branch });
        }}>{next.label} stack…</button>}
        {navigation && navigable && <button type="button" className="stack-button" onClick={() => {
          close();
          navigation.select({ repoId, stack, branch: current ?? branch });
        }}>Open stack view</button>}
        {stack.githubUrl && <button type="button" className="stack-popover__link" onClick={() =>
          void dispatch("shell:openExternal", { url: stack.githubUrl! })}>View on GitHub</button>}
      </footer>
    </div>, host)}
  </>;
}

/** A PR's place in its stack (`2/3`), beside its chip wherever the chip is
 * drawn; it opens the stack popover. */
export function StackPositionChip({ position, repoId, writable }: {
  position: StackPosition; repoId?: string | undefined; writable?: boolean | undefined;
}) {
  const { stack, layer, index } = position;
  return <StackPopoverTrigger stack={stack} repoId={repoId ?? ""} writable={writable} current={layer.pr ? layer.branch : undefined}
    className="stack-position"
    label={`${stackName(stack)}, position ${index} of ${stack.layers.length}${stack.closed === "merged" ? ", merged" : ""}. Show stack`}>
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m12 2 10 5-10 5L2 7Zm10 10-10 5-10-5m20 5-10 5-10-5" />
    </svg>
    {index}/{stack.layers.length}
  </StackPopoverTrigger>;
}

/** The PR hover card's Stack section (board 9a): the stack top first with this
 * PR marked, trunk last. A tall stack keeps this PR and two neighbours each
 * side; the popover behind the `i/n` tag shows the rest. */
export function StackCardSection({ position }: { position: StackPosition }) {
  const { stack, index } = position;
  const members = stackMembers(stack);
  const at = members.findIndex(member => member.index === index);
  const first = Math.max(0, Math.min(at - 2, members.length - 5));
  const shown = members.slice(first, first + 5);
  const above = first;
  const below = members.length - first - shown.length;
  return <div className="pr-status-card__section stack-card-section">
    <span className="pr-status-card__section-title stack-card-section__title">
      <span>{stackName(stack)}</span>
      <span className="stack-card-section__where">{index}/{stack.layers.length} · {stackDestination(stack).replace(/^\d+ \w+ /, "")}</span>
    </span>
    <ol className="stack-card-section__list" aria-label={`${stackName(stack)}, ${stackDestination(stack)}`}>
      {above > 0 && <li className="stack-card-section__more">{above} more above</li>}
      {shown.map(member => {
        const current = member.index === index;
        return <li key={member.layer.branch} className={current ? "is-current" : undefined} aria-current={current ? "true" : undefined}>
          <StackNode position={member} />
          <span className="stack-card-section__n">{member.index}/{stack.layers.length}</span>
          <span className="stack-card-section__t">
            {member.layer.pr ? <>#{member.layer.pr.number} {plainTitle(member.layer.pr.title)}</> : member.layer.branch}
          </span>
        </li>;
      })}
      {below > 0 && <li className="stack-card-section__more">{below} more below</li>}
      <li className="stack-card-section__trunk"><StackNode /><span /><span className="stack-card-section__t">{stack.trunk.branch}</span></li>
    </ol>
  </div>;
}

/** "feat(desktop): coordinate…" reads as "coordinate…" in a 272px card; the
 * full title is on the PR's own chip and card. */
function plainTitle(title: string) {
  return title.replace(/^[a-z]+(\([^)]*\))?!?:\s+/i, "");
}
