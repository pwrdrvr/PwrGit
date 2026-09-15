import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";

export function AuxiliaryTitleBar(props: {
  section: string;
  title: string;
}) {
  const tip = useViewportTooltip();
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
        <span
          className="auxiliary-titlebar__title"
          {...hoverTooltip(tip, props.title)}
        >
          {props.title}
        </span>
      </div>
      <div className="titlebar__spacer" />
      {tip.tooltipNode}
    </header>
  );
}
