// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateContributions,
  aggregateAuthorFlow,
  type ContributionSnapshot
} from "@pwrgit/shared";
import {
  installObjectUrlLedger,
  type ObjectUrlLedger
} from "../../test-support/object-urls";
import { contributionFixture } from "./contribution-fixture";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatchOrThrow: mocks.dispatch }));
import { ContributionScreen } from "./ContributionScreen";

let container: HTMLDivElement,
  root: Root,
  ledger: ObjectUrlLedger,
  snapshot: ContributionSnapshot;
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label
  )!;
const change = async (label: string, value: string) => {
  const field = [...container.querySelectorAll("label")]
    .find((node) => node.firstChild?.textContent === label)
    ?.querySelector("select")!;
  await act(async () => {
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T16:00:00Z"));
  snapshot = contributionFixture();
  mocks.dispatch.mockReset().mockImplementation(async (name) => {
    if (name === "forge:hosts")
      return {
        hosts: [
          {
            kind: "github",
            host: "github.com",
            enabled: true,
            account: "demo-user"
          },
          { kind: "gitlab", host: "gitlab.com", enabled: true }
        ]
      };
    if (name === "contribution:verify")
      return { identity: snapshot.identity, snapshot };
    if (name === "contribution:read") return snapshot;
    if (name === "contribution:sync") {
      snapshot = { ...snapshot, status: "collecting", refreshedAt: null };
      return snapshot;
    }
    if (name === "contribution:cancel") {
      snapshot = { ...snapshot, status: "canceled" };
      return null;
    }
    if (name === "contribution:clear") return null;
    throw new Error(`Unexpected command ${name}`);
  });
  ledger = installObjectUrlLedger();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  ledger.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function mount(onClose: () => void = () => {}) {
  await act(async () =>
    root.render(
      <ContributionScreen profileId="demo-profile" onClose={onClose} />
    )
  );
  // Select the fixture's scope through the UI, independent of the host timezone.
  // A resolvedOptions prototype spy misses call-without-new Intl instances in
  // some test realms, leaving UTC CI hosts with a mismatched cached snapshot.
  for (const [label, value] of [
    ["From", snapshot.window.startDate],
    ["Through", snapshot.window.endDate],
    ["Timezone", snapshot.window.timezone]
  ]) {
    const input = [...container.querySelectorAll("label")]
      .find((node) => node.firstChild?.textContent === label)
      ?.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}
async function connect() {
  // The screen asks the CLI who is signed in on its own: an identity read,
  // never PR metadata. The fixture's range then reads the cached snapshot.
  expect(
    mocks.dispatch.mock.calls.filter(([name]) => name === "contribution:verify")
  ).toEqual([
    [
      "contribution:verify",
      expect.objectContaining({
        profileId: "demo-profile",
        host: snapshot.identity.host
      })
    ]
  ]);
  expect(container.textContent).toContain("Verified account demo-user");
}
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}

describe("Contributions integrated screen", () => {
  it("names skipped SSO organizations and distinguishes accessible completion from full coverage", async () => {
    Object.assign(snapshot, {
      status: "partial", accessibleComplete: true,
      blockedOrganizations: [{ id: "42", login: "blocked-org" }, { id: "99", login: null }],
      blockedRepoIds: [snapshot.repos[0]!.id]
    });
    Object.assign(snapshot.authoredInventory, { complete: false, skipped: 7, exhausted: true });
    await mount();
    const coverage = container.querySelector("[aria-label='Collection coverage']")!;
    expect(coverage.textContent).toContain("Accessible activity collected");
    expect(coverage.textContent).toContain("blocked-org");
    expect(coverage.textContent).toContain("Organization ID 99");
    expect(coverage.textContent).toContain("7 authored PRs skipped");
    expect(coverage.textContent).toContain("1 repositories skipped");
    expect(coverage.textContent).not.toContain("Finished for visible inventory");
    expect(container.textContent).toContain("Resume collection");
    expect(container.textContent).toContain("Historical backlog and");
  });
  it("starts from local account selection, advertises only supported hosts and never collects on chart/filter renders", async () => {
    await mount();
    expect(container.textContent).not.toContain("gitlab.com");
    expect(new Set(mocks.dispatch.mock.calls.map((call) => call[0]))).toEqual(
      new Set(["forge:hosts", "contribution:verify", "contribution:read"])
    );
    await connect();
    expect(container.textContent).toContain("Verified account demo-user");
    await change("Stack by", "repo");
    await change("Interval", "week");
    await change("Top series", "3");
    const data = aggregateContributions(
      snapshot.records,
      snapshot.identity.id,
      snapshot.window,
      { group: "repo", interval: "week", topN: 3 }
    );
    expect(
      container.querySelector("svg[role='img']")?.getAttribute("aria-label")
    ).toContain(`${data.total} pull requests`);
    expect(
      container.querySelector(".contributions__legend")?.textContent
    ).toContain("Other");
    expect(
      mocks.dispatch.mock.calls.filter(
        (call) => call[0] === "contribution:sync"
      )
    ).toHaveLength(0);
    expect(
      mocks.dispatch.mock.calls.every(
        (call) =>
          call[0] === "forge:hosts" || call[1].profileId === "demo-profile"
      )
    ).toBe(true);
  });
  it("keeps chart/table/CSV/JSON totals equal and drills down using exactly the same series", async () => {
    await mount();
    await connect();
    await change("Interval", "month");
    await change("Top series", "3");
    const data = aggregateContributions(
      snapshot.records,
      snapshot.identity.id,
      snapshot.window,
      { interval: "month", topN: 3 }
    );
    expect(
      [
        ...container.querySelectorAll(
          "[aria-labelledby='contributions-chart-heading'] details tbody tr"
        )
      ].reduce(
        (sum, row) => sum + Number(row.querySelector("td")?.textContent),
        0
      )
    ).toBe(data.total);
    await act(async () => button("Export CSV").click());
    const csvRead = blobText([...ledger.minted.values()][0]!);
    await vi.runAllTimersAsync();
    const csv = await csvRead;
    expect(csv).toContain('"coverage"');
    expect(csv).toContain('"complete"');
    expect(csv).toContain('"America/New_York"');
    const parsed = csv
      .split("\r\n")
      .slice(1)
      .map((line) =>
        line.split('","').map((cell) => cell.replace(/^"|"$/g, ""))
      );
    expect(parsed.reduce((sum, cells) => sum + Number(cells[4]), 0)).toBe(
      data.total
    );
    for (const cells of parsed)
      expect(cells.slice(5).reduce((sum, cell) => sum + Number(cell), 0)).toBe(
        Number(cells[4])
      );
    await act(async () => button("Export JSON").click());
    const jsonRead = blobText([...ledger.minted.values()][1]!);
    await vi.runAllTimersAsync();
    const json = JSON.parse(await jsonRead);
    expect(json.records).toHaveLength(data.total);
    expect(json.coverage.status).toBe("complete");
    expect(
      json.buckets.reduce(
        (sum: number, bucket: { total: number }) => sum + bucket.total,
        0
      )
    ).toBe(data.total);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>("details tbody button")!
        .click()
    );
    expect(container.textContent).toContain("PRs in period starting 2026-04");
    expect(container.textContent).toContain("matching pull requests");
  });
  it("shows incomplete counts on cancellation, polls only checkpoints, and clears account cache explicitly", async () => {
    await mount();
    await connect();
    await act(async () => button("Refresh").click());
    expect(container.textContent).toContain("Collection in progress");
    expect(container.textContent).toContain(
      "Unread or inaccessible repositories are unknown, never zero"
    );
    const syncs = mocks.dispatch.mock.calls.filter(
      (call) => call[0] === "contribution:sync"
    ).length;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(
      mocks.dispatch.mock.calls.filter(
        (call) => call[0] === "contribution:sync"
      )
    ).toHaveLength(syncs);
    await act(async () => button("Cancel collection").click());
    expect(container.textContent).toContain("Incomplete · canceled");
    await act(async () =>
      button("Clear this account’s local analytics cache").click()
    );
    expect(container.textContent).toContain("Nothing collected yet");
    expect(button("Collect my activity")).toBeDefined();
  });
  it("exports authored flow totals and shifts August preset scope without collecting automatically", async () => {
    await mount();
    await connect();
    const flow = aggregateAuthorFlow(
      snapshot.records,
      snapshot.identity.id,
      snapshot.window
    );
    expect(container.textContent).toContain(
      `${flow.baseline} → ${flow.ending}`
    );
    await act(async () => button("Export author flow CSV").click());
    const read = blobText([...ledger.minted.values()][0]!);
    await vi.runAllTimersAsync();
    const parsed = (await read)
      .split("\r\n")
      .slice(1)
      .map((line) =>
        line.split('","').map((cell) => cell.replace(/^"|"$/g, ""))
      );
    expect(parsed.reduce((sum, cells) => sum + Number(cells[3]), 0)).toBe(
      flow.created
    );
    expect(parsed.reduce((sum, cells) => sum + Number(cells[4]), 0)).toBe(
      flow.merged
    );
    await act(async () => button("Since August 1").click());
    const reads = mocks.dispatch.mock.calls.filter(
      (call) => call[0] === "contribution:read"
    );
    expect(reads.at(-1)?.[1]).toMatchObject({
      startDate: "2026-08-01",
      endDate: "2026-10-11",
      timezone: "America/New_York"
    });
    expect(
      mocks.dispatch.mock.calls.filter(
        (call) => call[0] === "contribution:sync"
      )
    ).toHaveLength(0);
    expect(container.textContent).not.toContain(
      `${flow.baseline} → ${flow.ending}`
    );
  });
  it("opens Share image from the chart and closes it on Escape without leaving the screen", async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await connect();
    expect(button("Export chart")).toBeUndefined();
    await act(async () => button("Share image…").click());
    const dialog = container.querySelector("[role='dialog']")!;
    expect(dialog.textContent).toContain("Names in the image");
    const preview = decodeURIComponent(
      dialog.querySelector("img")!.getAttribute("src")!.split(",")[1]!
    );
    expect(preview).not.toContain("demo-org0");
    await act(async () =>
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true
        })
      )
    );
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
  it("verifies on open and offers one clear button to collect a range nothing has been read for", async () => {
    const empty = mocks.dispatch.getMockImplementation()!;
    mocks.dispatch.mockImplementation(async (name, req) => {
      if (name === "contribution:verify")
        return { identity: snapshot.identity, snapshot: null };
      if (name === "contribution:read") return null;
      return empty(name, req);
    });
    await mount();
    expect(container.textContent).toContain(
      "Nothing collected yet for 2026-04-11 – 2026-10-10"
    );
    expect(
      mocks.dispatch.mock.calls.some(([name]) => name === "contribution:sync")
    ).toBe(false);
    await act(async () => button("Collect my activity").click());
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "contribution:sync",
      expect.objectContaining({
        profileId: "demo-profile",
        viewerId: snapshot.identity.id,
        refresh: false
      })
    );
  });
});
