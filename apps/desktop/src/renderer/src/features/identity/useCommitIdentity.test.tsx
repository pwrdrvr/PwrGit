// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn(() => () => undefined) }));
vi.mock("../../lib/pwrgit", () => mocks);
import { useCommitIdentity } from "./useCommitIdentity";
import { inspection } from "./identity-test-fixtures";

let root: Root;
let container: HTMLDivElement;

function Probe({ head }: { head: string | null }) {
  useCommitIdentity("wt-1", head);
  return null;
}

async function render(head: string | null): Promise<void> {
  await act(async () => {
    root.render(<Probe head={head} />);
  });
}

const inspects = (): number =>
  mocks.dispatch.mock.calls.filter(([name]) => name === "identity:inspect").length;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockResolvedValue(ok(inspection()));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useCommitIdentity", () => {
  it("asks once on select, and again only when HEAD moves", async () => {
    await render("aaa");
    expect(inspects()).toBe(1);
    await render("aaa");
    expect(inspects()).toBe(1);
    // A branch switch, pull or rebase inside PwrGit: Amend's preview reads
    // HEAD's author, so the answer has to follow it.
    await render("bbb");
    expect(inspects()).toBe(2);
  });
});
