import { mkdir } from "node:fs/promises";
import {
  JsonRpcConnection,
  StdioJsonRpcTransport,
  type JsonRpcTransport,
} from "@pwrdrvr/agent-transport";
import {
  DISABLE_CODING_AGENT_THREAD_CONFIG,
  type CodexOneShotRequest,
  type CodexOneShotResponse,
} from "@pwrdrvr/agent-client";
import type { ChatGptCredential } from "./chatgpt-auth";
import type { StructuredAgentClient } from "./agent-session";

export const CHATGPT_CODEX_ARGS = [
  "app-server",
  "--listen",
  "stdio://",
  ...Object.entries({
    model_provider: "openai_chatgpt_plan",
    "model_providers.openai_chatgpt_plan.name": "ChatGPT plan",
    "model_providers.openai_chatgpt_plan.base_url": "https://api.openai.com/v1",
    "model_providers.openai_chatgpt_plan.env_key": "ACCESS_TOKEN",
    "model_providers.openai_chatgpt_plan.wire_api": "responses",
    "model_providers.openai_chatgpt_plan.requires_openai_auth": false,
    "model_providers.openai_chatgpt_plan.supports_websockets": false,
  }).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
];
export class ChatGptPlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function chatGptFailure(value: unknown): ChatGptPlanError {
  // Do not expose error bodies or diagnostics, which can contain credentials.
  const text = JSON.stringify(value) ?? "";
  if (text.includes("subscription_sharing_usage_limit_exceeded"))
    return new ChatGptPlanError(
      "subscription_sharing_usage_limit_exceeded",
      "ChatGPT plan usage limit reached. Manage usage to review your app limit.",
    );
  if (text.includes("subscription_sharing_user_not_eligible"))
    return new ChatGptPlanError(
      "subscription_sharing_user_not_eligible",
      "This ChatGPT account is not eligible for plan usage.",
    );
  if (/subscription_sharing_(usage_unavailable|user_unavailable)/.test(text))
    return new ChatGptPlanError(
      "chatgpt_unavailable",
      "ChatGPT plan usage is unavailable. Try again later.",
    );
  return new ChatGptPlanError(
    "chatgpt_failed",
    "ChatGPT could not complete this request. Check plan permissions or sign in again.",
  );
}
type Thread = { id: string; model: string; key: string };
type Notification = {
  threadId?: string;
  turnId?: string;
  item?: { type: string; text?: string };
  turn?: { id: string; status: string; error?: unknown };
};
type Pending = {
  threadId: string;
  turnId?: string;
  text: string;
  early: Array<{ method: string; params: Notification }>;
  resolve: () => void;
  reject: (error: Error) => void;
};
/** Purpose-bound client: no tools, no MCP, no shared credentials, no diagnostic logger. */
export class ChatGptCodexClient implements StructuredAgentClient {
  private connection: JsonRpcConnection | undefined;
  private token: string | undefined;
  private thread?: Thread;
  private pending: Pending | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly options: {
      command: string;
      env: NodeJS.ProcessEnv;
      workspaceDir: string;
      version: string;
      credential: () => Promise<ChatGptCredential>;
      transport?: (env: NodeJS.ProcessEnv, args: string[]) => JsonRpcTransport;
    },
  ) {}
  run(request: CodexOneShotRequest): Promise<CodexOneShotResponse> {
    const run = this.queue
      .then(() => this.perform(request))
      .catch((cause: unknown) => {
        if (cause instanceof ChatGptPlanError || cause instanceof DOMException)
          throw cause;
        throw new ChatGptPlanError(
          "chatgpt_failed",
          "ChatGPT could not complete this request. Continue with ChatGPT again or check your connection.",
        );
      });
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async connect(accessToken: string): Promise<JsonRpcConnection> {
    if (this.connection && this.token === accessToken) return this.connection;
    await this.connection?.close();
    this.connection = undefined;
    const env: NodeJS.ProcessEnv = {
      ...this.options.env,
      ACCESS_TOKEN: accessToken,
    };
    if (env.CODEX_HOME)
      await mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
    // The token exists only in this child's environment, never process.env.
    const transport =
      this.options.transport?.(env, CHATGPT_CODEX_ARGS) ??
      new StdioJsonRpcTransport({
        command: this.options.command,
        args: CHATGPT_CODEX_ARGS,
        env,
      });
    const connection = new JsonRpcConnection(transport, 30_000);
    connection.setRequestHandler(async () => ({
      decision: "denied",
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "PwrGit does not expose tools in this job.",
        },
      ],
    }));
    connection.setNotificationHandler((method, raw) =>
      this.handleNotification(method, raw as Notification),
    );
    try {
      await connection.connect();
      await connection.request("initialize", {
        clientInfo: {
          name: "PwrGit",
          title: "PwrGit",
          version: this.options.version,
        },
        capabilities: { experimentalApi: true },
      });
      await connection.notify("initialized", {});
      if (this.thread)
        await connection.request("thread/resume", {
          threadId: this.thread.id,
          approvalPolicy: "never",
          sandbox: "read-only",
          config: DISABLE_CODING_AGENT_THREAD_CONFIG,
          environments: [],
        });
      this.connection = connection;
      this.token = accessToken;
      return connection;
    } catch {
      await connection.close();
      throw new ChatGptPlanError(
        "chatgpt_start_failed",
        "ChatGPT app-server could not start. Check your Codex installation.",
      );
    }
  }
  private handleNotification(method: string, params: Notification): void {
    if (method !== "item/completed" && method !== "turn/completed") return;
    const pending = this.pending;
    if (!pending || params.threadId !== pending.threadId) return;
    if (pending.turnId === undefined) {
      if (pending.early.length < 100) pending.early.push({ method, params });
      return;
    }
    if (
      method === "item/completed" &&
      params.turnId === pending.turnId &&
      params.item?.type === "agentMessage"
    )
      pending.text = params.item.text ?? "";
    if (method === "turn/completed" && params.turn?.id === pending.turnId) {
      if (params.turn.status === "completed" && pending.text) pending.resolve();
      else pending.reject(chatGptFailure(params.turn.error));
    }
  }
  private async perform(
    request: CodexOneShotRequest,
  ): Promise<CodexOneShotResponse> {
    if (request.abortSignal?.aborted)
      throw new DOMException("Cancelled", "AbortError");
    const credential = await this.options.credential();
    const connection = await this.connect(credential.accessToken);
    await mkdir(this.options.workspaceDir, { recursive: true });
    const key = JSON.stringify([request.model, request.baseInstructions]);
    if (!this.thread || this.thread.key !== key) {
      const result = (await connection.request("thread/start", {
        model: request.model ?? null,
        modelProvider: "openai_chatgpt_plan",
        cwd: this.options.workspaceDir,
        runtimeWorkspaceRoots: [this.options.workspaceDir],
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: request.baseInstructions,
        config: DISABLE_CODING_AGENT_THREAD_CONFIG,
        environments: [],
        dynamicTools: [],
      })) as { thread: { id: string }; model: string };
      this.thread = { id: result.thread.id, model: result.model, key };
    }
    if (request.abortSignal?.aborted)
      throw new DOMException("Cancelled", "AbortError");
    const thread = this.thread;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      this.pending?.reject(new DOMException("Cancelled", "AbortError"));
      void this.close();
    };
    const completed = new Promise<void>((resolve, reject) => {
      this.pending = {
        threadId: thread.id,
        text: "",
        early: [],
        resolve,
        reject,
      };
      timer = setTimeout(() => {
        reject(
          new ChatGptPlanError("timeout", "ChatGPT did not finish in time."),
        );
        void this.close();
      }, 150_000);
    });
    void completed.catch(() => undefined);
    request.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      const result = (await connection.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: request.prompt }],
        effort: request.effort ?? "low",
        outputSchema: request.outputSchema,
      })) as { turn: { id: string } };
      this.pending!.turnId = result.turn.id;
      for (const event of this.pending!.early.splice(0))
        this.handleNotification(event.method, event.params);
      await completed;
      const text = this.pending!.text;
      await connection.request("thread/rollback", {
        threadId: thread.id,
        numTurns: 1,
      });
      return {
        rawText: text,
        model: thread.model,
        modelProvider: "openai_chatgpt_plan",
        threadId: thread.id,
        turnId: result.turn.id,
        userAgent: "PwrGit",
        serviceTier: null,
        tokenUsage: null,
      };
    } catch (cause) {
      await this.close();
      delete this.thread;
      if (cause instanceof ChatGptPlanError || cause instanceof DOMException)
        throw cause;
      throw chatGptFailure(cause instanceof Error ? cause.message : cause);
    } finally {
      clearTimeout(timer);
      request.abortSignal?.removeEventListener("abort", abort);
      this.pending = undefined;
    }
  }
  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.token = undefined;
    this.pending?.reject(
      new ChatGptPlanError("cancelled", "ChatGPT request stopped."),
    );
    await connection?.close();
  }
}
