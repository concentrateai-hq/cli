import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Environment } from "../types.js";
import { errorCode, record } from "../validation.js";
import {
  configDir,
  credentialsFile,
  keptCredentials,
  writeJson,
} from "./settings.js";

/** The sign-in session; `expires_at` is when the access token expires (epoch ms). */
export type Session = {
  refresh_token: string;
  access_token: string;
  expires_at: number;
};

export function readSession(env: Environment = process.env): Session | null {
  const { refresh_token, access_token, expires_at } = record(
    keptCredentials(env).session,
  );
  return typeof refresh_token === "string" &&
    typeof access_token === "string" &&
    typeof expires_at === "number"
    ? { refresh_token, access_token, expires_at }
    : null;
}

/** Saves the session next to the key; null removes it. */
export function writeSession(
  session: Session | null,
  env: Environment = process.env,
) {
  const { session: _old, ...rest } = keptCredentials(env);
  writeJson(credentialsFile(env), session ? { ...rest, session } : rest);
}

/** The session in a token response; none when the server issued no refresh token. */
export function toSession(
  body: Record<string, unknown>,
  now = Date.now(),
): Session | null {
  const { access_token, refresh_token, expires_in } = body;
  if (typeof access_token !== "string" || typeof refresh_token !== "string")
    return null;
  const seconds = typeof expires_in === "number" ? expires_in : 3600;
  return { access_token, refresh_token, expires_at: now + seconds * 1000 };
}

// A refresh token works once: a second use ends the whole session, so only one
// cn process refreshes at a time. A lock older than 30 s was left by a crash.
export async function withSessionLock<T>(
  env: Environment,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = path.join(configDir(env), "session.lock");
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600));
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) {
        fs.rmSync(lock, { force: true });
        continue;
      }
    } catch {
      continue; // released between the two calls
    }
    await sleep(100);
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
