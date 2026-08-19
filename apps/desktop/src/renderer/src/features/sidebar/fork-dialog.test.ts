import { describe, expect, it } from "vitest";
import type {
  CloneRepository,
  ForgeStatus,
  ForkPreflight
} from "@pwrgit/shared";
import {
  cliProtocolLabel,
  defaultForkTarget,
  defaultUpstream,
  forkAction,
  forkNameProblem,
  forkTargets,
  FORK_PROGRESS_LABELS,
  isValidForkName,
  needsUpstreamChoice,
  sourceEmptyMessage,
  statusFor
} from "./fork-dialog";

const source: CloneRepository = {
  name: "react",
  owner: "facebook",
  nameWithOwner: "facebook/react",
  visibility: "public",
  host: "github",
  hostname: "github.com",
  sshUrl: "git@github.com:facebook/react.git",
  httpsUrl: "https://github.com/facebook/react.git",
  localPaths: []
};

const preflight = (over: Partial<ForkPreflight> = {}): ForkPreflight => ({
  source,
  target: {
    owner: "huntharo",
    name: "react",
    nameWithOwner: "huntharo/react"
  },
  upstreamChoices: [
    { nameWithOwner: "facebook/react", url: "https://github.com/facebook/react" }
  ],
  ...over
});

const statuses: ForgeStatus[] = [
  {
    host: "github",
    installed: true,
    loggedIn: true,
    owners: [
      { login: "huntharo", kind: "user", host: "github" },
      { login: "pwr-family", kind: "organization", host: "github" },
      { login: "facebook", kind: "organization", host: "github" }
    ]
  },
  { host: "gitlab", installed: false, loggedIn: false, owners: [] }
];

describe("forkAction", () => {
  it("forks when there is nothing in the way", () => {
    expect(forkAction(preflight())).toEqual({
      kind: "fork",
      label: "Fork & clone"
    });
  });

  it("clones an existing fork instead of forking again", () => {
    // Both forges return the existing repository rather than erroring, so the
    // button says what will actually happen.
    const action = forkAction(
      preflight({ existing: { ...source, nameWithOwner: "huntharo/react" } })
    );
    expect(action).toEqual({ kind: "clone_existing", label: "Clone your fork" });
  });

  it("reveals an existing fork that is already checked out", () => {
    const action = forkAction(
      preflight({
        existing: {
          ...source,
          nameWithOwner: "huntharo/react",
          localPaths: ["/repos/react"]
        }
      })
    );
    expect(action).toEqual({
      kind: "reveal_existing",
      label: "Reveal checkout",
      path: "/repos/react"
    });
  });

  it("blocks with the forge's reason, and blocking beats an existing fork", () => {
    const action = forkAction(
      preflight({
        existing: { ...source, nameWithOwner: "huntharo/react" },
        blocked: { code: "self_owned", message: "You already own it." }
      })
    );
    expect(action).toEqual({
      kind: "blocked",
      label: "Fork & clone",
      message: "You already own it."
    });
  });

  it("defaults to forking before a preflight has answered", () => {
    expect(forkAction(null).kind).toBe("fork");
  });
});

describe("forkTargets", () => {
  it("drops the source's own owner — no forge forks into itself", () => {
    expect(forkTargets(statuses, source).map((o) => o.login)).toEqual([
      "huntharo",
      "pwr-family"
    ]);
  });

  it("offers the forge the source is on, not whichever is first", () => {
    const gitlabSource: CloneRepository = {
      ...source,
      host: "gitlab",
      hostname: "gitlab.com"
    };
    expect(forkTargets(statuses, gitlabSource)).toEqual([]);
  });

  it("prefers the personal account as the default target", () => {
    expect(defaultForkTarget(forkTargets(statuses, source))?.login).toBe(
      "huntharo"
    );
    // With no personal account listed, the first organization stands in.
    expect(
      defaultForkTarget([
        { login: "pwr-family", kind: "organization", host: "github" }
      ])?.login
    ).toBe("pwr-family");
    expect(defaultForkTarget([])).toBeNull();
  });
});

