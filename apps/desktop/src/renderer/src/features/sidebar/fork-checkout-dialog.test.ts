import { describe, expect, it } from "vitest";
import type { CloneRepository, ForkCheckoutPreflight } from "@pwrgit/shared";
import {
  forkCheckoutAction,
  forkInPlaceAction,
  forkCheckoutLead,
  forkPlanRoutes,
  originForkOffer,
  remoteChanges,
  routeBranch,
  upstreamAnswerIsCurrent
} from "./fork-checkout-dialog";

const source: CloneRepository = {
  name: "dugite",
  owner: "desktop",
  nameWithOwner: "desktop/dugite",
  visibility: "public",
  host: "github",
  hostname: "github.com",
  sshUrl: "git@github.com:desktop/dugite.git",
  httpsUrl: "https://github.com/desktop/dugite.git",
  viewerCanPush: false,
  localPaths: []
};

const preflight = (
  over: Partial<ForkCheckoutPreflight> = {}
): ForkCheckoutPreflight => ({
  fork: {
    source,
    target: {
      owner: "huntharo",
      name: "dugite",
      nameWithOwner: "huntharo/dugite"
    },
    upstreamChoices: [
      { nameWithOwner: "desktop/dugite", url: "https://github.com/desktop/dugite" }
    ]
  },
  origin: {
    url: "git@github.com:desktop/dugite.git",
    nameWithOwner: "desktop/dugite"
  },
  protocol: "ssh",
  upstreamRemote: { name: "upstream", existing: false },
  upstreamFor: "desktop/dugite",
  ...over
});

describe("forkInPlaceAction", () => {
  it("says Fork in place where the alternative on screen is Fork & clone", () => {
    expect(forkInPlaceAction(preflight())).toEqual({
      kind: "fork",
      label: "Fork in place"
    });
    expect(forkInPlaceAction(null).label).toBe("Fork in place");
  });

  it("adopts an existing fork in the header dialog's words", () => {
    const existing = preflight();
    existing.fork.existing = { ...source, nameWithOwner: "huntharo/dugite" };
    expect(forkInPlaceAction(existing)).toEqual({
      kind: "adopt",
      label: "Switch origin to my fork"
    });
  });
});

describe("forkCheckoutAction", () => {
  it("offers to fork when there is nothing there yet", () => {
    expect(forkCheckoutAction(preflight())).toEqual({
      kind: "fork",
      label: "Fork & switch origin"
    });
  });

  it("stops promising to create something that already exists", () => {
    const existing = preflight();
    existing.fork.existing = { ...source, nameWithOwner: "huntharo/dugite" };
    expect(forkCheckoutAction(existing)).toEqual({
      kind: "adopt",
      label: "Switch origin to my fork"
    });
  });

  it("carries the forge's own reason when forking is blocked", () => {
    const blocked = preflight();
    blocked.fork.blocked = {
      code: "self_owned",
      message: "GitHub does not fork a repository into the account that owns it."
    };
    expect(forkCheckoutAction(blocked)).toMatchObject({
      kind: "blocked",
      message: expect.stringContaining("does not fork")
    });
  });

  it("says fork before the preflight has answered, not blocked", () => {
    // The label is on screen from the first paint; guessing `blocked` there
    // would report a refusal nobody made.
    expect(forkCheckoutAction(null).kind).toBe("fork");
  });
});

