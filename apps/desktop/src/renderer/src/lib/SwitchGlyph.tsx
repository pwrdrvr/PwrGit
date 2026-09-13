/**
 * "Move this checkout onto that branch" — Lucide `arrow-right-to-line`, an
 * arrow travelling to a bar it stops at. Transcribed like every other glyph
 * here and painted with `currentColor`; see `lib/AGENTS.md`.
 *
 * Deliberately not the `⇥` character: `--font-mono` carries no U+21E5, so it
 * would resolve through an OS fallback and change shape per platform — the
 * same trap the refresh control documents in `styles/AGENTS.md`.
 */
export function SwitchGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 12H3" />
      <path d="m11 18 6-6-6-6" />
      <path d="M21 5v14" />
    </svg>
  );
}
