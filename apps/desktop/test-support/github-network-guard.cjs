// Test-only transport boundary. Install before importing application code so
// startup checks are covered too. Tests may replace a transport with a stub,
// but forwarding to the original still reaches this guard.
function installGitHubNetworkGuard(targets, onAttempt = () => {}) {
  const attempts = [];
  const restorers = [];
  for (const [target, method] of targets) {
    const original = target[method];
    target[method] = function (input, ...args) {
      const value = typeof input === "string" || input instanceof URL
        ? String(input)
        : input?.url ?? `https://${input?.hostname ?? input?.host ?? "localhost"}`;
      const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
      if (["github.com", "githubusercontent.com"].some(
        domain => hostname === domain || hostname.endsWith(`.${domain}`)
      )) {
        const message = `Unstubbed GitHub request in test: ${method} ${value}`;
        attempts.push(message);
        onAttempt(message);
        throw new Error(message);
      }
      return original.call(this, input, ...args);
    };
    restorers.push(() => { target[method] = original; });
  }
  return { attempts, restore: () => restorers.reverse().forEach(restore => restore()) };
}

module.exports = { installGitHubNetworkGuard };
