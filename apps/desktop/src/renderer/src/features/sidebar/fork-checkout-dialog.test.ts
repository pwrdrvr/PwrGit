import { describe, expect, it } from "vitest";
import type { CloneRepository, ForkCheckoutPreflight } from "@pwrgit/shared";
import {
  forkCheckoutAction,
  forkCheckoutLead,
  remoteChanges,
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
      preflight: preflight({ protocol: "https" }),
      target: "huntharo/dugite",
      upstream: null
    });
    expect(rows[0]?.url).toBe("https://github.com/huntharo/dugite.git");
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
