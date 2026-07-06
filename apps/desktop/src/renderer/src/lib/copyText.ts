// Clipboard write with graceful fallbacks (async Clipboard API → hidden
// textarea + execCommand). Lifted from PwrAgnt's copy-text.ts, minus the
// Electron-IPC path — the renderer's navigator.clipboard works here.

export async function copyText(text: string): Promise<void> {
  const clipboard =
    typeof navigator !== "undefined" &&
    "clipboard" in navigator &&
    typeof navigator.clipboard?.writeText === "function"
      ? navigator.clipboard
      : undefined;

  if (clipboard) {
    await clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") return;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand?.("copy");
  document.body.removeChild(textarea);
}

/** Shorten a long value from the middle so both ends stay readable. */
export function elideMiddle(text: string, maxLength = 72): string {
  if (text.length <= maxLength) return text;
  const visible = Math.max(8, maxLength - 1);
  const left = Math.ceil(visible / 2);
  const right = Math.floor(visible / 2);
  return `${text.slice(0, left)}…${text.slice(-right)}`;
}

/** Tooltip body for a click-to-copy affordance: the value + a copy hint. */
export function copyHint(value: string, maxLength = 72): string {
  return `${elideMiddle(value, maxLength)}\nClick to copy`;
}
