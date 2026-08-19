import { describe, expect, it } from "vitest";
import type { CloneDestination, CloneRepository } from "@pwrgit/shared";
import {
  cloneDestinationLabel,
  cloneDestinationSelectionIndex,
  cloneRepositoryAtSelection,
  cloneSourceQuery,
  exactRepository,
  filterCloneDestinations,
  filterCloneRepositories,
  moveCloneSelection,
  unverifiedCloneRepository
} from "./clone-dialog";

const repositories: CloneRepository[] = [
  {
    name: "billing-service",
    owner: "pwrdrvr",
    nameWithOwner: "pwrdrvr/billing-service",
    description: "Payments API",
    visibility: "private",
    host: "github",
    hostname: "github.com",
    sshUrl: "git@github.com:pwrdrvr/billing-service.git",
    httpsUrl: "https://github.com/pwrdrvr/billing-service",
    localPaths: []
  },
  {
    name: "x-code-clone",
    owner: "huntharo",
    nameWithOwner: "huntharo/x-code-clone",
    visibility: "public",
    host: "github",
    hostname: "github.com",
    sshUrl: "git@github.com:huntharo/x-code-clone.git",
    httpsUrl: "https://github.com/huntharo/x-code-clone",
    localPaths: []
  }
];

const destinations: CloneDestination[] = [
  {
    path: "/projects/pwrdrvr",
    root: "/projects/pwrdrvr",
    relativePath: "",
    repoCount: 10
  },
  {
    path: "/projects/pwrdrvr/services",
    root: "/projects/pwrdrvr",
    relativePath: "services",
    repoCount: 6,
    lastUsedAt: "2026-08-04 12:00:00"
  }
];

