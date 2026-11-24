import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { parse } from "jsonc-parser";
import {
  configureZed,
  refreshZedKey,
  resetZed,
  zedConfigured,
  zedSettingsFile,
} from "../../src/lib/config/zed-config.js";
import {
  refreshConfiguredKey,
  toolConfigured,
} from "../../src/lib/harnesses/tool-config.js";
import { writeKey } from "../../src/lib/config/settings.js";
import { tempDir } from "../helpers.js";

const ROOT = "https://api.concentrate.ai";
const URL = `${ROOT}/v1`;
const KEY = `sk-cn-v1-${"a".repeat(64)}`;
const NEW_KEY = `sk-cn-v1-${"b".repeat(64)}`;
const models = [
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    context: 200000,
    output: 64000,
    image: true,
    chat_candidate: true,
  },
  {
    id: "plain-model",
    name: "Plain model",
    context: null,
    output: null,
    image: false,
    chat_candidate: true,
  },
  {
    id: "chat-only",
    name: "Chat only",
    context: 8000,
    output: 1000,
    image: false,
    chat_candidate: false,
  },
];

// A stand-in for macOS `security` that keeps internet passwords in a JSON file
// and records each command line, so tests never touch the real keychain.
const FAKE_SECURITY = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const store = path.join(dir, "keychain.json");
const log = path.join(dir, "security.log");
const load = () => (fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : {});
const save = (data) => fs.writeFileSync(store, JSON.stringify(data));
fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
const words = (line) => [...line.matchAll(/"([^"]*)"|(\\S+)/g)].map((m) => m[1] ?? m[2]);
const opt = (args, flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
function run(args) {
  const data = load();
  const id = opt(args, "-s") + "|" + opt(args, "-a");
  if (args[0] === "find-internet-password") return data[id] ? 0 : 44;
  if (args[0] === "add-internet-password") {
    if (data[id] && !args.includes("-U")) return 45;
    data[id] = { password: opt(args, "-w"), trusted: args.filter((a, i) => args[i - 1] === "-T") };
    save(data);
    return 0;
  }
  if (args[0] === "delete-internet-password") {
    if (!data[id]) return 44;
    delete data[id];
    save(data);
    return 0;
  }
  return 1;
}
if (process.argv[2] === "-i") {
  let status = 0;
  for (const line of fs.readFileSync(0, "utf8").split("\\n").filter(Boolean)) status = run(words(line)) || status;
  process.exit(status);
}
process.exit(run(process.argv.slice(2)));
`;

function fixture(settings?: string) {
  const home = fs.realpathSync(tempDir("cn-zed-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "security"), FAKE_SECURITY, {
    mode: 0o755,
  });
  const env = {
    HOME: home,
    PATH: `${bin}:${path.dirname(process.execPath)}`,
    CN_CONFIG_HOME: path.join(home, "cn"),
    CN_OFFLINE: "1",
  };
  const file = zedSettingsFile(env, "darwin");
  if (settings !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, settings);
  }
  const keychain = () => {
    const store = path.join(bin, "keychain.json");
    return fs.existsSync(store)
      ? JSON.parse(fs.readFileSync(store, "utf8"))
      : {};
  };
  const commandLines = () => {
    const log = path.join(bin, "security.log");
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  };
  const read = () => fs.readFileSync(file, "utf8");
  return { env, file, keychain, commandLines, read };
}

test("Zed settings live in ~/.config/zed on macOS and the XDG directory on Linux", () => {
  const env = { HOME: "/home/me", XDG_CONFIG_HOME: "/xdg" };
  expect(zedSettingsFile(env, "darwin")).toBe(
    "/home/me/.config/zed/settings.json",
  );
  expect(zedSettingsFile(env, "linux")).toBe("/xdg/zed/settings.json");
  expect(zedSettingsFile({ HOME: "/home/me" }, "linux")).toBe(
    "/home/me/.config/zed/settings.json",
  );
});

test("Zed Configure on a fresh install adds the provider, a default model, and the keychain key", () => {
  const f = fixture();
  configureZed(ROOT, KEY, models, f.env, "darwin");
  expect(zedConfigured(f.env)).toBe(true);
  const doc = parse(f.read());
  expect(doc.language_models.openai_compatible.Concentrate).toStrictEqual({
    api_url: URL,
    available_models: [
      {
        name: "claude-sonnet-5-5",
        display_name: "Claude Sonnet 5.5",
        max_tokens: 200000,
        max_output_tokens: 64000,
        capabilities: {
          tools: true,
          images: true,
          parallel_tool_calls: true,
          prompt_cache_key: true,
          chat_completions: true,
        },
      },
      {
        name: "plain-model",
        display_name: "Plain model",
        max_tokens: 128000,
        capabilities: {
          tools: true,
          images: false,
          parallel_tool_calls: true,
          prompt_cache_key: true,
          chat_completions: true,
        },
      },
    ],
  });
  expect(doc.agent.default_model).toStrictEqual({
    provider: "Concentrate",
    model: "claude-sonnet-5-5",
  });
  expect(f.keychain()[`${URL}|Bearer`].password).toBe(KEY);
  // The key goes to `security` on stdin, never on its command line.
  expect(f.commandLines()).not.toContain(KEY);
});

test("Zed Configure keeps comments, other providers, and the user's default model", () => {
  const original = `// My Zed settings
{
  // theme comment
  "theme": "One Dark",
  "agent": {
    "default_model": { "provider": "anthropic", "model": "claude-opus" },
  },
  "language_models": {
    "openai_compatible": {
      "Mine": { "api_url": "http://localhost:1234/v1", "available_models": [] }
    }
  },
  "edit_predictions": { "provider": "zed" }
}
`;
  const f = fixture(original);
  configureZed(ROOT, KEY, models, f.env, "darwin");
  const text = f.read();
  expect(text).toContain("// My Zed settings");
  expect(text).toContain("// theme comment");
  const doc = parse(text);
  expect(doc.agent.default_model).toStrictEqual({
    provider: "anthropic",
    model: "claude-opus",
  });
  expect(doc.language_models.openai_compatible.Mine.api_url).toBe(
    "http://localhost:1234/v1",
  );
  expect(doc.edit_predictions).toStrictEqual({ provider: "zed" });
  expect(doc.language_models.openai_compatible.Concentrate.api_url).toBe(URL);

  const result = resetZed(f.env, "darwin");
  expect(result).toStrictEqual({ reset: true, preserved: [] });
  expect(f.read()).toBe(original);
  expect(f.keychain()).toStrictEqual({});
  expect(zedConfigured(f.env)).toBe(false);
});

test("Zed Reset removes only cn's parts and keeps a default model the user picked since", () => {
  const f = fixture('{\n  "theme": "One Dark"\n}\n');
  configureZed(ROOT, KEY, models, f.env, "darwin");
  // Zed rewrites the default model when the user picks one in the agent panel.
  const picked = f
    .read()
    .replace('"model": "claude-sonnet-5-5"', '"model": "plain-model"');
  fs.writeFileSync(f.file, picked);
  // Configure again (as cn refresh does) does not fight the user's choice.
  configureZed(ROOT, KEY, models.slice(1), f.env, "darwin");
  let doc = parse(f.read());
  expect(doc.agent.default_model.model).toBe("plain-model");
  expect(
    doc.language_models.openai_compatible.Concentrate.available_models.map(
      (m) => m.name,
    ),
  ).toStrictEqual(["plain-model"]);

  expect(resetZed(f.env, "darwin")).toStrictEqual({
    reset: true,
    preserved: [],
  });
  doc = parse(f.read());
  expect(doc).toStrictEqual({
    theme: "One Dark",
    agent: { default_model: { provider: "Concentrate", model: "plain-model" } },
  });
  expect(f.keychain()).toStrictEqual({});
});

test("Zed Reset leaves a keychain key the user saved in Zed before cn", () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.env.HOME, "bin", "keychain.json"),
    JSON.stringify({ [`${URL}|Bearer`]: { password: "theirs" } }),
  );
  configureZed(ROOT, KEY, models, f.env, "darwin");
  expect(f.keychain()[`${URL}|Bearer`].password).toBe(KEY);
  resetZed(f.env, "darwin");
  expect(f.keychain()[`${URL}|Bearer`]).toBeDefined();
});

test("Zed key refresh replaces the keychain copy", () => {
  const f = fixture();
  writeKey(KEY, f.env);
  configureZed(ROOT, KEY, models, f.env, "darwin");
  expect(toolConfigured("zed", f.env)).toBe(true);
  refreshZedKey(ROOT, NEW_KEY, f.env, "darwin");
  expect(f.keychain()[`${URL}|Bearer`].password).toBe(NEW_KEY);
  expect(f.commandLines()).not.toContain(NEW_KEY);
});

test("refreshConfiguredKey updates Zed's keychain copy with the saved key", () => {
  if (process.platform !== "darwin") return;
  const f = fixture();
  writeKey(KEY, f.env);
  configureZed(ROOT, KEY, models, f.env, "darwin");
  writeKey(NEW_KEY, f.env);
  refreshConfiguredKey(f.env);
  expect(f.keychain()[`${URL}|Bearer`].password).toBe(NEW_KEY);
});

test("Zed Configure on Linux writes settings only", () => {
  const f = fixture();
  const env = { ...f.env, XDG_CONFIG_HOME: path.join(f.env.HOME, "xdg") };
  const file = configureZed(ROOT, KEY, models, env, "linux");
  expect(file).toBe(path.join(env.XDG_CONFIG_HOME, "zed", "settings.json"));
  expect(
    parse(fs.readFileSync(file, "utf8")).language_models.openai_compatible
      .Concentrate.api_url,
  ).toBe(URL);
  expect(f.keychain()).toStrictEqual({});
  expect(resetZed(env, "linux").reset).toBe(true);
  expect(fs.existsSync(file)).toBe(false);
});

test("Zed Configure refuses when no model supports tools", () => {
  const f = fixture();
  expect(() => configureZed(ROOT, KEY, [models[2]], f.env, "darwin")).toThrow(
    /No tool-calling models/,
  );
  expect(fs.existsSync(f.file)).toBe(false);
});
