import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { afterAll, afterEach, beforeEach, expect } from "vitest";
import guard from "./github-network-guard.cjs";

const { attempts, restore } = guard.installGitHubNetworkGuard([
  [globalThis, "fetch"], [http, "request"], [http, "get"],
  [https, "request"], [https, "get"]
]);
syncBuiltinESMExports();
beforeEach(() => { attempts.length = 0; });
afterEach(() => { expect(attempts, "Tests must stub GitHub transports").toEqual([]); });
afterAll(() => {
  restore();
  syncBuiltinESMExports();
});
