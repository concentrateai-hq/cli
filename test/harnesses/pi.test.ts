import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import {
  fakeTool,
  runCn,
  tempDir,
  setup,
  writeOrgServers,
} from "../helpers.js";

test("pi runs against a temporary agent dir that is removed afterwards", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "pi");
  const result = runCn(["pi", "--", "-p", "hi"], { env });
  expect(result.status, result.stderr).toBe(0);
  const seen = record();
  expect(seen.args.slice(0, 4)).toStrictEqual([
    "--provider",
    "concentrate",
    "--model",
    "deepseek-v4-1-flash",
  ]);
  expect(seen.args.includes("--session-dir")).toBe(false);
  expect(seen.args.includes("--session-id")).toBe(false);
  expect(seen.env.PI_CODING_AGENT_DIR).toMatch(/cn-pi-/);
  expect(
    fs.existsSync(seen.env.PI_CODING_AGENT_DIR),
    "temp dir should be cleaned up",
  ).toBe(false);
  expect(seen.args.slice(-2)).toStrictEqual(["-p", "hi"]);
});

test("pi refuses versions before 0.77 and asks for an update", () => {
  const { bin, env } = setup();
  fakeTool(bin, "pi", { version: "0.76.2", versionOnStderr: true });
  const result = runCn(["pi", "--", "-p", "hi"], { env });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/Pi 0\.77 or newer/);
  expect(result.stderr).toMatch(/pi update self/);
  expect(fs.existsSync(path.join(bin, "pi.record.json"))).toBe(false);
});

test.each(["0.77.0", "0.87.1", "1.0.0"])(
  "pi launches on 0.77 and later: %s",
  (version) => {
    const { bin, env } = setup();
    const record = fakeTool(bin, "pi", { version });
    const result = runCn(["pi", "--", "-p", "hi"], { env });
    expect(result.status, result.stderr).toBe(0);
    expect(record().args.slice(-2)).toStrictEqual(["-p", "hi"]);
  },
);

test("pi keeps the user's settings and never copies auth.json", () => {
  const { bin, env } = setup();
  const source = tempDir("cn-pi-src-");
  fs.writeFileSync(path.join(source, "settings.json"), '{"theme":"dark"}');
  fs.writeFileSync(path.join(source, "auth.json"), '{"secret":"nope"}');
  const probe = path.join(bin, "pi");
  fs.writeFileSync(
    probe,
    `#!/usr/bin/env node
const fs = require("node:fs"), p = require("node:path");
const d = process.env.PI_CODING_AGENT_DIR;
console.log(JSON.stringify({ settings: JSON.parse(fs.readFileSync(p.join(d, "settings.json"), "utf8")), hasAuth: fs.existsSync(p.join(d, "auth.json")) }));
`,
    { mode: 0o755 },
  );
  const result = runCn(["pi"], {
    env: { ...env, PI_CODING_AGENT_DIR: source },
  });
  const out = JSON.parse(result.stdout);
  expect(out.settings.theme).toBe("dark");
  expect(out.settings.defaultProvider).toBe("concentrate");
  expect(out.hasAuth).toBe(false);
});

// Launches a stand-in Pi that reports the mcp.json in its agent dir.
function piMcp(userMcp, org) {
  const { bin, config, env } = setup();
  const source = tempDir("cn-pi-src-");
  fs.writeFileSync(path.join(source, "mcp.json"), userMcp);
  fs.mkdirSync(path.join(env.HOME, ".config", "mcp"), { recursive: true });
  fs.writeFileSync(
    path.join(env.HOME, ".config", "mcp", "mcp.json"),
    JSON.stringify({ mcpServers: { shared: { command: "y" } } }),
  );
  if (org) writeOrgServers(config, "sk-test", org);
  fs.writeFileSync(
    path.join(bin, "pi"),
    `#!/usr/bin/env node
const fs = require("node:fs"), p = require("node:path");
const file = p.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
let mcp = null;
try { mcp = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
console.log(JSON.stringify({ mcp, linked: fs.lstatSync(file).isSymbolicLink() }));
`,
    { mode: 0o755 },
  );
  const result = runCn(["pi"], {
    env: { ...env, PI_CODING_AGENT_DIR: source },
  });
  return { result, out: JSON.parse(result.stdout) };
}

const ORG = {
  docs: { url: "https://docs.example/mcp" },
  mine: { url: "https://org.example/mcp" },
  shared: { url: "https://org.example/s" },
};

test("pi gets org MCP servers in a merged mcp.json; the user's entries and other keys win", () => {
  const { result, out } = piMcp(
    JSON.stringify({ mcpServers: { mine: { command: "x" } }, extra: 1 }),
    ORG,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(out.linked).toBe(false);
  expect(out.mcp).toStrictEqual({
    extra: 1,
    mcpServers: {
      docs: { url: "https://docs.example/mcp" },
      mine: { command: "x" },
    },
  });
});

test("with no org servers, mcp.json stays the user's own file", () => {
  const { out } = piMcp(JSON.stringify({ mcpServers: {} }));
  expect(out.linked).toBe(true);
});

test("an mcp.json that doesn't parse stays linked and pi still launches", () => {
  const { result, out } = piMcp("{ not json", ORG);
  expect(result.status, result.stderr).toBe(0);
  expect(out.linked).toBe(true);
});
