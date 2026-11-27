import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import {
  configureCopilotCli,
  copilotCliConfigured,
  copilotEntries,
  copilotModelRef,
  refreshCopilotCliKey,
  resetCopilotCli,
} from "../../src/lib/config/copilot-cli-config.js";
import { parseHarnessLaunchArgs } from "../../src/lib/cli/cli.js";
import {
  writeCatalog,
  writeOrgServers,
  runCn,
  setup,
  tempDir,
} from "../helpers.js";

const ROOT = "https://api.concentrate.ai";
const model = (id, extra = {}) => ({
  id,
  name: id,
  context: 200000,
  output: 32000,
  image: false,
  efforts: null,
  chat_candidate: true,
  ...extra,
});
const models = [
  model("claude-sonnet-5-5"),
  model("gpt-6.2-sol"),
  model("deepseek-v4-pro", { context: null, output: null }),
  model("chat-only", { chat_candidate: false }),
];

function fixture() {
  const home = tempDir("cn-copilot-cli-");
  return {
    env: {
      HOME: home,
      COPILOT_HOME: path.join(home, "copilot"),
      CN_CONFIG_HOME: path.join(home, "cn"),
    },
    file: path.join(home, "copilot", "providers.json"),
  };
}
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const userProvider = {
  name: "mine",
  type: "openai",
  baseUrl: "http://127.0.0.1:8080/v1",
  extra: { kept: true },
};
const userModel = { id: "local", provider: "mine", maxPromptTokens: 8000 };

test("each model goes to the provider for its wire format", () => {
  expect(copilotModelRef("claude-sonnet-5-5")).toBe(
    "concentrate-claude/claude-sonnet-5-5",
  );
  expect(copilotModelRef("anthropic/claude-opus-5-5")).toBe(
    "concentrate-claude/anthropic/claude-opus-5-5",
  );
  expect(copilotModelRef("gpt-6.2-sol")).toBe("concentrate-openai/gpt-6.2-sol");
  expect(copilotModelRef("deepseek-v4-pro")).toBe(
    "concentrate/deepseek-v4-pro",
  );
  const entries = copilotEntries(ROOT, models, { apiKey: "sk-x" });
  expect(entries.providers).toStrictEqual([
    {
      name: "concentrate",
      type: "openai",
      baseUrl: `${ROOT}/v1`,
      wireApi: "completions",
      apiKey: "sk-x",
      headers: { "X-App": "copilot-cli" },
    },
    {
      name: "concentrate-claude",
      type: "anthropic",
      baseUrl: ROOT,
      apiKey: "sk-x",
      headers: { "X-App": "copilot-cli" },
    },
    {
      name: "concentrate-openai",
      type: "openai",
      baseUrl: `${ROOT}/v1`,
      wireApi: "responses",
      apiKey: "sk-x",
      headers: { "X-App": "copilot-cli" },
    },
  ]);
  const plain = {
    supports: { toolCalls: true, vision: false, reasoningEffort: false },
  };
  expect(entries.models).toStrictEqual([
    {
      id: "claude-sonnet-5-5",
      provider: "concentrate-claude",
      name: "claude-sonnet-5-5",
      maxPromptTokens: 168000,
      maxContextWindowTokens: 200000,
      maxOutputTokens: 32000,
      capabilities: plain,
    },
    {
      id: "gpt-6.2-sol",
      provider: "concentrate-openai",
      name: "gpt-6.2-sol",
      maxPromptTokens: 168000,
      maxContextWindowTokens: 200000,
      maxOutputTokens: 32000,
      capabilities: plain,
    },
    {
      id: "deepseek-v4-pro",
      provider: "concentrate",
      name: "deepseek-v4-pro",
      capabilities: plain,
    },
  ]);
});

test("model entries carry the display name and what the model supports", () => {
  const [entry] = copilotEntries(
    ROOT,
    [
      model("claude-opus-5-5", {
        name: "Claude Opus 5.5",
        context: 1000000,
        output: 128000,
        image: true,
        reasoning: true,
        reasoningSupport: true,
        efforts: ["low", "medium", "high"],
      }),
    ],
    { apiKey: "sk-x" },
  ).models;
  expect(entry).toStrictEqual({
    id: "claude-opus-5-5",
    provider: "concentrate-claude",
    name: "Claude Opus 5.5",
    maxPromptTokens: 872000,
    maxContextWindowTokens: 1000000,
    maxOutputTokens: 128000,
    capabilities: {
      supports: { toolCalls: true, vision: true, reasoningEffort: true },
    },
  });
  const noEffort = copilotEntries(
    ROOT,
    [
      model("m", {
        reasoning: true,
        reasoningSupport: true,
        efforts: ["none"],
      }),
    ],
    { apiKey: "sk-x" },
  ).models[0];
  expect(noEffort.capabilities.supports.reasoningEffort).toBe(false);
  // Only a context size: the prompt may use all of it.
  const contextOnly = copilotEntries(ROOT, [model("c", { output: null })], {
    apiKey: "sk-x",
  }).models[0];
  expect(contextOnly.maxPromptTokens).toBe(200000);
  expect(contextOnly.maxOutputTokens).toBe(undefined);
});

