import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { test, expect, vi } from "vitest";

import { runLogin, sessionToken, signIn } from "../../src/lib/cli/login.js";
import { runKey } from "../../src/lib/cli/commands.js";
import { readStoredKey, writeKey } from "../../src/lib/config/settings.js";
import { readSession, writeSession } from "../../src/lib/config/session.js";
import { interactive, select } from "../../src/lib/ui/widgets.js";
import { json, tempDir } from "../helpers.js";

vi.mock("../../src/lib/cli/commands.js", { spy: true });
vi.mock("../../src/lib/ui/widgets.js", { spy: true });

const env = { CN_APP_URL: "https://app.test" };
const CONFIG = {
  client_id: "cn-client",
  authorization_endpoint: "https://auth.test/authorize",
  token_endpoint: "https://auth.test/token",
  device_authorization_endpoint: "https://auth.test/device",
};

// Routes the stubbed fetch by URL; token responses are served in order.
const TOKENS = { access_token: "at", refresh_token: "rt", expires_in: 3600 };

function stubAuth({ token = [json(TOKENS)], device } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body?.toString(),
      auth: init?.headers?.Authorization,
    });
    if (String(url) === "https://app.test/api/cli/config") return json(CONFIG);
    if (String(url) === CONFIG.device_authorization_endpoint)
      return json(device);
    return token.shift();
  });
  return calls;
}

// Plays the browser: reads the authorize URL and hits the callback.
const browser = (query) => (url) => {
  const params = new URL(url).searchParams;
  const callback = new URL(params.get("redirect_uri"));
  for (const [k, v] of Object.entries(query(params)))
    callback.searchParams.set(k, v);
  http.get(callback, (res) => res.resume());
};
const silent = () => {};

test("PKCE exchanges the code with the verifier it challenged", async () => {
  const calls = stubAuth();
  let challenge;
  const open = browser((params) => {
    challenge = params.get("code_challenge");
    return { code: "c", state: params.get("state") };
  });

  await expect(signIn(env, { device: false, open })).resolves.toMatchObject({
    token: "at",
    session: { access_token: "at", refresh_token: "rt" },
  });

  const sent = new URLSearchParams(calls[1].body);
  expect(calls[1].url).toBe(CONFIG.token_endpoint);
  expect(sent.get("code")).toBe("c");
  expect(
    createHash("sha256").update(sent.get("code_verifier")).digest("base64url"),
  ).toBe(challenge);
});

test.each([
  ["a forged state", () => ({ code: "c", state: "forged" }), "did not match"],
  [
    "a denied consent",
    (params) => ({
      error: "access_denied",
      code: "c",
      state: params.get("state"),
    }),
    "not approved",
  ],
])("PKCE refuses %s", async (_, query, message) => {
  stubAuth();

  await expect(
    signIn(env, { device: false, open: browser(query) }),
  ).rejects.toThrow(message);
});

test("device code polls past authorization_pending", async () => {
  const calls = stubAuth({
    device: {
      device_code: "dc",
      user_code: "ABCD",
      verification_uri: "https://auth.test/device",
      interval: 0,
      expires_in: 60,
    },
    token: [
      json({ error: "authorization_pending" }, 400),
      json({ access_token: "at" }),
    ],
  });

  await expect(
    signIn(env, { device: true, open: silent }),
  ).resolves.toStrictEqual({ token: "at", session: null });
  expect(calls).toHaveLength(4);
});

test("PKCE times out when the browser never comes back", async () => {
  stubAuth();

  await expect(
    signIn(env, { device: false, open: silent, timeoutMs: 50 }),
  ).rejects.toThrow("timed out");
});

test("device code stops when it expires", async () => {
  const calls = stubAuth({
    device: {
      device_code: "dc",
      verification_uri_complete: "https://auth.test/d",
      interval: 0,
      expires_in: 0,
    },
  });

  await expect(signIn(env, { device: true, open: silent })).rejects.toThrow(
    "expired",
  );
  expect(calls).toHaveLength(2);
});

const DEVICE = {
  device_code: "dc",
  verification_uri_complete: "https://auth.test/d",
  interval: 0,
  expires_in: 60,
};

// Signs in by device code, then answers the account and key calls in order.
const stubLogin = (...app) =>
  stubAuth({ device: DEVICE, token: [json(TOKENS), ...app] });
const loginEnv = () => ({ ...env, HOME: tempDir(), CN_CONFIG_HOME: tempDir() });

