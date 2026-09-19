import { describe, expect, it } from "vitest";
import { agentErrorMessage } from "./agent-error-message";

describe("agentErrorMessage", () => {
  it("reads an Error's message", () => {
    expect(agentErrorMessage(new Error("spawn codex ENOENT"))).toBe("spawn codex ENOENT");
  });

  it("reads a bare string", () => {
    expect(agentErrorMessage("model not available")).toBe("model not available");
  });

  it("flattens multi-line CLI output into one sentence for the Settings row", () => {
    expect(agentErrorMessage(new Error("  first line\n\n  second\tline  "))).toBe(
      "first line second line"
    );
  });

  it("reads the message out of a JSON-RPC error envelope", () => {
    expect(
      agentErrorMessage({ jsonrpc: "2.0", id: 4, error: { code: -32000, message: "Not signed in" } })
    ).toBe("Not signed in");
  });

  it("prefers a record's own readable field over what it wraps", () => {
    expect(
      agentErrorMessage({ message: "outer", cause: new Error("inner") })
    ).toBe("outer");
    // `error` as a string is a reason in its own right, not a wrapper.
    expect(agentErrorMessage({ error: "unauthorized" })).toBe("unauthorized");
  });

  it("skips blank fields and digs into cause, data, response and body", () => {
    expect(agentErrorMessage({ message: "   ", cause: new Error("from cause") })).toBe("from cause");
    expect(agentErrorMessage({ data: { stderr: "from stderr" } })).toBe("from stderr");
    expect(agentErrorMessage({ response: { body: { detail: "from detail" } } })).toBe(
      "from detail"
    );
    expect(agentErrorMessage({ reasonMessage: "from reasonMessage" })).toBe("from reasonMessage");
  });

  it("falls back when there is nothing readable", () => {
    expect(agentErrorMessage(undefined)).toBe("Agent request failed");
    expect(agentErrorMessage(42)).toBe("Agent request failed");
    expect(agentErrorMessage({ code: -32000 })).toBe("Agent request failed");
    expect(agentErrorMessage({ code: 1 }, "Agent discovery failed.")).toBe(
      "Agent discovery failed."
    );
  });

  it("does not loop on a cyclic error record", () => {
    const cyclic: Record<string, unknown> = { code: 1 };
    cyclic["cause"] = cyclic;
    cyclic["data"] = { error: cyclic };
    expect(agentErrorMessage(cyclic)).toBe("Agent request failed");
  });

  it("bounds a runaway message", () => {
    const message = agentErrorMessage(new Error("x".repeat(10_000)));
    expect(message.length).toBe(2_000);
  });

  it("falls back, rather than answering an empty string, for a blank message", () => {
    // A blank one used to come back as "" — `??` keeps it — so the row read
    // empty instead of saying anything.
    expect(agentErrorMessage(new Error(""))).toBe("Agent request failed");
    expect(agentErrorMessage("   ")).toBe("Agent request failed");
  });

  it("reads an Error's cause when its own message is blank", () => {
    expect(agentErrorMessage(new Error("", { cause: new Error("real reason") }))).toBe(
      "real reason"
    );
  });
});
