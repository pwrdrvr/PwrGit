// Ported from PwrAgnt (diagnostics/startup-cpu-profile-session.ts), minus the
// offline analysis artifacts — PwrGit writes the raw main/renderer
// .cpuprofile files (openable in Chrome DevTools) and an events log.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { StartupCpuProfileConfig } from "./startup-cpu-profile-config";

export type StartupCpuProfileSessionEvent = {
  source: "main" | "renderer";
  capturedAt: string;
  type: string;
  detail?: Record<string, unknown>;
};

export type StartupCpuProfileVersions = {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
};

type StartupCpuProfileManifest = {
  id: string;
  directoryName: string;
  createdAt: string;
  outputRoot: string;
  status: "running" | "completed" | "partial" | "failed";
  completedAt: string | null;
  mainProfile: { filename: string; capturedAt: string | null };
  rendererProfile: { filename: string; capturedAt: string | null };
  heapSnapshots: { enabled: boolean; files: string[] };
  config: {
    postLoadDurationMs: number;
    hardTimeoutMs: number;
    quitOnComplete: boolean;
    captureHeapSnapshots: boolean;
  };
  versions: StartupCpuProfileVersions;
};

export type StartupCpuProfileSession = {
  id: string;
  directoryName: string;
  directoryPath: string;
  manifestPath: string;
  eventsPath: string;
  mainProfilePath: string;
  rendererProfilePath: string;
  mainHeapSnapshotPath: string;
  rendererHeapSnapshotPath: string;
  appendEvent: (event: StartupCpuProfileSessionEvent) => Promise<void>;
  markProfileCaptured: (
    process: "main" | "renderer",
    capturedAt: string
  ) => Promise<void>;
  registerHeapSnapshot: (filename: string) => Promise<void>;
  complete: (params: {
    status: "completed" | "partial" | "failed";
    completedAt: string;
  }) => Promise<void>;
};

export type StartupCpuProfileSessionCreateResult =
  | { ok: true; session: StartupCpuProfileSession }
  | { ok: false; code: "SESSION_CREATE_FAILED"; message: string; cause: unknown };

function formatSessionPrefix(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}`;
}

function serializeNdjsonRecord(record: StartupCpuProfileSessionEvent): string {
  return `${JSON.stringify(record)}\n`;
}

async function writeManifest(
  manifestPath: string,
  manifest: StartupCpuProfileManifest
): Promise<void> {
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
}

export async function createStartupCpuProfileSession(options: {
  config: Extract<StartupCpuProfileConfig, { enabled: true }>;
  createdAt?: Date;
  sessionId?: string;
  versions: StartupCpuProfileVersions;
}): Promise<StartupCpuProfileSessionCreateResult> {
  const createdAt = options.createdAt ?? new Date();
  const sessionId = options.sessionId ?? randomBytes(3).toString("hex");
  const directoryName = `startup-cpu-${formatSessionPrefix(createdAt)}-${sessionId}`;
  const directoryPath = path.join(options.config.outputRoot, directoryName);
  const manifestPath = path.join(directoryPath, "session.json");
  const eventsPath = path.join(directoryPath, "events.ndjson");
  const mainProfilePath = path.join(directoryPath, "main.cpuprofile");
  const rendererProfilePath = path.join(directoryPath, "renderer.cpuprofile");
  const mainHeapSnapshotPath = path.join(directoryPath, "main.heapsnapshot");
  const rendererHeapSnapshotPath = path.join(
    directoryPath,
    "renderer.heapsnapshot"
  );

  const manifest: StartupCpuProfileManifest = {
    id: sessionId,
    directoryName,
    createdAt: createdAt.toISOString(),
    outputRoot: options.config.outputRoot,
    status: "running",
    completedAt: null,
    mainProfile: { filename: path.basename(mainProfilePath), capturedAt: null },
    rendererProfile: {
      filename: path.basename(rendererProfilePath),
      capturedAt: null
    },
    heapSnapshots: { enabled: options.config.captureHeapSnapshots, files: [] },
    config: {
      postLoadDurationMs: options.config.postLoadDurationMs,
      hardTimeoutMs: options.config.hardTimeoutMs,
      quitOnComplete: options.config.quitOnComplete,
      captureHeapSnapshots: options.config.captureHeapSnapshots
    },
    versions: options.versions
  };

  try {
    await fs.mkdir(options.config.outputRoot, { recursive: true });
    await fs.mkdir(directoryPath);
    await writeManifest(manifestPath, manifest);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "SESSION_CREATE_FAILED",
      message: `Unable to create startup CPU profiling session in ${options.config.outputRoot}: ${reason}`,
      cause: error
    };
  }

  let manifestWriteQueue = Promise.resolve();

  async function updateManifest(
    mutator: (current: StartupCpuProfileManifest) => void
  ): Promise<void> {
    manifestWriteQueue = manifestWriteQueue.then(async () => {
      mutator(manifest);
      await writeManifest(manifestPath, manifest);
    });
    await manifestWriteQueue;
  }

  return {
    ok: true,
    session: {
      id: sessionId,
      directoryName,
      directoryPath,
      manifestPath,
      eventsPath,
      mainProfilePath,
      rendererProfilePath,
      mainHeapSnapshotPath,
      rendererHeapSnapshotPath,
      appendEvent: async (event) => {
        await fs.appendFile(eventsPath, serializeNdjsonRecord(event), "utf8");
      },
      markProfileCaptured: async (processName, capturedAtValue) => {
        await updateManifest((current) => {
          if (processName === "main") {
            current.mainProfile.capturedAt = capturedAtValue;
          } else {
            current.rendererProfile.capturedAt = capturedAtValue;
          }
        });
      },
      registerHeapSnapshot: async (filename) => {
        await updateManifest((current) => {
          if (!current.heapSnapshots.files.includes(filename)) {
            current.heapSnapshots.files.push(filename);
          }
        });
      },
      complete: async ({ status, completedAt: completedAtValue }) => {
        await updateManifest((current) => {
          current.status = status;
          current.completedAt = completedAtValue;
        });
      }
    }
  };
}
