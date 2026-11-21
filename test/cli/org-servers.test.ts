import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";

import { orgMcpServers } from "../../src/lib/cli/org-servers.js";
import { writeSession } from "../../src/lib/config/session.js";
import { json, tempDir } from "../helpers.js";

const CONFIG = {
  client_id: "cn-client",
  authorization_endpoint: "https://auth.test/authorize",
  token_endpoint: "https://auth.test/token",
  device_authorization_endpoint: "https://auth.test/device",
};

const GOOD = {
  mcp: {
    docs: { url: "https://docs.example/mcp" },
    typed: { type: "http", url: "https://typed.example/mcp" },
    events: { type: "sse", url: "https://events.example/sse" },
    "bad name!": { url: "https://x.example/mcp" },
    plain: { url: "http://x.example/mcp" },
    broken: { url: "not a url" },
    local: {
      command: "rm",
      url: "https://ok.example/mcp",
      headers: { a: "b" },
    },
  },
};

const status = (code) => () => new Response(null, { status: code });
const offline = () => Promise.reject(new TypeError("fetch failed"));

let env;
let calls;
let replies;
let warn;

beforeEach(() => {
  vi.restoreAllMocks();
  env = { CN_CONFIG_HOME: tempDir(), CN_APP_URL: "https://app.test" };
  writeSession(
    {
      access_token: "at",
      refresh_token: "rt",
      expires_at: Date.now() + 3_600_000,
    },
    env,
  );
  calls = [];
  replies = [];
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers });
    return replies.shift()();
  });
  warn = vi.spyOn(console, "error").mockImplementation(() => {});
});

test("asks with the session and the key, and keeps only valid http servers", async () => {
  replies.push(() => json(GOOD));
  await expect(orgMcpServers("sk-a", env)).resolves.toStrictEqual({
    docs: { type: "http", url: "https://docs.example/mcp" },
    typed: { type: "http", url: "https://typed.example/mcp" },
    local: { type: "http", url: "https://ok.example/mcp" },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: "https://app.test/api/cli/settings",
    headers: { Authorization: "Bearer at", "X-Api-Key": "sk-a" },
  });
  expect(warn).not.toHaveBeenCalled();
});

test("without a saved session nothing is fetched or warned", async () => {
  writeSession(null, env);
  await expect(orgMcpServers("sk-a", env)).resolves.toStrictEqual({});
  expect(calls).toHaveLength(0);
  expect(warn).not.toHaveBeenCalled();
});

test.each([
  ["a 401", status(401), /cn login/],
  ["a server error", status(500), /org MCP servers/],
  ["a network failure", offline, /org MCP servers/],
])(
  "after %s the last good copy is used, with a warning",
  async (_, failure, warning) => {
    replies.push(() => json(GOOD), failure);
    await orgMcpServers("sk-a", env);
    await expect(orgMcpServers("sk-a", env)).resolves.toMatchObject({
      docs: { type: "http", url: "https://docs.example/mcp" },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(warning);
  },
);

test("a 404 turns the servers off and forgets the saved copy", async () => {
  replies.push(() => json(GOOD), status(404), offline);
  await orgMcpServers("sk-a", env);
  await expect(orgMcpServers("sk-a", env)).resolves.toStrictEqual({});
  await expect(orgMcpServers("sk-a", env)).resolves.toStrictEqual({});
  expect(warn).toHaveBeenCalledTimes(1);
});

test("a saved copy for another key is not used", async () => {
  replies.push(() => json(GOOD), offline);
  await orgMcpServers("sk-a", env);
  await expect(orgMcpServers("sk-b", env)).resolves.toStrictEqual({});
});

test("offline, the saved copy is used without a request", async () => {
  replies.push(() => json(GOOD));
  await orgMcpServers("sk-a", env);
  await expect(
    orgMcpServers("sk-a", { ...env, CN_OFFLINE: "1" }),
  ).resolves.toMatchObject({ docs: { type: "http" } });
  expect(calls).toHaveLength(1);
});

test("a damaged saved copy counts as none", async () => {
  fs.writeFileSync(
    path.join(env.CN_CONFIG_HOME, "org-servers.json"),
    "not json",
    { mode: 0o600 },
  );
  replies.push(offline);
  await expect(orgMcpServers("sk-a", env)).resolves.toStrictEqual({});
});

test("a session that can no longer be refreshed warns and uses the saved copy", async () => {
  replies.push(() => json(GOOD));
  await orgMcpServers("sk-a", env);
  writeSession(
    { access_token: "old", refresh_token: "rt", expires_at: 0 },
    env,
  );
  replies.push(
    () => json(CONFIG),
    () => json({ error: "invalid_grant" }, 400),
  );
  await expect(orgMcpServers("sk-a", env)).resolves.toMatchObject({
    docs: { type: "http" },
  });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toMatch(/cn login/);
});
