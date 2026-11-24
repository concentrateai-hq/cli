import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CnError } from "../errors.js";
import { which } from "../executables.js";
import { isApiKey } from "../safe.js";
import { configDir, readJson, writeJson } from "./settings.js";
import { parseConfig } from "./config-formats.js";
import {
  applyNativeSetup,
  hasNativeSetup,
  readConfigFile,
  releaseChangedSetting,
  resetNativeSetup,
  withSetupLock,
  type ConfigPlan,
} from "./native-config-store.js";
import { isRecord } from "../validation.js";
import type { Environment, Model } from "../types.js";

export const ZED_PROVIDER = "Concentrate";
// Zed reads an OpenAI-compatible provider's key from an environment variable
// named after the provider: upper snake case plus _API_KEY.
export const ZED_KEY_ENV = "CONCENTRATE_API_KEY";
const DEFAULT_MODEL = "claude-sonnet-5-5";
const PROVIDER_KEY = ["language_models", "openai_compatible", ZED_PROVIDER];
const DEFAULT_KEY = ["agent", "default_model"];

export const ZED_NOTICE =
  process.platform === "darwin"
    ? "Adds a Concentrate provider to Zed's settings and saves your Concentrate API key in the macOS keychain, where Zed reads it. Choose models in Zed's agent panel."
    : `Adds a Concentrate provider to Zed's settings. Zed reads the key from ${ZED_KEY_ENV}, or enter it in Zed's agent settings. Choose models in Zed's agent panel.`;
export const ZED_DONE =
  process.platform === "darwin"
    ? "Done. Open Zed's agent panel and pick a model under Concentrate."
    : `Done. Set ${ZED_KEY_ENV} for Zed or enter your key in Zed's agent settings, then pick a model under Concentrate.`;

const setupDir = (env: Environment) =>
  path.join(configDir(env), "tool-setups", "zed");
const receiptFile = (env: Environment) =>
  path.join(setupDir(env), "restore.json");
const keychainFile = (env: Environment) =>
  path.join(setupDir(env), "keychain.json");

// Zed keeps settings in ~/.config/zed on macOS and in the XDG config
// directory on Linux.
export function zedSettingsFile(
  env: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const home = path.resolve(env.HOME || os.homedir());
  const base =
    platform !== "darwin" && env.XDG_CONFIG_HOME
      ? env.XDG_CONFIG_HOME
      : path.join(home, ".config");
  return path.join(base, "zed", "settings.json");
}

export const zedConfigured = (env: Environment = process.env) =>
  hasNativeSetup(receiptFile(env));

export const zedApiUrl = (apiRoot: string) => `${apiRoot}/v1`;

function zedModels(models: Model[]) {
  const tools = [
    ...new Map(
      models
        .filter((model) => model.chat_candidate)
        .map((model) => [model.id, model]),
    ).values(),
  ];
  return tools.map((model) => ({
    name: model.id,
    display_name: model.name,
    // Zed requires a context size; an unknown one gets a safe floor.
    max_tokens: model.context ?? 128000,
    ...(model.output ? { max_output_tokens: model.output } : {}),
    capabilities: {
      tools: true,
      images: Boolean(model.image),
      parallel_tool_calls: true,
      // Lets Claude and other models reuse the prompt cache between turns.
      prompt_cache_key: true,
      chat_completions: true,
    },
  }));
}

// --- macOS keychain -------------------------------------------------------
// Zed saves a provider's key as an internet password whose server is the
// provider's api_url and whose account is "Bearer". The key is passed to
// `security` on stdin, never on its command line.

function security(env: Environment) {
  return which("security", env.PATH) ?? "/usr/bin/security";
}

