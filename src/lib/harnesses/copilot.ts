import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { API_ROOT } from "../catalog.js";
import {
  copilotModelRef,
  launchProviders,
} from "../config/copilot-cli-config.js";
import { hasOption } from "../sessions.js";
import type { Environment, Harness, McpServers } from "../types.js";
import { record } from "../validation.js";
import { configDocument } from "./app-headers.js";

function copilotVersion(executable: string) {
  const out = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  });
  return (out.stdout || "").trim().split("\n")[0] || null;
}

// Server names the user already has in the files Copilot reads: its user
// config, and .mcp.json or .github/mcp.json from here up to the repository
// root. A file that won't parse names none; Copilot reports it itself.
function userServerNames(env: Environment) {
  const home =
    env.COPILOT_HOME || path.join(env.HOME || os.homedir(), ".copilot");
  const files = [path.join(home, "mcp-config.json")];
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    files.push(
      path.join(dir, ".mcp.json"),
      path.join(dir, ".github", "mcp.json"),
    );
    if (fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir)
      break;
  }
  return new Set(
    files.flatMap((file) => {
      try {
        return Object.keys(record(configDocument(file).mcpServers));
      } catch {
        return [];
      }
    }),
  );
}

// Org servers are added for this session only. Copilot lets added servers
// replace the user's own, so names the user already has are left out.
function mcpArgs(mcp: McpServers, env: Environment) {
  const taken = userServerNames(env);
  const mcpServers = Object.fromEntries(
    Object.entries(mcp)
      .filter(([name]) => !taken.has(name))
      .map(([name, { url }]) => [name, { type: "http", url, tools: ["*"] }]),
  );
  if (!Object.keys(mcpServers).length) return [];
  return ["--additional-mcp-config", JSON.stringify({ mcpServers })];
}

const adapter: Harness = {
  id: "copilot-cli",
  label: "GitHub Copilot CLI",
  binary: "copilot",
  installHint:
    "Install GitHub Copilot CLI (npm install -g @github/copilot) and make sure `copilot` is on your PATH, then run cn copilot again.",
  modelFlags: ["--model"],
  version: copilotVersion,

  async prepare({ model, key, available, forwarded, env, mcp }) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cn-copilot-"));
    const cleanup = () =>
      fs.rmSync(directory, { recursive: true, force: true });
    try {
      // The key stays out of the file: Copilot reads it from this environment.
      const file = path.join(directory, "providers.json");
      fs.writeFileSync(
        file,
        JSON.stringify(launchProviders(API_ROOT, available, env)),
        { mode: 0o600 },
      );
      return {
        args: [
          ...(hasOption(forwarded, "--model")
            ? []
            : ["--model", copilotModelRef(model)]),
          ...mcpArgs(mcp, env),
          ...forwarded,
        ],
        env: { CONCENTRATE_API_KEY: key, COPILOT_PROVIDERS_CONFIG: file },
        cleanup,
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  },
};

export default adapter;