describe("fork names", () => {
  it.each(["react", "react-fork", "react.js", "a_b", "x"])(
    "accepts %s",
    (name) => expect(isValidForkName(name)).toBe(true)
  );

  it.each(["", "a/b", "-leading", ".hidden", "has space", "a".repeat(101)])(
    "rejects %s",
    (name) => expect(isValidForkName(name)).toBe(false)
  );

  it("explains the problem rather than just disabling the button", () => {
    expect(forkNameProblem("", null)).toBe("Give the fork a name.");
    expect(forkNameProblem("a/b", null)).toBe(
      "Use letters, numbers, dots, dashes and underscores."
    );
    expect(forkNameProblem("react", null)).toBeNull();
  });

  it("surfaces a name collision the forge already reported", () => {
    expect(
      forkNameProblem(
        "react",
        preflight({
          blocked: {
            code: "forking_disabled",
            message: "huntharo/react already exists and is not a fork."
          }
        })
      )
    ).toBe("huntharo/react already exists and is not a fork.");
  });
});

describe("upstream choice", () => {
  it("does not ask when there is only one candidate", () => {
    // A source that is not a fork has exactly one — asking would be a question
    // with one answer.
    expect(needsUpstreamChoice(preflight())).toBe(false);
    expect(needsUpstreamChoice(null)).toBe(false);
  });

  it("asks when the source is itself a fork", () => {
    const p = preflight({
      upstreamChoices: [
        { nameWithOwner: "facebook/react", url: "" },
        { nameWithOwner: "gaearon/react", url: "" }
      ]
    });
    expect(needsUpstreamChoice(p)).toBe(true);
    // The root leads: rebasing on the original is what forking a fork means.
    expect(defaultUpstream(p)).toBe("facebook/react");
  });
});

describe("forge labelling", () => {
  it("names the CLI the active forge actually uses", () => {
    expect(cliProtocolLabel("github").label).toBe("GitHub CLI");
    expect(cliProtocolLabel("gitlab").label).toBe("GitLab CLI");
    expect(cliProtocolLabel("gitlab").detail("acme/api")).toBe(
      "glab repo clone acme/api"
    );
  });

  it("stands in a not-installed status rather than returning undefined", () => {
    expect(statusFor([], "gitlab")).toEqual({
      host: "gitlab",
      installed: false,
      loggedIn: false,
      owners: []
    });
  });
});

describe("progress labels", () => {
  it("names every phase, including the two with no percentage", () => {
    // A phase with no label renders as `undefined` in the button; the two
    // forge-side steps are exactly the ones with no bar to fall back on.
    for (const phase of [
      "starting",
      "creating",
      "awaiting_fork",
      "counting",
      "compressing",
      "receiving",
      "resolving",
      "checking_out",
      "adding_upstream",
      "indexing"
    ] as const) {
      expect(FORK_PROGRESS_LABELS[phase]).toBeTruthy();
    }
  });
});

describe("sourceEmptyMessage", () => {
  const signedIn = statuses[0]!;
  const notInstalled = statuses[1]!;
  const base = {
    catalogError: null,
    status: signedIn,
    cliLabel: "GitHub CLI",
    query: "react"
  };

  it("says it is loading while the catalog is still in flight", () => {
    // Regression: this state was reported as "Install the GitHub CLI to
    // search." on a machine with gh installed and signed in — the dialog
    // spends its first seconds here, so it was the first thing users saw.
    expect(sourceEmptyMessage({ ...base, catalogLoaded: false })).toBe(
      "Loading repositories…"
    );
    expect(
      sourceEmptyMessage({ ...base, catalogLoaded: false, status: notInstalled })
    ).toBe("Loading repositories…");
  });

  it("only blames the CLI once the catalog has actually answered", () => {
    expect(
      sourceEmptyMessage({ ...base, catalogLoaded: true, status: notInstalled })
    ).toBe("Install the GitHub CLI to search.");
    expect(
      sourceEmptyMessage({
        ...base,
        catalogLoaded: true,
        status: { ...signedIn, loggedIn: false }
      })
    ).toBe("Sign in with the GitHub CLI to search.");
  });

  it("reports a real catalog error ahead of everything else", () => {
    expect(
      sourceEmptyMessage({
        ...base,
        catalogLoaded: false,
        catalogError: "gh exploded"
      })
    ).toBe("gh exploded");
  });

  it("falls through to no-matches when everything is fine", () => {
    expect(sourceEmptyMessage({ ...base, catalogLoaded: true })).toBe(
      "No repositories match \u201Creact\u201D."
    );
  });
});
