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

/** The pane embeds AgentAccessSection, which reads its own state on mount.
 * Every dispatch mock in this file needs to answer that call; anything else is
 * still an unexpected command. */
function agentAccessFallback(name: string): Promise<unknown> {
  if (name === "agentAccess:read") {
    return Promise.resolve(
      ok({
        enabled: false,
        listening: false,
        mcpUrl: "http://127.0.0.1:51731/mcp",
        pending: []
      })
    );
  }
  throw new Error(`unexpected command ${name}`);
}

let container: HTMLDivElement;
let root: Root;
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscribe.mockReturnValue(unsubscribe);
  mocks.dispatch.mockImplementation((name: string) => {
    if (name === "localAgents:read") return Promise.resolve(ok(snapshot));
    return agentAccessFallback(name);
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

  it.each([
    ["Edit selected role", "localAgents:roleUpdate"],
    ["Duplicate selected role", "localAgents:roleCreate"]
  ])("%s preserves full role permissions for a narrowly consented Session", async (buttonText, command) => {
    const scopedSnapshot: McpAgentPolicySnapshot = {
      ...snapshot,
      sessions: [{ ...snapshot.sessions[0]!, oauth: { clientId: "fixture", scopes: ["repository.roots.read"] } }]
    };
    mocks.dispatch.mockImplementation((name: string) => {
      if (name === "localAgents:read") return Promise.resolve(ok(scopedSnapshot));
      if (name === command) return Promise.resolve(ok(snapshot.roles[1]!));
      return agentAccessFallback(name);
    });
    await render();
    expect(container.querySelectorAll(".agent-auth-permission.is-allowed")).toHaveLength(1);
    const button = (text: string) => Array.from(container.querySelectorAll("button"))
      .find(candidate => candidate.textContent === text)!;
    await act(async () => button(buttonText).click());
    const editor = container.querySelector(".agent-role-editor")!;
    expect(editor.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(MCP_AGENT_CAPABILITIES.length);
    const description = Array.from(editor.querySelectorAll("label"))
      .find(label => label.textContent === "Description")!.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(description, "Updated description");
      description.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save role").click());
    const expected = expect.objectContaining({
      description: "Updated description", permissions: [...MCP_AGENT_CAPABILITIES]
    });
    expect(mocks.dispatch).toHaveBeenCalledWith(command, command === "localAgents:roleUpdate"
      ? { id: "role_scoped", patch: expected } : expected);
  });

  it("offers OAuth connection commands instead of manual token creation", async () => {
    await render();
    expect(container.textContent).toContain("Connect an agent");
    expect(container.textContent).not.toContain("Create Session");
    expect(mocks.dispatch).not.toHaveBeenCalledWith("localAgents:createSession", expect.anything());
  });

  it("revokes a Session through the typed command bus", async () => {
    mocks.dispatch.mockImplementation((name: string) => {
      if (name === "localAgents:read") return Promise.resolve(ok(snapshot));
      if (name === "localAgents:revoke") {
        return Promise.resolve(ok({ ...snapshot.sessions[0]!, revokedAt: "now" }));
      }
      return agentAccessFallback(name);
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
