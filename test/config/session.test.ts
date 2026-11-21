import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";

import {
  readSession,
  toSession,
  writeSession,
} from "../../src/lib/config/session.js";
import { readStoredKey, writeKey } from "../../src/lib/config/settings.js";
import { tempDir } from "../helpers.js";

const SESSION = { refresh_token: "r", access_token: "a", expires_at: 1 };
const sandbox = () => ({ CN_CONFIG_HOME: tempDir("cn-session-") });

test("a session round-trips and keeps the saved key", () => {
  const env = sandbox();
  writeKey("sk-cn-v1-a", env);
  writeSession(SESSION, env);

  expect(readSession(env)).toStrictEqual(SESSION);
  expect(readStoredKey(env)).toBe("sk-cn-v1-a");
});

test("cn key keeps the session", () => {
  const env = sandbox();
  writeSession(SESSION, env);
  writeKey("sk-cn-v1-b", env);

  expect(readSession(env)).toStrictEqual(SESSION);
});

test("a damaged session reads as none", () => {
  const env = sandbox();
  writeKey("sk-cn-v1-a", env);
  const file = path.join(env.CN_CONFIG_HOME, "credentials.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ api_key: "sk-cn-v1-a", session: { refresh_token: 5 } }),
    { mode: 0o600 },
  );

  expect(readSession(env)).toBe(null);
});

test("toSession sets the expiry from expires_in", () => {
  expect(
    toSession({ access_token: "a", refresh_token: "r", expires_in: 60 }, 1000),
  ).toStrictEqual({ access_token: "a", refresh_token: "r", expires_at: 61000 });
});

test("a sign-in without a refresh token has no session", () => {
  expect(toSession({ access_token: "a", expires_in: 60 }, 1000)).toBe(null);
});

test("a damaged credentials file reads as no session", () => {
  const env = sandbox();
  writeSession(SESSION, env);
  fs.writeFileSync(path.join(env.CN_CONFIG_HOME, "credentials.json"), "{", {
    mode: 0o600,
  });

  expect(readSession(env)).toBe(null);
});
