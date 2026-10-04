// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ok, type ForkTrackingOffer, type Repo } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock, subscribe: () => () => undefined }));
import { ForkTrackingRecoveryDialog, type ForkTrackingEntry } from "./ForkTrackingRecoveryDialog";

const repo: Pick<Repo, "id" | "profileId" | "name" | "identity"> = {
  id: "repo-a", profileId: "profile-a", name: "sparkline",
  identity: {
    host: "github", hostname: "github.com", owner: "riverbend", name: "sparkline",
    nameWithOwner: "riverbend/sparkline", visibility: "public",
    parent: { nameWithOwner: "octo-labs/sparkline", url: "https://github.com/octo-labs/sparkline" }
  }
};
const fork = (remote: string, owner: string) => ({
  remote, nameWithOwner: `${owner}/sparkline`, ref: `${remote}/main`
});
const offer = (targets = [fork("origin", "riverbend")]): ForkTrackingOffer => ({
  branch: "main", upstream: "upstream/main", upstreamRemote: "upstream", target: "origin/main",
  parent: "octo-labs/sparkline", targets
});

let container: HTMLDivElement;
let root: Root;
const onRepaired = vi.fn();
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
const open = async (answer: ForkTrackingOffer | null, entry: ForkTrackingEntry = { from: "pull" }) => {
  dispatchMock.mockImplementation((name: string) => Promise.resolve(
    name === "repo:refreshIdentities" ? ok({ changed: 0, outcomes: [] })
      : name === "remote:inspectForkTracking" ? ok(answer) : ok(null)
  ));
  await act(async () => root.render(<ForkTrackingRecoveryDialog repo={repo} worktreeId="wt-a"
    entry={entry} onRepaired={onRepaired} onClose={() => undefined} />));
};
const dialog = () => container.querySelector(".fork-tracking-dialog")!;
const button = (label: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label);
const afterFork = () => dialog().querySelector(".fork-route--after .fork-route__node--chosen .fork-route__slug")?.textContent;

it("draws Now and After for a single fork, and names the forge that refused", async () => {
  await open(offer(), { from: "push", error: "ERROR: Permission to octo-labs/sparkline.git denied to riverbend." });
  expect(dialog().querySelector("strong")?.textContent).toBe("Push to your fork instead");
  expect(dialog().querySelector(".fork-tracking-refused b")?.textContent).toBe("GitHub refused the push");
  expect(dialog().querySelector(".fork-tracking-pick")).toBeNull();
  const routes = [...dialog().querySelectorAll(".fork-route__grid")].map((node) => node.getAttribute("aria-label"));
  expect(routes).toEqual([
    "Now: main pulls from and pushes to octo-labs/sparkline, which refused the push. riverbend/sparkline is not used.",
    "After: main pulls from and pushes to riverbend/sparkline. Sync in the Pull menu still brings in octo-labs/sparkline."
  ]);
  expect(afterFork()).toBe("riverbend/sparkline");
  expect(dialog().querySelector(".fork-tracking-terms")?.textContent).toContain("git branch --set-upstream-to=origin/main main");
});

it("lets you choose among forks you can push to, and the After route follows the pick", async () => {
  await open(offer([fork("origin", "riverbend"), fork("lumen", "lumen-co"), fork("acme", "acme")]));
  expect(dialog().querySelector("strong")?.textContent).toBe("Use a fork for main");
  // With a list, Now is said in words; the picture is of where it goes.
  expect([...dialog().querySelectorAll(".fork-route__phase")].map((node) => node.textContent)).toEqual(["After"]);
  const radios = [...dialog().querySelectorAll<HTMLInputElement>(".fork-tracking-pick input[type=radio]")];
  expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
  expect(dialog().querySelector(".fork-tracking-pick__list")).not.toBeNull();
  expect(button("Use riverbend/sparkline")).toBeDefined();
  await act(async () => radios[1]!.click());
  expect(afterFork()).toBe("lumen-co/sparkline");
  expect(dialog().querySelector(".fork-route--after .fork-route__node--chosen .fork-route__role")?.textContent).toBe("lumen-co's fork");
  expect(dialog().querySelector(".fork-tracking-terms")?.textContent).toContain("git branch --set-upstream-to=lumen/main main");
  await act(async () => button("Use lumen-co/sparkline")!.click());
  expect(dispatchMock).toHaveBeenCalledWith("remote:repairForkTracking", {
    worktreeId: "wt-a", branch: "main", upstream: "upstream/main",
    target: { remote: "lumen", nameWithOwner: "lumen-co/sparkline" }
  });
  expect(onRepaired).toHaveBeenCalledWith({
    branch: "main", parent: "octo-labs/sparkline", target: fork("lumen", "lumen-co")
  });
});

it("says there is nothing to change when the branch no longer tracks the original", async () => {
  await open(null, { from: "remotes" });
  expect(dialog().textContent).toContain("Nothing to change");
  expect(button("Use my fork")).toBeUndefined();
  expect(button("Re-check")).toBeDefined();
});