describe("remoteChanges", () => {
  it("puts origin first and writes both URLs in origin's protocol", () => {
    expect(
      remoteChanges({
        preflight: preflight(),
        target: "huntharo/dugite",
        upstream: "desktop/dugite"
      })
    ).toEqual([
      {
        remote: "origin",
        nameWithOwner: "huntharo/dugite",
        url: "git@github.com:huntharo/dugite.git",
        note: "your fork — where pushes go",
        unchanged: false
      },
      {
        remote: "upstream",
        nameWithOwner: "desktop/dugite",
        url: "git@github.com:desktop/dugite.git",
        note: "the original — fetch and rebase on it",
        unchanged: false
      }
    ]);
  });

  it("follows an HTTPS checkout into HTTPS", () => {
    const rows = remoteChanges({
      preflight: preflight({
        protocol: "https",
        origin: {
          url: "https://github.com/desktop/dugite.git",
          nameWithOwner: "desktop/dugite"
        }
      }),
      target: "huntharo/dugite",
      upstream: null
    });
    expect(rows[0]?.url).toBe("https://github.com/huntharo/dugite.git");
  });

  it("keeps the port the checkout is actually reached on", () => {
    // The list is a promise about what the rewire will write, and main writes
    // the fork URL in the shape of the remote it replaces. A preview composed
    // from protocol + hostname would show a URL without the port — the one
    // difference that decides whether the remote works.
    const rows = remoteChanges({
      preflight: preflight({
        origin: {
          url: "ssh://git@git.corp.example:2222/acme/widget-core.git",
          nameWithOwner: "acme/widget-core"
        }
      }),
      target: "octo-dev/widget-core",
      upstream: "acme/widget-core"
    });
    expect(rows.map((row) => row.url)).toEqual([
      "ssh://git@git.corp.example:2222/octo-dev/widget-core.git",
      "ssh://git@git.corp.example:2222/acme/widget-core.git"
    ]);
  });

  it("says a remote that already points there is left alone", () => {
    const rows = remoteChanges({
      preflight: preflight({
        upstreamRemote: { name: "original", existing: true }
      }),
      target: "huntharo/dugite",
      upstream: "desktop/dugite"
    });
    expect(rows[1]).toMatchObject({
      remote: "original",
      unchanged: true,
      note: "already points there — left alone"
    });
  });

  it("lists only origin when the user declined a remote for the original", () => {
    const rows = remoteChanges({
      preflight: preflight(),
      target: "huntharo/dugite",
      upstream: null
    });
    expect(rows).toHaveLength(1);
  });
});

describe("upstreamAnswerIsCurrent", () => {
  it("holds the list back while the answer is about another repository", () => {
    // Printing a remote name answered about a different repository would
    // describe a remote the rewire is not going to make.
    expect(
      upstreamAnswerIsCurrent(preflight(), "gaearon/dugite")
    ).toBe(false);
    expect(upstreamAnswerIsCurrent(preflight(), "desktop/dugite")).toBe(true);
  });

  it("needs no answer when no remote is being added", () => {
    expect(upstreamAnswerIsCurrent(preflight(), null)).toBe(true);
  });

  it("draws nothing before the preflight has landed", () => {
    expect(upstreamAnswerIsCurrent(null, null)).toBe(false);
  });
});

describe("forkCheckoutLead", () => {
  it("leads with the refusal when the forge has stated one", () => {
    expect(forkCheckoutLead(preflight())).toContain(
      "You can't push to desktop/dugite"
    );
  });

  it("does not claim a refusal nobody made", () => {
    const unknown = preflight();
    unknown.fork.source = { ...source };
    delete unknown.fork.source.viewerCanPush;
    expect(forkCheckoutLead(unknown)).toBe(
      "Fork desktop/dugite and point this checkout at your own copy."
    );
  });
});

describe("originForkOffer", () => {
  const url = "git@github.com:tzarebczan/diskhound.git";
  const identity = {
    nameWithOwner: "tzarebczan/diskhound"
  };

  it("offers the fork before the forge has answered, from origin's own URL", () => {
    // The diskhound report: no identity row, and the origin row showed Fetch
    // and nothing else.
    expect(originForkOffer(url, undefined, {})).toEqual({
      nameWithOwner: "tzarebczan/diskhound",
      urgent: false
    });
  });

  it("is urgent only once the forge says you cannot push", () => {
    expect(
      originForkOffer(url, { ...identity, viewerCanPush: false }, {})
    ).toEqual({ nameWithOwner: "tzarebczan/diskhound", urgent: true });
    expect(
      originForkOffer(url, { ...identity, viewerCanPush: true }, {})
    ).toEqual({ nameWithOwner: "tzarebczan/diskhound", urgent: false });
  });

  it("stays quiet on an origin that is already your fork", () => {
    expect(
      originForkOffer(
        url,
        {
          ...identity,
          viewerCanPush: true,
          parent: { nameWithOwner: "upstream/diskhound", url: "" }
        },
        {}
      )
    ).toBeNull();
  });

  it("stays quiet on an origin no forge claims", () => {
    expect(originForkOffer("/Volumes/nas/diskhound.git", undefined, {})).toBeNull();
    expect(
      originForkOffer("git@git.corp.example:team/app.git", undefined, {})
    ).toBeNull();
  });
});

