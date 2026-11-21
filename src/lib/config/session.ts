import type { Environment } from "../types.js";
import { record } from "../validation.js";
import { credentialsFile, keptCredentials, writeJson } from "./settings.js";

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
