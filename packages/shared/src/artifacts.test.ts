import { describe, expect, it } from "vitest";
import { artifactsTokenExpiry, parseArtifactsRemote } from "./artifacts";
import { classifyForgeHost, forgeCloneUrls, forgeWebUrl, parseForgeRemote } from "./forge-remote";
import { forgeProduct } from "./forge-product";

const hostname = "0123456789abcdef0123456789abcdef.artifacts.cloudflare.net";
const remote = `https://${hostname}/git/default/demo.git`;

describe("documented Artifacts Git coordinates", () => {
  it("requires an explicit host mapping and removes the Git route prefix", () => {
    expect(classifyForgeHost(hostname)).toBe("other");
    expect(parseForgeRemote(remote)?.host).toBe("other");
    expect(parseForgeRemote(remote, { [hostname]: "artifacts" })).toMatchObject({
      host: "artifacts", hostname, owner: "default", repo: "demo", nameWithOwner: "default/demo"
    });
    expect(parseArtifactsRemote(remote)).toEqual({ remote, hostname, namespace: "default", repo: "demo" });
  });
  it.each([
    remote.replace("https:", "http:"), remote.replace("https:", "ssh:"),
    remote.replace("https://", "https://x:secret@"), `${remote}?token=secret`, `${remote}#fragment`,
    remote.replace("/git/", "/"), remote.replace("/default/", "/a/"),
    remote.replace("/default/", "/../"), remote.replace("demo.git", "demo%2Fother.git"),
    remote.replace(".net/", ".net:443/")
  ])("rejects a non-contract or credential-bearing remote: %s", (value) => {
    expect(parseArtifactsRemote(value)).toBeNull();
    expect(parseForgeRemote(value, { [hostname]: "artifacts" })).toBeNull();
  });
  it("keeps valid case and punctuation in repository names", () => {
    expect(parseArtifactsRemote(`https://${hostname}/git/team-1/App_v2.test.git`)?.repo).toBe("App_v2.test");
    expect(parseArtifactsRemote(`https://${hostname}/git/default/a.git`)?.repo).toBe("a");
  });
  it("offers only a documented HTTPS clone URL and a dashboard browse destination", () => {
    expect(forgeCloneUrls(hostname, "default/demo", "artifacts")).toEqual({ httpsUrl: remote, sshUrl: "" });
    expect(forgeWebUrl(hostname, "default/demo", "artifacts")).toBe("https://dash.cloudflare.com/");
    expect(forgeCloneUrls("github.com", "team/demo", "github")).toEqual({ httpsUrl: "https://github.com/team/demo.git", sshUrl: "git@github.com:team/demo.git" });
    expect(forgeProduct("artifacts").capabilities).toMatchObject({ changeRequests: false, repositoryApi: false, ssh: false, forkDefaultBranchOnly: false, commitAuthorIdentity: false });
  });
  it("parses only full repository tokens with an expiry", () => {
    expect(artifactsTokenExpiry(`art_v1_${"a".repeat(40)}?expires=1900000000`)).toBe(1_900_000_000_000);
    for (const value of ["cloudflare-api-token", `art_v1_${"a".repeat(40)}`, `art_v1_${"a".repeat(40)}?expires=0`, `art_v1_${"a".repeat(40)}?expires=1900000000\nAuthorization: bad`]) expect(artifactsTokenExpiry(value)).toBeNull();
  });
});
