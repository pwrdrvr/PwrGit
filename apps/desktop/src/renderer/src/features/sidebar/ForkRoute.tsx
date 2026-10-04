import type { ReactNode } from "react";

/** `owner/name` split at its last slash: GitLab owners can hold slashes. */
export function splitSlug(slug: string): { owner: string; name: string } {
  const cut = slug.lastIndexOf("/");
  return { owner: slug.slice(0, cut), name: slug.slice(cut) };
}

/** One repository in a route: the original, or a fork. */
export type RouteRepo = {
  /** `owner/name`. */
  slug: string;
  /** The local nickname, drawn only as a small tag: the owner is what tells
   *  three same-named repositories apart. */
  remote: string;
  /** "The original", "Your fork", "lumen-co's fork". */
  role: string;
};

/** A box at either end of a strip. */
export type RouteEnd = {
  role: string;
  slug: string;
  /** The nickname, or none when no remote points there (yet, or any more). */
  remote?: string;
  /** The nickname lands here in this change, so it is outlined: in Fork…,
   *  `origin` moving is the whole change. */
  remoteMoved?: boolean;
  /** Only what the forge said: `viewerCanPush` is known for `origin` alone. */
  perm?: "yes" | "no";
  /** A dashed pill for a state rather than a permission: "will be created". */
  pending?: string;
  /** `unused`: present, but not part of the route. `chosen`: where the
   *  branch goes after this change. */
  state?: "unused" | "chosen";
};

/**
 * One arrow. Its direction follows from the lane and the verb, so a spec
 * cannot draw a push flowing out of a remote: towards the end for Push,
 * towards this checkout for Pull and Sync.
 *
 * - `plain`: as it is. `go`: after this change. `bad`: refused (dashed, ×).
 *   `ghost`: one click away, not automatic (dotted).
 * - `confirmed` ticks a Push the forge has said you may make.
 */
export type RouteArrow = {
  verb: "push" | "pull" | "sync";
  tone: "plain" | "go" | "bad" | "ghost";
  confirmed?: boolean;
};

/**
 * Where a branch pulls from and pushes to, drawn rather than named in Git's
 * terms: the original, this checkout, and a fork, with the arrows between
 * them. Every surface that draws a route uses this, so the boxes sit in the
 * same places and the eye compares arrows rather than layouts.
 * Design: `design/Fork Route Graphic - UX Review.dc.html`.
 */
export function RouteStrip({ phase, phaseLabel, caption, label, original, branch, fork, toOriginal, toFork }: {
  /** `after` tints the strip as the outcome of the dialog it sits in. */
  phase?: "now" | "after";
  /** The pill's words, when "Now" or "After" would not say it. */
  phaseLabel?: string;
  caption?: string;
  /** The whole route in one sentence, for a screen reader. */
  label: string;
  original: RouteEnd;
  branch: string;
  fork: RouteEnd;
  toOriginal: RouteArrow[];
  toFork: RouteArrow[];
}) {
  const after = phase === "after";
  return <div className={after ? "fork-route fork-route--after" : "fork-route"}>
    {(phase !== undefined || caption !== undefined) && <div className="fork-route__head">
      {phase !== undefined && <span className={after ? "fork-route__phase fork-route__phase--after" : "fork-route__phase"}>
        {phaseLabel ?? (after ? "After" : "Now")}
      </span>}
      {caption !== undefined && <span className="fork-route__caption">{caption}</span>}
    </div>}
    <div className={after ? "fork-route__grid fork-route__grid--after" : "fork-route__grid"} role="img" aria-label={label}>
      <RouteNode end={original} />
      <div className="fork-route__lane">
        {toOriginal.map((arrow) => <ArrowOf key={arrow.verb} arrow={arrow} towards={arrow.verb === "push" ? "left" : "right"} />)}
      </div>
      <div className="fork-route__node fork-route__node--here">
        <span className="fork-route__role">This checkout</span>
        <b>{branch}</b>
      </div>
      <div className="fork-route__lane">
        {toFork.map((arrow) => <ArrowOf key={arrow.verb} arrow={arrow} towards={arrow.verb === "push" ? "right" : "left"} />)}
      </div>
      <RouteNode end={fork} />
    </div>
  </div>;
}

/**
 * The repair dialog's two strips: `now` is the branch as configured; `after`
 * is the same three boxes once it tracks the fork.
 * Design: `design/Fork Tracking Repair - UX Review.dc.html`, 2b.
 */
