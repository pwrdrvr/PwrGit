import type { AppIdentity, DiagnosticsRepositoryContext } from "@pwrgit/shared";
import { releaseLabel } from "./app-identity";

/**
 * Help → Copy Diagnostics Info. One report answers "which PwrGit, which
 * process, which files, which Git" without a follow-up question: the build
 * and the checkout it came from, every pid, every path a support reply would
 * ask for, and the repository the window was showing.
 */

/** Read once at startup: a dev checkout can change branch under a running app. */
export type DiagnosticsBuild =
  | { kind: "packaged" }
  | {
      kind: "development";
      checkoutPath?: string;
      branch?: string;
      commitSha?: string;
      detachedHead?: boolean;
    };

export type DiagnosticsGit = {
  source: "bundled" | "installed";
  path: string;
  /** `git --version` / `git lfs version` output; null when it did not answer. */
  version: string | null;
  lfs: string | null;
  keychainHelper: string | null;
};

export type DiagnosticsInput = {
  collectedAt: Date;
  identity: AppIdentity;
  build: DiagnosticsBuild;
  executablePath: string;
  appPath: string;
  chromeVersion: string;
  nodeVersion: string;
  /** The profile window the report is about; null when none is open. */
  profile: { id: string; name: string } | null;
  openProfiles: string[];
  /** Undefined when no window was asked; null when it showed no repository. */
  repository?: DiagnosticsRepositoryContext | null;
  mainPid: number;
  rendererPid: number | null;
  /** formatProcessIds' line, the same one main.log records. */
  processTable: string;
  paths: {
    log: string | null;
    userData: string;
    database: string;
    settings: string;
    diagnosticsOutput: string;
  };
  git: DiagnosticsGit;
};

export type DiagnosticsReport = { text: string; html: string };

type Row = [label: string, value: string];
type Section = { title: string; rows: Row[] };

function available(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? "Unavailable" : trimmed;
}

function appSection(input: DiagnosticsInput): Section {
  const { identity, build } = input;
  const rows: Row[] = [
    ["Version", `${identity.name} ${identity.version}`],
    ["Release", releaseLabel(identity.release)],
    ["Build", build.kind === "packaged" ? "Packaged" : "Development"],
    ["Executable", input.executablePath],
    ["App path", input.appPath]
  ];
  if (build.kind === "development") {
    rows.push(
      ["Development checkout", available(build.checkoutPath)],
      [
        "Development branch (startup)",
        build.detachedHead === true ? "Detached HEAD" : available(build.branch)
      ],
      ["Development commit (startup)", available(build.commitSha)]
    );
  }
  return { title: "App", rows };
}

function platformSection(input: DiagnosticsInput): Section {
  const { platform } = input.identity;
  return {
    title: "Platform",
    rows: [
      ["OS", `${platform.name} ${platform.version} (${platform.arch})`],
      ["Electron", input.identity.electronVersion],
      ["Chrome", input.chromeVersion],
      ["Node", input.nodeVersion]
    ]
  };
}

function windowSection(input: DiagnosticsInput): Section {
  const rows: Row[] = [
    [
      "Profile",
      input.profile === null
        ? "No profile window open"
        : `${input.profile.name} (${input.profile.id})`
    ],
    [
      "Open profile windows",
      input.openProfiles.length === 0 ? "None" : input.openProfiles.join(", ")
    ]
  ];
  const repo = input.repository;
  if (repo === undefined) {
    rows.push(["Repository", "Unavailable (no window answered)"]);
  } else if (repo === null) {
    rows.push(["Repository", "None selected"]);
  } else {
    rows.push(
      ["Repository", repo.name],
      ["Repository path", repo.path],
      ["Worktree path", available(repo.worktreePath)],
      ["Branch", available(repo.branch)]
    );
  }
  return { title: "Window", rows };
}

function processSection(input: DiagnosticsInput): Section {
  return {
    title: "Processes",
    rows: [
      ["Main PID", String(input.mainPid)],
      [
        "Renderer PID",
        input.rendererPid === null ? "Unavailable" : String(input.rendererPid)
      ],
      ["All processes", available(input.processTable)]
    ]
  };
}

function pathSection(input: DiagnosticsInput): Section {
  const { paths } = input;
  return {
    title: "Paths",
    rows: [
      ["Log file", available(paths.log)],
      ["User data", paths.userData],
      ["Database", paths.database],
      ["Settings", paths.settings],
      ["Diagnostics output", paths.diagnosticsOutput]
    ]
  };
}

function gitSection(input: DiagnosticsInput): Section {
  const { git } = input;
  const rows: Row[] = [
    ["Git", git.source === "bundled" ? "Bundled" : "Installed (chosen in Settings)"],
    ["Git executable", git.path],
    ["Git version", available(git.version)],
    ["Git LFS version", available(git.lfs)]
  ];
  if (git.keychainHelper !== null) {
    rows.push(["Keychain helper", git.keychainHelper]);
  }
  return { title: "Git", rows };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Plain text for terminals and issue forms; a code block for rich editors. */
export function buildDiagnosticsReport(input: DiagnosticsInput): DiagnosticsReport {
  const sections = [
    appSection(input),
    platformSection(input),
    windowSection(input),
    processSection(input),
    pathSection(input),
    gitSection(input)
  ];
  const text = [
    `PwrGit diagnostics — collected ${input.collectedAt.toISOString()}`,
    ...sections.map((section) =>
      [
        "",
        `[${section.title}]`,
        ...section.rows.map(([label, value]) => `${label}: ${value}`)
      ].join("\n")
    )
  ].join("\n");
  // Code-block HTML is what PwrAgnt copies too: GitHub, Slack and Docs keep it
  // monospaced and unwrapped, so a pasted path stays one selectable line.
  return { text, html: `<pre><code>${escapeHtml(text)}</code></pre>` };
}
