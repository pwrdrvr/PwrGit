import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createPwrGitMcpServer,
  FixedMcpAuthorizer,
  fullAccessAuthorization,
} from "@pwrgit/mcp-server";
import { expect, it } from "vitest";
import { ChatGptAuth } from "./chatgpt-auth";

it("keeps SIWC credentials out of MCP resources and exposes no plan completion tool", async () => {
  const original = process.env.ACCESS_TOKEN;
  const auth = new ChatGptAuth(
    {
      hostId: () => "urn:uuid:fixture",
      read: () => ({
        clientId: "oaiapp_fixture",
        subject: "fixture",
        label: "Fixture",
        welcomed: true,
        credential: {
          clientId: "oaiapp_fixture",
          subject: "fixture",
          label: "Fixture",
          accessToken: "plan-access-fixture",
          refreshToken: "plan-refresh-fixture",
          idToken: "plan-id-fixture",
          scopes: ["chatgpt.tokens.use.direct"],
          expiresAt: Date.now() + 3600000,
        },
      }),
      write: () => {},
    },
    async () => {},
  );
  expect((await auth.credential("work")).accessToken).toBe(
    "plan-access-fixture",
  );
  const server = await createPwrGitMcpServer({
    authorizer: new FixedMcpAuthorizer(fullAccessAuthorization()),
    appBackend: {
      catalog: () => ({
        activeProfileId: "work",
        profiles: [{ id: "work", name: "Fixture", roots: [] }],
        repositories: [],
      }),
      open: async () => {},
      refresh: async () => {},
    },
  });
  const client = new Client({ name: "fixture", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const resources = await client.listResources();
    expect(tools.tools.map((tool) => tool.name).join(" ")).not.toMatch(
      /chatgpt|completion|responses|draft_message|tidy_plan/,
    );
    expect(JSON.stringify({ tools, resources })).not.toMatch(
      /plan-access-fixture|plan-refresh-fixture|plan-id-fixture/,
    );
    const result = await client.callTool({
      name: "pwrgit_app_repositories",
      arguments: {},
    });
    expect(JSON.stringify(result)).not.toMatch(
      /plan-access-fixture|plan-refresh-fixture|plan-id-fixture/,
    );
    expect(process.env.ACCESS_TOKEN).toBe(original);
  } finally {
    await client.close();
    await server.close();
  }
});
