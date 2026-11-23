import type { ChangeRequestEntry, RepositoryStack, StackAction, StackPosition } from "@pwrgit/shared";
import { changeRequestKey, type ChangeRequestRow } from "../sidebar/change-request-groups";
import { prPresentation } from "../sidebar/pr-status";

export function stackName(stack: RepositoryStack) {
  return stack.githubNumber === undefined ? stack.layers[0]?.branch ?? stack.trunk.branch : `Stack #${stack.githubNumber}`;
}

export function stackSource(stack: RepositoryStack) {
  return stack.githubNumber !== undefined ? "linked on GitHub" : stack.source === "tracked" ? "gh stack" : "from PR bases";
}

export function stackDestination(stack: RepositoryStack) {
  const count = stack.layers.length;
  const noun = stack.layers.every(layer => layer.pr) ? "PR" : "branch";
  return `${count} ${noun}${count === 1 ? "" : noun === "branch" ? "es" : "s"} into ${stack.trunk.branch}`;
}

export function stackMembers(stack: RepositoryStack): StackPosition[] {
  return stack.layers.map((layer, index) => ({ stack, layer, index: index + 1 })).reverse();
}

export function stackState(layer: StackPosition["layer"]) {
  return layer.pr ? prPresentation(layer.pr).stackState : "no-pr";
}

export function stackStateLabel(layer: StackPosition["layer"]) {
  return {
    passing: "checks passing", pending: "checks running", failing: "checks failing", conflicting: "merge conflict",
    open: "open", draft: "draft", merged: "merged", closed: "closed", "no-pr": "no PR yet"
  }[stackState(layer)];
}

export function stackPositionLabel({ stack, layer, index }: StackPosition) {
  return `${index} of ${stack.layers.length}, ${layer.pr ? `#${layer.pr.number}` : layer.branch}, ${stackStateLabel(layer)}`;
}

export function stackActionAt({ stack, layer, index }: StackPosition, writable: boolean):
  { label: "Sync" | "Restack"; action: StackAction } | undefined {
  if (!writable || stack.source !== "tracked" || (layer.pr && layer.pr.state !== "open") || !layer.base ||
      !stack.layers.slice(index - 1).every(member => member.local !== false && member.head)) return;
  const lower = stack.layers[index - 2];
  if (index === 2 && layer.health.parentMerged && layer.syncReady && stack.trunk.local !== false && stack.trunk.head) {
    return { label: "Sync", action: { kind: "sync", mergedParent: lower.branch } };
  }
  if (layer.health.needsRestack && !layer.health.parentMerged &&
      (lower ?? stack.trunk).local !== false && (lower ?? stack.trunk).head) {
    return { label: "Restack", action: { kind: "restack", from: layer.branch } };
  }
}

export function stackNextAction(stack: RepositoryStack, writable: boolean) {
  const actions = stackMembers(stack).reverse().flatMap(member => stackActionAt(member, writable) ?? []);
  return actions.find(action => action.label === "Sync") ?? actions[0];
}

export function stackLayerKey({ layer }: StackPosition) {
  return layer.pr && layer.forgeRepo ? `${layer.forgeRepo}#${layer.pr.number}` : undefined;
}

export function stackEntry(position: StackPosition, entries: readonly ChangeRequestEntry[]): ChangeRequestEntry | undefined {
  const { layer } = position;
  const { pr, forgeRepo } = layer;
  if (!pr || !forgeRepo) return undefined;
  const entry = entries.find(candidate => changeRequestKey(candidate) === stackLayerKey(position));
  if (entry) return entry;
  return { pr, forgeRepo, remote: "origin", location: { kind: "missing", branch: layer.branch } };
}

export type StackListItem =
  | { kind: "row"; row: ChangeRequestRow; position?: StackPosition | undefined }
  | { kind: "stack"; stack: RepositoryStack; rows: ReadonlyMap<string, ChangeRequestRow> };

/** Move a complete stack as one group at the first member's old slot. A
 * filtered or separately sorted list keeps its original order and gets pips. */
export function stackListItems(
  local: readonly ChangeRequestRow[], remote: readonly ChangeRequestRow[], stacks: readonly RepositoryStack[], keepOrder = false
): StackListItem[] {
  const positions = new Map<string, StackPosition>();

  for (const stack of stacks) {
    const open = stackMembers(stack).filter(({ layer }) => layer.pr?.state === "open");
    for (const position of open) {
      const key = stackLayerKey(position);
      if (key && !positions.has(key)) positions.set(key, position);
    }

  }

  // A stacked counterpart needs its own position. Keep unrelated paired PRs
  // attached to their original card.
  const rows = [...local, ...remote].flatMap(row => {
    const stacked = row.paired.filter(entry => positions.has(changeRequestKey(entry)));
    return stacked.length ? [
      { ...row, paired: row.paired.filter(entry => !positions.has(changeRequestKey(entry))) },
      ...stacked.map(entry => ({ entry, paired: [] })),
    ] : [row];
  });
  const byKey = new Map(rows.map(row => [changeRequestKey(row.entry), row]));
  const complete = new Set(stacks.filter(stack => {
    const open = stackMembers(stack).filter(member => member.layer.pr?.state === "open");
    return open.length > 0 && open.every(member => {
      const key = stackLayerKey(member) ?? "";
      return positions.get(key)?.stack === stack && byKey.has(key);
    });
  }).map(stack => stack.id));
  const emitted = new Set<string>();
  const items: StackListItem[] = [];
  for (const row of rows) {
    const position = positions.get(changeRequestKey(row.entry));
    if (!position || keepOrder || !complete.has(position.stack.id)) items.push({ kind: "row", row, position });
    else if (!emitted.has(position.stack.id)) {
      emitted.add(position.stack.id);
      items.push({ kind: "stack", stack: position.stack, rows: byKey });
    }
  }
  return items;
}

export function stackItemRows(item: StackListItem): ChangeRequestRow[] {
  if (item.kind === "row") return [item.row];
  return stackMembers(item.stack).flatMap(position => item.rows.get(stackLayerKey(position) ?? "") ?? []);
}
