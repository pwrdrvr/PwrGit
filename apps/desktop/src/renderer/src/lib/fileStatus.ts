/**
 * Presentation for Git's one-letter file-status codes.
 *
 * Three surfaces render the same chip — the Changes tab, a commit's file list,
 * and file history — and each one used to carry its own copy of the table. The
 * copies drifted: two of them shipped the chip with no accessible name at all,
 * so a screen reader read a bare "M". One table, one label, one tone.
 */

const TONE: Record<string, string> = {
  M: "warn",
  A: "ok",
  D: "danger",
  R: "warn",
  C: "warn",
  U: "danger",
  "?": "muted"
};

const LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Conflicted",
  "?": "Untracked"
};

/** The `file-status--*` modifier for a status code. */
function fileStatusTone(status: string): string {
  return TONE[status] ?? "muted";
}

/**
 * The chip's accessible name. Never empty — a bare letter is not a name.
 *
 * Exported for the one case the chip cannot cover: a row that is itself a
 * button carries its own aria-label, which replaces everything inside it, so
 * the change kind has to be folded into that name by hand.
 */
export function fileStatusLabel(status: string): string {
  return LABEL[status] ?? "Changed";
}

/**
 * The props every status chip needs, so no call site can forget the name.
 *
 * Preferred over assembling a chip by hand: the tone stays private so no
 * caller can rebuild the unlabelled version, which is the hole this module was
 * extracted to close.
 */
export function fileStatusChipProps(status: string): {
  className: string;
  title: string;
  "aria-label": string;
} {
  const label = fileStatusLabel(status);
  return {
    className: `file-status file-status--${fileStatusTone(status)}`,
    title: label,
    "aria-label": label
  };
}
