import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CnError } from "../errors.js";
import { isOpenAiModel } from "../safe.js";
import { isRecord, record } from "../validation.js";
import { appHeaders } from "../harnesses/app-headers.js";
import { configDir, readJson, writeJson } from "./settings.js";
import { withSetupLock } from "./native-config-store.js";
import type { Environment, Model } from "../types.js";

// Copilot CLI picks the wire format per provider, so Concentrate is three
// providers: Claude on the Anthropic Messages API (it caches there), OpenAI
// models on the Responses API, and every other model on Chat Completions.
export const COPILOT_PROVIDERS = {
  chat: "concentrate",
  claude: "concentrate-claude",
  openai: "concentrate-openai",
} as const;
const OWNED = new Set<string>(Object.values(COPILOT_PROVIDERS));

type Credential = { apiKey: string } | { apiKeyCommand: string };

export const copilotHome = (env: Environment = process.env) =>
  env.COPILOT_HOME || path.join(env.HOME || os.homedir(), ".copilot");
export const copilotProvidersFile = (env: Environment = process.env) =>
  path.join(copilotHome(env), "providers.json");

export function copilotProvider(id: string) {
  const base = id.split("/").pop() ?? id;
  if (/^claude-/.test(base)) return COPILOT_PROVIDERS.claude;
  if (isOpenAiModel(id)) return COPILOT_PROVIDERS.openai;
  return COPILOT_PROVIDERS.chat;
}

// The model reference Copilot's --model and /model use: provider/model.
export const copilotModelRef = (id: string) => `${copilotProvider(id)}/${id}`;

// Concentrate's providers and models for Copilot CLI's providers.json.
export function copilotEntries(
  apiRoot: string,
  models: Model[],
  credential: Credential,
) {
  const listed = [
    ...new Map(
      models
        .filter((model) => model.chat_candidate)
        .map((model) => [model.id, model]),
    ).values(),
  ];
  const headers = appHeaders("copilot-cli");
  const definitions = {
    [COPILOT_PROVIDERS.chat]: {
      type: "openai",
      baseUrl: `${apiRoot}/v1`,
      wireApi: "completions",
    },
    // Copilot's Anthropic client adds /v1/messages itself.
    [COPILOT_PROVIDERS.claude]: { type: "anthropic", baseUrl: apiRoot },
    [COPILOT_PROVIDERS.openai]: {
      type: "openai",
      baseUrl: `${apiRoot}/v1`,
      wireApi: "responses",
    },
  };
  const used = new Set<string>(
    listed.map((model) => copilotProvider(model.id)),
  );
  return {
    providers: Object.entries(definitions)
      .filter(([name]) => used.has(name))
      .map(([name, definition]) => ({
        name,
        ...definition,
        ...credential,
        headers,
      })),
    models: listed.map((model) => ({
      id: model.id,
      provider: copilotProvider(model.id),
      ...(model.context ? { maxPromptTokens: model.context } : {}),
      ...(model.output ? { maxOutputTokens: model.output } : {}),
    })),
  };
}

// providers.json as Copilot left it; anything unreadable is the user's to fix.
function readProviders(file: string) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CnError(
      `${file} is not valid JSON. Fix or remove it, then retry; nothing was changed.`,
    );
  }
  if (!isRecord(value))
    throw new CnError(
      `${file} does not hold a JSON object. Fix or remove it, then retry; nothing was changed.`,
    );
  return value;
}

const entries = (value: unknown): unknown[] =>
  Array.isArray(value) ? (value as unknown[]) : [];
const providerName = (entry: unknown) => record(entry).name;
const modelProvider = (entry: unknown) => record(entry).provider;

// The user's own providers and models: everything not named after Concentrate's.
export function userEntries(document: Record<string, unknown> | null) {
  return {
    providers: entries(document?.providers).filter(
      (entry) => !OWNED.has(providerName(entry) as string),
    ),
    models: entries(document?.models).filter(
      (entry) => !OWNED.has(modelProvider(entry) as string),
    ),
  };
}