const quoted = (value: string) => {
  if (/["\\\n]/.test(value))
    throw new CnError("Cannot save a value with quotes in the keychain.");
  return `"${value}"`;
};

function keychainCommand(command: string, env: Environment) {
  const result = spawnSync(security(env), ["-i"], {
    input: `${command}\n`,
    encoding: "utf8",
    timeout: 15000,
  });
  return result.status === 0;
}

function keychainHas(server: string, env: Environment) {
  const result = spawnSync(
    security(env),
    ["find-internet-password", "-s", server, "-a", "Bearer"],
    { encoding: "utf8", timeout: 15000 },
  );
  return result.status === 0;
}

// Zed installs that may read the key without asking.
function zedApps(env: Environment) {
  const home = path.resolve(env.HOME || os.homedir());
  return [
    "/Applications/Zed.app",
    "/Applications/Zed Preview.app",
    path.join(home, "Applications", "Zed.app"),
    path.join(home, "Applications", "Zed Preview.app"),
  ].filter((app) => fs.existsSync(app));
}

function saveKeychainKey(server: string, key: string, env: Environment) {
  if (!isApiKey(key)) throw new CnError("The saved API key is not valid.");
  const trusted = zedApps(env)
    .map((app) => ` -T ${quoted(app)}`)
    .join("");
  if (
    !keychainCommand(
      `add-internet-password -U -s ${quoted(server)} -a Bearer -w ${quoted(key)}${trusted}`,
      env,
    )
  )
    throw new CnError(
      "Could not save the key in the macOS keychain for Zed. Unlock the login keychain and retry.",
    );
}

// --- Configure / Reset ----------------------------------------------------

export function configureZed(
  apiRoot: string,
  key: string,
  models: Model[],
  env: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const available = zedModels(models);
  if (!available.length)
    throw new CnError(
      "No tool-calling models are available for Zed; nothing was changed.",
    );
  const file = zedSettingsFile(env, platform);
  const server = zedApiUrl(apiRoot);
  return withSetupLock(setupDir(env), () => {
    // A default model the user has since chosen in Zed is theirs.
    releaseChangedSetting(receiptFile(env), [file], file, DEFAULT_KEY);
    const current = parseConfig(readConfigFile(file) ?? "", "json");
    const agent = current.agent;
    const hasDefault = isRecord(agent) && agent.default_model !== undefined;
    const model =
      available.find((entry) => entry.name === DEFAULT_MODEL)?.name ??
      available[0].name;
    const plan: ConfigPlan = {
      file,
      format: "json",
      changes: [
        {
          key: PROVIDER_KEY,
          value: { api_url: server, available_models: available },
        },
        ...(hasDefault
          ? []
          : [
              {
                key: DEFAULT_KEY,
                value: { provider: ZED_PROVIDER, model },
              },
            ]),
      ],
    };
    if (platform === "darwin") {
      // Record whether the entry was ours before writing it, so Reset never
      // removes a key the user saved in Zed themselves.
      const saved = readJson(keychainFile(env));
      const created =
        saved.server === server
          ? saved.created === true
          : !keychainHas(server, env);
      writeJson(keychainFile(env), { version: 1, server, created });
    }
    applyNativeSetup(receiptFile(env), [plan]);
    if (platform === "darwin") saveKeychainKey(server, key, env);
    return file;
  });
}

export function resetZed(
  env: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const file = zedSettingsFile(env, platform);
  return withSetupLock(setupDir(env), () => {
    releaseChangedSetting(receiptFile(env), [file], file, DEFAULT_KEY);
    const result = resetNativeSetup(receiptFile(env), [file]);
    const saved = readJson(keychainFile(env));
    if (typeof saved.server === "string") {
      if (
        platform === "darwin" &&
        saved.created === true &&
        keychainHas(saved.server, env) &&
        !keychainCommand(
          `delete-internet-password -s ${quoted(saved.server)} -a Bearer`,
          env,
        )
      )
        throw new CnError(
          "Zed's settings were reset, but its key could not be removed from the macOS keychain. Unlock the login keychain and run cn reset zed again.",
        );
      fs.rmSync(keychainFile(env), { force: true });
      return { ...result, reset: true };
    }
    return result;
  });
}

// A new cn key replaces the copy Zed reads from the keychain.
export function refreshZedKey(
  apiRoot: string,
  key: string,
  env: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "darwin") return;
  const server = zedApiUrl(apiRoot);
  withSetupLock(setupDir(env), () => saveKeychainKey(server, key, env));
}