describe("routeBranch", () => {
  it("draws a branch that follows a remote, and nothing for one that doesn't", () => {
    expect(routeBranch({ branch: "main", tracking: "up_to_date" })).toBe("main");
    expect(routeBranch({ branch: "main" })).toBe("main");
    expect(routeBranch({ branch: "fix", tracking: "unpublished" })).toBeNull();
    expect(routeBranch({ branch: "fix", tracking: "upstream_missing" })).toBeNull();
    expect(routeBranch({ branch: "main", tracking: "behind", missing: true })).toBeNull();
    expect(routeBranch(undefined)).toBeNull();
  });
});

describe("forkPlanRoutes", () => {
  const routes = (over: Partial<Parameters<typeof forkPlanRoutes>[0]> = {}) =>
    forkPlanRoutes({
      preflight: preflight(),
      branch: "main",
      target: "huntharo/dugite",
      upstream: "desktop/dugite",
      ...over
    });

  it("draws origin moving to the fork, with the refused push only when the forge said so", () => {
    const { now, after } = routes();
    expect(now.original).toEqual({ role: "The original", slug: "desktop/dugite", remote: "origin", perm: "no" });
    expect(now.toOriginal).toEqual([{ verb: "push", tone: "bad" }, { verb: "pull", tone: "plain" }]);
    expect(now.fork).toMatchObject({ slug: "huntharo/dugite", pending: "will be created", state: "unused" });
    expect(after.original).toEqual({ role: "The original", slug: "desktop/dugite", remote: "upstream", remoteMoved: true });
    expect(after.fork).toMatchObject({ remote: "origin", remoteMoved: true, perm: "yes", state: "chosen" });
    expect(after.toOriginal).toEqual([{ verb: "sync", tone: "ghost" }]);
    expect(after.caption).toBe("main keeps following origin, and origin moves to your fork");

    const open = forkPlanRoutes({
      preflight: preflight({ fork: { ...preflight().fork, source: { ...source, viewerCanPush: true } } }),
      branch: "main", target: "huntharo/dugite", upstream: "desktop/dugite"
    });
    expect(open.now.original).not.toHaveProperty("perm");
    expect(open.now.toOriginal[0]).toEqual({ verb: "push", tone: "plain" });
  });

  it("keeps no original once the user declines one", () => {
    const { after } = routes({ upstream: null });
    expect(after.original).toEqual({ role: "The original", slug: "desktop/dugite", pending: "no remote", state: "unused" });
    expect(after.toOriginal).toEqual([]);
    expect(after.label).toBe("After: main pulls from and pushes to huntharo/dugite.");
  });

  it("names an adopted fork as already there, and an existing upstream as unmoved", () => {
    const { now, after } = routes({
      preflight: preflight({
        fork: { ...preflight().fork, existing: { ...source, owner: "huntharo", nameWithOwner: "huntharo/dugite" } },
        upstreamRemote: { name: "upstream", existing: true }
      })
    });
    expect(now.fork.pending).toBe("on GitHub");
    expect(after.original.remoteMoved).toBe(false);
  });

  it("tells a fork-of-a-fork's origin apart from the root it keeps as upstream", () => {
    const { now, after } = routes({
      preflight: preflight({ origin: { url: "git@github.com:alice/dugite.git", nameWithOwner: "alice/dugite" } })
    });
    expect(now.original).toMatchObject({ role: "Origin today", slug: "alice/dugite" });
    expect(after.original).toMatchObject({ role: "The original", slug: "desktop/dugite" });
  });
});
