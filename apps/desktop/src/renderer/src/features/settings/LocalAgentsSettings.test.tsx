// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_AGENT_CAPABILITIES,
  MCP_AGENT_CAPABILITY_DETAILS,
  ok,
  type McpAgentPolicySnapshot
} from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));

import { LocalAgentsSettings } from "./LocalAgentsSettings";

const snapshot: McpAgentPolicySnapshot = {
  protocol: "pwrgit.mcp-policy/v1",
  version: 1,
  policyFile: "/Users/test/Library/Application Support/PwrGit/mcp-policy.json",
  capabilities: MCP_AGENT_CAPABILITIES.map((capability) => ({
    capability,
    ...MCP_AGENT_CAPABILITY_DETAILS[capability]
  })),
  roles: [
    {
      id: "builtin.discovery",
      name: "Repository Discovery",
      description: "Find repositories.",
      builtIn: true,
      permissions: ["repository.roots.read", "repository.checkout.locate"],
      repositoryRoots: null
    },
    {
      id: "role_scoped",
      name: "Acme Status",
      description: "Status inside Acme.",
      builtIn: false,
      permissions: [...MCP_AGENT_CAPABILITIES],
      repositoryRoots: ["/Users/test/src/acme"]
    }
  ],
  sessions: [
    {
      id: "session_agent",
      name: "PwrAgent",
      roleId: "role_scoped",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      revokedAt: null
    }
  ]
};

let container: HTMLDivElement;
let root: Root;
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscribe.mockReturnValue(unsubscribe);
  mocks.dispatch.mockImplementation((name: string) => {
    if (name === "localAgents:read") return Promise.resolve(ok(snapshot));
    throw new Error(`unexpected command ${name}`);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<LocalAgentsSettings />);
  });
}

describe("LocalAgentsSettings", () => {
  it("renders the Session-to-role graph, effective permissions, and concrete roots", async () => {
    await render();

    expect(mocks.dispatch).toHaveBeenCalledWith("localAgents:read", undefined);
    expect(container.textContent).toContain("Authorization graph");
    expect(container.textContent).toContain("PwrAgent");
    expect(container.textContent).toContain("Acme Status");
    expect(container.textContent).toContain("5 permissions");
    expect(container.textContent).toContain("1 approved root");
    expect(container.textContent).toContain("/Users/test/src/acme");
    expect(container.textContent).toContain("Read forge status");
  });

  it("creates a named Session and shows its token exactly once", async () => {
    const credential = {
      session: {
        id: "session_new",
        name: "Codex",
        roleId: "builtin.discovery",
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:00.000Z",
        revokedAt: null
      },
      token: "pgmcp_secret-once",
      environment: {
        policyFileVariable: "PWRGIT_MCP_POLICY_FILE" as const,
        policyFile: snapshot.policyFile,
        sessionTokenVariable: "PWRGIT_MCP_SESSION_TOKEN" as const
      }
    };
    mocks.dispatch.mockImplementation((name: string) => {
      if (name === "localAgents:read") return Promise.resolve(ok(snapshot));
      if (name === "localAgents:createSession") return Promise.resolve(ok(credential));
      throw new Error(`unexpected command ${name}`);
    });
    await render();
    const input = container.querySelector<HTMLInputElement>("input[placeholder='PwrAgent on this Mac']");
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Create Session"
    );
    await act(async () => {
      if (input !== null) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, "Codex");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      button?.click();
    });

    expect(mocks.dispatch).toHaveBeenCalledWith("localAgents:createSession", {
      name: "Codex",
      roleId: "builtin.discovery"
    });
    expect(container.textContent).toContain("Copy this now");
    expect(container.textContent).toContain("PWRGIT_MCP_SESSION_TOKEN");
    expect(container.textContent).toContain("pgmcp_secret-once");
  });

  it("revokes a Session through the typed command bus", async () => {
    mocks.dispatch.mockImplementation((name: string) => {
      if (name === "localAgents:read") return Promise.resolve(ok(snapshot));
      if (name === "localAgents:revoke") {
        return Promise.resolve(ok({ ...snapshot.sessions[0]!, revokedAt: "now" }));
      }
      throw new Error(`unexpected command ${name}`);
    });
    await render();
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Revoke"
    );
    await act(async () => {
      button?.click();
    });

    expect(mocks.dispatch).toHaveBeenCalledWith("localAgents:revoke", {
      id: "session_agent"
    });
  });

  it("unsubscribes from policy updates when the pane closes", async () => {
    await render();
    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalled();
    root = createRoot(container);
  });
});
