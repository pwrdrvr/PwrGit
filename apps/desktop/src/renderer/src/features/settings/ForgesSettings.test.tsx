// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  forgeProduct,
  ok,
  type ForgeHostRow,
  type ForgeStatus
} from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));

import { ForgesSettings } from "./ForgesSettings";
import { __resetCollapsedPanesForTests } from "./SettingsLayout";

/**
 * A status shaped the way main's probe shapes one.
 *
 * `hosts` is derived from the same two values the summary is, because the pane
 * reads it: a fixture that set `loggedIn` without a matching host would exercise
 * a state main cannot produce, and a missing CLI probes nothing at all.
 */
function forge(overrides: Partial<ForgeStatus> = {}): ForgeStatus {
  const kind = overrides.kind ?? "github";
  const installed = overrides.installed ?? true;
  const loggedIn = overrides.loggedIn ?? true;
  const product = forgeProduct(kind);
  return {
    kind,
    cli: product.cli,
    installed,
    loggedIn,
    capabilities: {
      batchedBranchLookup: true,
      batchedCommitAssociation: true,
      changeSizeAndTimeline: true,
      commitAuthorIdentity: true,
      forkDefaultBranchOnly: true
    },
    hosts: installed
      ? [{ host: product.saasHost, enabled: true, loggedIn }]
      : [],
    ...overrides
  };
}

let container: HTMLDivElement;
let root: Root;
let listener: ((payload: { forges: ForgeStatus[] }) => void) | undefined;
const unsubscribe = vi.fn();
/** What `forge:hosts` answers. Empty unless a test is about the rows — this
 *  file is about what a PRODUCT reports; `ForgeHosts.test.tsx` owns the rows. */
let rows: ForgeHostRow[];