test("configure keeps the user's providers, models and other fields; reset restores them", () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  fs.writeFileSync(
    f.file,
    JSON.stringify({
      providers: [userProvider],
      models: [userModel],
      future: 1,
    }),
  );
  configureCopilotCli(ROOT, "sk-one", models, f.env);
  expect(copilotCliConfigured(f.env)).toBe(true);
  expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
  let doc = read(f.file);
  expect(doc.future).toBe(1);
  expect(doc.providers[0]).toStrictEqual(userProvider);
  expect(doc.providers.map((p) => p.name)).toStrictEqual([
    "mine",
    "concentrate",
    "concentrate-claude",
    "concentrate-openai",
  ]);
  expect(doc.models[0]).toStrictEqual(userModel);
  expect(doc.models).toHaveLength(4);

  // Configuring again replaces cn's entries instead of adding more.
  configureCopilotCli(ROOT, "sk-one", [models[2]], f.env);
  doc = read(f.file);
  expect(doc.providers.map((p) => p.name)).toStrictEqual([
    "mine",
    "concentrate",
  ]);
  expect(doc.models.map((m) => m.id)).toStrictEqual([
    "local",
    "deepseek-v4-pro",
  ]);

  expect(resetCopilotCli(f.env).reset).toBe(true);
  expect(read(f.file)).toStrictEqual({
    future: 1,
    providers: [userProvider],
    models: [userModel],
  });
  expect(copilotCliConfigured(f.env)).toBe(false);
  expect(resetCopilotCli(f.env).reset).toBe(false);
});

test("reset removes providers.json when cn created it", () => {
  const f = fixture();
  configureCopilotCli(ROOT, "sk-one", models, f.env);
  expect(fs.existsSync(f.file)).toBe(true);
  resetCopilotCli(f.env);
  expect(fs.existsSync(f.file)).toBe(false);
});

test("configure refuses a provider of the user's that shares a Concentrate name", () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  const mine = { providers: [{ name: "concentrate", type: "openai" }] };
  fs.writeFileSync(f.file, JSON.stringify(mine));
  expect(() => configureCopilotCli(ROOT, "sk-one", models, f.env)).toThrow(
    /already has a provider named concentrate/,
  );
  expect(read(f.file)).toStrictEqual(mine);
  expect(copilotCliConfigured(f.env)).toBe(false);
});

test("configure leaves a damaged providers.json alone", () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  fs.writeFileSync(f.file, "{oops");
  expect(() => configureCopilotCli(ROOT, "sk-one", models, f.env)).toThrow(
    /not valid JSON/,
  );
  expect(fs.readFileSync(f.file, "utf8")).toBe("{oops");
});

test("a new key replaces only Concentrate's copies", () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  fs.writeFileSync(
    f.file,
    JSON.stringify({ providers: [{ ...userProvider, apiKey: "theirs" }] }),
  );
  configureCopilotCli(ROOT, "sk-old", models, f.env);
  refreshCopilotCliKey("sk-new", f.env);
  const keys = read(f.file).providers.map((p) => p.apiKey);
  expect(keys).toStrictEqual(["theirs", "sk-new", "sk-new", "sk-new"]);
});

