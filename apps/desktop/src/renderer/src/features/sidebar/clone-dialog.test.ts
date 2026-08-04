import { describe, expect, it } from "vitest";
import type { CloneDestination, CloneRepository } from "@pwrgit/shared";
import {
  cloneDestinationLabel,
  exactGitHubRepository,
  filterCloneDestinations,
  filterCloneRepositories
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

  it("recognizes only complete owner/name lookups", () => {
    expect(exactGitHubRepository("huntharo/x-code-clone")).toBe(
      "huntharo/x-code-clone"
    );
    expect(exactGitHubRepository("huntharo/")).toBeNull();
  });
});
