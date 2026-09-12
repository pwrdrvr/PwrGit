// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  ok,
  type RemoteActivity,
  type SshRemoteRecovery,
  type Worktree,
  type WorktreeState
} from "@pwrgit/shared";

// The activity store subscribes once per module instance, so the captured
// handlers deliberately outlive a single test's mock reset.
const bridge = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: bridge.dispatch,
  subscribe: bridge.subscribe,
  windowProfileId: () => "profile-1"
}));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
  dismissToastKey: vi.fn()
}));
vi.mock("../shell/WorktreeMenu", () => ({ WorktreeMenu: () => null }));

import { WorktreeHeader } from "./WorktreeHeader";

const repo = { id: "repo-1", name: "project", path: "/repos/project" };
const worktree: Worktree = {
  id: "worktree-1",
  repoId: "repo-1",
  branch: "main",
  path: "/repos/project",
  dirty: 0,
  ahead: 0,
  behind: 24,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: true,
  pinned: false,
  isPrimary: true
};

/** A live pull against this checkout, at its first phase. */
const idle: RemoteActivity = {
  id: "op-1",
  kind: "pull",
  phase: "fetch",
  profileId: "profile-1",
  repoId: "repo-1",
  repoName: "project",
  worktreeId: "worktree-1",
  branch: "main",
  startedAt: 0,
  phaseSince: 0,
  lastOutputAt: 0,
  silent: false,
  progress: null,
  command: null,
  tail: [],
  canceling: false
};

let container: HTMLDivElement;
let root: Root;

/** Publish the live remote operations this window can see. */
async function emitActivities(activities: Partial<RemoteActivity>[]) {
  await act(async () => {
    bridge.handlers.get("remote:activity")?.({
      activities: activities.map((activity) => ({ ...idle, ...activity }))
    });
  });
}

beforeEach(async () => {
  bridge.dispatch.mockImplementation((name: string) =>
    name === "remote:activities"
      ? Promise.resolve(ok([]))
      : new Promise(() => undefined)
  );
  bridge.subscribe.mockImplementation((channel, handler) => {
    bridge.handlers.set(channel, handler);
    return () => undefined;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<WorktreeHeader repo={repo} worktree={worktree} state={null} />);
  });
});