// A stand-in `copilot` that records its arguments, key and providers file.
function fakeCopilot(bin) {
  const record = path.join(bin, "copilot.record.json");
  fs.writeFileSync(
    path.join(bin, "copilot"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.COPILOT_PROVIDERS_CONFIG;
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args: process.argv.slice(2),
  key: process.env.CONCENTRATE_API_KEY,
  file,
  mode: fs.statSync(file).mode & 0o777,
  providers: JSON.parse(fs.readFileSync(file, "utf8")),
}));
`,
    { mode: 0o755 },
  );
  return () => JSON.parse(fs.readFileSync(record, "utf8"));
}

test("cn copilot launches Copilot CLI with Concentrate's providers and keeps the key out of the file", () => {
  const { bin, config, env } = setup();
  writeCatalog(config, models);
  const copilotHome = tempDir("cn-copilot-home-");
  fs.writeFileSync(
    path.join(copilotHome, "providers.json"),
    JSON.stringify({ providers: [userProvider], models: [userModel] }),
  );
  const record = fakeCopilot(bin);
  const result = runCn(["copilot", "--", "-p", "hi"], {
    env: { ...env, COPILOT_HOME: copilotHome },
  });
  expect(result.status, result.stderr).toBe(0);
  const seen = record();
  expect(seen.args).toStrictEqual([
    "--model",
    "concentrate-claude/claude-sonnet-5-5",
    "-p",
    "hi",
  ]);
  expect(seen.key).toBe("sk-test");
  expect(seen.mode).toBe(0o600);
  expect(JSON.stringify(seen.providers)).not.toContain("sk-test");
  expect(seen.providers.providers[0]).toStrictEqual(userProvider);
  expect(
    seen.providers.providers
      .slice(1)
      .every((p) => p.apiKeyCommand === "printenv CONCENTRATE_API_KEY"),
  ).toBe(true);
  expect(seen.providers.models.map((m) => m.id)).toStrictEqual([
    "local",
    "claude-sonnet-5-5",
    "gpt-6.2-sol",
    "deepseek-v4-pro",
  ]);
  expect(fs.existsSync(seen.file), "temporary file removed").toBe(false);
  // The user's own file is untouched.
  expect(read(path.join(copilotHome, "providers.json")).providers).toHaveLength(
    1,
  );
});

test("cn copilot keeps a model the user passes to Copilot directly", () => {
  const { bin, config, env } = setup();
  writeCatalog(config, models);
  const record = fakeCopilot(bin);
  const result = runCn(["copilot", "--", "--model", "mine/local"], {
    env: { ...env, COPILOT_HOME: tempDir() },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(record().args).toStrictEqual(["--model", "mine/local"]);
});

test("cn copilot --model picks the provider for that model", () => {
  const { bin, config, env } = setup();
  writeCatalog(config, models);
  const record = fakeCopilot(bin);
  const result = runCn(["copilot", "--model", "gpt-6.2-sol"], {
    env: { ...env, COPILOT_HOME: tempDir() },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(record().args).toStrictEqual([
    "--model",
    "concentrate-openai/gpt-6.2-sol",
  ]);
});

// A repository inside a folder whose own .mcp.json Copilot never reads.
function copilotMcp(userConfig) {
  const { bin, config, env } = setup();
  writeCatalog(config, models);
  writeOrgServers(config, "sk-test", {
    docs: { type: "http", url: "https://docs.example/mcp" },
    mine: { type: "http", url: "https://org.example/mine" },
    shared: { type: "http", url: "https://org.example/shared" },
    team: { type: "http", url: "https://org.example/team" },
  });
  const copilotHome = tempDir("cn-copilot-home-");
  fs.writeFileSync(path.join(copilotHome, "mcp-config.json"), userConfig);
  const outside = tempDir("cn-copilot-outside-");
  const servers = (name) =>
    JSON.stringify({ mcpServers: { [name]: { command: "x" } } });
  fs.writeFileSync(path.join(outside, ".mcp.json"), servers("docs"));
  const repo = path.join(outside, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".github"));
  fs.mkdirSync(path.join(repo, "sub"));
  fs.writeFileSync(path.join(repo, ".mcp.json"), servers("shared"));
  fs.writeFileSync(path.join(repo, ".github", "mcp.json"), servers("team"));
  const record = fakeCopilot(bin);
  const result = runCn(["copilot"], {
    env: { ...env, COPILOT_HOME: copilotHome },
    cwd: path.join(repo, "sub"),
  });
  expect(result.status, result.stderr).toBe(0);
  const args = record().args;
  const at = args.indexOf("--additional-mcp-config");
  return at < 0 ? null : Object.keys(JSON.parse(args[at + 1]).mcpServers);
}

test("cn copilot leaves out org MCP servers the user already names", () => {
  expect(
    copilotMcp(JSON.stringify({ mcpServers: { mine: { command: "x" } } })),
  ).toStrictEqual(["docs"]);
});

test("a Copilot MCP config that doesn't parse names no servers", () => {
  expect(copilotMcp("{ not json")).toStrictEqual(["docs", "mine"]);
});

test("cn copilot resume and continue use Copilot's own flags", () => {
  expect(
    parseHarnessLaunchArgs("copilot-cli", ["resume", "abc"]).forwarded,
  ).toStrictEqual(["--resume=abc"]);
  expect(
    parseHarnessLaunchArgs("copilot-cli", ["resume"]).forwarded,
  ).toStrictEqual(["--resume"]);
  expect(
    parseHarnessLaunchArgs("copilot-cli", ["continue"]).forwarded,
  ).toStrictEqual(["--continue"]);
});

test.each(["configure", "reset"])(
  "cn %s copilot asks which Copilot when it cannot prompt",
  (command) => {
    const { env } = setup();
    const result = runCn([command, "copilot"], { env });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(
      new RegExp(`cn ${command} copilot-cli .*cn ${command} copilot-app`),
    );
  },
);

test("cn configure copilot-cli and cn reset copilot-cli edit Copilot's providers.json", () => {
  const { bin, config, env } = setup();
  writeCatalog(config, models);
  fakeCopilot(bin);
  const copilotHome = tempDir("cn-copilot-home-");
  const full = { ...env, COPILOT_HOME: copilotHome };
  expect(
    runCn(["key", "--no-verify"], { env: full, input: "sk-saved\n" }).status,
  ).toBe(0);
  const configured = runCn(["configure", "copilot-cli"], { env: full });
  expect(configured.status, configured.stderr).toBe(0);
  const file = path.join(copilotHome, "providers.json");
  expect(read(file).providers.map((p) => p.apiKey)).toStrictEqual([
    "sk-saved",
    "sk-saved",
    "sk-saved",
  ]);
  const reset = runCn(["reset", "copilot-cli"], { env: full });
  expect(reset.status, reset.stderr).toBe(0);
  expect(fs.existsSync(file)).toBe(false);
});
