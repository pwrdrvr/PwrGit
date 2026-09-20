import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type ChangeRequestLocation } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { GitHubCommitAuthorIdentityService } from "./commit-author-identity";
import { registerChangeRequestHandlers } from "./change-request-handlers";
import { registerGitHubHandlers } from "./github-handlers";
import type { OpenPrService } from "./open-pr-service";
import type { PrService } from "./pr-service";

const { emitEvent } = vi.hoisted(() => ({ emitEvent: vi.fn() }));
vi.mock("../ipc", () => ({ emitEvent }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

const emptyList = { forge: "github" as const, fetchedAt: 1, truncated: false, entries: [] };

function fakeService(overrides: Partial<OpenPrService> = {}): OpenPrService {
  return {
    refresh: vi.fn(async () => false),
    list: vi.fn(async () => emptyList),
    lookup: vi.fn(async () => null),
    fetchHead: vi.fn(async () => ok<ChangeRequestLocation>({ kind: "local", branch: "pr/121" })),
    ...overrides
  } as unknown as OpenPrService;
}

beforeEach(() => emitEvent.mockClear());

describe("change-request handlers", () => {
  it("answers the list from the cache and re-lists behind it on request", async () => {
    let finish: (changed: boolean) => void = () => undefined;
    const service = fakeService({
      refresh: vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }))
    });
    const bus = new CommandBus();
    registerChangeRequestHandlers(bus, service);

    // The read does not wait on the forge.
    expect(await bus.dispatch("pr:openList", { repoId: "r", refresh: true })).toEqual(ok(emptyList));
    expect(service.refresh).toHaveBeenCalledWith("r", { trigger: "user" });
    expect(emitEvent).not.toHaveBeenCalled();
    finish(true);
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledWith("pr:openChanged", { repoId: "r" }));

    await bus.dispatch("pr:openList", { repoId: "r" });
    expect(service.refresh).toHaveBeenCalledTimes(1);
  });

  it("re-indexes and announces after fetching a head, and not after a failure", async () => {
    const onHeadFetched = vi.fn(async () => undefined);
    const service = fakeService();
    const bus = new CommandBus();
    registerChangeRequestHandlers(bus, service, { onHeadFetched });
    expect(await bus.dispatch("pr:fetchHead", { repoId: "r", number: 121 })).toEqual(
      ok({ kind: "local", branch: "pr/121" })
    );
    expect(onHeadFetched).toHaveBeenCalledWith("r");
    expect(emitEvent).toHaveBeenCalledWith("pr:openChanged", { repoId: "r" });

    emitEvent.mockClear();
    onHeadFetched.mockClear();
    (service.fetchHead as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: "remote", code: "branch_gone", message: "gone" })
    );
    const failed = await bus.dispatch("pr:fetchHead", { repoId: "r", number: 98 });
    expect(failed.ok).toBe(false);
    expect(onHeadFetched).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("rides the whole-repo PR sweep, not a targeted branch refresh", async () => {
    const onRepoSweep = vi.fn();
    const prs = { refreshRepo: vi.fn(async () => new Map()) } as unknown as PrService;
    const bus = new CommandBus();
    const handlers = registerGitHubHandlers(
      bus,
      prs,
      {} as GitHubCommitAuthorIdentityService,
      undefined,
      undefined,
      onRepoSweep
    );
    await bus.dispatch("pr:refresh", { repoId: "r", branches: ["x"] });
    expect(onRepoSweep).not.toHaveBeenCalled();
    await bus.dispatch("pr:refresh", { repoId: "r" });
    expect(onRepoSweep).toHaveBeenCalledWith("r");
    handlers.stop();
  });
});
