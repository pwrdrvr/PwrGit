import { useId, useRef, useState } from "react";
import {
  routedRemotes,
  type PushPublishTarget,
  type RemoteEndpoint,
  type RepoIdentity,
  type RoutedRemote
} from "@pwrgit/shared";
import { useForgeHostMap } from "../../lib/useForgeHostMap";
import { useModal } from "../../lib/useModal";
import { RouteStrip, type RouteArrow, type RouteEnd } from "../sidebar/ForkRoute";

/**
 * The remote a branch is offered to first: `origin` when there is one, since
 * that is where a clone's branches go unless someone chose otherwise, and
 * otherwise whichever remote is listed first.
 */
export function defaultPublishRemote(remotes: RemoteEndpoint[]): string | null {
  return (
    remotes.find((remote) => remote.name === "origin")?.name ??
    remotes[0]?.name ??
    null
  );
}

/** How a row names a remote whose repository is known. */
function roleWords(row: RoutedRemote): string | null {
  if (row.role === "fork") return "Your fork";
  if (row.role === "original") return "The original";
  return null;
}

/**
 * Where the branch goes once published, drawn — or null when there is
 * nothing to explain. That is any repository that is neither a fork nor
 * closed to you: one remote you can push to needs no picture. Exported for
 * the tests; the dialog is its only caller.
 */
export function publishRoute(input: {
  branch: string;
  rows: RoutedRemote[];
  picked: string | null;
  /** `owner/name` of the fork's parent, when the forge named one. */
  parent: string | null;
}): {
  phase: "now" | "after";
  phaseLabel?: string;
  caption?: string;
  label: string;
  original: RouteEnd;
  fork: RouteEnd;
  toOriginal: RouteArrow[];
  toFork: RouteArrow[];
} | null {
  const { branch, rows, picked } = input;
  const fork = rows.find((row) => row.role === "fork");
  const original = rows.find((row) => row.role === "original");
  const target = rows.find((row) => row.name === picked);
  if (target === undefined || target.role === "other") return null;
  if (fork === undefined && original?.canPush !== false) return null;
  const originalSlug = original?.nameWithOwner ?? input.parent;
  if (originalSlug === null) return null;
  const toFork = target.role === "fork";
  const originalEnd: RouteEnd = {
    role: "The original",
    slug: originalSlug,
    ...(original === undefined ? { pending: "no remote" } : { remote: original.name }),
    ...(original?.canPush === false ? { perm: "no" as const } : {}),
    ...(toFork ? { state: "unused" as const } : {})
  };
  const forkEnd: RouteEnd = fork === undefined
    ? { role: "Your fork", slug: "none yet", state: "unused" }
    : {
      role: "Your fork",
      slug: fork.nameWithOwner ?? fork.name,
      remote: fork.name,
      ...(fork.canPush === true ? { perm: "yes" as const } : {}),
      state: toFork ? "chosen" : "unused"
    };
  if (toFork && fork !== undefined) {
    return {
      phase: "after",
      caption: `${branch} pulls from and pushes to your fork`,
      label: `After publishing: ${branch} pulls from and pushes to ${forkEnd.slug}.`,
      original: originalEnd,
      fork: forkEnd,
      toOriginal: [],
      toFork: [{ verb: "push", tone: "go", confirmed: fork.canPush === true }, { verb: "pull", tone: "go" }]
    };
  }
  if (original?.canPush === false) {
    return {
      phase: "now",
      phaseLabel: "If you publish now",
      label: `If you publish now, the push to ${originalSlug} is refused: this account can't push there.`,
      original: originalEnd,
      fork: forkEnd,
      toOriginal: [{ verb: "push", tone: "bad" }],
      toFork: []
    };
  }
  // The original, picked by someone who may well maintain it: the forge was
  // asked about `origin` only, so the push is drawn without a verdict.
  return {
    phase: "after",
    caption: "PwrGit hasn't asked whether you can push to the original",
    label: `After publishing: ${branch} pulls from and pushes to ${originalSlug}.`,
    original: { ...originalEnd, state: "chosen" },
    fork: forkEnd,
    toOriginal: [{ verb: "push", tone: "go" }, { verb: "pull", tone: "go" }],
    toFork: []
  };
}

/**
 * Where to put a branch that is on no remote yet — what the toolbar's Push asks
 * when there is nowhere for a plain push to go.
 *
 * Without it, Push on a new branch was a dead end: Git refused, and the status
 * card relayed Git's advice to go and run `git push --set-upstream origin
 * <branch>` in a terminal. This is that command, with the one question it
 * needs answered put to the user.
 *
 * It asks for the remote and nothing else. The branch keeps its own name there
 * because Git's default `push.default=simple` refuses a plain push whose
 * upstream is named differently — a rename here would publish a branch the
 * Push button could never push to again.
 *
 * On a fork, or a clone the forge says you can't push to, each remote is
 * named by its repository and what it is to you, and a strip draws where the
 * branch will go (`publishRoute`). Where the push would be refused, Fork…
 * leads and Publish stays as "Publish anyway": `viewerCanPush` can be stale,
 * and Git has the last word. Design: `design/Fork Route Graphic - UX
 * Review.dc.html`, 3b and 3c.
 *
 * The remotes arrive with the dialog rather than after it: the caller loads
 * them before opening, so the list never appears under a dialog the user is
 * already reading.
 */
