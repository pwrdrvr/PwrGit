// Public reads only. gh obtains GH_TOKEN from the calling step's environment;
// neither credentials nor raw subprocess/API errors enter the report or logs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function ghRequest(path, { execute = execFileAsync } = {}) {
  let output;
  try {
    output = (await execute("gh", ["api", "--include", path], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 45_000,
      env: { ...process.env, GH_DEBUG: "" },
    })).stdout;
  } catch (error) {
    // gh includes the HTTP response on stdout even for non-2xx responses.
    output = error.stdout ?? "";
  }
  const split = /\r?\n\r?\n/.exec(output);
  const status = Number(/^HTTP\/[\d.]+\s+(\d+)/.exec(output)?.[1] ?? 0);
  if (!split || !status) return { status: 0, headers: {}, body: null };
  const headers = Object.fromEntries(output.slice(0, split.index).split(/\r?\n/)
    .slice(1).map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
  let body;
  try {
    body = JSON.parse(output.slice(split.index + split[0].length));
  } catch {
    return { status: 0, headers: {}, body: null };
  }
  return { status, headers, body };
}

export function makeApi({ request = ghRequest, sleep = pause, now = Date.now } = {}) {
  return async (path, { allow404 = false, search = false } = {}) => {
    let waited = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { status, headers, body } = await request(path);
      const incomplete = search && status === 200 && body?.incomplete_results !== false;
      if (status === 200 && !incomplete) return body;
      if (status === 404 && allow404) return null;
      const limited = status === 429 || (status === 403 &&
        (headers["retry-after"] || headers["x-ratelimit-remaining"] === "0" ||
          /rate limit|secondary|abuse/i.test(body?.message ?? "")));
      const transient = status === 0 || status >= 500;
      const reason = incomplete ? "incomplete search" : limited ? "throttled" : `HTTP ${status || "unavailable"}`;
      if ((!limited && !incomplete && !transient) || attempt === 2) {
        throw new Error(`Audit blocked: ${reason} at ${path.split("?")[0]}; no absence conclusion`);
      }
      let delay = (limited || incomplete) ? 60_000 * (attempt + 1) : 1_000 * (attempt + 1);
      const retryAfter = Number(headers["retry-after"]);
      const reset = Number(headers["x-ratelimit-reset"]);
      if (Number.isFinite(retryAfter) && retryAfter > 0) delay = Math.max(delay, retryAfter * 1000);
      if (headers["x-ratelimit-remaining"] === "0" && Number.isFinite(reset)) {
        delay = Math.max(delay, reset * 1000 - now());
      }
      if (delay > 120_000 || waited + delay > 180_000) throw new Error(`Audit blocked: retry delay exceeds 120s per-wait / 180s total budget; ${reason}; no absence conclusion`);
      waited += delay;
      console.error(`Audit retry ${attempt + 1}/2: ${reason} at ${path.split("?")[0]}; waiting ${Math.ceil(delay / 1000)}s`);
      await sleep(delay);
    }
  };
}

export async function searchAll(api, kind, query) {
  const items = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= 10; page++) {
    const result = await api(`search/${kind}?q=${encodeURIComponent(query)}&per_page=100&page=${page}`, { search: true });
    if (result.incomplete_results !== false || !Number.isInteger(result.total_count) || result.total_count < 0 || !Array.isArray(result.items) || result.total_count > 1000) {
      throw new Error("Audit blocked: malformed or truncated search; narrow the query; no absence conclusion");
    }
    total ??= result.total_count;
    if (result.total_count !== total) throw new Error("Audit blocked: search changed during pagination; rerun; no absence conclusion");
    for (const item of result.items) {
      const key = item.html_url ?? item.id ?? item.path;
      if (key === undefined || seen.has(key)) throw new Error("Audit blocked: duplicate or malformed search page; rerun; no absence conclusion");
      seen.add(key);
    }
    items.push(...result.items);
    if (items.length === total) return items;
    if (!result.items.length || items.length > total) break;
  }
  throw new Error("Audit blocked: incomplete search pagination; no absence conclusion");
}

