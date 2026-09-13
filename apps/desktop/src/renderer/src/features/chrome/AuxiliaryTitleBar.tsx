import { useWindowFrameState } from "./use-window-frame-state";

/**
 * The strip every supporting window wears. These windows keep the platform's
 * own frame, so — unlike the profile window's `TitleBar` — it paints no window
 * buttons; it tracks the frame state only so the Linux window hairline knows
 * when the window is maximized and there is no edge left to draw.
 */
export function AuxiliaryTitleBar(props: {
  section: string;
  title: string;
}) {
  useWindowFrameState();

  return (
    <header className="titlebar auxiliary-titlebar">
      <div className="titlebar__gutter" />
      <p className="titlebar__brand">
        Pwr<span className="titlebar__brand-accent">Git</span>
      </p>
      <div className="auxiliary-titlebar__breadcrumb">
        <span className="auxiliary-titlebar__section">{props.section}</span>
        <span aria-hidden="true" className="auxiliary-titlebar__separator">
          ›
        </span>
        <span className="auxiliary-titlebar__title" title={props.title}>
          {props.title}
        </span>
      </div>
      <div className="titlebar__spacer" />
    </header>
  );
}
