import type { ReactElement } from "react";

/**
 * Clone's mark — Lucide `cloud-download`: bring a repository down from a
 * forge. It sits beside `<ForkGlyph />`, and the pair reads as the two ways to
 * get a repo you do not have yet.
 *
 * It replaced a `↓` text node, and deliberately does NOT become a plain down
 * arrow. `<PullGlyph />` — an arrow onto a line — is two rows below it in the
 * same block and means something else entirely, and at 12px the only thing
 * separating two arrow marks is their silhouette. The cloud carries the
 * distinction: this one comes from a remote, over the network.
 */
export function CloneGlyph({ size = 12 }: { size?: number }): ReactElement {
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
      <path d="M12 13v8l-4-4" />
      <path d="m12 21 4-4" />
      <path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284" />
    </svg>
  );
}
