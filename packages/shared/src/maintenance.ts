/** Repository maintenance is explicitly scoped; all profiles is opt-in. */
export type MaintenanceScope = { profileId: string; allProfiles?: boolean };
export type GarbageCollectionMode = "standard" | "keep-largest" | "aggressive";
export type MaintenanceRepo = {
  id: string;
  name: string;
  path: string;
  profileId: string;
  profileName: string;
};
export type StaleBranch = {
  repoId: string;
  branch: string;
  expectedHead: string;
  upstream: string;
};
export type MaintenanceAction =
  | { kind: "gc"; mode: GarbageCollectionMode }
  | { kind: "scan-branches" }
  | { kind: "delete-branches"; branches: StaleBranch[] };
export type MaintenanceRepoResult = {
  repo: MaintenanceRepo;
  outcome: "success" | "partial" | "skipped" | "failed" | "cancelled";
  message: string;
  beforeBytes?: number;
  afterBytes?: number;
  candidates?: StaleBranch[];
  branches?: { branch: string; deleted: boolean; message: string }[];
};
export type MaintenanceSummary = {
  operationId: string;
  startedAt: string;
  finishedAt: string;
  cancelled: boolean;
  results: MaintenanceRepoResult[];
};
export type MaintenanceProgress = {
  operationId: string;
  profileId: string;
  phase: "starting" | "repo_started" | "repo_progress" | "repo_completed";
  repos?: MaintenanceRepo[];
  repo?: MaintenanceRepo;
  detail?: string;
  result?: MaintenanceRepoResult;
};
