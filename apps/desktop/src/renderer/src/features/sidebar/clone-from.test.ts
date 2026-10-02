import { describe, expect, it } from "vitest";
import type { CloneRepository, ForgeOwner, ForkPreflight } from "@pwrgit/shared";
import {
  canPushOriginal,
  cloneFromDefault,
  forkCardDetail,
  forkCardPill,
  forkCardState,
  forkOriginRepository,
  offersCloneFrom,
  originalCardDetail
} from "./clone-from";

const source: CloneRepository = {
  name: "sparkline",
  owner: "octo-labs",
  nameWithOwner: "octo-labs/sparkline",
  visibility: "public",
  host: "github",
  hostname: "github.com",
  viewerCanPush: false,
  sshUrl: "git@github.com:octo-labs/sparkline.git",
  httpsUrl: "https://github.com/octo-labs/sparkline.git",
  localPaths: []
};

const fork: CloneRepository = {
  ...source,
  owner: "riverbend",
  nameWithOwner: "riverbend/sparkline",
  viewerCanPush: true,
  sshUrl: "git@github.com:riverbend/sparkline.git",
  httpsUrl: "https://github.com/riverbend/sparkline"
};

const owners: ForgeOwner[] = [
  { login: "riverbend", kind: "user", host: "github" },
  { login: "lumen-co", kind: "organization", host: "github" }
];

const preflight = (extra: Partial<ForkPreflight> = {}): ForkPreflight => ({
  source,
  target: { owner: "riverbend", name: "sparkline", nameWithOwner: "riverbend/sparkline" },
  upstreamChoices: [
    { nameWithOwner: "octo-labs/sparkline", url: "https://github.com/octo-labs/sparkline" }
  ],
  ...extra
});

const state = (p: ForkPreflight | null, targets: ForgeOwner[] | null = owners) =>
  forkCardState({ preflight: p, checkError: null, targets, cliLabel: "GitHub CLI" });

describe("forkCardState", () => {
  it("is checking until the forge answers", () => {
    expect(state(null)).toEqual({ kind: "checking" });
  });

  it("reads create, exists and checked out off the preflight", () => {
    expect(state(preflight())).toEqual({ kind: "create" });
    expect(state(preflight({ existing: fork }))).toEqual({ kind: "exists" });
    expect(
      state(preflight({ existing: { ...fork, localPaths: ["/src/sparkline"] } }))
    ).toEqual({ kind: "checked_out", path: "/src/sparkline" });
  });

  it("is unavailable with the forge's own sentence when blocked", () => {
    const blocked = preflight({
      blocked: { code: "forking_disabled", message: "riverbend/sparkline already exists and is not a fork." }
    });
    expect(state(blocked)).toEqual({
      kind: "unavailable",
      message: "riverbend/sparkline already exists and is not a fork."
    });
  });

  it("is unavailable with no account to fork into, before the forge answers", () => {
    expect(state(null, [])).toEqual({
      kind: "unavailable",
      message: "Sign in with the GitHub CLI to fork from here."
    });
  });

  it("prefers a failed lookup over everything else", () => {
    expect(
      forkCardState({ preflight: null, checkError: "Couldn't find it.", targets: null, cliLabel: "GitHub CLI" })
    ).toEqual({ kind: "unavailable", message: "Couldn't find it." });
  });
});

describe("offersCloneFrom", () => {
  it("offers the pair for a forge repository someone else owns", () => {
    expect(offersCloneFrom({ source, owners, preflight: null })).toBe(true);
  });

  it("waits for the accounts, so the pair never appears and then vanishes", () => {
    expect(offersCloneFrom({ source, owners: null, preflight: null })).toBe(false);
  });

  it("skips a repository the signed-in user owns", () => {
    expect(
      offersCloneFrom({
        source: { ...source, owner: "RiverBend", nameWithOwner: "RiverBend/sparkline" },
        owners,
        preflight: null
      })
    ).toBe(false);
  });

  it("does not skip a repository in one of the user's orgs", () => {
    expect(
      offersCloneFrom({
        source: { ...source, owner: "lumen-co", nameWithOwner: "lumen-co/sparkline" },
        owners,
        preflight: null
      })
    ).toBe(true);
  });

  it("skips local paths and unclaimed hosts", () => {
    expect(
      offersCloneFrom({ source: { ...source, localPath: "/src/x" }, owners, preflight: null })
    ).toBe(false);
    expect(
      offersCloneFrom({ source: { ...source, host: "other" }, owners, preflight: null })
    ).toBe(false);
  });

  it("skips what the forge itself says is yours", () => {
    expect(
      offersCloneFrom({
        source,
        owners,
        preflight: preflight({ blocked: { code: "self_owned", message: "yours" } })
      })
    ).toBe(false);
  });
});

describe("cloneFromDefault", () => {
  it("defaults to your fork only when you can't push and the fork already exists", () => {
    expect(cloneFromDefault(false, { kind: "exists" })).toBe("fork");
    expect(cloneFromDefault(false, { kind: "checked_out", path: "/x" })).toBe("fork");
  });

  it("never defaults to creating a repository", () => {
    expect(cloneFromDefault(false, { kind: "create" })).toBe("original");
    expect(cloneFromDefault(false, { kind: "checking" })).toBe("original");
  });

  it("keeps the original for collaborators and unknown push answers", () => {
    expect(cloneFromDefault(true, { kind: "exists" })).toBe("original");
    expect(cloneFromDefault(undefined, { kind: "exists" })).toBe("original");
  });
});

describe("canPushOriginal", () => {
  it("prefers what preflight just read over the search row", () => {
    const row: CloneRepository = { ...source };
    delete row.viewerCanPush;
    expect(canPushOriginal(row, null)).toBeUndefined();
    expect(canPushOriginal(row, preflight())).toBe(false);
  });
});

describe("forkOriginRepository", () => {
  it("uses the existing fork's own URLs", () => {
    expect(forkOriginRepository(preflight({ existing: fork }))).toBe(fork);
  });

  it("builds a fork that does not exist yet on the source's instance", () => {
    const enterprise = preflight({
      source: { ...source, hostname: "git.example.test" }
    });
    expect(forkOriginRepository(enterprise)).toMatchObject({
      name: "sparkline",
      nameWithOwner: "riverbend/sparkline",
      hostname: "git.example.test",
      sshUrl: "git@git.example.test:riverbend/sparkline.git",
      httpsUrl: "https://git.example.test/riverbend/sparkline.git",
      localPaths: []
    });
  });
});

describe("card copy", () => {
  it("names the forge and the upstream", () => {
    expect(forkCardPill({ kind: "exists" }, "github").label).toBe("on GitHub");
    expect(forkCardDetail({ kind: "create" }, "github", "octo-labs/sparkline")).toBe(
      "Created on GitHub first. octo-labs/sparkline is kept as upstream."
    );
    expect(originalCardDetail(false)).toBe("You can read it. Pushes will be refused.");
  });
});
