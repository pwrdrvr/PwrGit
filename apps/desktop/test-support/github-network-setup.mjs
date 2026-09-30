import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { afterAll, afterEach, expect } from "vitest";
import guard from "./github-network-guard.cjs";

const { attempts, restore } = guard.installGitHubNetworkGuard([
  [globalThis, "fetch"], [http, "request"], [http, "get"],
  [https, "request"], [https, "get"]
]);
syncBuiltinESMExports();
afterEach(() => {
  try {
    expect(attempts, "Tests must stub GitHub transports").toEqual([]);
  } finally {
    // Keep import-time attempts until the first assertion, too.
    attempts.length = 0;
  }
});
afterAll(() => {
  restore();
  syncBuiltinESMExports();
});