test("cn login saves the key minted for a single account", async () => {
  const calls = stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ key: "sk-cn-v1-minted" }, 201),
  );
  const home = loginEnv();

  await expect(runLogin({ device: true }, home, silent)).resolves.toBe(0);

  expect(readStoredKey(home)).toBe("sk-cn-v1-minted");
  expect(readSession(home)?.refresh_token).toBe("rt");
  expect(calls[3]).toMatchObject({
    url: "https://app.test/api/cli/accounts",
  });
  expect(JSON.parse(calls[4].body)).toMatchObject({ organization_id: null });
});

test("cn login falls back to pasting a key where it isn't available", async () => {
  stubLogin(json({ error: "Not found" }, 404));
  vi.mocked(runKey).mockResolvedValueOnce(0);

  await expect(runLogin({ device: true }, loginEnv(), silent)).resolves.toBe(0);

  expect(runKey).toHaveBeenCalledTimes(1);
});

test("cn login starts the picker on the first team and mints the key there", async () => {
  const calls = stubLogin(
    json({
      accounts: [
        { organization_id: null, team_id: null, name: "Personal" },
        { organization_id: "o1", team_id: null, name: "Acme" },
        { organization_id: "o1", team_id: "t1", name: "Acme / Platform" },
      ],
    }),
    json({ key: "sk-cn-v1-minted", reused: false }, 201),
  );
  vi.mocked(interactive).mockReturnValueOnce(true);
  vi.mocked(select).mockImplementationOnce(async ({ initial }) => ({
    value: initial,
  }));

  await runLogin({ device: true }, loginEnv(), silent);

  expect(vi.mocked(select).mock.calls[0][0].initial).toBe("2");
  expect(JSON.parse(calls[4].body)).toMatchObject({
    organization_id: "o1",
    team_id: "t1",
  });
});

test("cn login uses a device code over SSH", async () => {
  stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ key: "sk-cn-v1-minted" }, 201),
  );
  const open = vi.fn();

  await expect(
    runLogin({ device: false }, { ...loginEnv(), SSH_CONNECTION: "1" }, open),
  ).resolves.toBe(0);
  expect(open).not.toHaveBeenCalled();
});

test.each([
  [
    "several accounts without a terminal to choose in",
    {
      accounts: [
        { organization_id: null, name: "Personal" },
        { organization_id: "o1", name: "Acme" },
      ],
    },
    "interactive terminal",
  ],
  ["no accounts", { accounts: [] }, "no accounts"],
])("cn login stops on %s", async (_, accounts, message) => {
  stubLogin(json(accounts));

  await expect(runLogin({ device: true }, loginEnv(), silent)).rejects.toThrow(
    message,
  );
});

test("cn login explains an unexpected server error", async () => {
  stubLogin(json({}, 500));

  await expect(runLogin({ device: true }, loginEnv(), silent)).rejects.toThrow(
    /HTTP 500.*cn key/,
  );
});

test("sign-in refuses an endpoint that isn't https", async () => {
  vi.stubGlobal("fetch", async () =>
    json({ ...CONFIG, token_endpoint: "http://auth.test/token" }),
  );

  await expect(signIn(env, { device: true, open: silent })).rejects.toThrow(
    "https",
  );
});

test("cn login keeps this computer's key when it already belongs to that account", async () => {
  const calls = stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ key: "sk-cn-v1-other", reused: true }),
  );
  const home = loginEnv();
  writeKey("sk-cn-v1-saved", home);

  await expect(runLogin({ device: true }, home, silent)).resolves.toBe(0);

  expect(JSON.parse(calls[4].body)).toMatchObject({
    current_key: "sk-cn-v1-saved",
  });
  expect(readStoredKey(home)).toBe("sk-cn-v1-saved");
});

test("cn login sends no current key when none is saved", async () => {
  const calls = stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ key: "sk-cn-v1-minted", reused: false }, 201),
  );

  await runLogin({ device: true }, loginEnv(), silent);

  expect(JSON.parse(calls[4].body)).not.toHaveProperty("current_key");
});

test("cn login --new creates another key instead of keeping the saved one", async () => {
  const calls = stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ key: "sk-cn-v1-minted", reused: false }, 201),
  );
  const home = loginEnv();
  writeKey("sk-cn-v1-saved", home);

  await runLogin({ device: true, new: true }, home, silent);

  expect(JSON.parse(calls[4].body)).not.toHaveProperty("current_key");
  expect(readStoredKey(home)).toBe("sk-cn-v1-minted");
});

