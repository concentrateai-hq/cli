import { openCodeDocuments, openCodeHeaders } from "./app-headers.js";
import type { Harness } from "../types.js";
import { execFileSync, spawnSync } from "node:child_process";
import { CnError } from "../errors.js";
import { record } from "../validation.js";
import { optionValue } from "../sessions.js";

import { API_ROOT } from "../catalog.js";
import { opencodeConfig } from "./pickers.js";

import { supportsStandalone, withStandalone } from "./opencode-cli.js";
export { supportsStandalone, withStandalone } from "./opencode-cli.js";

const adapter: Harness = {
  id: "opencode",
  label: "OpenCode",
  binary: "opencode",
  installHint:
    "Install OpenCode (https://opencode.ai), then run cn opencode again.",

  version(executable) {
    const out = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    });
    return (out.stdout ?? "").trim().split("\n")[0] || null;
  },

  async prepare({ executable, model, key, available, forwarded, env, mcp }) {
    const modern = supportsStandalone(executable);
    // cn's inline config outranks the user's files, and a same-named server
    // replaces the whole entry, so the user's names are skipped.
    const taken = new Set(
      openCodeDocuments(env).flatMap((doc) => [
        ...Object.keys(record(doc.mcp)),
        ...Object.keys(record(record(doc.mcp).servers)),
      ]),
    );
    const servers = Object.fromEntries(
      Object.entries(mcp)
        .filter(([name]) => !taken.has(name))
        .map(([name, { url }]) => [
          name,
          modern
            ? { type: "remote", url }
            : { type: "remote", url, enabled: true },
        ]),
    );
    const config = JSON.stringify({
      ...opencodeConfig(API_ROOT, model, available, {
        modern,
        headers: openCodeHeaders(env, modern),
      }),
      ...(Object.keys(servers).length
        ? { mcp: modern ? { servers } : servers }
        : {}),
    });
    const session = optionValue(forwarded, "--session", "-s");
    if (session && modern) {
      // v2's full-screen CLI has no --model flag. Its durable session model
      // wins over config.model, so use the supported model-switch API first.
      try {
        execFileSync(
          executable,
          [
            "api",
            "--standalone",
            "POST",
            `/api/session/${encodeURIComponent(session)}/model`,
            "--data",
            JSON.stringify({ model: { providerID: "concentrate", id: model } }),
          ],
          {
            env: {
              ...env,
              OPENCODE_CONFIG_CONTENT: config,
              CONCENTRATE_API_KEY: key,
            },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 20000,
          },
        );
      } catch (error) {
        // `--session` also creates a named session in v2, so a missing one is
        // not an error: there is no saved model to switch.
        const output = [error]
          .flatMap((value) => {
            const { stdout, stderr } = value as Record<string, unknown>;
            return [stdout, stderr].map(String);
          })
          .join("\n");
        if (!/\b404\b|not found/i.test(output))
          throw new CnError(
            "Could not switch the saved OpenCode session to Concentrate. Its history is intact. Check the session ID and your OpenCode version, then try again.",
          );
      }
    }
    const args =
      session && !modern && !optionValue(forwarded, "--model", "-m")
        ? ["--model", `concentrate/${model}`, ...forwarded]
        : forwarded;
    return {
      args: modern ? withStandalone(args) : args,
      env: { OPENCODE_CONFIG_CONTENT: config, CONCENTRATE_API_KEY: key },
      cleanup() {},
    };
  },
};

export default adapter;
