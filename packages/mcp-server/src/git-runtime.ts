import { delimiter, dirname, join } from "node:path";
import dugite from "dugite";

/** Pin Git and its helpers together; inherited Dugite overrides are not a
 * user selection. Keep auth, SSH and certificate configuration intact. */
export function bundledGitEnvironment(
  directory = dugite.resolveEmbeddedGitDir(),
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const execPath = dugite.resolveGitExecPath(directory, "");
  const inheritedPath = Object.entries({ ...process.env, ...overrides })
    .reverse().find(([key]) => process.platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH")?.[1] ?? "";
  return {
    ...overrides,
    LOCAL_GIT_DIRECTORY: directory,
    GIT_EXEC_PATH: execPath,
    PATH: [execPath, dirname(dugite.resolveGitBinary(directory)), inheritedPath].join(delimiter),
    // Dugite normally supplies this only when LOCAL_GIT_DIRECTORY is unset.
    ...(process.platform === "linux" && !process.env.GIT_SSL_CAINFO && !overrides.GIT_SSL_CAINFO
      ? { GIT_SSL_CAINFO: join(directory, "ssl", "cacert.pem") } : {})
  };
}
