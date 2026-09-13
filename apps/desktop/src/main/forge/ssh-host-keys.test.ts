import { expect, it, vi } from "vitest";
import { createForgeSshHostKeyProviders, parseSshPublicKey } from "./ssh-host-keys";
const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 2)]).toString("base64");
const key = `ssh-ed25519 ${blob}`;
it("reads GitHub's authless meta endpoint without credentials or redirects", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ssh_keys: [key] })));
  const found = await createForgeSshHostKeyProviders(fetcher).github.lookup("github.com", 22);
  expect(found?.keys).toEqual([parseSshPublicKey(key)]);
  expect(fetcher).toHaveBeenCalledWith("https://api.github.com/meta", expect.objectContaining({ credentials: "omit", redirect: "error" }));
  expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
});
it("extracts only GitLab.com known_hosts records from official documentation", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(`<pre><span>gitlab.com</span> ${key}\nother.example ${key}</pre>`));
  const found = await createForgeSshHostKeyProviders(fetcher).gitlab.lookup("gitlab.com", 22);
  expect(found?.keys).toHaveLength(1);
  expect(found?.sourceUrl).toBe("https://docs.gitlab.com/user/gitlab_com/");
});
it("does not apply SaaS keys to another host or port, and leaves GitCafe unknown", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const providers = createForgeSshHostKeyProviders(fetcher);
  expect(await providers.github.lookup("ghe.example", 22)).toBeNull();
  expect(await providers.github.lookup("github.com", 2222)).toBeNull();
  expect(await providers.gitlab.lookup("gitlab.internal", 22)).toBeNull();
  expect(await providers.gitcafe.lookup("git.cafe", 22)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it("fails explicitly on missing data, fetch errors and changed documentation markup", async () => {
  const providers = createForgeSshHostKeyProviders(async () => new Response("<html>sign in</html>"));
  await expect(providers.github.lookup("github.com", 22)).rejects.toThrow();
  await expect(providers.gitlab.lookup("gitlab.com", 22)).rejects.toThrow("could not be parsed");
  const offline = createForgeSshHostKeyProviders(async () => new Response("", { status: 503 }));
  await expect(offline.github.lookup("github.com", 22)).rejects.toThrow("retrieved");
});
it("rejects malformed keys and algorithm/blob mismatches", () => {
  expect(parseSshPublicKey(`ssh-rsa ${blob}`)).toBeNull();
  expect(parseSshPublicKey("ssh-ed25519 !!!")).toBeNull();
  expect(parseSshPublicKey("ssh-ed25519 AAAA")).toBeNull();
});
