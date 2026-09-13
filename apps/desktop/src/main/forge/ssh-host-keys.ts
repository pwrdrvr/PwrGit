import { createHash } from "node:crypto";
import type { ForgeKind } from "@pwrgit/shared";

export type SshPublicKey = { algorithm: string; key: string; fingerprint: string };
export type PublishedSshHostKeys = {
  sourceUrl: string;
  keys: SshPublicKey[];
};
/** Separate from account SSH keys: this authenticates a server, without login. */
export interface ForgeSshHostKeyProvider {
  lookup(hostname: string, port: number): Promise<PublishedSshHostKeys | null>;
}

export function parseSshPublicKey(text: string): SshPublicKey | null {
  const parts = text.trim().split(/\s+/);
  const algorithm = parts[0];
  const key = parts[1];
  if (!algorithm || !key || !/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)$/.test(algorithm)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) return null;
  const bytes = Buffer.from(key, "base64");
  if (bytes.length < 8 || bytes.length > 16384) return null;
  let offset = 0;
  const field = (): Buffer | null => {
    if (offset + 4 > bytes.length) return null;
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    if (length > bytes.length - offset) return null;
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  if (field()?.toString() !== algorithm) return null;
  if (algorithm === "ssh-ed25519") {
    if (field()?.length !== 32) return null;
  } else if (algorithm === "ecdsa-sha2-nistp256") {
    if (field()?.toString() !== "nistp256") return null;
    const point = field();
    if (point?.length !== 65 || point[0] !== 4) return null;
  } else {
    const exponent = field();
    const modulus = field();
    if (!exponent?.length || exponent.length > 8 || !modulus || modulus.length < 128) return null;
  }
  if (offset !== bytes.length) return null;
  return { algorithm, key, fingerprint: `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}` };
}

async function publicText(url: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url, {
    redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10000),
    headers: { Accept: "application/json, text/html", "User-Agent": "PwrGit" }
  });
  if (!response.ok || response.body === null) throw new Error("Published SSH keys could not be retrieved.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 2_000_000) throw new Error("Published SSH key response was too large.");
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

export function createForgeSshHostKeyProviders(fetcher: typeof fetch = fetch): Record<ForgeKind, ForgeSshHostKeyProvider> {
  return {
    github: {
      async lookup(hostname, port) {
        if (hostname !== "github.com" || port !== 22) return null;
        const sourceUrl = "https://api.github.com/meta";
        const data = JSON.parse(await publicText(sourceUrl, fetcher)) as { ssh_keys?: unknown };
        if (!Array.isArray(data.ssh_keys)) throw new Error("GitHub did not return its SSH host keys.");
        const keys = data.ssh_keys.flatMap((value) => {
          const key = typeof value === "string" ? parseSshPublicKey(value) : null;
          return key === null ? [] : [key];
        });
        if (keys.length === 0) throw new Error("GitHub returned no recognized SSH host keys.");
        return { sourceUrl, keys };
      }
    },
    gitlab: {
      async lookup(hostname, port) {
        if (hostname !== "gitlab.com" || port !== 22) return null;
        const sourceUrl = "https://docs.gitlab.com/user/gitlab_com/";
        // Official documentation publishes literal known_hosts records. Fail
        // closed if its markup changes; never substitute a network keyscan.
        const text = (await publicText(sourceUrl, fetcher)).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");
        const records = text.match(/(?:^|\s)gitlab\.com\s+(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256)\s+[A-Za-z0-9+/=]+/g) ?? [];
        const keys = records.flatMap((record) => {
          const key = parseSshPublicKey(record.trim().replace(/^gitlab\.com\s+/, ""));
          return key === null ? [] : [key];
        });
        if (keys.length === 0) throw new Error("GitLab's published SSH host keys could not be parsed.");
        return { sourceUrl, keys };
      }
    },
    gitcafe: { async lookup() { return null; } }
  };
}
