import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "vitest";
import {
  copilotDatabase,
  configureCopilot,
  resetCopilot,
  copilotConfigured,
  refreshCopilotKey,
} from "../../src/lib/config/copilot-config.js";
import {
  configureTool,
  refreshConfiguredKey,
  toolConfigured,
} from "../../src/lib/harnesses/tool-config.js";
import { writeKey, writeJson } from "../../src/lib/config/settings.js";
import { refreshConfiguredTools } from "../../src/lib/cli/update.js";
import { tempDir, runCn } from "../helpers.js";

const ROOT = "https://api.concentrate.ai";
const models = [
  {
    id: "test-tool-model",
    name: "Tool model",
    context: 200000,
    output: 64000,
    image: true,
    efforts: ["none", "low", "medium", "high"],
    chat_candidate: true,
  },
  {
    id: "plain-model",
    name: "Plain model",
    context: null,
    output: null,
    image: false,
    efforts: null,
    chat_candidate: true,
  },
  {
    id: "not-a-tool-model",
    name: "Chat only",
    context: 8000,
    output: 1000,
    image: false,
    efforts: null,
    chat_candidate: false,
  },
];
const laterModels = [models[1], models[2]];
const chatOnly = [models[2]];
const SCHEMA = `PRAGMA journal_mode=WAL;
CREATE TABLE model_providers (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), type TEXT NOT NULL DEFAULT 'openai', settings_json TEXT NOT NULL DEFAULT '{}', account_id TEXT);
CREATE TABLE provider_models (id TEXT PRIMARY KEY NOT NULL, provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE, model_id TEXT NOT NULL, wire_model TEXT, display_name TEXT NOT NULL, max_prompt_tokens INTEGER, max_output_tokens INTEGER, wire_api_override TEXT CHECK (wire_api_override IN ('completions', 'responses')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), supported_reasoning_efforts TEXT, supports_vision INTEGER NOT NULL DEFAULT 0 CHECK (supports_vision IN (0, 1)), UNIQUE(provider_id, model_id));
INSERT INTO model_providers (id, name, type, settings_json) VALUES ('user-provider', 'My provider', 'custom', '{"baseUrl":"https://api.concentrate.ai/v1","wireApi":"responses","authKind":"api_key"}');
INSERT INTO provider_models (id, provider_id, model_id, display_name) VALUES ('user-model', 'user-provider', 'my-model', 'Mine');`;

