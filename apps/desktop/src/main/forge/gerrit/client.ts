import { gerritReviewUrl } from "@pwrgit/shared";
import type { ForgeRepo } from "../types";
import { forgeRetryDelayMs } from "../retry";

export class GerritError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type GerritGet = (repo: ForgeRepo, path: string) => Promise<unknown>;

/** Anonymous reads only: never forward Git/Google credentials or redirects. */
export const gerritGet: GerritGet = async (repo, path) => {
  const base = gerritReviewUrl(repo.host, repo.reviewUrl, repo.port);
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${base}/${path}`, {
      headers: { Accept: "application/json" },
      redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      const delay = forgeRetryDelayMs({ kind: "gerrit", status: response.status, header: (key) => response.headers.get(key) ?? undefined, attempt });
      if (attempt < 2 && delay !== null && delay <= 15_000) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new GerritError(response.status, `Gerrit public read failed (HTTP ${response.status}).`);
    }
    const reader = response.body?.getReader();
    if (reader === undefined) throw new GerritError(0, "Gerrit returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) throw new GerritError(0, "Gerrit response exceeded the size limit.");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text.startsWith(")]}'\n")) throw new GerritError(0, "Gerrit returned an invalid JSON response.");
    try { return JSON.parse(text.slice(5)) as unknown; }
    catch { throw new GerritError(0, "Gerrit returned invalid JSON."); }
  }
};