// For cn copilot: the user's providers file with Concentrate's entries added,
// so models they added themselves stay in /model.
export function launchProviders(
  apiRoot: string,
  models: Model[],
  env: Environment,
) {
  let document: Record<string, unknown> | null = null;
  try {
    document = readProviders(copilotProvidersFile(env));
  } catch {
    // Copilot reports its own damaged file; cn's session still starts.
  }
  const own = userEntries(document);
  const cn = copilotEntries(apiRoot, models, {
    apiKeyCommand: "printenv CONCENTRATE_API_KEY",
  });
  return {
    ...(document ?? {}),
    providers: [...own.providers, ...cn.providers],
    models: [...own.models, ...cn.models],
  };
}

const setupDir = (env: Environment) =>
  path.join(configDir(env), "tool-setups", "copilot-cli");
const receiptFile = (env: Environment) =>
  path.join(setupDir(env), "restore.json");

export const copilotCliConfigured = (env: Environment = process.env) =>
  fs.existsSync(receiptFile(env));

function writeProviders(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.cn-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

// Plain `copilot` lists Concentrate models. The key sits in providers.json,
// like any key added through Copilot's /model, so the file is kept private.
export function configureCopilotCli(
  apiRoot: string,
  key: string,
  models: Model[],
  env: Environment = process.env,
) {
  const file = copilotProvidersFile(env);
  return withSetupLock(setupDir(env), () => {
    const document = readProviders(file);
    if (!copilotCliConfigured(env)) {
      const taken = entries(document?.providers)
        .map(providerName)
        .filter((name) => OWNED.has(name as string));
      if (taken.length)
        throw new CnError(
          `${file} already has a provider named ${String(taken[0])}. Rename or remove it, then retry; nothing was changed.`,
        );
    }
    const cn = copilotEntries(apiRoot, models, { apiKey: key });
    if (!cn.models.length)
      throw new CnError(
        "No tool-calling models are available for GitHub Copilot CLI; nothing was changed.",
      );
    const own = userEntries(document);
    // Record first, so an interrupted setup can still be reset.
    if (!copilotCliConfigured(env))
      writeJson(receiptFile(env), { version: 1, created: document === null });
    writeProviders(file, {
      ...(document ?? {}),
      providers: [...own.providers, ...cn.providers],
      models: [...own.models, ...cn.models],
    });
    return file;
  });
}

export function resetCopilotCli(env: Environment = process.env) {
  if (!copilotCliConfigured(env))
    return { reset: false, preserved: [] as string[] };
  const file = copilotProvidersFile(env);
  return withSetupLock(setupDir(env), () => {
    const saved = readJson(receiptFile(env));
    const document = readProviders(file);
    if (document) {
      const own = userEntries(document);
      const { providers: _p, models: _m, ...rest } = document;
      const empty =
        !own.providers.length &&
        !own.models.length &&
        !Object.keys(rest).length;
      if (empty && saved.created === true) fs.rmSync(file, { force: true });
      else
        writeProviders(file, {
          ...rest,
          providers: own.providers,
          models: own.models,
        });
    }
    fs.rmSync(receiptFile(env), { force: true });
    return { reset: true, preserved: [] as string[] };
  });
}

// A new cn key replaces the copy in Concentrate's providers only.
export function refreshCopilotCliKey(key: string, env: Environment) {
  const file = copilotProvidersFile(env);
  withSetupLock(setupDir(env), () => {
    const document = readProviders(file);
    const providers = entries(document?.providers);
    const ours = providers.filter((entry) =>
      OWNED.has(providerName(entry) as string),
    );
    if (!document || !ours.length)
      throw new CnError(
        "GitHub Copilot CLI no longer has cn's Concentrate providers. Run cn configure copilot-cli to add them again.",
      );
    writeProviders(file, {
      ...document,
      providers: providers.map((entry) =>
        OWNED.has(providerName(entry) as string)
          ? { ...record(entry), apiKey: key }
          : entry,
      ),
    });
  });
}
