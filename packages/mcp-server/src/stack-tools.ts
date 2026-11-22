import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpAccessError, type McpAuthorizer, type McpAgentCapability } from "./access-policy.js";
import type { AppBackend } from "./app-tools.js";

const template = "pwrgit://repository/{repoId}/stacks";
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const resourcePattern = /^pwrgit:\/\/repository\/([a-zA-Z0-9_.%-]+)\/stacks$/;

export class StackResources {
  private readonly subscriptions = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly mcp: McpServer,
    private readonly backend: AppBackend,
    private readonly authorizer: McpAuthorizer,
    private readonly supportsSubscriptions: boolean,
  ) {
    mcp.registerTool("pwrgit_stack_list", {
      description: "Read the tracked and inferred stacks for an authorized PwrGit repository ID.",
      inputSchema: { repoId: z.string().min(1).max(200) }, annotations: readOnly,
    }, async ({ repoId }) => this.result({
      ...await this.load(repoId),
      resourceUri: `pwrgit://repository/${encodeURIComponent(repoId)}/stacks`,
    }));
    mcp.registerTool("pwrgit_stack_get", {
      description: "Read one stack and branch health by the ID from pwrgit_stack_list.",
      inputSchema: { repoId: z.string().min(1).max(200), stackId: z.string().min(1).max(1500) }, annotations: readOnly,
    }, async ({ repoId, stackId }) => {
      const snapshot = await this.load(repoId);
      const stack = snapshot.stacks.find(entry => entry.id === stackId);
      if (!stack) throw new Error("Stack is no longer available in this repository");
      return this.result({ stack, readOnly: snapshot.readOnly, busy: snapshot.busy });
    });
    mcp.registerResource("pwrgit-repository-stacks", new ResourceTemplate(template, { list: undefined }), {
      title: "PwrGit repository stacks",
      description: "Tracked and inferred stacks. Obtain the concrete URI from pwrgit_stack_list.",
      mimeType: "application/json",
    }, async (uri) => ({
      contents: [{ uri: uri.toString(), mimeType: "application/json",
        text: JSON.stringify(await this.load(this.repoId(uri.toString()), true)) }],
    }));
  }

  private result(value: Record<string, unknown>) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
  }

  handles(uri: string): boolean {
    return resourcePattern.test(uri);
  }

  private repoId(uri: string): string {
    const match = resourcePattern.exec(uri);
    if (!match) throw new Error("Invalid stacks resource URI");
    return decodeURIComponent(match[1]);
  }

  private async load(repoId: string, resource = false) {
    const capabilities: McpAgentCapability[] = resource ? ["repository.stack.read", "status.subscribe"] : ["repository.stack.read"];
    await this.authorizer.authorize({ capabilities });
    const catalog = await this.backend.catalog();
    const repo = catalog.repositories.find(candidate => candidate.id === repoId);
    if (!repo) throw new Error("Repository unavailable or outside the Session's scope.");
    await this.authorizer.authorize({ capabilities, repositoryPaths: [repo.path] });
    if (!this.backend.stackList) throw new Error("The desktop does not provide stacks");
    return this.backend.stackList(repo);
  }

  async subscribe(uri: string) {
    const id = this.repoId(uri);
    let previous = JSON.stringify(await this.load(id, true));
    if (!this.supportsSubscriptions || this.subscriptions.has(uri)) return;
    if (this.subscriptions.size >= 64) throw new Error("Stack watch limit reached");
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void this.load(id, true).then(async snapshot => {
        const next = JSON.stringify(snapshot);
        if (next !== previous && this.subscriptions.get(uri) === timer) {
          previous = next;
          await this.mcp.server.sendResourceUpdated({ uri });
        }
      }).catch(error => {
        if (error instanceof McpAccessError && this.subscriptions.get(uri) === timer) this.unsubscribe(uri);
      }).finally(() => { polling = false; });
    }, 15_000);
    timer.unref();
    this.subscriptions.set(uri, timer);
  }

  unsubscribe(uri: string) {
    clearInterval(this.subscriptions.get(uri));
    this.subscriptions.delete(uri);
  }

  close() {
    for (const uri of this.subscriptions.keys()) this.unsubscribe(uri);
  }
}
