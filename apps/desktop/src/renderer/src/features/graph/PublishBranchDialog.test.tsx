// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RemoteEndpoint, RepoIdentity } from "@pwrgit/shared";

vi.mock("../../lib/useForgeHostMap", () => ({ useForgeHostMap: () => ({}) }));
import { PublishBranchDialog } from "./PublishBranchDialog";

const endpoint = (name: string, slug: string): RemoteEndpoint => ({
  name, fetchUrl: `git@github.com:${slug}.git`, pushUrl: `git@github.com:${slug}.git`
});
const fork: RepoIdentity = {
  host: "github", hostname: "github.com", owner: "riverbend", name: "sparkline",
  nameWithOwner: "riverbend/sparkline", visibility: "public", viewerCanPush: true,
  parent: { nameWithOwner: "octo-labs/sparkline", url: "https://github.com/octo-labs/sparkline" }
};
const readOnly: RepoIdentity = {
  host: "github", hostname: "github.com", owner: "octo-labs", name: "sparkline",
  nameWithOwner: "octo-labs/sparkline", visibility: "public", viewerCanPush: false
};

let container: HTMLDivElement;
let root: Root;
const onPublish = vi.fn();
const onFork = vi.fn();
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});
const open = async (remotes: RemoteEndpoint[], identity?: RepoIdentity) => {
  await act(async () => root.render(<PublishBranchDialog branch="fix-tooltips" remotes={remotes}
    identity={identity} onPublish={onPublish} onFork={onFork} onClose={() => undefined} />));
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label);
const strip = () => container.querySelector(".fork-route__grid")?.getAttribute("aria-label");

it("keeps the plain question where there is nothing to explain", async () => {
  await open([endpoint("origin", "riverbend/sparkline")]);
  expect(container.textContent).toContain("Remote");
  expect(container.querySelector(".refs-destination__url")?.textContent).toBe("git@github.com:riverbend/sparkline.git");
  expect(container.querySelector(".fork-route")).toBeNull();
});

it("names a fork's remotes by repository and draws where the branch goes", async () => {
  await open([endpoint("origin", "riverbend/sparkline"), endpoint("upstream", "octo-labs/sparkline")], fork);
  const rows = [...container.querySelectorAll(".refs-destination--routed")].map((row) => row.textContent);
  expect(rows).toEqual([
    "riverbend/sparklineYour fork · originyou can push",
    "octo-labs/sparklineThe original · upstream"
  ]);
  expect(strip()).toBe("After publishing: fix-tooltips pulls from and pushes to riverbend/sparkline.");
  expect(container.querySelector(".fork-route__tick")).not.toBeNull();

  // The original: drawn, but with no verdict — only origin was asked about.
  const original = container.querySelectorAll<HTMLInputElement>("input[type=radio]")[1]!;
  await act(async () => original.click());
  expect(strip()).toBe("After publishing: fix-tooltips pulls from and pushes to octo-labs/sparkline.");
  expect(container.textContent).toContain("PwrGit hasn't asked whether you can push to the original");
  expect(container.querySelector(".fork-route__tick")).toBeNull();
  await act(async () => button("Publish")?.click());
  expect(onPublish).toHaveBeenCalledExactlyOnceWith({ remote: "upstream" });
});

it("does not call a remote the original because it is named upstream", async () => {
  await open([endpoint("origin", "riverbend/sparkline"), endpoint("upstream", "someone/sparkline")], fork);
  const rows = [...container.querySelectorAll(".refs-destination--routed")].map((row) => row.textContent);
  expect(rows[1]).toBe("someone/sparklineupstream");
  // The original still has a box, from the forge's parent, with no remote.
  expect(container.querySelector(".fork-route__perm--pending")?.textContent).toBe("no remote");
});

it("advises forking only where Fork… is offered", async () => {
  // Your fork, refusing pushes: there is nothing to fork, so no such advice.
  await open([endpoint("origin", "riverbend/sparkline")], { ...fork, viewerCanPush: false });
  expect(container.querySelector("[role=note]")?.textContent).toContain("can't push to riverbend/sparkline");
  expect(container.querySelector("[role=note]")?.textContent).not.toContain("Fork it first");
  expect(button("Publish")).toBeDefined();
});

it("offers Fork… before a push the forge has said would be refused", async () => {
  await open([endpoint("origin", "octo-labs/sparkline")], readOnly);
  expect(container.querySelector("[role=note]")?.textContent).toContain("can't push to octo-labs/sparkline");
  expect(strip()).toBe("If you publish now, the push to octo-labs/sparkline is refused: this account can't push there.");
  expect(container.querySelector(".fork-route__arrow--bad")).not.toBeNull();
  // No slash to split at: the fork box reads whole, not "none ye" + "t".
  const forkSlug = [...container.querySelectorAll(".fork-route__slug")].at(-1)!;
  expect(forkSlug.querySelector("b")?.textContent).toBe("none yet");
  expect(button("Publish")).toBeUndefined();
  await act(async () => button("Fork octo-labs/sparkline…")?.click());
  expect(onFork).toHaveBeenCalledOnce();
  // The forge's answer can be stale; Git keeps the last word.
  await act(async () => button("Publish anyway")?.click());
  expect(onPublish).toHaveBeenCalledExactlyOnceWith({ remote: "origin" });
});
