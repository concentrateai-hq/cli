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
import type { Harness, McpServers } from "../types.js";

function copilotVersion(executable: string) {
  const out = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  });
  return (out.stdout || "").trim().split("\n")[0] || null;
}

// Org servers are added for this session only; the user's own MCP config wins.
function mcpArgs(mcp: McpServers) {
  if (!Object.keys(mcp).length) return [];
  const mcpServers = Object.fromEntries(
    Object.entries(mcp).map(([name, { url }]) => [
      name,
      { type: "http", url, tools: ["*"] },
    ]),
  );
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
          ...mcpArgs(mcp),
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