afterEach(async () => {
  await emitActivities([]);
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("WorktreeHeader sync buttons stay focusable while busy", () => {
  // The sibling of a11y-sidebar.spec.ts's guard on .wt-refresh. Chromium blurs
  // an element the moment it becomes disabled, so `disabled={busy !== null}`
  // here threw a keyboard user back to <body> for the length of the operation
  // (SC 2.4.3). Asserting the PROPERTY is the durable half: the operation can
  // settle before any focus check runs, but a reintroduced `disabled` fails
  // this outright.
  it("says aria-disabled, never disabled, while an operation runs", async () => {
    let settle!: () => void;
    bridge.dispatch.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = () => resolve(ok(undefined));
      })
    );

    const fetchButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fetch"]'
    );
    expect(fetchButton).not.toBeNull();

    await act(async () => fetchButton?.click());

    expect(fetchButton?.getAttribute("aria-busy")).toBe("true");
    expect(fetchButton?.getAttribute("aria-disabled")).toBe("true");
    expect(
      fetchButton?.disabled,
      "the sync buttons must never use the disabled property"
    ).toBe(false);

    // Its peers are unavailable for the duration, and they say so the same way.
    for (const label of ["Pull", "Push"]) {
      const peer = container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`
      );
      expect(peer?.getAttribute("aria-disabled")).toBe("true");
      expect(peer?.disabled).toBe(false);
    }

    // Still inert: aria-disabled removes nothing from the a11y tree and does
    // not block the click, so the handler's own guard has to. Asserted by
    // command rather than call count — GitLfsChip shares this bridge mock.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Push"]')
        ?.click();
    });
    expect(bridge.dispatch).not.toHaveBeenCalledWith(
      "remote:push",
      expect.anything()
    );

    await act(async () => {
      settle();
    });
  });
});

describe("WorktreeHeader pull progress", () => {
  it("replaces the indefinite pull label with each worktree-scoped phase", async () => {
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    expect(pull).not.toBeNull();

    await act(async () => pull?.click());
    expect(pull?.getAttribute("aria-busy")).toBe("true");
    // Before main reports anything the label is honestly indefinite; the
    // queued phase is the first thing it can truthfully say.
    expect(container.textContent).toContain("Pulling…");

    await emitActivities([{ phase: "queued" }]);
    expect(container.textContent).toContain(
      "Waiting for another Git operation…"
    );
    expect(
      container
        .querySelector('[role="status"]')
        ?.classList.contains("sync-chip--progress")
    ).toBe(true);

    for (const [phase, label] of [
      ["fetch", "Fetching updates…"],
      ["prepare", "Preparing local changes…"],
      ["fast_forward", "Fast-forwarding and checking out files…"],
      ["reapply", "Reapplying local changes…"],
      ["refresh", "Finishing refresh…"]
    ] as const) {
      await emitActivities([{ phase }]);
      expect(container.textContent).toContain(label);
      expect(pull?.getAttribute("aria-label")).toBe(label);
    }

    // Another checkout's operation is another checkout's business: this
    // toolbar must never narrate it.
    await emitActivities([
      { phase: "refresh" },
      { id: "op-2", worktreeId: "another-worktree", phase: "fetch" }
    ]);
    expect(container.textContent).toContain("Finishing refresh…");
    expect(container.textContent).not.toContain("Fetching updates…");
  });

  it("opens the status card from the working button, and cancels from it", async () => {
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    await act(async () => pull?.click());
    await emitActivities([
      {
        phase: "fetch",
        silent: true,
        command: "git fetch --prune --progress",
        tail: ["remote: Enumerating objects: 12"]
      }
    ]);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-busy="true"]')
        ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const card = document.querySelector(".remote-activity-popover");
    expect(card).not.toBeNull();
    // Git's own words, and the command that produced them — the two facts a
    // spinner cannot carry.
    expect(card?.textContent).toContain("git fetch --prune --progress");
    expect(card?.textContent).toContain("remote: Enumerating objects: 12");

    const cancel = [
      ...(card?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    ].find((button) => button.textContent === "Cancel");
    await act(async () => cancel?.click());
    expect(bridge.dispatch).toHaveBeenCalledWith("remote:cancelActivity", {
      operationId: "op-1"
    });

    // While Git is being stopped the button says so with aria-disabled, never
    // `disabled`: Chromium blurs a disabled element, and this card dismisses
    // itself on blur — the status would vanish at the moment it is wanted.
    bridge.dispatch.mockClear();
    await emitActivities([{ phase: "fetch", canceling: true }]);
    const stopping = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".remote-activity-popover button"
      )
    ].find((button) => button.textContent === "Stopping…");
    expect(stopping?.getAttribute("aria-disabled")).toBe("true");
    expect(stopping?.disabled).toBe(false);
    await act(async () => stopping?.click());
    expect(bridge.dispatch).not.toHaveBeenCalledWith(
      "remote:cancelActivity",
      expect.anything()
    );
  });

  it("answers a hover that landed before the operation was reported", async () => {
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    await act(async () => pull?.click());

    // The whole of the race, in order. Clicking Pull turns the button busy
    // from this component's own state and swaps its glyph for the spinner,
    // which fires mouseenter under the pointer the click left resting there —
    // all of it BEFORE main reports the operation. That enter used to be the
    // only one the button would ever see, and it was dropped for having
    // nothing to report; the pointer was already inside, so no further enter
    // was coming and the card never opened however long the user waited.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-busy="true"]')
        ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(document.querySelector(".remote-activity-popover")).toBeNull();

    // Old enough to be past the age gate the moment it is reported, which is
    // the case the card exists for.
    await emitActivities([
      { startedAt: Date.now() - 30_000, phase: "fetch", silent: true }
    ]);
    expect(
      document.querySelector(".remote-activity-popover")?.textContent,
      "a hover is a place the pointer is, not a moment an event fired"
    ).toContain("Pull · project · main");
  });

  it("does not open a later operation's card beside a pointer that left", async () => {
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    await act(async () => pull?.click());
    const busy = container.querySelector<HTMLButtonElement>(
      'button[aria-busy="true"]'
    );
    await act(async () => {
      busy?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    // The pointer leaves while there is still nothing to report. React derives
    // its mouseleave prop from `mouseout`, so BOTH exits are dispatched here:
    // the synthetic one drives `close()` while the control is still a trigger,
    // and the element-level one is what still works after it stops being one.
    // Assert them separately or one covers for the other.
    await act(async () => {
      busy?.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: container })
      );
    });
    await emitActivities([
      { startedAt: Date.now() - 30_000, phase: "fetch", silent: true }
    ]);
    expect(
      document.querySelector(".remote-activity-popover"),
      "React's own mouseleave must forget the trigger"
    ).toBeNull();
  });

  it("forgets a trigger the pointer left after the operation ended", async () => {
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    await act(async () => pull?.click());
    const busy = container.querySelector<HTMLButtonElement>(
      'button[aria-busy="true"]'
    );
    await act(async () => {
      busy?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    // Once nothing is running the control is no longer a trigger and React has
    // dropped its handlers, so the exit arrives as a bare DOM event and
    // nothing else. Missing it would leave the trigger remembered forever, and
    // the NEXT operation would throw a card at a pointer that is elsewhere.
    await emitActivities([]);
    await act(async () => {
      busy?.dispatchEvent(new MouseEvent("mouseleave"));
    });

    await emitActivities([
      { id: "op-2", startedAt: Date.now() - 30_000, phase: "fetch" }
    ]);
    expect(document.querySelector(".remote-activity-popover")).toBeNull();
  });

  it("arms the operation that replaced one still inside the age gate", async () => {
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    await act(async () => pull?.click());
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-busy="true"]')
        ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    // Young enough that its card is still waiting on the age gate.
    await emitActivities([{ startedAt: Date.now(), phase: "fetch" }]);
    expect(document.querySelector(".remote-activity-popover")).toBeNull();

    // It finishes and another takes its place before that wait elapses. The
    // pending timer belongs to the operation that is over; treating it as "this
    // one is already being handled" would leave the new one armed by nothing,
    // and its timer fires into an id check that discards it.
    await emitActivities([
      { id: "op-2", startedAt: Date.now() - 30_000, phase: "fetch" }
    ]);
    expect(
      document.querySelector(".remote-activity-popover")?.textContent
    ).toContain("Pull · project · main");
  });

  it("never hangs one operation's card off another operation's button", async () => {
    // `running` answers to this header's own `busy` as well as to the live
    // record, so a locally dispatched fetch can be what makes a button busy
    // while the record for this checkout is a pull someone started elsewhere.
    // The trigger widened in time, not in scope: a card naming a Pull must not
    // hang off the Fetch button.
    const fetchButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fetch"]'
    );
    await act(async () => fetchButton?.click());
    await emitActivities([
      { kind: "pull", startedAt: Date.now() - 30_000, phase: "fetch" }
    ]);

    const busy = container.querySelector<HTMLButtonElement>(
      'button[aria-busy="true"]'
    );
    expect(busy?.getAttribute("aria-label")).toBe("Fetching…");
    await act(async () => {
      busy?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(document.querySelector(".remote-activity-popover")).toBeNull();
  });

  it("keeps the card off a pull short enough that nobody asked", async () => {
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    await act(async () => pull?.click());
    // Clicking Pull leaves the pointer on the button, and swapping in the
    // spinner fires mouseenter under it. A card for every one-second pull is
    // the "front and centre" this deliberately is not.
    await emitActivities([{ startedAt: Date.now(), phase: "fetch" }]);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-busy="true"]')
        ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    expect(document.querySelector(".remote-activity-popover")).toBeNull();
  });

  it("keeps a tooltip on a working button until the card can take over", async () => {
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    await act(async () => pull?.click());
    // Before main registers the operation there is no card to summon, and in
    // the narrow header the label span is display:none — so the title is the
    // only text a spinning button has.
    expect(pull?.getAttribute("title")).toBe("Pulling…");

    await emitActivities([{ phase: "fetch" }]);
    // Now the card carries it, and a native tooltip would cover the card.
    expect(
      container
        .querySelector('button[aria-busy="true"]')
        ?.hasAttribute("title")
    ).toBe(false);
  });

  it("offers user-approved SSH recovery after a Git LFS HTTPS authentication failure", async () => {
    const recovery: SshRemoteRecovery = {
      remote: "origin",
      httpsUrl: "https://github.com/pwrdrvr/PwrAgent.git",
      sshUrl: "git@github.com:pwrdrvr/PwrAgent.git",
      pushUrlWillAlsoChange: true
    };
    bridge.dispatch.mockImplementation((name: string) => {
      if (name === "remote:pull") {
        return Promise.resolve(
          err({
            kind: "remote",
            code: "authentication_required",
            message: "Git LFS needs authentication during checkout."
          })
        );
      }
      if (name === "remote:inspectSshRecovery") {
        return Promise.resolve(ok(recovery));
      }
      return new Promise(() => undefined);
    });
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );

    await act(async () => {
      pull?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bridge.dispatch).toHaveBeenCalledWith("remote:inspectSshRecovery", {
      worktreeId: worktree.id
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("Try this remote with SSH?");
    expect(container.textContent).toContain(recovery.sshUrl);
    expect(bridge.dispatch).not.toHaveBeenCalledWith(
      "remote:testSshRecovery",
      expect.anything()
    );
    expect(bridge.dispatch).not.toHaveBeenCalledWith(
      "remote:applySshRecovery",
      expect.anything()
    );
  });
});

describe("WorktreeHeader default-branch drift", () => {
  const feature: Worktree = {
    ...worktree,
    branch: "releases/1.0",
    isDefaultBranch: false,
    isPrimary: false,
    behind: 0,
    behindDefault: 4
  };
  const render = async (
    w: Worktree,
    state: WorktreeState | null = null
  ): Promise<void> => {
    await act(async () => {
      root.render(<WorktreeHeader repo={repo} worktree={w} state={state} />);
    });
  };
  const drift = (): HTMLElement | null =>
    container.querySelector(".sync-chip--drift");

  it("names the branch the count belongs to, without the warn rung", async () => {
    await render(feature);
    expect(drift()?.textContent).toBe("main +4");
    expect(drift()?.getAttribute("title")).toBe(
      "main has 4 commits not in releases/1.0; this is not commits available to pull"
    );
    // Warn is reserved for ↓behind, which Pull actually clears.
    expect(drift()?.classList.contains("sync-chip--warn")).toBe(false);
  });

  it("reads the count and the name from one source, never a mix", async () => {
    // A stale tree row beside a fresh snapshot that resolved a different
    // default: pairing "main" with 9 would name the wrong comparison.
    await render(
      { ...feature, defaultBranch: "main", behindDefault: 4 },
      {
        worktreeId: feature.id,
        branch: "releases/1.0",
        head: "abc1234",
        hasUpstream: true,
        ahead: 0,
        behind: 0,
        dirty: 0,
        behindDefault: 9,
        defaultBranch: "develop",
        mergedIntoDefault: false,
        divergedFromDefault: false,
        isDefaultBranch: false,
        updatedAt: "2026-08-12T00:00:00.000Z"
      }
    );
    expect(drift()?.textContent).toBe("develop +9");
  });

  it("ignores the snapshot still held from the previous selection", async () => {
    // useWorktreeState keeps the old worktree's state until the new
    // `worktree:getState` resolves. Trusting it here would tell the user
    // viewing `main` that main is 9 commits ahead of a branch they left.
    await render(worktree, {
      worktreeId: "worktree-2",
      branch: "releases/1.0",
      head: "abc1234",
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      dirty: 0,
      behindDefault: 9,
      defaultBranch: "main",
      mergedIntoDefault: false,
      divergedFromDefault: false,
      isDefaultBranch: false,
      updatedAt: "2026-08-12T00:00:00.000Z"
    });
    expect(drift()).toBeNull();
  });

  it("says the directory is missing ahead of any sync reading", async () => {
    const syncChip = (): HTMLElement | null =>
      container.querySelector(".sync-chip:not(.sync-chip--drift)");
    await render({ ...feature, behind: 24, missing: true });
    expect(syncChip()?.textContent).toBe("directory missing");
    expect(syncChip()?.classList.contains("sync-chip--warn")).toBe(true);
    // The live snapshot carries the flag too, once the probe has run.
    await render(feature, {
      worktreeId: feature.id,
      branch: "releases/1.0",
      head: "abc1234",
      hasUpstream: true,
      ahead: 0,
      behind: 3,
      dirty: 0,
      behindDefault: 0,
      defaultBranch: "main",
      mergedIntoDefault: false,
      divergedFromDefault: false,
      isDefaultBranch: false,
      updatedAt: "2026-08-12T00:00:00.000Z",
      missing: true
    });
    expect(syncChip()?.textContent).toBe("directory missing");
  });

  it("says nothing on the default branch, or once the work is in it", async () => {
    await render(worktree);
    expect(drift()).toBeNull();
    await render({ ...feature, mergedIntoDefault: true });
    expect(drift()).toBeNull();
    await render({ ...feature, behindDefault: 0 });
    expect(drift()).toBeNull();
  });
});
