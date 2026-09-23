import type { ReactElement } from "react";

/**
 * The local-agent mark — Lucide `sparkle`. It leads everything an agent wrote
 * or is about to write: the Tidy entry on the selection bar, the Tidy head,
 * the Draft links, and the footer line that names the provider. Seeing it is
 * how the operator knows a sentence came from a model rather than from Git.
 *
 * It replaced a `✦` text node. U+2726 is in neither bundled face — a cmap read
 * of `geist-sans-latin-600-normal.woff` and `geist-mono-latin-400-normal.woff`
 * finds it in neither — so it resolved through an OS fallback and changed
 * shape per platform, exactly like the `↻` that `styles/AGENTS.md` describes.
 *
 * One mark, one meaning: it says "a model wrote this", never "this is new" or
 * "this is clever". Anything decorative wants a different shape, or none.
 */
export function AgentGlyph({ size = 12 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      /* Scaled like its siblings: the viewBox shrinks with `size`, and a fixed
         stroke would thin the smaller instance into a lighter icon. */
      strokeWidth={(2 * 13) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </svg>
  );
}
