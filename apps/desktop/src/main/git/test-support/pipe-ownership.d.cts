export type OwnershipCall = {
  callId: string;
  env: NodeJS.ProcessEnv;
  event(event: string, pid?: number, detail?: Record<string, unknown>): void;
};
export type OwnershipSession = {
  directory: string;
  privateDirectory: string;
  context: Record<string, unknown>;
  begin(args: string[], cwd: string, env: NodeJS.ProcessEnv, id?: string, controlled?: boolean): OwnershipCall | undefined;
  inspect(callId: string, phase: string, pid?: number): Promise<void>;
  close(): Promise<void>;
};
export function startOwnership(directory: string): Promise<OwnershipSession>;
export function beginOwnership(args: string[], cwd: string, env: NodeJS.ProcessEnv, id?: string): OwnershipCall | undefined;
export function sanitizeTrace(row: unknown): Record<string, unknown> | null;
