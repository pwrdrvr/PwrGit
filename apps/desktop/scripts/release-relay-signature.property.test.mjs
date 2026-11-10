import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { runInNewContext } from "node:vm";
import fc from "fast-check";
import { expect, test } from "vitest";

const release = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
// Exercise the production post-package block without building, signing or
// publishing. Like release-config's harness, only its process boundary is fake.
const verification = release.slice(
  release.indexOf("  const nativeRelay ="),
  release.indexOf('  step("verify installer artifact'),
);

function invocation(builtApp, { requireSigning = true, exists = true } = {}) {
  const calls = [];
  runInNewContext(verification, {
    builtApp, requireSigning, join: win32.join, existsSync: () => exists,
    runChecked: (file, args, options) => calls.push({ file, args, options }),
  });
  return calls;
}

// Windows permits all of these characters in directory names. In particular,
// quotes, brackets, dollar signs and backticks must remain path data.
const segment = fc.array(fc.constantFrom(..."abcXYZ019 '-_()[]+$`;=&雪"), {
  minLength: 1, maxLength: 32,
}).map((chars) => `dir-${chars.join("")}-end`);
const builtApp = fc.array(segment, { minLength: 1, maxLength: 5 })
  .map((segments) => win32.join("D:\\a", ...segments, "win-unpacked"));

test("every signed relay uses the pipeline's PowerShell 7 host with a literal path", () => {
  fc.assert(fc.property(builtApp, (app) => {
    const calls = invocation(app);
    expect(calls).toHaveLength(1);
    const { file, args, options } = calls[0];
    expect(file).toBe("pwsh");
    expect(args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(options.env.PWRGIT_NATIVE_RELAY_PATH).toBe(win32.join(app, "resources", "pwrgit-mcp.exe"));
    expect(args.at(-1)).not.toContain(app);
    expect(args.at(-1)).toContain("-LiteralPath $env:PWRGIT_NATIVE_RELAY_PATH");
  }));
});

test.each([
  "D:\\a\\dir-a-end\\win-unpacked", // Shrunk pre-fix counterexample.
  "D:\\a\\PwrGit\\PwrGit\\apps\\desktop\\release-stage\\dist\\win-unpacked",
])("the v0.56.0 launch-chain regression stays in pwsh (%s)", (app) => {
  expect(invocation(app)[0].file).toBe("pwsh");
});

test("a missing packaged relay fails even when signing is optional", () => {
  expect(() => invocation("D:\\app", { requireSigning: false, exists: false }))
    .toThrow("Packaged native MCP relay is missing");
  expect(invocation("D:\\app", { requireSigning: false })).toEqual([]);
});

// Model the cmdlet's outcomes, but let the real PowerShell interpreter decide
// the production command's exit code. Lookup errors and absent results must
// never become success, and every non-Valid status must fail closed.
test.skipIf(process.platform !== "win32").each([
  "Valid", "NotSigned", "HashMismatch", "NotTrusted", "UnknownError",
  "NotSupportedFileFormat", "Incompatible", "NoResult", "LookupError",
])("only Valid succeeds for generated literal paths (%s)", (outcome) => {
  const cmdlet = `
    function Get-AuthenticodeSignature {
      [CmdletBinding()]
      param([string]$LiteralPath)
      if ($LiteralPath -cne $env:PWRGIT_EXPECTED_RELAY_PATH) { throw 'literal path changed' }
      switch ($env:PWRGIT_SIGNATURE_FIXTURE) {
        'LookupError' { Write-Error 'fixture lookup error'; return }
        'NoResult' { return }
        default { [pscustomobject]@{ Status = $env:PWRGIT_SIGNATURE_FIXTURE } }
      }
    }
  `;
  // Each run starts real pwsh; three generated paths per outcome keep process
  // startup bounded. The platform-independent transport property uses 100.
  fc.assert(fc.property(builtApp, (app) => {
    const { file, args, options } = invocation(app)[0];
    const result = spawnSync(file, [...args.slice(0, -1), `${cmdlet}\n${args.at(-1)}`], {
      encoding: "utf8", shell: false,
      env: { ...process.env, ...options.env,
        PWRGIT_EXPECTED_RELAY_PATH: win32.join(app, "resources", "pwrgit-mcp.exe"),
        PWRGIT_SIGNATURE_FIXTURE: outcome },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${outcome}: ${result.stderr}`).toBe(outcome === "Valid" ? 0 : 1);
    if (outcome === "LookupError") {
      expect(result.stderr).toContain("fixture lookup error");
      expect(result.stderr).not.toContain("MCP relay Authenticode verification failed");
    }
  }), { numRuns: 3 });
});

// Windows CI supplies the real cmdlet and trust oracle. A signed OS executable
// is copied as fixture bytes only; it is never executed. This also reproduces
// the pwsh -> Node -> verifier launch chain from the failed release.
test.skipIf(process.platform !== "win32")("real Authenticode accepts signed bytes and rejects unsigned/missing bytes at a hostile literal path", () => {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-signature-"));
  const target = join(directory, "relay [x] ' $() ; & ` 雪.exe");
  const { file, args, options } = invocation(directory)[0];
  const verify = () => spawnSync(file, args, {
    encoding: "utf8", shell: false,
    env: { ...process.env, ...options.env, PWRGIT_NATIVE_RELAY_PATH: target },
  });
  try {
    copyFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), target);
    const signed = verify();
    expect(signed.error).toBeUndefined();
    expect(signed.status, signed.stderr).toBe(0);
    writeFileSync(target, "unsigned fixture, never executed");
    const unsigned = verify();
    expect(unsigned.status).toBe(1);
    expect(unsigned.stderr).toContain("MCP relay Authenticode verification failed");
    rmSync(target);
    const missing = verify();
    expect(missing.status).toBe(1);
    // The lookup must terminate before the invalid-signature branch masks it.
    expect(missing.stderr).not.toContain("MCP relay Authenticode verification failed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