export function ForkRoute({ phase, branch, original, fork, refused }: {
  phase: "now" | "after";
  branch: string;
  original: RouteRepo;
  fork: RouteRepo;
  /** The forge refused a push to the original, so its arrow is drawn failing
   *  and it is marked as closed to you. Only a refusal proves that:
   *  `viewerCanPush` is known for `origin` alone. */
  refused: boolean;
}) {
  const now = phase === "now";
  const label = now
    ? `Now: ${branch} pulls from and pushes to ${original.slug}${refused ? ", which refused the push" : ""}. ${fork.slug} is not used.`
    : `After: ${branch} pulls from and pushes to ${fork.slug}. Sync in the Pull menu still brings in ${original.slug}.`;
  return <RouteStrip phase={phase} label={label} branch={branch}
    original={{ ...original, ...(now && refused ? { perm: "no" as const } : {}) }}
    fork={{ ...fork, perm: "yes", state: now ? "unused" : "chosen" }}
    toOriginal={now
      ? [{ verb: "push", tone: refused ? "bad" : "plain" }, { verb: "pull", tone: "plain" }]
      : [{ verb: "sync", tone: "ghost" }]}
    toFork={now ? [] : [{ verb: "push", tone: "go", confirmed: true }, { verb: "pull", tone: "go" }]} />;
}

function RouteNode({ end }: { end: RouteEnd }) {
  const { owner, name } = splitSlug(end.slug);
  return <div className={end.state === undefined ? "fork-route__node" : `fork-route__node fork-route__node--${end.state}`}>
    <span className="fork-route__role">{end.role}</span>
    {/* Every repository here usually shares one name, so the owner leads
        and the name wraps under it rather than ellipsizing the owner away. */}
    <span className="fork-route__slug"><b>{owner}</b><wbr />{name}</span>
    {(end.remote !== undefined || end.perm !== undefined || end.pending !== undefined) && <span className="fork-route__tags">
      {end.remote !== undefined && <span className={end.remoteMoved === true ? "fork-route__remote fork-route__remote--moved" : "fork-route__remote"}>{end.remote}</span>}
      {end.perm === "no" && <span className="fork-route__perm fork-route__perm--no">can't push</span>}
      {end.perm === "yes" && <span className="fork-route__perm fork-route__perm--yes">you can push</span>}
      {end.pending !== undefined && <span className="fork-route__perm fork-route__perm--pending">{end.pending}</span>}
    </span>}
  </div>;
}

function ArrowOf({ arrow, towards }: { arrow: RouteArrow; towards: "left" | "right" }) {
  return <span className={`fork-route__arrow fork-route__arrow--${towards} fork-route__arrow--${arrow.tone}`}>
    <span className="fork-route__arrow-label">{arrowLabel(arrow)}</span>
    <span className="fork-route__shaft" aria-hidden="true" />
  </span>;
}

function arrowLabel(arrow: RouteArrow): ReactNode {
  if (arrow.verb === "sync") {
    return <>Pull <i className="fork-route__caret" aria-hidden="true" /> Sync</>;
  }
  if (arrow.verb === "pull") return "Pull";
  return <>
    {arrow.tone === "bad" && <span className="fork-route__x" aria-hidden="true">×</span>}
    Push
    {arrow.confirmed === true && <span className="fork-route__tick" aria-hidden="true" />}
  </>;
}

/** The route flattened to one line, for a menu note or a card. */
export function ForkRouteLine({ branch, original }: { branch: string; original: string }) {
  return <span className="fork-route-line" aria-label={`${branch} pulls from and pushes to ${original}`}>
    <span className="fork-route-line__node">{branch}</span>
    {/* Drawn, not typed: no bundled face carries U+21C4, so the glyph would
        come from whatever font the platform falls back to. */}
    <span className="fork-route-line__arrows" aria-hidden="true"><i /><i /></span>
    <span className="fork-route-line__node">{original}</span>
  </span>;
}

/** One stop on a one-line route. */
export type RouteStop = {
  text: string;
  kind: "repo" | "here" | "go";
};

/**
 * A route as a sentence of boxes with one-way arrows between them, for a row
 * too short for `RouteStrip`: the Pull menu's choices. `here` is this
 * checkout (dashed), `go` is where a push lands (accent).
 */
export function RouteLine({ stops, label }: { stops: RouteStop[]; label: string }) {
  return <span className="fork-route-line fork-route-line--steps" role="img" aria-label={label}>
    {stops.map((stop, index) => <span key={`${index}:${stop.text}`} className="fork-route-line__step">
      {index > 0 && <span className="fork-route-line__to" aria-hidden="true"><i /></span>}
      <span className={stop.kind === "repo" ? "fork-route-line__node" : `fork-route-line__node fork-route-line__node--${stop.kind}`}>{stop.text}</span>
    </span>)}
  </span>;
}
