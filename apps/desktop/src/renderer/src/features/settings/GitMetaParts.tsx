import { Fragment } from "react";

/** `Bundled · 2.53.0 · LFS 3.7.1` — the versions a row is chosen by. The line
 *  wraps between parts, never inside one, so `2.56.0-dev-pwrgit.2` is not split
 *  at its hyphens in a narrow window. */
export function MetaParts(props: { parts: string[] }) {
  return (
    <span className="settings-ai-install__meta">
      {props.parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? " " : null}
          <span className="settings-ai-install__meta-part">
            {index < props.parts.length - 1 ? `${part} ·` : part}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