beforeEach(() => {
  // This pane's real id is `forges`, and collapse state is module-level —
  // so without this a folded section survives into the next test.
  __resetCollapsedPanesForTests();
  vi.clearAllMocks();
  listener = undefined;
  rows = [];
  mocks.subscribe.mockImplementation((_channel: string, cb: typeof listener) => {
    listener = cb;
    return unsubscribe;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Answer each channel separately. A blanket `mockResolvedValue` cannot: the
 *  pane reads the host list and the status probe, and a failure injected for
 *  one would arrive on both. */
function respond(handlers: {
  status?: () => unknown;
  hosts?: () => unknown;
}): void {
  mocks.dispatch.mockImplementation(async (channel: string) => {
    if (channel === "forge:hosts") {
      return handlers.hosts?.() ?? ok({ hosts: rows });
    }
    if (channel === "forge:status") {
      return handlers.status?.() ?? ok({ forges: [] });
    }
    throw new Error(`unexpected channel: ${channel}`);
  });
}

/** Every `forge:status` call the pane made — the reads this file counts, with
 *  the host read that accompanies each mount left out of the tally. */
function statusCalls(): unknown[][] {
  return mocks.dispatch.mock.calls.filter((call) => call[0] === "forge:status");
}

async function render(forges: ForgeStatus[]): Promise<void> {
  respond({ status: () => ok({ forges }) });
  await act(async () => {
    root.render(<ForgesSettings saving={false} />);
  });
}

describe("ForgesSettings", () => {
  it("reads status from main rather than probing a forge itself", async () => {
    await render([forge()]);

    expect(mocks.dispatch).toHaveBeenCalledWith("forge:status", undefined);
    // Two reads, both over the bus, and nothing that reaches a vendor API.
    expect(
      new Set(mocks.dispatch.mock.calls.map((call) => call[0]))
    ).toEqual(new Set(["forge:hosts", "forge:status"]));
    expect(statusCalls()).toHaveLength(1);
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Connected");
  });

  it("replaces an initial failure with useful retry UI and recovers", async () => {
    respond({
      status: () =>
        err({
          kind: "unknown",
          code: "probe_failed",
          message: "The local service did not answer."
        })
    });
    await act(async () => root.render(<ForgesSettings saving={false} />));

    const alert = container.querySelector<HTMLElement>("[role='alert']");
    expect(alert?.textContent).toContain("Forge connections couldn’t be checked");
    expect(alert?.textContent).toContain("The local service did not answer.");
    expect(container.textContent).not.toContain("Checking…");

    respond({ status: () => ok({ forges: [forge()] }) });
    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(container.textContent).toContain("Connected");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("names the command that unblocks a signed-out forge", async () => {
    await render([forge({ kind: "gitlab", cli: "glab", loggedIn: false })]);

    expect(container.textContent).toContain("Signed out");
    expect(container.textContent).toContain("glab auth login");
  });

  it("reports a self-managed host as connected, and names it", async () => {
    // The complaint that started this: gitlab.com is signed out, but the
    // instance the user actually works on is not. A summary that probed only
    // gitlab.com said "Signed out" directly below a Hosts row reading
    // "signed in as huntharo".
    await render([
      forge({
        kind: "gitlab",
        loggedIn: true,
        hosts: [
          { host: "gitlab.com", enabled: true, loggedIn: false },
          { host: "gitlab.example.com", enabled: true, loggedIn: true }
        ]
      })
    ]);

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("gitlab.example.com");
    // It may not claim to be reading a host that answered with no credential.
    expect(container.textContent).not.toContain("from gitlab.com");
    expect(container.textContent).not.toContain("auth login");
  });

  it("reads a forge whose every host is switched off as off, not signed out", async () => {
    await render([
      forge({
        kind: "gitlab",
        loggedIn: false,
        hosts: [{ host: "gitlab.example.com", enabled: false, loggedIn: false }]
      })
    ]);

    expect(container.textContent).toContain("Off");
    expect(container.textContent).toContain("switched off");
    // Sending someone to a terminal cannot fix a switch, and they are already
    // signed in to the host they turned off.
    expect(container.textContent).not.toContain("Signed out");
    expect(container.textContent).not.toContain("auth login");
    // A deliberate choice is not a warning — anywhere on the pane. Scoping this
    // to `.settings-field` hid the section header, which was still amber.
    expect(container.querySelector(".settings-card__chip--warn")).toBeNull();
    // The product's own chip, in its own section header — there is no longer an
    // aggregate one to summarize both products into a single "All off".
    expect(
      container
        .querySelector("section[aria-label='GitLab'] .settings-card__chip")
        ?.textContent
    ).toBe("Off");
  });

  it("puts the instance in the sign-in command when one self-managed host is waiting", async () => {
    // `glab auth login` signs in to gitlab.com, which is not the instance this
    // user is missing.
    await render([
      forge({
        kind: "gitlab",
        loggedIn: false,
        hosts: [{ host: "gitlab.example.com", enabled: true, loggedIn: false }]
      })
    ]);

    expect(container.textContent).toContain(
      "glab auth login --hostname gitlab.example.com"
    );
  });

  it("ignores a disabled host when wording the sign-in command", async () => {
    // Two hosts, but only one the user allows — naming the disabled one would
    // send them to sign in to something they have switched off.
    await render([
      forge({
        kind: "gitlab",
        loggedIn: false,
        hosts: [
          { host: "gitlab.example.com", enabled: true, loggedIn: false },
          { host: "gitlab.internal", enabled: false, loggedIn: false }
        ]
      })
    ]);

    expect(container.textContent).toContain(
      "glab auth login --hostname gitlab.example.com"
    );
    expect(container.textContent).not.toContain("gitlab.internal");
  });

  it("tells the user to install a missing CLI instead of blaming the login", async () => {
    await render([forge({ kind: "gitlab", cli: "glab", installed: false, loggedIn: false })]);

    expect(container.textContent).toContain("Not installed");
    expect(container.textContent).toContain("Install the GitLab CLI");
    expect(container.textContent).not.toContain("auth login");
    // Not in the sub-line either: a missing CLI reports no hosts, which used to
    // fall through to "No host is signed in…" beside the "Not installed" chip.
    expect(container.textContent).not.toContain("No host is signed in");
  });

  it("does not claim to read a host it cannot name", async () => {
    // Connected through the CLI's own default host: that host has no row in
    // Hosts, so main does not report it. Saying "no host is signed in" next to a
    // "Connected" chip would be the row contradicting itself.
    await render([forge({ loggedIn: true, hosts: [] })]);

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toContain("No host is signed in");
  });

  it("keeps the chip colour and the chip label describing the same state", async () => {
    // `tone()` used to read `loggedIn` while the label read the state, so this
    // pair rendered "Not installed" in a green pill.
    await render([forge({ installed: false, loggedIn: true })]);

    expect(container.textContent).toContain("Not installed");
    // Anywhere on the pane, not just in a field: the chip now lives in the
    // section header, where scoping the old query would have missed it.
    expect(container.querySelector(".settings-card__chip--ok")).toBeNull();
  });

  it("names a waiting host when the bare command would sign in elsewhere", async () => {
    // Two Enterprise hosts waiting and gitlab.com switched off: `glab auth
    // login` authenticates gitlab.com, the one host the user cannot use.
    await render([
      forge({
        kind: "gitlab",
        loggedIn: false,
        hosts: [
          { host: "gitlab.com", enabled: false, loggedIn: false },
          { host: "gitlab.a.example", enabled: true, loggedIn: false },
          { host: "gitlab.b.example", enabled: true, loggedIn: false }
        ]
      })
    ]);

    expect(container.textContent).toContain(
      "glab auth login --hostname gitlab.a.example"
    );
  });

  it("states an unsupported capability as a limit of that forge", async () => {
    await render([
      forge({
        kind: "gitlab",
        cli: "glab",
        capabilities: {
          batchedBranchLookup: true,
          batchedCommitAssociation: false,
          changeSizeAndTimeline: true,
          commitAuthorIdentity: true,
          forkDefaultBranchOnly: false
        }
      })
    ]);

    // So a missing feature reads as a known limit, not as a bug in PwrGit.
    expect(container.textContent).toContain("Not supported by this forge");
    expect(container.textContent).toContain("commit links in bulk");
  });

  it("repaints when main pushes a change, without being asked again", async () => {
    await render([forge({ loggedIn: false })]);
    expect(container.textContent).toContain("Signed out");

    await act(async () => {
      listener?.({ forges: [forge({ loggedIn: true })] });
    });

    expect(container.textContent).toContain("Connected");
    // Signing in from a terminal must not require a second request.
    expect(statusCalls()).toHaveLength(1);
  });

  it("lets a pushed success win over a slower failed read", async () => {
    let settle: ((value: unknown) => void) | undefined;
    const hanging = new Promise((resolve) => {
      settle = resolve;
    });
    respond({ status: () => hanging });
    await act(async () => {
      root.render(<ForgesSettings saving={false} />);
    });

    // The push lands first, then the stale read resolves.
    await act(async () => {
      listener?.({ forges: [forge({ loggedIn: true })] });
    });
    await act(async () => {
      settle?.(
        err({
          kind: "unknown",
          code: "probe_failed",
          message: "Stale failure"
        })
      );
    });

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toContain("Stale failure");
  });

  it("keeps asking while open, so a terminal sign-in can reach the pane", async () => {
    // Main never probes on its own: `forge:statusChanged` only has something to
    // announce because somebody asked again. Without this tick the pane would
    // sit on "Signed out" forever while the user ran `gh auth login`.
    vi.useFakeTimers();
    try {
      await render([forge({ loggedIn: false })]);
      expect(statusCalls()).toHaveLength(1);

      respond({ status: () => ok({ forges: [forge({ loggedIn: true })] }) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(statusCalls().length).toBeGreaterThan(1);
      expect(container.textContent).toContain("Connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking once the pane closes", async () => {
    vi.useFakeTimers();
    try {
      await render([forge()]);
      act(() => root.unmount());
      root = createRoot(container);
      const afterUnmount = mocks.dispatch.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(mocks.dispatch.mock.calls.length).toBe(afterUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribes on unmount", async () => {
    await render([forge()]);
    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalled();
    root = createRoot(container);
  });
});

describe("GitCafe settings", () => {
  it("shows the Bun installation and minimum CLI version remedy", async () => {
    await render([forge({ kind: "gitcafe", installed: false, loggedIn: false })]);
    expect(container.textContent).toContain("GitCafe");
    expect(container.textContent).toContain("bun i -g @gitcafe/cli");
    expect(container.textContent).toContain("0.5.0");
    expect(container.querySelector('[aria-label="GitCafe: Not installed"]')).not.toBeNull();
  });
  it("uses GitCafe's host syntax when signed out of an added host", async () => {
    await render([forge({ kind: "gitcafe", loggedIn: false, hosts: [{ host: "cafe.example", enabled: true, loggedIn: false }] })]);
    expect(container.textContent).toContain("cafe auth login --host https://cafe.example/api");
    expect(container.textContent).not.toContain("--hostname");
  });
  it("shows Connected and Off with the integration's actual capabilities", async () => {
    await render([forge({ kind: "gitcafe", capabilities: forgeProduct("gitcafe").capabilities })]);
    expect(container.querySelector('[aria-label="GitCafe: Connected"]')).not.toBeNull();
    expect(container.textContent).toContain("Not supported");
    await act(async () => listener?.({ forges: [forge({ kind: "gitcafe", loggedIn: false, hosts: [{ host: "git.cafe", enabled: false, loggedIn: false }] })] }));
    expect(container.querySelector('[aria-label="GitCafe: Off"]')).not.toBeNull();
  });
});
