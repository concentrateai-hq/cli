import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AppOpenError, CnError } from "./errors.js";
import type { Environment } from "./types.js";

export function which(command: string, searchPath = process.env.PATH ?? "") {
  for (const directory of searchPath
    .split(path.delimiter)
    .filter(path.isAbsolute)) {
    const candidate = path.join(directory, command);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Not executable here; keep looking.
    }
  }
  return null;
}

// Desktop apps can overwrite their settings while running, so setup needs them closed.
export function requireAppClosed(
  app: string,
  processName: string | undefined,
  env: Environment,
) {
  if (!processName)
    throw new CnError(
      `${app} setup on this platform is not supported by cn yet.`,
    );
  const pgrep = which("pgrep", env.PATH) || which("pgrep", "/usr/bin:/bin");
  if (!pgrep)
    throw new CnError(
      `Cannot check whether ${app} is closed: pgrep is required for ${app} setup.`,
    );
  const result = spawnSync(pgrep, ["-x", processName], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status === 0)
    throw new AppOpenError(
      `${app} is open. Quit it, run this again, then reopen it.`,
    );
  if (result.error || result.status !== 1)
    throw new CnError(
      `Could not confirm that ${app} is closed. Quit ${app} and retry.`,
    );
}
