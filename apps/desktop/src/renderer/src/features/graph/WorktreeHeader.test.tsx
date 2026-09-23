// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi
} from "vitest";
import {
  err,
  ok,
  type RemoteActivity,
  type RemoteEndpoint,
  type Repo,
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

import { REMOTE_ACTIVITY_SETTLED_MS } from "../remote/remote-activity";
import {
  REMOTE_ACTIVITY_POPOVER_AFTER_MS,
  WHERE_THE_USER_IS
} from "../remote/useRemoteActivityPopover";
import { showErrorToast } from "../../lib/toast";
import { WorktreeHeader } from "./WorktreeHeader";

const repo = {
  id: "repo-1",
  profileId: "profile-1",
  name: "project",
  path: "/repos/project"
};
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

/**
 * Park the user — pointer or focus ring — on one element for the length of a
 * test.
 *
 * jsdom does track `:hover`, but only as bookkeeping on a dispatched
 * `mouseover` — and dispatching one is precisely what these tests must not do,
 * since React would turn it into the `onMouseEnter` whose absence is the whole
 * subject. (It also answers `:focus-visible` for anything merely focused,
 * which Chromium does not.) Answering the query directly is the only way to
 * say "the user is here, and nothing told the popover so".
 *
 * That covers the wiring — which controls carry the ref, the age gate, the Tab
 * handoff — and is deliberately blind to which half of the query a real
 * browser would have set. That half is a browser fact, checked in
 * `e2e/remote-activity.spec.ts`.
 */
function userIsOn(selector: string): void {
  const real = Element.prototype.matches;
  function hovering(this: Element, query: string): boolean {
    return real.call(this, query === WHERE_THE_USER_IS ? selector : query);
  }
  // `matches` is typed as a stack of `this is HTMLElementTagNameMap[K]`
  // predicates; a stub that answers one extra selector cannot narrow anything,
  // so it is cast back onto the shape it replaces.
  Element.prototype.matches = hovering as typeof Element.prototype.matches;
  onTestFinished(() => {
    Element.prototype.matches = real;
  });
}

/**
 * Stop the clock, for a test that means something precise by an operation's
 * age.
 *
 * The age gate is measured from `startedAt` against `Date.now()`, so a test
 * that arms a wait and then says the card is *not* there yet is otherwise
 * racing the real clock: nothing holds the wait open, and any stall between
 * emitting the record and reading the DOM lets it elapse and put the card on
 * screen. Frozen, "50ms of the wait still to run" is 50ms however loaded the
 * machine is, and only `vi.advanceTimersByTime` moves it on.
 *
 * Restored in `afterEach` rather than the `onTestFinished` its neighbour
 * above uses: Vitest runs `afterEach` first, and teardown there unmounts the
 * tree.
 */
function freezeClock(): void {
  vi.useFakeTimers();
}

/** Old enough that the popover's age gate is already satisfied. */
const WEDGED_SINCE = 60_000;

/**
 * Started late enough that its card is armed with 50ms of the wait left — near
 * enough the end that advancing by the whole gate is past the moment it would
 * have opened, which is what makes "and it still did not open" mean anything.
 */
const ALMOST_DUE = REMOTE_ACTIVITY_POPOVER_AFTER_MS - 50;

let container: HTMLDivElement;
let root: Root;

/**
 * Publish the live remote operations this window can see.
 *
 * Emitting one is also how every hover-path test below makes a button busy —
 * `running` answers to the record as well as to this header's own dispatch, so
 * a record alone is an operation something ELSE started: the sidebar, a bulk
 * sync, a second window. Those tests used to press the button first, which is
 * no longer a route to the hover path at all: a click pins the card outright
 * and a pinned card stands the hover machinery down. This is both the only way
 * left and a closer likeness of the case the hover path still exists for.
 */
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
  // Ahead of the teardown below, so unmounting is never waiting on a clock
  // that no longer runs on its own.
  vi.useRealTimers();
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

  it("pins the card from the click and cancels from it", async () => {
    freezeClock();
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    await act(async () => pull?.click());

    // Before main has said a word. This is the whole change: no age gate, no
    // hover, and the card is already answering "what is it doing?" during the
    // stretch where nothing else could.
    expect(
      document.querySelector(".remote-activity-popover")?.textContent
    ).toContain("Pull · project · main");

    // Past the narration threshold: below it the card deliberately carries no
    // command line at all, because `setCommand` fires per Git invocation and a
    // pull runs eight of them.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await emitActivities([
      {
        phase: "fetch",
        silent: true,
        command: "git fetch --prune --progress",
        tail: ["remote: Enumerating objects: 12"]
      }
    ]);

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

  // What used to be a race is now a non-event. Clicking Pull turns the button
  // busy from this component's own state and swaps its glyph for the spinner,
  // firing mouseenter under the pointer the click left resting there — before
  // main reports the operation. That enter used to be the only one the button
  // would ever see, and losing it meant no card however long the user waited.
  // The click has already opened one, so the enter arrives at a card that is
  // up and changes nothing.
  it("is unmoved by the stationary-pointer mouseenter the click fires", async () => {
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    await act(async () => pull?.click());
    const before = document.querySelector(".remote-activity-popover");
    expect(before).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-busy="true"]')
        ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await emitActivities([
      { startedAt: Date.now() - 30_000, phase: "fetch", silent: true }
    ]);

    const after = document.querySelector(".remote-activity-popover");
    expect(after, "the same card, not a second one").toBe(before);
    expect(after?.textContent).toContain("Pull · project · main");
  });

  it("does not open a later operation's card beside a pointer that left", async () => {
    // Young enough that its own card is still behind the age gate, so nothing
    // is on screen when the pointer leaves.
    await emitActivities([{ startedAt: Date.now(), phase: "fetch" }]);
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
    await emitActivities([{ startedAt: Date.now(), phase: "fetch" }]);
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
    //
    // Both halves of the exit, as a browser sends them: `mouseleave` is what
    // `restOn`'s own listener hears, and `mouseout` is what clears jsdom's
    // `:hover` bookkeeping. Sending only the first leaves jsdom insisting the
    // pointer is still on the button, which contradicts the premise and hands
    // the DOM query a trigger the test has just said was abandoned.
    await emitActivities([]);
    await act(async () => {
      busy?.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })
      );
      busy?.dispatchEvent(new MouseEvent("mouseleave"));
    });

    await emitActivities([
      { id: "op-2", startedAt: Date.now() - 30_000, phase: "fetch" }
    ]);
    expect(document.querySelector(".remote-activity-popover")).toBeNull();
  });

  it("arms the operation that replaced one still inside the age gate", async () => {
    freezeClock();
    // Young enough that its card is still waiting on the age gate.
    await emitActivities([{ startedAt: Date.now(), phase: "fetch" }]);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-busy="true"]')
        ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
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
    // The card is scoped, not merely anchored: one opened by pressing Fetch
    // names that Fetch and must never adopt the Pull's phase, command or
    // output just because both are true of this checkout at once.
    const fetchButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fetch"]'
    );
    await act(async () => fetchButton?.click());
    await emitActivities([
      {
        kind: "pull",
        startedAt: Date.now() - 30_000,
        phase: "fetch",
        command: "git fetch --prune --progress",
        tail: ["remote: Enumerating objects: 12"]
      }
    ]);

    const busy = container.querySelector<HTMLButtonElement>(
      'button[aria-busy="true"]'
    );
    expect(busy?.getAttribute("aria-label")).toBe("Fetching…");
    await act(async () => {
      busy?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const card = document.querySelector(".remote-activity-popover");
    expect(card?.textContent).toContain("Fetch · project · main");
    expect(card?.textContent).not.toContain("Pull · project · main");
    expect(card?.textContent).not.toContain("remote: Enumerating objects: 12");
  });

  it("takes the waiting card away with the trigger the pointer left", async () => {
    freezeClock();
    // Old enough that the wait is nearly up, so the card is genuinely armed
    // rather than merely not due yet.
    await emitActivities([
      { startedAt: Date.now() - ALMOST_DUE, phase: "fetch", silent: true }
    ]);
    const busy = container.querySelector<HTMLButtonElement>(
      'button[aria-busy="true"]'
    );
    await act(async () => {
      busy?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(document.querySelector(".remote-activity-popover")).toBeNull();

    // Letting the trigger go has to take the wait with it. The element-level
    // listener exists because `close()` may never run, so anything only
    // `close()` undid would still be armed — and would throw the card at a
    // pointer that has gone.
    await act(async () => {
      busy?.dispatchEvent(new MouseEvent("mouseleave"));
    });
    // Well past the moment the wait was due to fire: had letting the trigger go
    // left it armed, the card would be here by now.
    await act(async () => {
      vi.advanceTimersByTime(REMOTE_ACTIVITY_POPOVER_AFTER_MS);
    });
    expect(document.querySelector(".remote-activity-popover")).toBeNull();
  });

  // What the age gate is still for. A bulk sync turns this button busy under a
  // pointer that came to rest there for its own reasons, once per repository —
  // and a card that appears and vanishes inside a second is a flicker, not a
  // status. Nobody asked for this one, so the gate withholds it.
  it("keeps the card off an elsewhere-started pull nobody asked about", async () => {
    freezeClock();
    await emitActivities([{ startedAt: Date.now(), phase: "fetch" }]);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-busy="true"]')
        ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    expect(document.querySelector(".remote-activity-popover")).toBeNull();
  });

  // The gap this closes, and the one the pin does not: an operation that turns
  // this button busy with the pointer already resting on it dispatches no
  // boundary event at all, because nothing under the pointer changed. There is
  // no click here to pin from — this is work something else started — so the
  // only way to a card is for the popover to ask the DOM where the user is
  // rather than wait to be told.
  it("opens the card for an operation that starts under a pointer that never moved", async () => {
    userIsOn('button[aria-busy="true"]');
    await emitActivities([
      {
        kind: "fetch",
        startedAt: Date.now() - WEDGED_SINCE,
        command: "git fetch --prune --progress"
      }
    ]);

    // Deliberately no synthesized mouseover or focus: the point is that none
    // is coming.
    const card = document.querySelector(".remote-activity-popover");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("git fetch --prune --progress");
  });

  it("opens it from the progress chip the same way", async () => {
    userIsOn(".sync-chip--progress");
    await emitActivities([
      { kind: "fetch", startedAt: Date.now() - WEDGED_SINCE }
    ]);

    expect(document.querySelector(".remote-activity-popover")).not.toBeNull();
  });

  // Opening it is half the job. What makes a hover card worth opening at all
  // is that it keeps counting — the elapsed readout, the transfer meter and
  // "no Git output for 2m 04s" are the whole difference between a fetch that
  // is working and one that is stuck, and they only exist in later records.
  // A card frozen at the instant it opened draws the stuck one as healthy.
  it("keeps the hover card up to date as the record moves", async () => {
    userIsOn('button[aria-busy="true"]');
    const startedAt = Date.now() - WEDGED_SINCE;
    const card = (): Element | null =>
      document.querySelector(".remote-activity-popover");
    await emitActivities([{ kind: "fetch", startedAt, tail: [] }]);
    expect(card()?.textContent).toContain("Git has produced no output yet.");

    await emitActivities([
      { kind: "fetch", startedAt, tail: ["remote: Enumerating objects: 214"] }
    ]);
    expect(card()?.textContent).toContain("remote: Enumerating objects: 214");
  });

  // A hover card leaves with the pointer — but the pointer's exit rides on
  // `onMouseLeave`, a prop on a control that stops being a trigger the moment
  // its operation ends. An operation that finishes under a resting pointer
  // takes its own dismissal away with it, so the record going has to be what
  // ends the card.
  it("takes the hover card away when the operation ends", async () => {
    userIsOn('button[aria-busy="true"]');
    await emitActivities([
      { kind: "fetch", startedAt: Date.now() - WEDGED_SINCE }
    ]);
    expect(document.querySelector(".remote-activity-popover")).not.toBeNull();

    await emitActivities([]);
    expect(document.querySelector(".remote-activity-popover")).toBeNull();
  });

  // The card carries Cancel, and the pointer's route into it — just move — has
  // no keyboard equivalent. Without this handoff Tab lands on Pull, blurs the
  // trigger and takes the card with it, so the one control that stops a wedged
  // fetch would be mouse-only. Same handoff GraphRow makes into its commit
  // context card.
  it("hands Tab from the working button into the card, not past it", async () => {
    userIsOn('button[aria-busy="true"]');
    await emitActivities([
      { kind: "fetch", startedAt: Date.now() - WEDGED_SINCE }
    ]);
    expect(document.querySelector(".remote-activity-popover")).not.toBeNull();

    const busy = container.querySelector<HTMLButtonElement>(
      'button[aria-busy="true"]'
    );
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true
    });
    await act(async () => {
      busy?.dispatchEvent(tab);
    });

    expect(document.activeElement?.textContent).toBe("Cancel");
    // Swallowed, or the browser moves focus on to Pull straight afterwards.
    expect(tab.defaultPrevented).toBe(true);
  });

  // Shift+Tab is the way back out, and the card is not where it leads.
  it("leaves Shift+Tab on the working button alone", async () => {
    userIsOn('button[aria-busy="true"]');
    await emitActivities([
      { kind: "fetch", startedAt: Date.now() - WEDGED_SINCE }
    ]);

    const back = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-busy="true"]')
        ?.dispatchEvent(back);
    });

    expect(back.defaultPrevented).toBe(false);
    expect(document.activeElement?.textContent).not.toBe("Cancel");
  });

  // Reading where the user is is a second way in, not a second policy:
  // the wait measured from `startedAt` is what keeps an ordinary one-second
  // fetch from throwing a card over the graph and taking it away again.
  it("still keeps the card off a fetch too young to have been asked about", async () => {
    freezeClock();
    userIsOn('button[aria-busy="true"]');
    await emitActivities([{ kind: "fetch", startedAt: Date.now() }]);

    expect(document.querySelector(".remote-activity-popover")).toBeNull();
  });

  // The native title and the card must never be on screen together, and the
  // pin removes the gap the title used to cover: a click puts a card up before
  // main has registered anything, so the button that was pressed drops its
  // title in the same breath — as do the idle buttons beside it, whose tooltip
  // would otherwise open over a card they have nothing to do with.
  it("drops every native tooltip while a card is on screen", async () => {
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    expect(pull?.getAttribute("title")).toBe("Pull · fetch + fast-forward");

    await act(async () => pull?.click());
    expect(document.querySelector(".remote-activity-popover")).not.toBeNull();
    for (const label of ["Fetch", "Pull", "Push"]) {
      expect(
        container
          .querySelector(`button[aria-label^="${label}"], button[aria-label="Pulling…"]`)
          ?.hasAttribute("title"),
        `${label} must not open a native tooltip over the card`
      ).toBe(false);
    }

    await emitActivities([{ phase: "fetch" }]);
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
      worktreeId: worktree.id,
      operation: "pull"
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

/**
 * Git refused a fetch, pull or push because it had no HTTPS credential and may
 * not prompt for one. All three hand that failure to the same dialog, and each
 * still ends in exactly one of: a settled card, a card dismissed for the
 * dialog, or a toast.
 */
describe("WorktreeHeader offers SSH when Git had no HTTPS credential", () => {
  const recovery: SshRemoteRecovery = {
    remote: "origin",
    httpsUrl: "https://github.com/pwrdrvr/PwrAgent.git",
    sshUrl: "git@github.com:pwrdrvr/PwrAgent.git",
    pushUrlWillAlsoChange: true
  };
  const noCredential = err({
    kind: "remote",
    code: "authentication_required",
    message:
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
  });
  const operations = [
    ["Fetch", "fetch"],
    ["Pull", "pull"],
    ["Push", "push"]
  ] as const;

  const card = (): Element | null =>
    document.querySelector(".remote-activity-popover");
  const dialog = (): Element | null =>
    container.querySelector('[role="dialog"]');
  /** By position, not name: a busy button's label is "Fetching…" and so on. */
  const button = (label: "Fetch" | "Pull" | "Push"): HTMLButtonElement | null =>
    container.querySelectorAll<HTMLButtonElement>(".wt-actions > .wt-btn")[
      ["Fetch", "Pull", "Push"].indexOf(label)
    ] ?? null;

  /** Answer the named commands; anything else never settles. */
  const answer = (replies: Record<string, () => Promise<unknown>>): void => {
    bridge.dispatch.mockImplementation(
      (name: string) =>
        replies[name]?.() ??
        (name === "remote:activities"
          ? Promise.resolve(ok([]))
          : new Promise(() => undefined))
    );
  };

  /** Let every dispatch already answered run its continuation to the end. */
  const drain = (): Promise<void> =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  const visit = (id: string): Promise<void> =>
    act(async () => {
      root.render(
        <WorktreeHeader repo={repo} worktree={{ ...worktree, id }} state={null} />
      );
    });

  it.each(operations)(
    "hands a %s Git could not authenticate to the dialog, and takes the card with it",
    async (label, operation) => {
      answer({
        [`remote:${operation}`]: () => Promise.resolve(noCredential),
        "remote:inspectSshRecovery": () => Promise.resolve(ok(recovery))
      });

      await act(async () => button(label)?.click());
      await drain();

      expect(bridge.dispatch).toHaveBeenCalledWith(
        "remote:inspectSshRecovery",
        { worktreeId: worktree.id, operation }
      );
      // The dialog names the operation that failed, not always Pull.
      expect(
        dialog()?.querySelector(".ssh-recovery__intro")?.textContent
      ).toMatch(new RegExp(`^${label}`));
      expect(dialog()?.textContent).toContain(recovery.sshUrl);
      expect(card()).toBeNull();
      expect(showErrorToast).not.toHaveBeenCalled();
      expect(button(label)?.getAttribute("aria-busy")).toBe("false");
      // Offered, never acted on: testing and changing are the user's clicks.
      for (const command of [
        "remote:testSshRecovery",
        "remote:applySshRecovery"
      ]) {
        expect(bridge.dispatch).not.toHaveBeenCalledWith(
          command,
          expect.anything()
        );
      }
    }
  );

  it.each(operations)(
    "leaves a %s failure on the card when there is nothing to offer",
    async (label, operation) => {
      answer({
        [`remote:${operation}`]: () => Promise.resolve(noCredential),
        // Not GitHub over HTTPS, no upstream, or a push by another URL.
        "remote:inspectSshRecovery": () => Promise.resolve(ok(null))
      });

      await act(async () => button(label)?.click());
      await drain();

      expect(dialog()).toBeNull();
      expect(card()?.textContent).toContain(
        `${label} failed — fatal: could not read Username`
      );
      expect(showErrorToast).not.toHaveBeenCalled();
      expect(button(label)?.getAttribute("aria-busy")).toBe("false");
    }
  );

  it("stays busy until the offer is decided, so nothing can start under it", async () => {
    let inspected!: () => void;
    answer({
      "remote:fetch": () => Promise.resolve(noCredential),
      "remote:inspectSshRecovery": () =>
        new Promise((resolve) => {
          inspected = () => resolve(ok(recovery));
        })
    });

    await act(async () => button("Fetch")?.click());
    await drain();

    // Git is done; the outcome is not. A Pull pressed here would pin a card
    // the arriving dialog then takes away.
    expect(button("Fetch")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => button("Pull")?.click());
    expect(bridge.dispatch).not.toHaveBeenCalledWith(
      "remote:pull",
      expect.anything()
    );

    await act(async () => inspected());
    await drain();
    expect(dialog()).not.toBeNull();
    expect(button("Fetch")?.getAttribute("aria-busy")).toBe("false");
  });

  it("drops the offer for a checkout the user has left", async () => {
    let inspected!: () => void;
    answer({
      "remote:push": () => Promise.resolve(noCredential),
      "remote:inspectSshRecovery": () =>
        new Promise((resolve) => {
          inspected = () => resolve(ok(recovery));
        })
    });

    await act(async () => button("Push")?.click());
    await drain();
    await visit("worktree-2");
    await act(async () => inspected());
    await drain();

    expect(dialog()).toBeNull();
    expect(card()).toBeNull();
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  // `activeWorktreeId` reads the same again once the user is back, so only
  // the operation count can tell this fetch's outcome from the pull's. Without
  // it, the fetch would clear the pull's busy state and settle the pull's
  // card as "Fetch failed".
  it("drops a failure from an earlier visit once this checkout has started something else", async () => {
    let failFetch!: () => void;
    answer({
      "remote:fetch": () =>
        new Promise((resolve) => {
          failFetch = () => resolve(noCredential);
        }),
      "remote:inspectSshRecovery": () => Promise.resolve(ok(recovery))
    });

    await act(async () => button("Fetch")?.click());
    await visit("worktree-2");
    await visit(worktree.id);
    await act(async () => button("Pull")?.click());
    expect(card()).not.toBeNull();

    await act(async () => failFetch());
    await drain();

    expect(bridge.dispatch).not.toHaveBeenCalledWith(
      "remote:inspectSshRecovery",
      expect.anything()
    );
    expect(dialog()).toBeNull();
    expect(card()).not.toBeNull();
    expect(card()?.textContent).not.toContain("Fetch failed");
    expect(button("Pull")?.getAttribute("aria-busy")).toBe("true");
    expect(showErrorToast).not.toHaveBeenCalled();
  });
});

/**
 * The card outliving its operation.
 *
 * Everything here is about the stretch AFTER Git exits, which is the half the
 * card never used to have: it was torn down the instant the record went away,
 * so the only thing it could ever describe was work in flight.
 */
describe("WorktreeHeader settled status card", () => {
  const card = (): Element | null =>
    document.querySelector(".remote-activity-popover");
  const buttonIn = (root: Element | null, label: string) =>
    [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button.textContent === label
    );

  /** Press a toolbar button and let its dispatch resolve. */
  const press = async (label: string, result: unknown): Promise<void> => {
    bridge.dispatch.mockReturnValueOnce(Promise.resolve(result));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  // Escape latches the trigger inside `useViewportTooltip` so that restoring
  // focus to it cannot reopen what was just dismissed. Pressing that same
  // button is a fresh ask, not a focus restore — and the failure mode is
  // silent twice over: `show` refuses the card, and `settle` still reports the
  // outcome as carried, so the toast that should have caught it never fires.
  it("reopens for the next press after Escape took the last one away", async () => {
    await press("Fetch", ok(null));
    expect(card()).not.toBeNull();

    // Tab in first, because that is the Escape the latch exists for: leaving
    // focus behind is what makes `useViewportTooltip` restore it to the
    // trigger, and what makes it hold the trigger against reopening.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fetch"]')
        ?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            bubbles: true,
            cancelable: true
          })
        );
    });
    expect(card()?.contains(document.activeElement)).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(card()).toBeNull();

    await press(
      "Fetch",
      err({ kind: "remote", code: "network", message: "boom" })
    );
    expect(card()?.textContent).toContain("Fetch failed");
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  // The selection changing is a fourth way out of an operation, and it had
  // none of the three. The card reports a checkout that is no longer on
  // screen, and the dispatch comes back to a staleness guard rather than to a
  // settle — so without this nothing would ever take it away.
  it("lets go of the card when the selection moves to another worktree", async () => {
    let finish!: () => void;
    bridge.dispatch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve(ok(null));
      })
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fetch"]')
        ?.click();
    });
    expect(card()).not.toBeNull();

    await act(async () => {
      root.render(
        <WorktreeHeader
          repo={repo}
          worktree={{ ...worktree, id: "worktree-2" }}
          state={null}
        />
      );
    });
    expect(card()).toBeNull();

    // And the outcome belongs to the checkout that left, so it must not write
    // a receipt over the one now on screen either.
    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(card()).toBeNull();
  });

  // A click that lands while the operation is still running is not a click on
  // a countdown, because there is no countdown yet. Carried forward it hands
  // the user a receipt that never goes away and no timer they could have seen
  // to stop.
  it("still counts the receipt out after a click during the operation", async () => {
    freezeClock();
    let finish!: () => void;
    bridge.dispatch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve(ok(null));
      })
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fetch"]')
        ?.click();
    });
    await act(async () => {
      card()
        ?.querySelector(".remote-activity__status")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(card()?.textContent).toContain("Fetched");

    await act(async () => {
      vi.advanceTimersByTime(REMOTE_ACTIVITY_SETTLED_MS);
    });
    expect(card()).toBeNull();
  });

  const steps = (): string[] =>
    [...(card()?.querySelectorAll(".remote-activity__step-label") ?? [])].map(
      (row) => row.textContent ?? ""
    );

  /**
   * Hold a dispatch open so the operation can be observed while it runs.
   *
   * The returned resolver takes the outcome, defaulting to a plain success —
   * an earlier version always resolved with `ok`, which quietly turned a test
   * of a *failed* operation into a test of a successful one.
   */
  const inFlight = async (
    label: string
  ): Promise<(value?: unknown) => void> => {
    let finish!: (value: unknown) => void;
    bridge.dispatch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
        ?.click();
    });
    return (value: unknown = ok({ fastForwarded: true, stashed: true })) =>
      finish(value);
  };

  // The complaint this answers: five phases, every transition publishing past
  // the 400ms throttle, so a sub-second pull lands five full redraws before
  // one frame can be read. Below the threshold the card says one stable thing
  // and then what it did.
  it("does not narrate an operation that is over before it can be read", async () => {
    freezeClock();
    const finish = await inFlight("Pull");
    await emitActivities([{ kind: "pull", phase: "fetch" }]);
    await emitActivities([{ kind: "pull", phase: "fast_forward" }]);
    expect(
      steps(),
      "nothing has run long enough to be worth narrating"
    ).toEqual([]);

    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    // But it was recorded throughout, so the receipt still answers the
    // question the churn was failing to.
    expect(steps()).toEqual(["Fetched", "Fast-forwarded"]);
  });

  // The same complaint, arriving by the other door. Gating only the step list
  // left the card falling back to `remoteActivityStatus`, which IS the
  // per-phase narration — so a sub-second pull still walked four sentences in
  // six tenths of a second, in the one line the card was showing.
  it("says one stable thing while it is too short to narrate", async () => {
    freezeClock();
    const finish = await inFlight("Pull");
    const line = (): string =>
      card()?.querySelector(".remote-activity__status")?.textContent ?? "";
    expect(line()).toBe("Starting…");

    for (const phase of [
      "fetch",
      "prepare",
      "fast_forward",
      "reapply"
    ] as const) {
      await emitActivities([
        { kind: "pull", phase, lastOutputAt: Date.now(), command: `git ${phase}` }
      ]);
      expect(line(), `the card was rewritten during ${phase}`).toBe(
        "Starting…"
      );
    }
    // And nothing under it moved either: the command line changes with every
    // Git invocation, not merely every phase.
    expect(card()?.querySelector(".remote-activity__command")).toBeNull();

    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(steps()).toEqual([
      "Fetched",
      "Fast-forwarded",
      "Reapplied your changes"
    ]);
  });

  // Cancel is the one thing the quiet period must not withhold: it is drawn
  // from the moment there is an operation to stop, not from the moment the
  // card starts narrating one.
  it("offers Cancel before it narrates", async () => {
    freezeClock();
    await inFlight("Pull");
    await emitActivities([
      { id: "op-9", kind: "pull", phase: "fetch", lastOutputAt: Date.now() }
    ]);
    const cancel = [
      ...(card()?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    ].find((button) => button.textContent === "Cancel");
    await act(async () => cancel?.click());
    expect(bridge.dispatch).toHaveBeenCalledWith("remote:cancelActivity", {
      operationId: "op-9"
    });
  });

  // The rule the whole card is now held to: it may grow, and it may not take
  // space back. Anything that disappears under the reader's eye moves the text
  // below it, and a thing that comes and goes moves that text twice.
  //
  // A network step's track is decided by its PHASE, not by whether Git has
  // sent a percentage yet — Git starts reporting a beat after the phase opens
  // and stops before it closes, so a track that followed the numbers would
  // resize its own row twice per step.
  it("gives a network step its progress track before Git sends a number", async () => {
    freezeClock();
    const finish = await inFlight("Pull");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    const bars = (): number =>
      card()?.querySelectorAll(".remote-activity__step-bar").length ?? 0;

    // No meter in this record at all.
    await emitActivities([
      { kind: "pull", phase: "fetch", lastOutputAt: Date.now() }
    ]);
    expect(bars(), "the fetch row reserves its track from the start").toBe(1);

    await emitActivities([
      {
        kind: "pull",
        phase: "fetch",
        lastOutputAt: Date.now(),
        progress: {
          label: "Receiving objects",
          percent: 43,
          completed: 43,
          total: 100
        }
      }
    ]);
    expect(bars(), "and keeps exactly that one when the numbers arrive").toBe(1);

    // A local phase never meters anything, so its row never carries a track —
    // which is what keeps every row's height fixed at the moment it is written.
    await emitActivities([
      { kind: "pull", phase: "fast_forward", lastOutputAt: Date.now() }
    ]);
    expect(bars(), "the finished fetch keeps its track; the local step has none")
      .toBe(1);

    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bars(), "and the receipt is the same rows it was a moment ago").toBe(
      1
    );
  });

  // "No Git output for 25s" appears under the list and above the buttons. Git
  // going quiet for twenty seconds and then speaking again is a real event and
  // a real retraction — but a line that vanishes on the retraction pushes the
  // evidence and the buttons down and pulls them back up.
  it("keeps the health line once it has had something to say", async () => {
    freezeClock();
    const finish = await inFlight("Pull");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    const health = (): string | null =>
      [...(card()?.querySelectorAll(".remote-activity__status") ?? [])]
        .at(-1)
        ?.textContent ?? null;

    await emitActivities([
      { kind: "pull", phase: "fetch", lastOutputAt: Date.now() }
    ]);
    expect(health(), "nothing wrong yet, so nothing to say").toBeNull();

    await emitActivities([
      { kind: "pull", phase: "fetch", lastOutputAt: Date.now() - 25_000 }
    ]);
    expect(health()).toContain("no Git output for");

    // Git speaks again. The reading is honest — and the line stays put.
    await emitActivities([
      { kind: "pull", phase: "fetch", lastOutputAt: Date.now() }
    ]);
    expect(health()).toBe("Fetching updates");
    finish();
  });

  // The card holds per-operation state, and the pinned popover UPDATES one
  // React tree rather than remounting it — so without a key tied to the
  // session, one operation's card starts where the last one's ended.
  it("does not inherit the previous operation's warning", async () => {
    freezeClock();
    const health = (): string | null =>
      [...(card()?.querySelectorAll(".remote-activity__status") ?? [])]
        .at(-1)
        ?.textContent ?? null;

    const first = await inFlight("Pull");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await emitActivities([
      { kind: "pull", phase: "fetch", lastOutputAt: Date.now() - 25_000 }
    ]);
    expect(health()).toContain("no Git output for");
    await act(async () => {
      first();
      await Promise.resolve();
      await Promise.resolve();
    });
    await emitActivities([]);

    // A second pull, perfectly healthy from its first breath.
    const second = await inFlight("Pull");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await emitActivities([
      { id: "op-2", kind: "pull", phase: "fetch", lastOutputAt: Date.now() }
    ]);
    expect(
      health(),
      "a healthy operation must not wear the last one's warning"
    ).toBeNull();
    second();
  });

  // Dropping the health line at settle was the same defect the evidence block
  // had, one line lower, and at the worst possible moment: the buttons jump
  // upward exactly as the user looks down to read the outcome.
  it("keeps the health line on the receipt it stood on", async () => {
    freezeClock();
    const finish = await inFlight("Pull");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await emitActivities([
      { kind: "pull", phase: "fetch", lastOutputAt: Date.now() - 25_000 }
    ]);
    const lines = (): number =>
      card()?.querySelectorAll(".remote-activity__status").length ?? 0;
    expect(lines()).toBe(1);

    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    await emitActivities([]);
    expect(lines(), "the receipt kept every line the running card had").toBe(1);
    // And it says the outcome rather than a stale stall reading.
    expect(card()?.textContent).toContain("Fast-forwarded");
  });

  // The command line is up to 160 monospace characters in a 320px card, so it
  // wraps to a different number of lines per invocation — as a permanent
  // fixture under the step list it moved everything below it several times a
  // second. It belongs with the output it produced, behind the disclosure that
  // opens itself when those two facts ARE the finding.
  it("keeps the command line inside the evidence disclosure", async () => {
    freezeClock();
    const finish = await inFlight("Pull");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await emitActivities([
      {
        kind: "pull",
        phase: "fetch",
        lastOutputAt: Date.now(),
        command: "git fetch --prune --progress origin"
      }
    ]);
    const command = card()?.querySelector(".remote-activity__command");
    expect(command?.textContent).toBe("git fetch --prune --progress origin");
    expect(
      command?.closest(".remote-activity__evidence"),
      "a line that reflows at Git's rate must not sit in the card's own column"
    ).not.toBeNull();
    finish();
  });

  // A row is appended, changes once when its own work ends, and then holds.
  // The DOM node is the honest way to assert "the row did not move".
  it("appends a row per phase, and each changes once when it completes", async () => {
    freezeClock();
    const finish = await inFlight("Pull");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await emitActivities([{ kind: "pull", phase: "fetch" }]);
    expect(steps()).toEqual(["Fetching updates"]);
    const firstRow = card()?.querySelector(".remote-activity__step");

    // `prepare` is a `git status` main emits whether or not there is anything
    // to stash. It earns no row — and, just as importantly, takes none away.
    // The fetch above it reads done because by then it genuinely is.
    await emitActivities([{ kind: "pull", phase: "prepare" }]);
    expect(steps()).toEqual(["Fetched"]);

    await emitActivities([{ kind: "pull", phase: "fast_forward" }]);
    expect(steps()).toEqual(["Fetched", "Fast-forwarding"]);
    expect(
      card()?.querySelector(".remote-activity__step"),
      "the first row is the same element, in the same place"
    ).toBe(firstRow);

    // A phase Git re-enters is still one row: a pull pops its stash in two
    // places, and that must not read as two separate pieces of work.
    await emitActivities([{ kind: "pull", phase: "reapply" }]);
    await emitActivities([{ kind: "pull", phase: "reapply" }]);
    expect(steps()).toEqual([
      "Fetched",
      "Fast-forwarded",
      "Reapplying your changes"
    ]);

    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(steps()).toEqual([
      "Fetched",
      "Fast-forwarded",
      "Reapplied your changes"
    ]);
  });

  // Git's progress output is `\r`-rewritten and grows to its cap while its
  // last line flickers — the card's largest single source of churn, and on a
  // healthy operation it says nothing the rows have not.
  it("keeps Git's output collapsed while the operation is healthy", async () => {
    freezeClock();
    const finish = await inFlight("Pull");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await emitActivities([
      {
        kind: "pull",
        phase: "fetch",
        // Git wrote a moment ago: a healthy transfer, not the quiet that
        // would rightly throw the evidence open.
        lastOutputAt: Date.now(),
        tail: ["Receiving objects:  71%"]
      }
    ]);
    const evidence = (): HTMLDetailsElement | null =>
      card()?.querySelector<HTMLDetailsElement>(".remote-activity__evidence") ??
      null;
    expect(evidence()?.open).toBe(false);

    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Still there on the receipt, still shut. Git's words are kept — Copy and
    // the Logs window both reach them — they are just not the thing a
    // successful pull is trying to say.
    expect(evidence()?.open).toBe(false);
    expect(evidence()?.textContent).toContain("Receiving objects");
  });

  // Caught by a real-app capture, not by this suite: marking every step done
  // on settle made a FAILED fetch report "✓ Fetched", and the step list
  // replaced the status line that carried the reason — so the card said the
  // operation had succeeded and said nothing about why it had not.
  it("does not report a step as done when the operation failed on it", async () => {
    freezeClock();
    const finish = await inFlight("Pull");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await emitActivities([
      { kind: "pull", phase: "fetch", lastOutputAt: Date.now() }
    ]);
    expect(steps()).toEqual(["Fetching updates"]);

    await act(async () => {
      finish(
        err({ kind: "remote", code: "network", message: "fatal: unreachable" })
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await emitActivities([]);

    // The step it stopped on, still in the present tense and marked as such.
    expect(steps()).toEqual(["Fetching updates"]);
    expect(
      card()?.querySelector(".remote-activity__step--failed"),
      "the step the operation failed on must not read as done"
    ).not.toBeNull();
    expect(card()?.querySelector(".remote-activity__step--done")).toBeNull();
    // And the reason is on screen, which the step list had displaced.
    expect(card()?.textContent).toContain("Pull failed");
    expect(card()?.textContent).toContain("fatal: unreachable");
  });

  // The three cases the card exists for. Making a user hunt for a disclosure
  // to read the finding would be the same mistake as the old age gate.
  it("opens Git's output by itself when that output IS the finding", async () => {
    freezeClock();
    await press(
      "Pull",
      err({ kind: "remote", code: "network", message: "fatal: unreachable" })
    );
    const evidence = card()?.querySelector<HTMLDetailsElement>(
      ".remote-activity__evidence"
    );
    expect(evidence?.open).toBe(true);
    expect(evidence?.textContent).toContain("fatal: unreachable");
  });

  it("quotes only what Git wrote under a reason PwrGit wrote", async () => {
    // A rejected push's message is PwrGit's reading of Git; `detail` is Git.
    // The headline takes the one and the Git-output block the other, so the
    // block never presents PwrGit's sentence as something Git printed.
    freezeClock();
    await press(
      "Push",
      err({
        kind: "remote",
        code: "rejected",
        message: "The remote has newer commits. Pull, then push again.",
        detail: " ! [rejected]        main -> main (fetch first)"
      })
    );
    expect(card()?.textContent).toContain(
      "Push failed — The remote has newer commits. Pull, then push again."
    );
    const output = card()?.querySelector(".remote-activity__output");
    expect(output?.textContent).toContain("! [rejected]");
    expect(output?.textContent).not.toContain("Pull, then push again");
  });

  it("keeps the card as the receipt, and counts it down", async () => {
    freezeClock();
    await press("Fetch", ok(null));

    expect(card()?.textContent).toContain("Fetched");
    // Cancel goes with the operation it addressed; the way out does not.
    expect(buttonIn(card(), "Cancel")).toBeUndefined();
    expect(card()?.querySelector(".remote-activity__close")).not.toBeNull();
    expect(card()?.querySelector(".remote-activity__rail")).not.toBeNull();

    // Not a moment before the rail is out.
    await act(async () => {
      vi.advanceTimersByTime(REMOTE_ACTIVITY_SETTLED_MS - 1);
    });
    expect(card()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(card()).toBeNull();
  });

  it("stands until dismissed when the operation fails, with no rail", async () => {
    freezeClock();
    await press(
      "Fetch",
      err({
        kind: "remote",
        code: "network",
        message: "fatal: Could not read from remote repository."
      })
    );

    expect(card()?.textContent).toContain("Fetch failed");
    // A bar that is not draining must not be mistaken for one that is.
    expect(card()?.querySelector(".remote-activity__rail")).toBeNull();

    // Several times the rail, with nothing to take it away.
    await act(async () => {
      vi.advanceTimersByTime(REMOTE_ACTIVITY_SETTLED_MS * 4);
    });
    expect(card()).not.toBeNull();
    expect(card()?.textContent).toContain(
      "fatal: Could not read from remote repository."
    );

    await act(async () => buttonIn(card(), "Close")?.click());
    expect(card()).toBeNull();
  });

  // A durable card anchored to the button that was pressed, carrying Git's own
  // output plus Logs and Copy, is a better report than a corner toast — and
  // both at once is the same failure said twice.
  it("raises no toast for a failure the card carried", async () => {
    await press(
      "Fetch",
      err({ kind: "remote", code: "network", message: "boom" })
    );
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it("still raises one for a failure with no card to land on", async () => {
    // The user clicked away while the fetch was still running, so when it does
    // fail the outcome has nowhere anchored to go. That is the whole remaining
    // job of the corner toast.
    let fail!: () => void;
    bridge.dispatch.mockReturnValueOnce(
      new Promise((resolve) => {
        fail = () =>
          resolve(err({ kind: "remote", code: "network", message: "boom" }));
      })
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fetch"]')
        ?.click();
    });
    expect(card()).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
    });
    expect(card()).toBeNull();

    await act(async () => {
      fail();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(showErrorToast).toHaveBeenCalled();
  });

  it("closes on a click elsewhere, and the click is not swallowed", async () => {
    await press("Fetch", ok(null));
    expect(card()).not.toBeNull();

    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true
    });
    await act(async () => {
      document.body.dispatchEvent(down);
    });
    expect(card()).toBeNull();
    // The click still lands where it was aimed — this dismissal costs the user
    // nothing but the card.
    expect(down.defaultPrevented).toBe(false);
  });

  // Pressing the button again is not "elsewhere": it either starts the next
  // operation or is inert because one is running, and neither should take the
  // status away.
  it("survives a mousedown on its own trigger", async () => {
    await press("Fetch", ok(null));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fetch"]')
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(card()).not.toBeNull();
  });

  it("stops the countdown when the user clicks the card, and keeps it stopped", async () => {
    freezeClock();
    await press("Fetch", ok(null));

    // The status line, not the Git-output block: a successful card has no
    // output block at all, because an empty one under "Fetched" reports
    // nothing.
    await act(async () => {
      card()
        ?.querySelector(".remote-activity__status")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      card()?.querySelector(".remote-activity__rail")?.getAttribute("data-paused"),
      "a click is deliberate, so the rail stops for good rather than while hovered"
    ).toBe("true");

    await act(async () => {
      vi.advanceTimersByTime(REMOTE_ACTIVITY_SETTLED_MS * 4);
    });
    expect(card()).not.toBeNull();
  });

  // The ✕ precedes Cancel in the header, so "first focusable in the DOM" and
  // "the control this card is being tabbed into for" stopped agreeing the
  // moment the card grew one. `data-focus-first` is what settles it.
  it("hands Tab to Cancel on a pinned card, not to the dismiss ✕", async () => {
    const fetchButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fetch"]'
    );
    await act(async () => fetchButton?.click());
    await emitActivities([{ kind: "fetch", phase: "fetch" }]);
    expect(card()?.querySelector(".remote-activity__close")).not.toBeNull();

    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-busy="true"]')
        ?.dispatchEvent(tab);
    });
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(tab.defaultPrevented).toBe(true);
  });

  // The block stood under this card for the whole operation, so it keeps its
  // place on the receipt. Dropping it because a successful fetch had nothing
  // to put in it pulled the buttons under it upward at the exact moment the
  // user looked down to read the outcome — and "Git produced no output" is a
  // sentence, not an empty block.
  it("keeps the Git-output block on the receipt it stood under", async () => {
    await press("Fetch", ok(null));
    expect(card()?.textContent).toContain("Fetched");
    expect(card()?.querySelector(".remote-activity__output")?.textContent).toBe(
      "Git produced no output."
    );

    await press(
      "Fetch",
      err({ kind: "remote", code: "network", message: "boom" })
    );
    expect(card()?.querySelector(".remote-activity__output")?.textContent).toBe(
      "boom"
    );
  });

  it("replaces one receipt with the next operation's card", async () => {
    await press("Fetch", ok(null));
    expect(card()?.textContent).toContain("Fetched");

    await press("Pull", ok({ fastForwarded: true, stashed: false, reappliedWithConflicts: false }));
    expect(card()?.textContent).toContain("Fast-forwarded");
    expect(card()?.textContent).not.toContain("Fetched");
  });

  // There is work left in the checkout. A receipt that takes itself away in
  // four seconds is the wrong shape for something the user has to act on.
  it("keeps a pull whose stash came back with conflicts up until dismissed", async () => {
    freezeClock();
    await press("Pull", ok({
      fastForwarded: true,
      stashed: true,
      reappliedWithConflicts: true
    }));

    expect(card()?.textContent).toContain("conflicts");
    expect(card()?.querySelector(".remote-activity__rail")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(REMOTE_ACTIVITY_SETTLED_MS * 4);
    });
    expect(card()).not.toBeNull();
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
  /** The drift sentence is a `useViewportTooltip` card rather than a `title`,
   *  so it exists only while the chip is hovered. Unlike the popover tests
   *  above — which must NOT dispatch a `mouseover` — this one is asserting
   *  exactly that the hover opens something. */
  const driftCard = async (): Promise<string> => {
    await act(async () => {
      drift()?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    return document.querySelector('[role="tooltip"]')?.textContent ?? "";
  };

  it("names the branch the count belongs to, without the warn rung", async () => {
    await render(feature);
    expect(drift()?.textContent).toBe("main +4");
    expect(await driftCard()).toBe(
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

describe("WorktreeHeader offers a fork when this account cannot push", () => {
  /** Mount a header outside the shared fixture, with an identity of its own. */
  async function mount(identity?: Repo["identity"]) {
    const own = document.createElement("div");
    document.body.append(own);
    const ownRoot = createRoot(own);
    onTestFinished(async () => {
      await act(async () => ownRoot.unmount());
      own.remove();
    });
    await act(async () => {
      ownRoot.render(
        <WorktreeHeader
          repo={{ ...repo, ...(identity === undefined ? {} : { identity }) }}
          worktree={worktree}
          state={null}
        />
      );
    });
    return own;
  }

  const readOnly: Repo["identity"] = {
    host: "github",
    hostname: "github.com",
    owner: "desktop",
    name: "dugite",
    nameWithOwner: "desktop/dugite",
    visibility: "public",
    viewerCanPush: false
  };

  it("draws the chip only where the forge actually said no", async () => {
    // Three states, and only one of them draws: `true` is the ordinary case,
    // and absent is "not known" — a chip there would claim a refusal nobody
    // made.
    const unknown = await mount();
    expect(unknown.querySelector(".sync-chip--readonly")).toBeNull();
    const writable = await mount({ ...readOnly, viewerCanPush: true });
    expect(writable.querySelector(".sync-chip--readonly")).toBeNull();
    const denied = await mount(readOnly);
    expect(denied.querySelector(".sync-chip--readonly")?.textContent).toBe(
      "read-only"
    );
  });

  it("opens the fork prompt from the chip", async () => {
    const own = await mount(readOnly);
    const chip = own.querySelector<HTMLButtonElement>(".sync-chip--readonly")!;
    await act(async () => chip.click());
    expect(document.querySelector(".fork-checkout-dialog")).not.toBeNull();
  });

  it("offers the fork when git itself refuses the push, with git's own words", async () => {
    // This path deliberately does not consult the stored identity: git has
    // just said the account may not write there, which is better evidence than
    // anything cached — and it works on a checkout nothing has ever asked the
    // forge about.
    const own = await mount();
    bridge.dispatch.mockImplementation((name: string) =>
      name === "remote:push"
        ? Promise.resolve(
            err({
              kind: "remote",
              code: "push_denied",
              message: "ERROR: Permission to desktop/dugite.git denied to huntharo."
            })
          )
        : name === "remote:activities"
          ? Promise.resolve(ok([]))
          : new Promise(() => undefined)
    );
    const push = [...own.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === "Push"
    )!;
    await act(async () => push.click());
    const dialog = document.querySelector(".fork-checkout-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Permission to desktop/dugite.git denied");
  });

  it("leaves an ordinary push failure to the error path", async () => {
    const own = await mount();
    bridge.dispatch.mockImplementation((name: string) =>
      name === "remote:push"
        ? Promise.resolve(
            err({
              kind: "remote",
              code: "rejected",
              message: "! [rejected] main -> main (non-fast-forward)"
            })
          )
        : name === "remote:activities"
          ? Promise.resolve(ok([]))
          : new Promise(() => undefined)
    );
    const push = [...own.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === "Push"
    )!;
    await act(async () => push.click());
    expect(document.querySelector(".fork-checkout-dialog")).toBeNull();
  });
});

describe("WorktreeHeader publishes a branch Push has nowhere to send", () => {
  // Push on a branch with no upstream used to be a dead end: Git refused, and
  // the card relayed its advice to go and run `git push --set-upstream` in a
  // terminal. The toolbar asks the one question that command needs instead.
  const branch = "feature/new-thing";
  const unpublishedRow: Worktree = {
    ...worktree,
    branch,
    isDefaultBranch: false,
    behind: 0,
    tracking: "unpublished"
  };
  const remote = (name: string): RemoteEndpoint => ({
    name,
    pushUrl: `https://example.test/${name}/project.git`
  });
  const snapshot = (overrides: Partial<WorktreeState>): WorktreeState => ({
    worktreeId: worktree.id,
    branch,
    head: "0123456789abcdef0123456789abcdef01234567",
    hasUpstream: false,
    ahead: 0,
    behind: 0,
    dirty: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: false,
    updatedAt: "2026-09-17T00:00:00.000Z",
    ...overrides
  });

  const dialog = (): Element | null => document.querySelector(".publish-branch");
  const card = (): Element | null =>
    document.querySelector(".remote-activity-popover");
  const pushCalls = () =>
    bridge.dispatch.mock.calls.filter(([name]) => name === "remote:push");

  /**
   * Mount a header of its own, answering `repo:remotes` with `remotes` and
   * `remote:push` with `push`. Listed `upstream` first, so a test that sees
   * `origin` chosen is seeing the preference and not the order.
   */
  async function mount({
    row = unpublishedRow,
    state = null,
    remotes = Promise.resolve(ok([remote("upstream"), remote("origin")])),
    push = new Promise(() => undefined),
    fetch = new Promise(() => undefined)
  }: {
    row?: Worktree;
    state?: WorktreeState | null;
    remotes?: Promise<unknown>;
    push?: Promise<unknown>;
    fetch?: Promise<unknown>;
  } = {}) {
    // The shared fixture's header is a second Push button on the page.
    await act(async () => root.unmount());
    bridge.dispatch.mockImplementation((name: string) =>
      name === "repo:remotes"
        ? remotes
        : name === "remote:push"
          ? push
          : name === "remote:fetch"
            ? fetch
            : name === "remote:activities"
              ? Promise.resolve(ok([]))
              : new Promise(() => undefined)
    );
    root = createRoot(container);
    await act(async () => {
      root.render(<WorktreeHeader repo={repo} worktree={row} state={state} />);
    });
  }

  const clickPush = async (): Promise<void> => {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Push"]')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const choose = async (name: string): Promise<void> => {
    const radio = [
      ...(dialog()?.querySelectorAll<HTMLLabelElement>(".refs-destination") ?? [])
    ]
      .find((row) => row.textContent?.startsWith(name))
      ?.querySelector("input");
    await act(async () => radio?.click());
  };
  const pressIn = async (label: string): Promise<void> => {
    const button = [
      ...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    ].find((candidate) => candidate.textContent === label);
    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("asks where to publish, and pushes nothing until it is answered", async () => {
    await mount();
    await clickPush();

    expect(dialog()?.textContent).toContain(`Publish ${branch}`);
    // origin, though it is listed second.
    expect(dialog()?.textContent).toContain(
      `Pushes ${branch} to origin/${branch} and tracks it.`
    );
    expect(pushCalls()).toEqual([]);
    // Nothing is running yet, so there is nothing for a card to report.
    expect(card()).toBeNull();
  });

  it("publishes to the remote chosen, and the sync chip says where", async () => {
    await mount({ push: Promise.resolve(ok(null)) });
    await clickPush();
    await choose("upstream");
    await pressIn("Publish");

    expect(dialog()).toBeNull();
    expect(pushCalls()).toEqual([
      ["remote:push", { worktreeId: worktree.id, publish: { remote: "upstream" } }]
    ]);
    // Hung off the button that asked, as a plain push's card is. Its receipt
    // is the step list — "✓ Pushed" once main has reported a phase, which
    // jsdom never does — so where it went is the chip's to say.
    expect(card()?.textContent).toContain("Push · project");
    expect(container.querySelector(".sync-chip")?.textContent).toBe(
      "published to upstream"
    );
  });

  it("leaves without pushing or pinning anything on Cancel", async () => {
    await mount();
    await clickPush();
    await pressIn("Cancel");

    expect(dialog()).toBeNull();
    expect(pushCalls()).toEqual([]);
    expect(card()).toBeNull();
  });

  it("reads the live snapshot ahead of the indexed row", async () => {
    // The row still says unpublished; the snapshot has seen it tracked since.
    await mount({ state: snapshot({ hasUpstream: true }) });
    await clickPush();
    expect(dialog()).toBeNull();
    expect(pushCalls()).toEqual([["remote:push", { worktreeId: worktree.id }]]);
  });

  it("offers nothing to publish when the directory is gone", async () => {
    // A missing checkout reads `hasUpstream: false` as well; publishing it
    // would be an answer to the wrong question.
    await mount({ state: snapshot({ missing: true }) });
    await clickPush();
    expect(dialog()).toBeNull();
    expect(pushCalls()).toEqual([["remote:push", { worktreeId: worktree.id }]]);
  });

  it("asks the same question when Git says no upstream after all", async () => {
    // Both the row and the snapshot said tracked; Git is the authority.
    await mount({
      row: { ...unpublishedRow, tracking: "up_to_date" },
      push: Promise.resolve(
        err({
          kind: "remote",
          code: "no_upstream",
          message: `fatal: The current branch ${branch} has no upstream branch.`
        })
      )
    });
    await clickPush();
    await act(async () => {
      await Promise.resolve();
    });

    expect(dialog()).not.toBeNull();
    // The card goes rather than relaying Git's terminal advice, and the
    // question is the report — so no toast either.
    expect(card()).toBeNull();
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it("says so, and offers no Publish, when there is no remote at all", async () => {
    await mount({ remotes: Promise.resolve(ok([])) });
    await clickPush();

    expect(dialog()?.textContent).toContain("no remotes to publish to");
    const publish = [
      ...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    ].find((button) => button.textContent === "Publish");
    expect(publish?.disabled).toBe(true);
  });

  it("leaves another operation's receipt alone when the remotes cannot be read", async () => {
    // Nothing of the question's is pinned while it loads, so a card still up
    // is some earlier operation's — settling would rewrite it as this failure.
    await mount({
      fetch: Promise.resolve(ok(null)),
      remotes: Promise.resolve(
        err({ kind: "git", code: "git_failed", message: "fatal: not a git repository" })
      )
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fetch"]')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(card()?.textContent).toContain("Fetched");

    await clickPush();

    expect(card()?.textContent).toContain("Fetched");
    expect(card()?.textContent).not.toContain("Push failed");
    expect(showErrorToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Push failed",
        message: "fatal: not a git repository"
      })
    );
    expect(dialog()).toBeNull();
  });

  it("drops a question asked on an earlier visit to the same checkout", async () => {
    let answer!: (value: unknown) => void;
    await mount({ remotes: new Promise((resolve) => (answer = resolve)) });
    await clickPush();

    // Away and back before the remotes arrive: the same id, a new visit.
    const elsewhere = { ...unpublishedRow, id: "worktree-2" };
    await act(async () => {
      root.render(<WorktreeHeader repo={repo} worktree={elsewhere} state={null} />);
    });
    await act(async () => {
      root.render(
        <WorktreeHeader repo={repo} worktree={unpublishedRow} state={null} />
      );
    });
    await act(async () => {
      answer(ok([remote("origin")]));
      await Promise.resolve();
    });

    expect(dialog()).toBeNull();
  });
});
