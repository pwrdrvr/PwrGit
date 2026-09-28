import { expect, it } from "vitest";
import { forgeProduct } from "./forge-product";
import { classifyForgeHost, parseCloneRemote, parseForgeRemote } from "./forge-remote";
import { gerritPatchSet, gerritReviewUrl, safeGerritReviewUrl } from "./gerrit";
it("recognizes two documented deployments, and requires explicit configuration elsewhere", () => {
  expect(classifyForgeHost("chromium.googlesource.com")).toBe("gerrit");
  expect(classifyForgeHost("codereview.qt-project.org")).toBe("gerrit");
  expect(classifyForgeHost("review.example.com")).toBe("other");
  expect(classifyForgeHost("review.example.com", { "review.example.com": "gerrit" })).toBe("gerrit");
  expect(classifyForgeHost("chromium.googlesource.com.attacker.test")).toBe("other");
});
it("allows a configured Gerrit project without an owner and preserves the SSH port", () => {
  const url = "ssh://reviewer@review.example.com:29418/project";
  expect(parseCloneRemote(url, { "review.example.com": "gerrit" })).toMatchObject({ sourceUrl: url, host: "gerrit", owner: "", repo: "project", nameWithOwner: "project" });
  expect(parseForgeRemote("https://github.com/project")).toBeNull();
});
it("has public, read-only capabilities without inventing account workflows", () => {
  expect(forgeProduct("gerrit")).toMatchObject({ access: "public", reviewModel: "patchset", workflows: { forks: false, repositorySearch: false, cliClone: false, branchReviews: false } });
});
it("validates review endpoints and immutable patch-set identity", () => {
  expect(gerritReviewUrl("chromium.googlesource.com")).toBe("https://chromium-review.googlesource.com");
  expect(gerritReviewUrl("git.example", "https://review.example:8443/r/")).toBe("https://review.example:8443/r");
  for (const bad of ["http://review.example", "https://a:b@review.example", "https://review.example?token=x", "https://review.example/#x"]) expect(safeGerritReviewUrl(bad)).toBeNull();
  expect(gerritPatchSet("refs/changes/23/123/2", 123)).toBe(2);
  for (const bad of ["refs/heads/main", "refs/changes/24/123/2", "refs/changes/23/124/2", "refs/changes/23/123/0"]) expect(gerritPatchSet(bad, 123)).toBeNull();
});