function sql(file, query) {
  const out = spawnSync("/usr/bin/sqlite3", ["-json", file], {
    input: query,
    encoding: "utf8",
  });
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout || "[]");
}
function fixture() {
  const home = fs.realpathSync(tempDir("cn-copilot-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pgrep"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  const env = {
    HOME: home,
    COPILOT_HOME: path.join(home, "copilot-home"),
    PATH: `${bin}:${path.dirname(process.execPath)}`,
    CN_CONFIG_HOME: path.join(home, "cn"),
    CN_OFFLINE: "1",
  };
  const database = copilotDatabase(env);
  fs.mkdirSync(path.dirname(database));
  sql(database, SCHEMA);
  return { env, database, bin };
}
const providers = (f) =>
  sql(f.database, "SELECT * FROM model_providers ORDER BY name;");
const modelRows = (f) =>
  sql(
    f.database,
    "SELECT p.name AS provider, m.* FROM provider_models m JOIN model_providers p ON p.id = m.provider_id ORDER BY p.name, m.model_id;",
  );
const headersOf = (provider) =>
  JSON.parse(JSON.parse(provider.settings_json).headersJson);

test("Copilot app Claude models use the Responses API and the rest use Chat Completions", () => {
  const f = fixture();
  configureCopilot(
    ROOT,
    "sk-dummy",
    [{ ...models[0], id: "claude-sonnet-5-5" }, models[1]],
    f.env,
  );
  const overrides = Object.fromEntries(
    modelRows(f)
      .filter((row) => row.provider === "Concentrate AI")
      .map((row) => [row.model_id, row.wire_api_override]),
  );
  expect(overrides).toStrictEqual({
    "claude-sonnet-5-5": "responses",
    "plain-model": null,
  });
});

test("Copilot app Configure adds cn's provider with tool models, and Reset removes only it", () => {
  const f = fixture();
  const before = { providers: providers(f), models: modelRows(f) };
  expect(copilotDatabase(f.env)).toBe(path.join(f.env.COPILOT_HOME, "data.db"));
  configureCopilot(ROOT, "sk-dummy", models, f.env);
  expect(copilotConfigured(f.env)).toBe(true);
  const added = providers(f);
  expect(added).toHaveLength(2);
  expect(added[1]).toMatchObject(before.providers[0]);
  expect(added[0]).toMatchObject({ name: "Concentrate AI", type: "custom" });
  expect(JSON.parse(added[0].settings_json)).toMatchObject({
    baseUrl: `${ROOT}/v1`,
    wireApi: "completions",
    authKind: "none",
  });
  expect(headersOf(added[0])).toStrictEqual({
    Authorization: "Bearer sk-dummy",
    "X-App": "copilot",
  });
  const rows = modelRows(f);
  expect(rows).toHaveLength(3);
  expect(rows).toMatchObject([
    {
      provider: "Concentrate AI",
      model_id: "plain-model",
      wire_model: "plain-model",
      display_name: "Plain model",
      max_prompt_tokens: null,
      max_output_tokens: null,
      wire_api_override: null,
      supported_reasoning_efforts: null,
      supports_vision: 0,
    },
    {
      provider: "Concentrate AI",
      model_id: "test-tool-model",
      wire_model: "test-tool-model",
      display_name: "Tool model",
      max_prompt_tokens: 200000,
      max_output_tokens: 64000,
      wire_api_override: null,
      supported_reasoning_efforts: '["low","medium","high"]',
      supports_vision: 1,
    },
    before.models[0],
  ]);
  expect(fs.statSync(f.database).mode & 0o777).toBe(0o600);
  configureCopilot(ROOT, "sk-dummy", laterModels, f.env);
  expect(providers(f)).toHaveLength(2);
  expect(modelRows(f)).toHaveLength(2);
  expect(resetCopilot(f.env)).toStrictEqual({ reset: true, preserved: [] });
  expect(copilotConfigured(f.env)).toBe(false);
  expect(providers(f)).toStrictEqual(before.providers);
  expect(modelRows(f)).toStrictEqual(before.models);
  expect(resetCopilot(f.env)).toStrictEqual({ reset: false, preserved: [] });
});

test("Copilot app Configure recreates a provider deleted in the app under the same id", () => {
  const f = fixture();
  configureCopilot(ROOT, "sk-dummy", models, f.env);
  const id = providers(f)[0].id;
  sql(f.database, `DELETE FROM model_providers WHERE id='${id}';`);
  expect(() => refreshCopilotKey(ROOT, "sk-new", f.env)).toThrow(
    /no longer has cn's Concentrate provider/,
  );
  configureCopilot(ROOT, "sk-dummy", models, f.env);
  expect(providers(f)[0].id).toBe(id);
});

test("Copilot app key rotation rewrites only cn's provider header", async () => {
  const f = fixture();
  writeKey("sk-saved", f.env);
  writeJson(path.join(f.env.CN_CONFIG_HOME, "catalog.json"), {
    version: 6,
    fetched_at: Date.now(),
    models,
  });
  await configureTool("copilot", f.env);
  expect(toolConfigured("copilot", f.env)).toBe(true);
  writeKey("sk-rotated", f.env);
  refreshConfiguredKey(f.env);
  const rows = providers(f);
  expect(headersOf(rows[0]).Authorization).toBe("Bearer sk-rotated");
  expect(JSON.parse(rows[1].settings_json).headersJson).toBe(undefined);
});

test("cn refresh updates Copilot's models, and skips the app without failing while it is open", async () => {
  const f = fixture();
  const catalog = (list) =>
    writeJson(path.join(f.env.CN_CONFIG_HOME, "catalog.json"), {
      version: 6,
      fetched_at: Date.now(),
      models: list,
    });
  writeKey("sk-saved", f.env);
  catalog(models);
  await configureTool("copilot", f.env);
  const ours = () =>
    modelRows(f)
      .filter((row) => row.provider === "Concentrate AI")
      .map((row) => row.model_id);
  expect(ours()).toStrictEqual(["plain-model", "test-tool-model"]);
  catalog(laterModels);
  expect(await refreshConfiguredTools(f.env)).toBe(0);
  expect(ours()).toStrictEqual(["plain-model"]);
  catalog(models);
  fs.writeFileSync(path.join(f.bin, "pgrep"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  expect(await refreshConfiguredTools(f.env)).toBe(0);
  expect(ours()).toStrictEqual(["plain-model"]);
});

test("After the Copilot app's settings are gone, a key change and Reset just forget cn's record", () => {
  const f = fixture();
  writeKey("sk-saved", f.env);
  configureCopilot(ROOT, "sk-saved", models, f.env);
  fs.rmSync(path.dirname(f.database), { recursive: true });
  expect(() => refreshConfiguredKey(f.env)).not.toThrow();
  expect(copilotConfigured(f.env)).toBe(false);
  const g = fixture();
  configureCopilot(ROOT, "sk-saved", models, g.env);
  fs.rmSync(path.dirname(g.database), { recursive: true });
  expect(resetCopilot(g.env).reset).toBe(true);
  expect(copilotConfigured(g.env)).toBe(false);
});

test("Copilot app rejects a running app, a missing database, symlinks and empty catalogs", () => {
  const f = fixture();
  const before = providers(f);
  fs.writeFileSync(path.join(f.bin, "pgrep"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  expect(() => configureCopilot(ROOT, "sk-dummy", models, f.env)).toThrow(
    /GitHub Copilot is open/,
  );
  expect(providers(f)).toStrictEqual(before);
  expect(copilotConfigured(f.env)).toBe(false);
  fs.writeFileSync(path.join(f.bin, "pgrep"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  expect(() => configureCopilot(ROOT, "sk-dummy", chatOnly, f.env)).toThrow(
    /No tool-calling/,
  );
  const renamed = f.database + ".original";
  fs.renameSync(f.database, renamed);
  expect(() => configureCopilot(ROOT, "sk-dummy", models, f.env)).toThrow(
    /Install and open the app once/,
  );
  fs.symlinkSync(renamed, f.database);
  expect(() => configureCopilot(ROOT, "sk-dummy", models, f.env)).toThrow(
    /symbolic link/,
  );
});

test("Copilot app rejects a malformed restore record", () => {
  const f = fixture();
  writeJson(
    path.join(f.env.CN_CONFIG_HOME, "tool-setups", "copilot", "restore.json"),
    {
      version: 1,
      providerId: "user-provider",
    },
  );
  expect(() => resetCopilot(f.env)).toThrow(/restore record is invalid/);
  expect(providers(f)).toHaveLength(1);
});

test("Copilot SQL values with quotes round-trip without executing their contents", () => {
  const f = fixture();
  configureCopilot(
    ROOT,
    "sk-key'with-quote",
    [{ ...models[1], name: "It's; DROP TABLE model_providers; --" }],
    f.env,
  );
  expect(headersOf(providers(f)[0]).Authorization).toBe(
    "Bearer sk-key'with-quote",
  );
  expect(modelRows(f)[0].display_name).toBe(
    "It's; DROP TABLE model_providers; --",
  );
});

test.each([
  ["reset", ["reset", "copilot"]],
  ["global reset", ["reset", "--yes"]],
  ["logout", ["logout"]],
])(
  "Copilot app CLI Configure, then %s removes cn's provider",
  (_operation, args) => {
    const f = fixture();
    const before = providers(f);
    writeKey("sk-saved", f.env);
    writeJson(path.join(f.env.CN_CONFIG_HOME, "catalog.json"), {
      version: 6,
      fetched_at: Date.now(),
      models,
    });
    const configured = runCn(["configure", "copilot"], { env: f.env });
    expect(configured.status, configured.stderr).toBe(0);
    expect(configured.stdout).toMatch(/Open Copilot and pick a model/);
    expect(configured.stdout).not.toMatch(/sk-saved/);
    expect(providers(f)).toHaveLength(2);
    const result = runCn(args, { env: f.env });
    expect(result.status, result.stderr).toBe(0);
    expect(providers(f)).toStrictEqual(before);
  },
);
