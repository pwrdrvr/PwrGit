const { app, net } = require("electron");
const http = require("node:http");
const https = require("node:https");
const { syncBuiltinESMExports } = require("node:module");
const { join, dirname } = require("node:path");
const { pathToFileURL } = require("node:url");
const { installGitHubNetworkGuard } = require("../../test-support/github-network-guard.cjs");

globalThis.__githubNetworkGuard = installGitHubNetworkGuard([
  [globalThis, "fetch"], [net, "request"], [net, "fetch"],
  [http, "request"], [http, "get"], [https, "request"], [https, "get"]
]);
syncBuiltinESMExports();
const main = join(__dirname, "../../out/main/index.js");
app.setAppPath(dirname(main));
import(pathToFileURL(main).href);
