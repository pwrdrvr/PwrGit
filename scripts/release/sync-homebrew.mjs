#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { isCliEntrypoint } from "../lib/cli-entrypoint.mjs";

const tap = "pwrdrvr/homebrew-tap";
const workflow = "bump-pwrgit.yml";
const workflowUrl = `https://github.com/${tap}/actions/workflows/${workflow}`;
function ghApi(endpoint, body, token) {
  const args = ["api", endpoint];
  if (body) args.push("--method", "POST", "--input", "-");
  try {
    const output = execFileSync("gh", args, {
      encoding: "utf8", input: body ? JSON.stringify(body) : undefined,
      env: token ? { ...process.env, GH_TOKEN: token } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output ? JSON.parse(output) : null;
  } catch (error) {
    if (!body && String(error.stderr).includes("(HTTP 404)")) return null;
    throw error;
  }
}
export async function syncHomebrew(version, {
  api = ghApi, dispatchToken = process.env.HOMEBREW_TAP_DISPATCH_TOKEN,
  pause = sleep, attempts = 40,
} = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Expected promoted stable X.Y.Z version");
  const source = `repos/${tap}/contents/Casks/pwrgit.rb?ref=main`;
  const latest = await api("repos/pwrdrvr/PwrGit/releases/latest");
  if (!latest || latest.draft || latest.prerelease || latest.tag_name !== `v${version}`) {
    throw new Error("Requested Homebrew target is no longer promoted Stable Latest");
  }
  const publishedVersion = async () => {
    const result = await api(source);
    return result ? Buffer.from(result.content, "base64").toString("utf8").match(/^  version "(\d+\.\d+\.\d+)"$/m)?.[1] : null;
  };
  if (await publishedVersion() === version) return { version, state: "published", workflowUrl };
  if (!dispatchToken) {
    throw new Error(`Homebrew has not published ${version}. Immediate dispatch needs HOMEBREW_TAP_DISPATCH_TOKEN (fine-grained PAT: pwrdrvr/homebrew-tap only, Actions write). The tap's 15-minute schedule also publishes validated updates after initial setup is merged. Check ${workflowUrl}; do not open a routine bump PR.`);
  }
  const remote = await api(`repos/${tap}/actions/workflows/${workflow}`);
  if (!remote || remote.state !== "active") throw new Error(`Homebrew publisher is not installed/active on tap main. Merge the tap setup before dispatching: ${workflowUrl}`);
  const dispatchedAt = Date.now();
  await api(`repos/${tap}/actions/workflows/${workflow}/dispatches`, { ref: "main", inputs: { version } }, dispatchToken);
  const currentRun = async () => {
    const runs = await api(`repos/${tap}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`);
    return runs?.workflow_runs.find((candidate) => candidate.display_title === `PwrGit Homebrew sync ${version}` &&
      Date.parse(candidate.created_at) >= dispatchedAt - 1000);
  };
  let run;
  for (let i = 0; i < attempts; i++) {
    if (await publishedVersion() === version) return { version, state: "published", workflowUrl };
    run = await currentRun();
    if (run?.status === "completed" && run.conclusion !== "success") {
      throw new Error(`Homebrew target ${version} failed: ${run.html_url}; status=${run.status}, conclusion=${run.conclusion}. Fix the failed step and dispatch the tap workflow again; the previous cask remains published.`);
    }
    await pause(30_000);
  }
  throw new Error(`Homebrew target ${version} is not on tap main after 20 minutes. Tap run: ${run?.html_url ?? workflowUrl}; status=${run?.status ?? "unknown"}, conclusion=${run?.conclusion ?? "pending"}. Inspect this run, fix its failed step, then dispatch the same workflow. No update PR approval is needed.`);
}
export async function runCli(args = process.argv.slice(2)) {
  const result = await syncHomebrew(args[0]);
  const summary = `Homebrew PwrGit ${result.version}: verified published on tap main. [Tap workflow](${result.workflowUrl}). Users receive it after brew update; client installation checks remain separate.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
if (isCliEntrypoint(import.meta.url)) runCli().catch((error) => {
  const summary = `Homebrew publication failed: ${error.message}\n`;
  console.error(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.exitCode = 1;
});
