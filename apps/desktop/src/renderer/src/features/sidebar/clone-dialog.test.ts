import { describe, expect, it } from "vitest";
import type { CloneDestination, CloneRepository } from "@pwrgit/shared";
import {
  cloneDestinationLabel,
  cloneSourceQuery,
  exactGitHubRepository,
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
    isPrivate: true,
    sshUrl: "git@github.com:pwrdrvr/billing-service.git",
    httpsUrl: "https://github.com/pwrdrvr/billing-service",
    localPaths: []
  },
  {
    name: "x-code-clone",
    owner: "huntharo",
    nameWithOwner: "huntharo/x-code-clone",
    isPrivate: false,
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
    expect(exactGitHubRepository(input)).toBe(expected);
  });

  it.each([
    "huntharo/",
    "x-code-clone",
    "https://gitlab.com/huntharo/x-code-clone",
    "https://github.com/huntharo/x-code-clone/issues",
    "git clone https://github.com/huntharo/x-code-clone.git",
    "gh repo clone huntharo/x-code-clone ./destination"
  ])("does not treat %s as an exact GitHub repository", (input) => {
    expect(exactGitHubRepository(input)).toBeNull();
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
        nameWithOwner: "huntharo/x-code-clone"
      }))
    );
  });

  it("uses catalog search for non-exact input", () => {
    expect(cloneSourceQuery(repositories, "payments")).toEqual({
      kind: "search",
      repositories: [repositories[0]]
    });
  });

  it("builds direct clone metadata without a GitHub CLI lookup", () => {
    expect(unverifiedCloneRepository("huntharo/x-code-clone")).toEqual({
      name: "x-code-clone",
      owner: "huntharo",
      nameWithOwner: "huntharo/x-code-clone",
      description: "Not verified — clone with SSH or HTTPS",
      isPrivate: false,
      sshUrl: "git@github.com:huntharo/x-code-clone.git",
      httpsUrl: "https://github.com/huntharo/x-code-clone.git",
      localPaths: []
    });
  });

  it("keeps keyboard selection valid when results are empty", () => {
    expect(moveCloneSelection(0, 1, 0)).toBe(0);
    expect(moveCloneSelection(0, 1, 2)).toBe(1);
    expect(moveCloneSelection(1, 1, 2)).toBe(1);
    expect(moveCloneSelection(0, -1, 2)).toBe(0);
  });
});
