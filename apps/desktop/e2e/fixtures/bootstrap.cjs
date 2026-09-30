const { app, net } = require("electron");
const http = require("node:http");
const https = require("node:https");
const { appendFileSync, writeFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { join, dirname } = require("node:path");
const { pathToFileURL } = require("node:url");
const { installGitHubNetworkGuard } = require("../../test-support/github-network-guard.cjs");

// Persist before throwing: updater code may catch the error, and quit specs
// close Electron before fixture cleanup can inspect main-process memory.
const attemptsFile = join(process.env.PWRGIT_USER_DATA_DIR, "github-network-attempts.log");
writeFileSync(attemptsFile, "");
globalThis.__githubNetworkGuard = installGitHubNetworkGuard([
  [globalThis, "fetch"], [net, "request"], [net, "fetch"],
  [http, "request"], [http, "get"], [https, "request"], [https, "get"]
], message => appendFileSync(attemptsFile, `${message}\n`));
syncBuiltinESMExports();
const main = join(__dirname, "../../out/main/index.js");
app.setAppPath(dirname(main));
import(pathToFileURL(main).href);