export function PublishBranchDialog({
  branch,
  remotes,
  identity,
  onPublish,
  onFork,
  onClose
}: {
  branch: string;
  remotes: RemoteEndpoint[];
  /** What the forge last said about `origin`; labels the remotes. */
  identity?: RepoIdentity | undefined;
  onPublish: (target: PushPublishTarget) => void;
  /** Offered instead of a push the forge has said would be refused. */
  onFork?: (() => void) | undefined;
  onClose: () => void;
}) {
  const hosts = useForgeHostMap();
  const [remote, setRemote] = useState(() => defaultPublishRemote(remotes));
  const publishRef = useRef<HTMLButtonElement>(null);
  const forkRef = useRef<HTMLButtonElement>(null);
  const rows = routedRemotes(identity, remotes, hosts);
  const picked = rows.find((row) => row.name === remote);
  const route = publishRoute({
    branch,
    rows,
    picked: remote,
    parent: identity?.parent?.nameWithOwner ?? null
  });
  const named = rows.some((row) => row.role !== "other");
  const refused = picked?.canPush === false;
  const offerFork = refused && onFork !== undefined && !rows.some((row) => row.role === "fork");
  // Focus lands on the primary action, so the common case is one Enter away
  // from the click that opened this.
  const modalRef = useModal<HTMLDivElement>({
    onClose,
    initialFocusRef: offerFork ? forkRef : publishRef
  });
  const titleId = useId();
  const listId = useId();

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className={named ? "modal publish-branch publish-branch--route" : "modal publish-branch"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title" id={titleId}>
          Publish {branch}
        </div>
        {refused && picked?.nameWithOwner != null ? (
          <p className="publish-branch__warn" role="note">
            The forge says this account can't push to{" "}
            <b>{picked.nameWithOwner}</b>, so publishing there would be
            refused. Fork it first: {branch} comes with you, and nothing is
            pushed until you publish.
          </p>
        ) : (
          <p className="publish-branch__lede">
            This branch isn’t on any remote yet. Publishing pushes it and tracks
            it there, so Push works on its own from then on.
          </p>
        )}

        {remotes.length === 0 ? (
          <p className="modal__error">
            This repository has no remotes to publish to. Add one under Remotes
            in the sidebar, then try again.
          </p>
        ) : (
          <div
            className="refs-destinations"
            role="radiogroup"
            aria-labelledby={listId}
          >
            <div className="refs-field__label" id={listId}>
              {named ? "Publish to" : "Remote"}
            </div>
            {rows.map((row, index) => {
              const candidate = remotes[index]!;
              const role = roleWords(row);
              return named ? (
                <label className="refs-destination refs-destination--routed" key={row.name}>
                  <input
                    type="radio"
                    name="publish-remote"
                    checked={remote === row.name}
                    onChange={() => setRemote(row.name)}
                  />
                  <span className="refs-destination__repo">
                    <b>{row.nameWithOwner ?? row.name}</b>
                    <small>
                      {role === null ? <code>{row.name}</code> : <>{role} · <code>{row.name}</code></>}
                    </small>
                  </span>
                  {row.canPush === true && <span className="fork-route__perm fork-route__perm--yes">you can push</span>}
                  {row.canPush === false && <span className="fork-route__perm fork-route__perm--no">can't push</span>}
                </label>
              ) : (
                <label className="refs-destination" key={row.name}>
                  <input
                    type="radio"
                    name="publish-remote"
                    checked={remote === row.name}
                    onChange={() => setRemote(row.name)}
                  />
                  <span className="refs-destination__name">{row.name}</span>
                  <span className="refs-destination__url">{candidate.pushUrl}</span>
                </label>
              );
            })}
          </div>
        )}

        {route !== null && (
          <div className="publish-branch__route">
            <RouteStrip branch={branch} {...route} />
          </div>
        )}

        {remote !== null && (
          <div className="modal__hint">
            Pushes {branch} to {remote}/{branch} and tracks it.
          </div>
        )}

        <div className="modal__actions">
          {offerFork && (
            <button
              ref={publishRef}
              className="modal__cancel publish-branch__anyway"
              type="button"
              onClick={() => {
                if (remote !== null) onPublish({ remote });
              }}
            >
              Publish anyway
            </button>
          )}
          <button className="modal__cancel" type="button" onClick={onClose}>
            Cancel
          </button>
          {offerFork ? (
            <button
              ref={forkRef}
              className="modal__create"
              type="button"
              onClick={onFork}
            >
              Fork {picked?.nameWithOwner ?? "it"}…
            </button>
          ) : (
            <button
              ref={publishRef}
              className="modal__create"
              type="button"
              disabled={remote === null}
              onClick={() => {
                if (remote !== null) onPublish({ remote });
              }}
            >
              Publish
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
