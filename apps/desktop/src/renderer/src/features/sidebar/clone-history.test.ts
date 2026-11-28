import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_HISTORY_DEPTH, type CloneProtocol, type ForgeHost } from "@pwrgit/shared";
import { cloneHistoryChoice } from "./clone-history";

const protocols: CloneProtocol[] = ["ssh", "https", "cli"];
const hosts: ForgeHost[] = ["github", "gitlab", "gitcafe", "other"];

describe("cloneHistoryChoice", () => {
  // Rule: a depth is sent only when the row is on, the count is valid and the
  // source can honour it. In every other on-state Clone is blocked with a
  // reason — the request never silently becomes a full clone. Off is always
  // a full clone that blocks nothing.
  it("sends a depth, or blocks with a reason, and never does both or neither while on", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.oneof(fc.integer({ min: -5, max: MAX_HISTORY_DEPTH + 5 }).map(String), fc.string()),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom(...protocols),
        fc.constantFrom(...hosts),
        (on, text, forking, local, protocol, host) => {
          const choice = cloneHistoryChoice({ on, text, forking, local, protocol, host });
          if (!on) {
            expect(choice.depth).toBeUndefined();
            expect(choice.blocksSubmit).toBe(false);
            expect(choice.error).toBeNull();
            return;
          }
          expect(choice.toggleDisabled).toBe(false);
          expect(choice.depth === undefined).toBe(choice.blocksSubmit);
          expect(choice.blocksSubmit).toBe(choice.error !== null);
          const cafeCli = !local && protocol === "cli" && host === "gitcafe";
          if (forking || cafeCli) expect(choice.depth).toBeUndefined();
          if (choice.depth !== undefined) expect(String(choice.depth)).toBe(text.trim().replace(/^0+(?=\d)/, ""));
        }
      )
    );
  });

  it("names the GitCafe CLI as the reason, and lets SSH and other CLIs through", () => {
    const base = { on: true, text: "10", forking: false, local: false } as const;
    expect(cloneHistoryChoice({ ...base, protocol: "cli", host: "gitcafe" }).error).toContain("GitCafe CLI");
    expect(cloneHistoryChoice({ ...base, protocol: "ssh", host: "gitcafe" }).depth).toBe(10);
    expect(cloneHistoryChoice({ ...base, protocol: "cli", host: "github" }).depth).toBe(10);
    expect(cloneHistoryChoice({ ...base, protocol: "cli", host: "gitlab" }).depth).toBe(10);
  });
});
