import type { ReactNode } from "react";

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

/**
 * Where a branch pulls from and pushes to, drawn rather than named in Git's
 * terms: the original, this checkout, and a fork, with the arrows between
 * them. `now` is the branch as configured; `after` is the same three boxes
 * once it tracks the fork, so the eye compares arrows rather than layouts.
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
  return <div className={now ? "fork-route" : "fork-route fork-route--after"}>
    <span className={now ? "fork-route__phase" : "fork-route__phase fork-route__phase--after"}>{now ? "Now" : "After"}</span>
    <div className={now ? "fork-route__grid" : "fork-route__grid fork-route__grid--after"} role="img" aria-label={label}>
      <RouteNode repo={original}>
        {now && refused && <span className="fork-route__perm fork-route__perm--no">can't push</span>}
      </RouteNode>
      <div className="fork-route__lane">
        {now ? <>
          <RouteArrow towards="left" tone={refused ? "bad" : "plain"}>
            {refused && <span className="fork-route__x" aria-hidden="true">×</span>}Push
          </RouteArrow>
          <RouteArrow towards="right" tone="plain">Pull</RouteArrow>
        </> : <RouteArrow towards="right" tone="ghost">
          Pull <i className="fork-route__caret" aria-hidden="true" /> Sync
        </RouteArrow>}
      </div>
      <div className="fork-route__node fork-route__node--here">
        <span className="fork-route__role">This checkout</span>
        <b>{branch}</b>
      </div>
      <div className="fork-route__lane">
        {!now && <>
          <RouteArrow towards="right" tone="go">
            Push<span className="fork-route__tick" aria-hidden="true" />
          </RouteArrow>
          <RouteArrow towards="left" tone="go">Pull</RouteArrow>
        </>}
      </div>
      <RouteNode repo={fork} state={now ? "unused" : "chosen"}>
        <span className="fork-route__perm fork-route__perm--yes">you can push</span>
      </RouteNode>
    </div>
  </div>;
}

function RouteNode({ repo, state, children }: {
  repo: RouteRepo;
  state?: "unused" | "chosen";
  children?: ReactNode;
}) {
  const cut = repo.slug.lastIndexOf("/");
  return <div className={state === undefined ? "fork-route__node" : `fork-route__node fork-route__node--${state}`}>
    <span className="fork-route__role">{repo.role}</span>
    {/* Every repository here usually shares one name, so the owner leads
        and the name wraps under it rather than ellipsizing the owner away. */}
    <span className="fork-route__slug"><b>{repo.slug.slice(0, cut)}</b><wbr />{repo.slug.slice(cut)}</span>
    <span className="fork-route__tags">
      <span className="fork-route__remote">{repo.remote}</span>
      {children}
    </span>
  </div>;
}

function RouteArrow({ towards, tone, children }: {
  towards: "left" | "right";
  tone: "plain" | "bad" | "go" | "ghost";
  children: ReactNode;
}) {
  return <span className={`fork-route__arrow fork-route__arrow--${towards} fork-route__arrow--${tone}`}>
    <span className="fork-route__arrow-label">{children}</span>
    <span className="fork-route__shaft" aria-hidden="true" />
  </span>;
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
