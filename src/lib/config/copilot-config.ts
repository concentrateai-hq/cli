import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CnError } from "../errors.js";
import { configDir, readJson, writeJson } from "./settings.js";
import { withSetupLock } from "./native-config-store.js";
import { requireAppClosed } from "../executables.js";
import { appHeaders } from "../harnesses/app-headers.js";
import {
  databaseCommand,
  privateDatabase,
  restrictDatabase,
} from "./sqlite-store.js";
import type { Environment, Model } from "../types.js";

export const COPILOT_NOTICE =
  "The GitHub Copilot app stores your Concentrate API key in its local settings database. Quit the app before Configure or Reset. Choose Concentrate models in the app's model picker.";
const APP = "GitHub Copilot";
// The efforts the app's runtime accepts; it stores them as a JSON array of strings.
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const literal = (value: string | number | null) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(Math.trunc(value))
      : `'${value.replaceAll("'", "''")}'`;
const setupDir = (env: Environment) =>
  path.join(configDir(env), "tool-setups", "copilot");
const receiptFile = (env: Environment) =>
  path.join(setupDir(env), "restore.json");

export function copilotDatabase(env: Environment = process.env) {
  return path.join(
    env.COPILOT_HOME || path.join(env.HOME || os.homedir(), ".copilot"),
    "data.db",
  );
}

// cn owns only the provider it created; the receipt records its id.
function providerId(env: Environment) {
  const saved = readJson(receiptFile(env));
  if (!Object.keys(saved).length) return null;
  if (
    saved.version !== 1 ||
    typeof saved.providerId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(saved.providerId)
  )
    throw new CnError(
      "The GitHub Copilot app's Concentrate restore record is invalid; nothing was changed.",
    );
  return saved.providerId;
}

export const copilotConfigured = (env: Environment = process.env) =>
  fs.existsSync(receiptFile(env));

function locked<T>(env: Environment, work: (file: string) => T) {
  return withSetupLock(setupDir(env), () => {
    requireAppClosed(
      APP,
      process.platform === "darwin" ? "github" : undefined,
      env,
    );
    const file = copilotDatabase(env);
    if (!fs.existsSync(file))
      throw new CnError(
        "No GitHub Copilot app settings found. Install and open the app once, then quit it and retry.",
      );
    privateDatabase(file, 2);
    return work(file);
  });
}

function run(file: string, statements: string[], env: Environment) {
  restrictDatabase(file);
  return databaseCommand(
    file,
    `BEGIN IMMEDIATE;\n${statements.join("\n")}\nCOMMIT;`,
    env,
    true,
    APP,
  );
}

const settings = (apiRoot: string, key: string) =>
  JSON.stringify({
    baseUrl: `${apiRoot}/v1`,
    wireApi: "completions",
    authKind: "none",
    headersJson: JSON.stringify(
      appHeaders("copilot", { Authorization: `Bearer ${key}` }),
    ),
  });

// On the Responses API the app sends a tool_search tool that Concentrate does
// not accept yet, so only Claude models, which need it for caching, use it.
const wireApi = (model: Model) =>
  /^claude-/.test(model.id) ? "responses" : null;

function modelRow(id: string, model: Model) {
  const efforts = (model.efforts ?? []).filter((level) => EFFORTS.has(level));
  return `(${[
    randomUUID(),
    id,
    model.id,
    model.id,
    model.name,
    model.context,
    model.output,
    wireApi(model),
    efforts.length ? JSON.stringify(efforts) : null,
    model.image ? 1 : 0,
  ]
    .map(literal)
    .join(
      ",",
    )},strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
}

export function configureCopilot(
  apiRoot: string,
  key: string,
  models: Model[],
  env: Environment = process.env,
) {
  const tools = [
    ...new Map(
      models
        .filter((model) => model.chat_candidate)
        .map((model) => [model.id, model]),
    ).values(),
  ];
  if (!tools.length)
    throw new CnError(
      "No tool-calling models are available for the GitHub Copilot app; nothing was changed.",
    );
  return locked(env, (file) => {
    let id = providerId(env);
    // Record the id before writing, so an interrupted setup can still be reset.
    if (!id) {
      id = randomUUID();
      writeJson(receiptFile(env), { version: 1, providerId: id });
    }
    run(
      file,
      [
        `INSERT INTO model_providers (id, name, type, settings_json, created_at, updated_at) VALUES (${literal(id)}, 'Concentrate AI', 'custom', ${literal(settings(apiRoot, key))}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, settings_json=excluded.settings_json, updated_at=excluded.updated_at;`,
        `DELETE FROM provider_models WHERE provider_id=${literal(id)};`,
        `INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name, max_prompt_tokens, max_output_tokens, wire_api_override, supported_reasoning_efforts, supports_vision, created_at, updated_at) VALUES ${tools.map((model) => modelRow(id, model)).join(",")};`,
      ],
      env,
    );
    return file;
  });
}

// With the app's settings gone (uninstalled, or its data removed) there is no
// provider or key copy left, so cn only forgets its record.
function forgetIfAppGone(env: Environment) {
  if (fs.existsSync(copilotDatabase(env))) return false;
  withSetupLock(setupDir(env), () =>
    fs.rmSync(receiptFile(env), { force: true }),
  );
  return true;
}

export function resetCopilot(env: Environment = process.env) {
  if (!copilotConfigured(env))
    return { reset: false, preserved: [] as string[] };
  if (forgetIfAppGone(env)) return { reset: true, preserved: [] as string[] };
  return locked(env, (file) => {
    const id = literal(providerId(env));
    run(
      file,
      [
        `DELETE FROM provider_models WHERE provider_id=${id};`,
        `DELETE FROM model_providers WHERE id=${id};`,
      ],
      env,
    );
    fs.rmSync(receiptFile(env));
    return { reset: true, preserved: [] as string[] };
  });
}

export function refreshCopilotKey(
  apiRoot: string,
  key: string,
  env: Environment,
) {
  if (forgetIfAppGone(env)) return;
  return locked(env, (file) => {
    const id = literal(providerId(env));
    const output = run(
      file,
      [
        `UPDATE model_providers SET settings_json=${literal(settings(apiRoot, key))}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=${id};`,
        "SELECT changes() AS changed;",
      ],
      env,
    );
    if (!output.includes('"changed":1'))
      throw new CnError(
        "The GitHub Copilot app no longer has cn's Concentrate provider. Run cn configure copilot to add it again.",
      );
  });
}