describe("clone dialog filtering", () => {
  it("searches repository names, owners, and descriptions", () => {
    expect(filterCloneRepositories(repositories, "billing")[0]?.name).toBe(
      "billing-service"
    );
    expect(filterCloneRepositories(repositories, "huntharo")[0]?.name).toBe(
      "x-code-clone"
    );
    expect(filterCloneRepositories(repositories, "payments")[0]?.name).toBe(
      "billing-service"
    );
  });

  it("matches a nested destination from a short prefix", () => {
    expect(filterCloneDestinations(destinations, "serv")).toEqual([
      destinations[1]
    ]);
    expect(cloneDestinationLabel(destinations[1]!)).toBe("pwrdrvr/services/");
  });

  it("preserves the highlighted destination when progressive results reorder", () => {
    const selectedPath = destinations[1]!.path;
    const reordered = [destinations[1]!, destinations[0]!];

    const selection = cloneDestinationSelectionIndex(reordered, selectedPath);

    expect(selection).toBe(0);
    expect(reordered[selection]?.path).toBe(selectedPath);
  });

  it.each([
    ["huntharo/x-code-clone", "huntharo/x-code-clone"],
    ["git@github.com:huntharo/x-code-clone.git", "huntharo/x-code-clone"],
    [
      "ssh://git@github.com/huntharo/x-code-clone.git",
      "huntharo/x-code-clone"
    ],
    [
      "https://github.com/huntharo/x-code-clone.git",
      "huntharo/x-code-clone"
    ],
    ["gh repo clone huntharo/x-code-clone", "huntharo/x-code-clone"],
    [
      "gh repo clone git@github.com:huntharo/x-code-clone.git",
      "huntharo/x-code-clone"
    ],
    [
      "gh repo clone https://github.com/huntharo/x-code-clone.git",
      "huntharo/x-code-clone"
    ]
  ])("parses an exact GitHub repository from %s", (input, expected) => {
    expect(exactRepository(input)?.nameWithOwner).toBe(expected);
    expect(exactRepository(input)?.host).toBe("github");
  });

  it.each([
    "huntharo/",
    "x-code-clone",
    "https://github.com/huntharo/x-code-clone/issues",
    "git clone https://github.com/huntharo/x-code-clone.git",
    "gh repo clone huntharo/x-code-clone ./destination"
  ])("does not treat %s as an exact repository", (input) => {
    expect(exactRepository(input)).toBeNull();
  });

  it("reads the forge out of a URL rather than assuming GitHub", () => {
    expect(exactRepository("https://gitlab.com/huntharo/x-code-clone")).toEqual({
      host: "gitlab",
      hostname: "gitlab.com",
      nameWithOwner: "huntharo/x-code-clone"
    });
    expect(
      exactRepository("git@gitlab.acme.io:acme/platform/billing.git")
    ).toEqual({
      host: "gitlab",
      hostname: "gitlab.acme.io",
      nameWithOwner: "acme/platform/billing"
    });
  });

  it("lets the CLI in a pasted command name the forge", () => {
    expect(exactRepository("glab repo clone acme/api")?.host).toBe("gitlab");
    expect(exactRepository("gh repo clone acme/api")?.host).toBe("github");
  });

  it("falls back to the dialog's host for a bare owner/name", () => {
    // The same slug exists on both forges, so a bare path cannot name one —
    // the host toggle decides, and it must not silently default to GitHub
    // when the user has switched it.
    expect(exactRepository("acme/api", "gitlab")).toEqual({
      host: "gitlab",
      hostname: "gitlab.com",
      nameWithOwner: "acme/api"
    });
    expect(exactRepository("acme/api")?.host).toBe("github");
  });

  it("accepts a GitLab subgroup path", () => {
    expect(exactRepository("acme/platform/team/api", "gitlab")).toMatchObject({
      nameWithOwner: "acme/platform/team/api"
    });
  });

  it("bypasses catalog search for every exact input form", () => {
    expect(
      [
        "huntharo/x-code-clone",
        "git@github.com:huntharo/x-code-clone.git",
        "ssh://git@github.com/huntharo/x-code-clone.git",
        "https://github.com/huntharo/x-code-clone",
        "gh repo clone huntharo/x-code-clone"
      ].map((input) => cloneSourceQuery(repositories, input))
    ).toEqual(
      Array.from({ length: 5 }, () => ({
        kind: "exact",
        repository: {
          host: "github",
          hostname: "github.com",
          nameWithOwner: "huntharo/x-code-clone"
        }
      }))
    );
  });

  it("uses catalog search for non-exact input", () => {
    expect(cloneSourceQuery(repositories, "payments")).toEqual({
      kind: "search",
      repositories: [repositories[0]]
    });
  });

  it("builds direct clone metadata without a forge CLI lookup", () => {
    expect(unverifiedCloneRepository("huntharo/x-code-clone")).toEqual({
      name: "x-code-clone",
      owner: "huntharo",
      nameWithOwner: "huntharo/x-code-clone",
      description: "Not verified — clone with SSH or HTTPS",
      // Not `public`: nothing confirmed this repository, and guessing the
      // permissive answer is exactly what the third state exists to prevent.
      visibility: "unknown",
      host: "github",
      hostname: "github.com",
      sshUrl: "git@github.com:huntharo/x-code-clone.git",
      httpsUrl: "https://github.com/huntharo/x-code-clone.git",
      localPaths: []
    });
  });

  it("builds unverified metadata against the chosen forge", () => {
    expect(
      unverifiedCloneRepository("acme/api", "gitlab")
    ).toMatchObject({
      host: "gitlab",
      hostname: "gitlab.com",
      sshUrl: "git@gitlab.com:acme/api.git",
      httpsUrl: "https://gitlab.com/acme/api.git"
    });
  });

  it("keeps keyboard selection valid when results are empty", () => {
    expect(moveCloneSelection(0, 1, 0)).toBe(0);
    expect(moveCloneSelection(0, 1, 2)).toBe(1);
    expect(moveCloneSelection(1, 1, 2)).toBe(1);
    expect(moveCloneSelection(0, -1, 2)).toBe(0);
  });

  it("falls back to the first result when a refined search makes the selection stale", () => {
    expect(cloneRepositoryAtSelection([repositories[0]!], 1)).toBe(
      repositories[0]
    );
  });
});
