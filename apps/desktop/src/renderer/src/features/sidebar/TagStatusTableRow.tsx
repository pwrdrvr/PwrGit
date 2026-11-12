import type { TagStatusRow, TagSummary } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { LocateGlyph } from "../../lib/LocateGlyph";
import { TagGlyph } from "../../lib/TagGlyph";
import { hoverTooltip, type TooltipHandle } from "../../lib/useViewportTooltip";
import { shortWhen } from "../graph/graph-view";
import type { MenuItem } from "../shell/ContextMenu";
import { CopyTarget } from "../shell/CopyTarget";
import { RefRowActions, RefRowMenu } from "./RefRowMenu";

const STATUS_LABEL: Partial<Record<TagStatusRow["status"], string>> = {
  differs: "differs from",
  kept_local: "kept local",
  local_only: "local only",
  remote_only: "only on"
};

/**
 * One row of the Tags tab. A tag that agrees with the published remote looks
 * exactly as it did before published tags existed; the others carry a status
 * pill, the published value, and the decision they need in the action slots.
 * Design: design/Published Tags - UX Review.dc.html, 2a.
 */
export function TagStatusTableRow({
  row,
  now,
  tip,
  canLocate,
  hasRemotes,
  adopting,
  deleting,
  onLocate,
  onRemote,
  onAdopt,
  onKeep,
  onDetails,
  onDelete
}: {
  row: TagStatusRow;
  now: number;
  tip: TooltipHandle;
  canLocate: boolean;
  hasRemotes: boolean;
  adopting: string | null;
  deleting: string | null;
  onLocate: (tag: TagSummary) => void;
  onRemote: (tag: TagSummary) => void;
  onAdopt: (row: TagStatusRow) => void;
  onKeep: (row: TagStatusRow, keep: boolean) => void;
  onDetails: (name: string) => void;
  onDelete: (tag: TagSummary) => void;
}) {
  const { local, published, status } = row;
  const remote = published?.remote ?? "";
  const label = STATUS_LABEL[status];
  const statusText =
    label === undefined
      ? null
      : status === "differs" || status === "remote_only"
        ? `${label} ${remote}`
        : label;
  const twoValues = local !== null && published !== null && (status === "differs" || status === "kept_local");
  const kindsDiffer = twoValues && local!.kind !== published!.kind;
  const busy = adopting === row.name;

  const menuItems: MenuItem[] = [
    { type: "item", label: "Copy tag name", onSelect: () => void copyText(row.name) },
    { type: "item", label: "Compare sources…", onSelect: () => onDetails(row.name) }
  ];
  if (status === "kept_local") {
    menuItems.push({ type: "item", label: `Ask again about ${remote}'s value`, onSelect: () => onKeep(row, false) });
  }
  if (local !== null) {
    menuItems.push(
      { type: "sep" },
      /* Busy, not unavailable: a menu item is gone from view once picked, so
         `disabled` is right here. The in-flight guard lives in the handler. */
      {
        type: "item",
        label: deleting === row.name ? "Deleting…" : "Delete local tag…",
        danger: true,
        disabled: deleting !== null,
        onSelect: () => onDelete(local)
      }
    );
  }

  const locate =
    local !== null && canLocate ? (
      <button
        className="refs-row-action refs-row-action--icon"
        /* The reason rides on the name: assistive tech reads the label. */
        aria-label={
          local.targetType === "commit"
            ? `Locate tag ${local.name} in lineage`
            : `Locate tag ${local.name} in lineage — unavailable, this tag points at a ${local.targetType}, not a commit`
        }
        disabled={local.targetType !== "commit"}
        {...hoverTooltip(
          tip,
          local.targetType === "commit"
            ? "Locate tag in lineage"
            : `This tag points at a ${local.targetType}, not a commit`
        )}
        onClick={() => onLocate(local)}
      >
        <LocateGlyph />
        Locate
      </button>
    ) : null;

  let primary = locate;
  let secondary =
    local === null ? null : (
      <button
        className="refs-row-action refs-row-action--quiet"
        disabled={!hasRemotes}
        onClick={() => onRemote(local)}
      >
        Remote…
      </button>
    );
  if (status === "differs") {
    primary = (
      <button
        className="refs-row-action"
        aria-busy={busy}
        aria-disabled={adopting !== null}
        aria-label={`Take ${remote}'s ${row.name}`}
        {...hoverTooltip(tip, `Replace local ${row.name} with ${remote}'s value; the current one is kept`)}
        onClick={() => {
          if (adopting === null) onAdopt(row);
        }}
      >
        {busy ? "Taking…" : `Take ${remote}'s`}
      </button>
    );
    secondary = (
      <button
        className="refs-row-action refs-row-action--quiet"
        aria-label={`Keep local ${row.name}`}
        {...hoverTooltip(tip, `Stop asking until ${remote}'s ${row.name} or yours changes`)}
        onClick={() => onKeep(row, true)}
      >
        Keep local
      </button>
    );
  } else if (status === "remote_only") {
    primary = (
      <button
        className="refs-row-action"
        aria-busy={busy}
        aria-disabled={adopting !== null}
        aria-label={`Download ${remote}'s ${row.name}`}
        {...hoverTooltip(
          tip,
          published?.available === true
            ? "Its commit is here; this adds the tag"
            : "Its commit is not here; this fetches the tag and its history"
        )}
        onClick={() => {
          if (adopting === null) onAdopt(row);
        }}
      >
        {busy ? "Downloading…" : published?.available === true ? "Download" : "Download…"}
      </button>
    );
  }

  /* Two values share one narrow column, so a line carries the commit only:
     that is what moved. Compare sources… shows each tag object. */
  const objectLine = (who: string, id: string, kind: string | null, emphasis = false) => (
    <span className="refs-tag-object__line">
      <span className="refs-tag-object__who">{who}</span>
      <CopyTarget
        value={id}
        label={`Copy ${who} target ${id}`}
        hint={`${id}\nClick to copy tag target`}
        className={`refs-plan__copy copyable${emphasis ? " refs-tag-object__new" : ""}`}
        deferForDoubleClick
      >
        {id.slice(0, 12)}
      </CopyTarget>
      {kind !== null && <span className="refs-tag-object__kind">{kind}</span>}
    </span>
  );

  return (
    <div
      className={[
        "refs-table__row",
        "refs-tag-table__row",
        status === "differs" ? "refs-tag-table__row--attention" : "",
        status === "remote_only" ? "refs-tag-table__row--remote" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      data-refs-row=""
      data-tag-status={status}
      tabIndex={-1}
    >
      <div className="refs-table__identity">
        <span className="refs-tag-icon" aria-hidden="true">
          <TagGlyph size={11} />
        </span>
        <div>
          <CopyTarget
            value={row.name}
            label={`Copy tag name ${row.name}`}
            hint={`refs/tags/${row.name}\nClick to copy tag name`}
            className="refs-copyable-name copyable"
            deferForDoubleClick
          >
            <strong>{row.name}</strong>
          </CopyTarget>
          {/* Lightweight is the default and saying so on 97% of rows is noise;
              annotated is the fact worth carrying. */}
          {((local?.kind ?? published?.kind) === "annotated" || statusText !== null) && (
            <small className="refs-tag-status">
              {(local?.kind ?? published?.kind) === "annotated" && <span>annotated</span>}
              {statusText !== null && (
                <span className={`refs-tag-pill refs-tag-pill--${status.replace("_", "-")}`}>{statusText}</span>
              )}
              {status === "remote_only" && published?.available !== true && (
                <span className="refs-tag-pill refs-tag-pill--missing">not downloaded</span>
              )}
            </small>
          )}
        </div>
      </div>
      <div className="refs-tag-object">
        {twoValues ? (
          <>
            {objectLine("local", local!.targetId, kindsDiffer ? local!.kind : null)}
            {objectLine(remote, published!.targetId, kindsDiffer ? published!.kind : null, status === "differs")}
          </>
        ) : local !== null ? (
          <>
            <span className="refs-tag-object__type">{local.targetType}</span>
            <CopyTarget
              value={local.targetId}
              label={`Copy tag target ${local.targetId}`}
              hint={`${local.targetId}\nClick to copy tag target`}
              className="refs-plan__copy copyable"
              deferForDoubleClick
            >
              {local.targetId.slice(0, 12)}
            </CopyTarget>
            {/* Only when the tag ref does not point straight at the commit —
                an annotated tag, whose tag object is worth being able to copy. */}
            {local.objectId !== local.targetId && (
              <CopyTarget
                value={local.objectId}
                label={`Copy tag object ${local.objectId}`}
                hint={`${local.objectId}\nClick to copy the ${local.objectType} object`}
                className="refs-tag-object__via copyable"
                deferForDoubleClick
              >
                via {local.objectType} {local.objectId.slice(0, 8)}
              </CopyTarget>
            )}
          </>
        ) : published !== null ? (
          objectLine(remote, published.targetId, null)
        ) : null}
      </div>
      <div className="refs-tag-annotation">
        {local?.annotation !== undefined ? (
          <>
            <strong>{local.annotation.subject || "Annotated tag"}</strong>
            <small>
              {local.annotation.taggerName ?? "Unknown tagger"}
              {local.annotation.taggedAt === undefined ? "" : ` · ${shortWhen(local.annotation.taggedAt, now)}`}
            </small>
            {local.annotation.body !== undefined && (
              <small {...hoverTooltip(tip, local.annotation.body)}>{local.annotation.body}</small>
            )}
          </>
        ) : local === null ? (
          <small>
            {published?.available === true
              ? "Its commit is here; the tag is not"
              : "Message not downloaded yet"}
          </small>
        ) : (
          <span className="refs-table__muted">—</span>
        )}
      </div>
      <RefRowActions
        primary={primary}
        secondary={secondary}
        menu={<RefRowMenu label={`Actions for tag ${row.name}`} items={menuItems} />}
      />
    </div>
  );
}
