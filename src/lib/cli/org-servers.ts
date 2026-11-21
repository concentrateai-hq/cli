import { createHash } from "node:crypto";
import path from "node:path";

import { HttpError, requestJson } from "../catalog.js";
import { readSession } from "../config/session.js";
import { configDir, readJson, writeJson } from "../config/settings.js";
import { CnError } from "../errors.js";
import type { Environment, McpServers } from "../types.js";
import { ledger } from "../ui/layout.js";
import { isRecord, record } from "../validation.js";
import { appRoot, sessionToken } from "./login.js";

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

// Remote https servers only; every other field is dropped.
function servers(value: unknown): McpServers {
  const kept: McpServers = {};
  for (const [name, entry] of Object.entries(record(value))) {
    if (!NAME.test(name) || !isRecord(entry)) continue;
    if (entry.type !== undefined && entry.type !== "http") continue;
    try {
      const url = new URL(String(entry.url));
      if (url.protocol === "https:")
        kept[name] = { type: "http", url: url.href };
    } catch {
      // not a URL
    }
  }
  return kept;
}

const cacheFile = (env: Environment) =>
  path.join(configDir(env), "org-servers.json");

// The last good copy, only for the key it was fetched with.
function saved(hash: string, env: Environment) {
  try {
    const cached = readJson(cacheFile(env));
    return cached.key === hash ? servers(cached.mcp) : {};
  } catch (error) {
    if (error instanceof CnError) return {};
    throw error;
  }
}

function save(hash: string, mcp: McpServers, env: Environment) {
  try {
    writeJson(cacheFile(env), { key: hash, mcp });
  } catch {
    /* The next launch fetches again. */
  }
  return mcp;
}

function fallback(hash: string, env: Environment, expired: boolean) {
  console.error(
    ledger(
      "warn",
      "mcp",
      expired
        ? "sign-in expired, using the last org MCP servers. Run cn login."
        : "couldn't fetch org MCP servers, using the last saved ones",
    ),
  );
  return saved(hash, env);
}

/** The organization's MCP servers for this key; the last saved ones when the fetch fails. */
export async function orgMcpServers(
  key: string,
  env: Environment,
): Promise<McpServers> {
  if (!readSession(env)) return {};
  const hash = createHash("sha256").update(key).digest("hex");
  if (env.CN_OFFLINE === "1") return saved(hash, env);
  let token;
  try {
    token = await sessionToken(env);
  } catch {
    return fallback(hash, env, false);
  }
  // A refused refresh removed the session
  if (!token) return fallback(hash, env, true);
  try {
    const body = await requestJson(`${appRoot(env)}/api/cli/settings`, {
      headers: { Authorization: `Bearer ${token}`, "X-Api-Key": key },
      timeoutMs: 4000,
    });
    return save(hash, servers(body.mcp), env);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404)
      return save(hash, {}, env);
    return fallback(
      hash,
      env,
      error instanceof HttpError && error.status === 401,
    );
  }
}
