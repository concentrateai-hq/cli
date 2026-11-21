import { appHeaders, configDocument } from "./app-headers.js";
import { record } from "../validation.js";
import type { Harness, Environment, McpServers, Model } from "../types.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { API_ROOT } from "../catalog.js";
import { CnError } from "../errors.js";
import { piConfig } from "./pickers.js";

function piVersion(executable: string) {
  const out = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  });
  // Older Pi prints its version to stderr.
  return (out.stdout || out.stderr || "").trim().split("\n")[0] || null;
}

// cn writes apiKey as "$NAME", which Pi reads as an environment variable from
// 0.77 on. Older Pi sends it literally and gets a 401.
export function requireSupportedPi(executable: string) {
  const found = piVersion(executable);
  const match = /^(\d+)\.(\d+)\./.exec(found ?? "");
  if (match && Number(match[1]) === 0 && Number(match[2]) < 77)
    throw new CnError(
      `cn needs Pi 0.77 or newer (you have ${found}). Run \`pi update self\`, then try again.`,
    );
}

// Written by cn for each run, or deliberately kept out of the temporary profile.
// Everything else in the Pi agent dir (extensions, skills, MCP config, caches)
// is linked through so the profile behaves like the user's own.
const OWNED = new Set([
  "settings.json",
  "models.json",
  "auth.json",
  "sessions",
]);

function readObject(file: string): Record<string, unknown> {
  try {
    if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
      return {};
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return record(value);
  } catch {
    return {};
  }
}

function writePrivate(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

// Builds a private agent dir that keeps the user's Pi settings, models, and
// resource dirs. Pi's auth.json is deliberately not copied.
function preparePiDir(
  directory: string,
  model: string,
  available: Model[],
  env: Environment,
  mcp: McpServers,
) {
  const source =
    env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  writePrivate(path.join(directory, "settings.json"), {
    ...readObject(path.join(source, "settings.json")),
    defaultProvider: "concentrate",
    defaultModel: model,
  });
  const existing = readObject(path.join(source, "models.json")).providers;
  writePrivate(path.join(directory, "models.json"), {
    providers: {
      ...(existing && typeof existing === "object" ? existing : {}),
      ...piConfig(
        API_ROOT,
        available,
        appHeaders("pi", record(record(existing).concentrate).headers),
      ).providers,
    },
  });
  // Org servers go in a merged copy of mcp.json, skipping names the user defines
  // in any file Pi or its MCP adapter reads. A file that won't parse stays linked.
  let copied = false;
  if (Object.keys(mcp).length) {
    const home = env.HOME || os.homedir();
    const user = path.join(source, "mcp.json");
    try {
      const own = configDocument(user);
      const taken = new Set(
        [
          user,
          path.join(source, "mcp-adapter.json"),
          path.join(home, ".config", "mcp", "mcp.json"),
          path.join(home, ".agents", "mcp.json"),
          path.join(home, ".agents", "mcp", "mcp.json"),
          path.join(process.cwd(), ".mcp.json"),
          path.join(process.cwd(), ".pi", "mcp-adapter.json"),
        ].flatMap((file) =>
          Object.keys(record(configDocument(file).mcpServers)),
        ),
      );
      const pushed = Object.entries(mcp)
        .filter(([name]) => !taken.has(name))
        .map(([name, { url }]): [string, { url: string }] => [name, { url }]);
      if (pushed.length) {
        writePrivate(path.join(directory, "mcp.json"), {
          ...own,
          mcpServers: {
            ...Object.fromEntries(pushed),
            ...record(own.mcpServers),
          },
        });
        copied = true;
      }
    } catch {
      // Pi reports the damaged file itself.
    }
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(source);
  } catch {
    // No Pi directory yet; there is nothing to carry over.
  }
  for (const name of names) {
    if (OWNED.has(name) || (copied && name === "mcp.json")) continue;
    try {
      fs.symlinkSync(path.join(source, name), path.join(directory, name));
    } catch {
      // A single unlinkable entry should not stop Pi from launching.
    }
  }
  // Pi owns its normal project sessions. The rest of this profile stays
  // temporary, so sharing this directory preserves sessions in both commands.
  const sessions = path.join(source, "sessions");
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  fs.symlinkSync(
    path.resolve(sessions),
    path.join(directory, "sessions"),
    "dir",
  );
}

const adapter: Harness = {
  id: "pi",
  label: "Pi",
  binary: "pi",
  installHint:
    "Install Pi and make sure `pi` is on your PATH, then run cn pi again.",
  modelFlags: ["--model", "--provider"],
  version: piVersion,

  async prepare({ executable, model, key, available, forwarded, env, mcp }) {
    requireSupportedPi(executable);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cn-pi-"));
    const cleanup = () =>
      fs.rmSync(directory, { recursive: true, force: true });
    try {
      preparePiDir(directory, model, available, env, mcp);
      return {
        args: ["--provider", "concentrate", "--model", model, ...forwarded],
        env: { CONCENTRATE_API_KEY: key, PI_CODING_AGENT_DIR: directory },
        cleanup,
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  },
};

export default adapter;