test("cn login --name names the key; without it the server names it", async () => {
  const named = stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ key: "sk-cn-v1-minted", reused: false }, 201),
  );
  await runLogin({ device: true, name: "laptop" }, loginEnv(), silent);
  expect(JSON.parse(named[4].body)).toMatchObject({ name: "laptop" });

  const unnamed = stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ key: "sk-cn-v1-minted", reused: false }, 201),
  );
  await runLogin({ device: true }, loginEnv(), silent);
  expect(JSON.parse(unnamed[4].body)).not.toHaveProperty("name");
});

test("PKCE closes a connection the browser opened but never used", async () => {
  stubAuth();
  let closed!: Promise<void>;
  const open = (url) => {
    const params = new URL(url).searchParams;
    const callback = new URL(params.get("redirect_uri"));
    // Browsers open a spare connection ahead of time and may never send on it
    const spare = net.connect(Number(callback.port), "127.0.0.1");
    closed = new Promise((resolve) => spare.on("close", () => resolve()));
    callback.searchParams.set("code", "c");
    callback.searchParams.set("state", params.get("state"));
    spare.on("connect", () => http.get(callback, (res) => res.resume()));
  };

  await signIn(env, { device: false, open });

  await closed;
});

test("cn login --rotate saves the rotated key", async () => {
  const calls = stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ key: "sk-cn-v1-rotated", reused: false, rotated: true }),
  );
  const home = loginEnv();
  writeKey("sk-cn-v1-saved", home);

  await runLogin({ device: true, rotate: true }, home, silent);

  expect(JSON.parse(calls[4].body)).toMatchObject({
    current_key: "sk-cn-v1-saved",
    rotate: true,
  });
  expect(readStoredKey(home)).toBe("sk-cn-v1-rotated");
});

test("cn login --rotate with nothing to rotate fails without a terminal", async () => {
  stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ error: "Nothing to rotate" }, 409),
  );
  const home = loginEnv();

  await expect(
    runLogin({ device: true, rotate: true }, home, silent),
  ).rejects.toThrow("Nothing to rotate in Personal");
  expect(readStoredKey(home)).toBeNull();
});

test("cn login --rotate offers to create a key when there's nothing to rotate", async () => {
  const calls = stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ error: "Nothing to rotate" }, 409),
    json({ key: "sk-cn-v1-minted", reused: false }, 201),
  );
  vi.mocked(interactive).mockReturnValueOnce(true);
  vi.mocked(select).mockResolvedValueOnce({ value: "new" });
  const home = loginEnv();

  await runLogin({ device: true, rotate: true }, home, silent);

  expect(JSON.parse(calls[5].body)).not.toHaveProperty("rotate");
  expect(readStoredKey(home)).toBe("sk-cn-v1-minted");
});

// A saved session whose access token expires `inMs` from now.
const withSession = (inMs) => {
  const home = loginEnv();
  writeKey("sk-cn-v1-saved", home);
  writeSession(
    { refresh_token: "r", access_token: "a", expires_at: Date.now() + inMs },
    home,
  );
  return home;
};
const REFRESHED = { access_token: "a2", refresh_token: "r2", expires_in: 3600 };

test("a valid access token is used without a refresh", async () => {
  const calls = stubAuth();

  await expect(sessionToken(withSession(3_600_000))).resolves.toBe("a");
  expect(calls).toHaveLength(0);
});

test("an expiring access token is refreshed and saved", async () => {
  const calls = stubAuth({ token: [json(REFRESHED)] });
  const home = withSession(0);

  await expect(sessionToken(home)).resolves.toBe("a2");

  const sent = new URLSearchParams(calls[1].body);
  expect(calls[1].url).toBe(CONFIG.token_endpoint);
  expect(sent.get("grant_type")).toBe("refresh_token");
  expect(sent.get("refresh_token")).toBe("r");
  expect(readSession(home)?.refresh_token).toBe("r2");
});

test("two refreshes at once send one token request", async () => {
  const calls = stubAuth({ token: [json(REFRESHED)] });
  const home = withSession(0);

  await expect(
    Promise.all([sessionToken(home), sessionToken(home)]),
  ).resolves.toStrictEqual(["a2", "a2"]);
  expect(calls).toHaveLength(3);
  expect(calls[2].url).toBe(CONFIG.token_endpoint);
});

test("a rejected refresh drops the session and keeps the key", async () => {
  stubAuth({ token: [json({ error: "invalid_grant" }, 400)] });
  const home = withSession(0);

  await expect(sessionToken(home)).resolves.toBeNull();
  expect(readSession(home)).toBeNull();
  expect(readStoredKey(home)).toBe("sk-cn-v1-saved");
});

test("a server error during refresh keeps the session", async () => {
  stubAuth({ token: [new Response("Bad gateway", { status: 502 })] });
  const home = withSession(0);

  await expect(sessionToken(home)).rejects.toThrow();
  expect(readSession(home)?.refresh_token).toBe("r");
});

test("a stale lock is taken over", async () => {
  stubAuth({ token: [json(REFRESHED)] });
  const home = withSession(0);
  const lock = path.join(home.CN_CONFIG_HOME, "session.lock");
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);

  await expect(sessionToken(home)).resolves.toBe("a2");
});

test("cn login with a live session skips the browser", async () => {
  const calls = stubAuth({
    token: [
      json({ accounts: [{ organization_id: null, name: "Personal" }] }),
      json({ key: "sk-cn-v1-minted" }, 201),
    ],
  });
  const open = vi.fn();
  const home = withSession(3_600_000);

  await expect(runLogin({ device: false }, home, open)).resolves.toBe(0);

  expect(open).not.toHaveBeenCalled();
  expect(calls[0]).toMatchObject({
    url: "https://app.test/api/cli/accounts",
    auth: "Bearer a",
  });
});

test("cn login --fresh signs in even with a live session", async () => {
  stubAuth({
    device: DEVICE,
    token: [
      json(TOKENS),
      json({ accounts: [{ organization_id: null, name: "Personal" }] }),
      json({ key: "sk-cn-v1-minted" }, 201),
    ],
  });
  const home = withSession(3_600_000);

  await runLogin({ device: true, fresh: true }, home, silent);

  expect(readSession(home)?.access_token).toBe("at");
});

// The token endpoint answers after another process has taken over the lock.
function stubTakeover(lock) {
  vi.stubGlobal("fetch", async (url) => {
    if (String(url) === "https://app.test/api/cli/config") return json(CONFIG);
    fs.writeFileSync(lock, "another process");
    return json(REFRESHED);
  });
}

test("a finished refresh leaves a lock another process took over", async () => {
  const home = withSession(0);
  const lock = path.join(home.CN_CONFIG_HOME, "session.lock");
  stubTakeover(lock);

  await expect(sessionToken(home)).resolves.toBe("a2");
  expect(fs.readFileSync(lock, "utf8")).toBe("another process");
});

test("cn login signs in again when the saved session can't be refreshed", async () => {
  stubAuth({
    device: DEVICE,
    token: [
      new Response("Bad gateway", { status: 502 }),
      json(TOKENS),
      json({ accounts: [{ organization_id: null, name: "Personal" }] }),
      json({ key: "sk-cn-v1-minted" }, 201),
    ],
  });
  const home = withSession(0);

  await expect(runLogin({ device: true }, home, silent)).resolves.toBe(0);
  expect(readSession(home)?.access_token).toBe("at");
});

test("cn login signs in again when the server rejects the saved token", async () => {
  stubAuth({
    device: DEVICE,
    token: [
      json({ error: "Unauthorized" }, 401),
      json(TOKENS),
      json({ accounts: [{ organization_id: null, name: "Personal" }] }),
      json({ key: "sk-cn-v1-minted" }, 201),
    ],
  });
  const home = withSession(3_600_000);

  await expect(runLogin({ device: true }, home, silent)).resolves.toBe(0);
  expect(readSession(home)?.access_token).toBe("at");
  expect(readStoredKey(home)).toBe("sk-cn-v1-minted");
});

test("cn login signs in again when the saved session has ended", async () => {
  stubAuth({
    device: DEVICE,
    token: [
      json({ error: "invalid_grant" }, 400),
      json(TOKENS),
      json({ accounts: [{ organization_id: null, name: "Personal" }] }),
      json({ key: "sk-cn-v1-minted" }, 201),
    ],
  });
  const home = withSession(0);

  await expect(runLogin({ device: true }, home, silent)).resolves.toBe(0);
  expect(readSession(home)?.refresh_token).toBe("rt");
});
