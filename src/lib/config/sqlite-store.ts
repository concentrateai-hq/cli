import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { which } from "../executables.js";
import { CnError } from "../errors.js";
import { isRecord } from "../validation.js";
import type { Environment } from "../types.js";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const sqliteBinary = (env: Environment) =>
  which("sqlite3", env.PATH) || which("sqlite3", "/usr/bin:/bin");

export function databaseCommand(
  file: string,
  sql: string,
  env: Environment,
  write = false,
  app = "Cursor",
) {
  const binary = sqliteBinary(env);
  if (!binary) throw new CnError(`${app} setup requires sqlite3 on your PATH.`);
  const open = (mode: string) => {
    const uri = pathToFileURL(file);
    uri.searchParams.set("mode", mode);
    return spawnSync(binary, ["-json", uri.href], {
      input: `.bail on\n.timeout 5000\n${sql}\n`,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 32 * 1024 * 1024,
    });
  };
  let result = open(write ? "rw" : "ro");
  // After the app quits cleanly its database has no -wal/-shm files, and a
  // read-only connection cannot create them. Reading through a normal
  // connection creates them and changes nothing else.
  if (!write && result.status !== 0 && /unable to open/.test(result.stderr))
    result = open("rw");
  if (result.error || result.status !== 0)
    throw new CnError(
      `Could not read or update ${app}'s settings database. Quit ${app} and retry. No partial database changes were committed.`,
    );
  return result.stdout;
}

// state.vscdb lives in <Cursor>/User/globalStorage. Check the file and those
// three folders, so a link inside the app's own data cannot redirect a write, but
// a home folder that is itself reached through a link (common on Linux) is fine.
const CURSOR_DATA_LEVELS = 4;

export function privateDatabase(file: string, levels = CURSOR_DATA_LEVELS) {
  let current = file;
  for (let level = 0; level < levels; level += 1) {
    const stat = fs.lstatSync(current);
    if (
      stat.isSymbolicLink() ||
      (current === file ? !stat.isFile() : !stat.isDirectory())
    )
      throw new CnError(
        "Refusing to access app settings through a symbolic link or non-regular database.",
      );
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function readDatabaseRows(
  file: string,
  keys: string[],
  env: Environment,
) {
  privateDatabase(file);
  // sqlite3 takes seconds to escape a large text value as JSON; hex is instant.
  const output = databaseCommand(
    file,
    `SELECT key, hex(value) AS value FROM ItemTable WHERE key IN (${keys.map(literal).join(",")});`,
    env,
  );
  let rows: unknown;
  try {
    rows = JSON.parse(output || "[]");
  } catch {
    throw new CnError(
      "Cursor's settings database returned an unreadable result.",
    );
  }
  if (
    !Array.isArray(rows) ||
    !rows.every(
      (row: unknown) =>
        isRecord(row) &&
        typeof row.key === "string" &&
        typeof row.value === "string",
    )
  )
    throw new CnError("Cursor's saved settings have an unsupported format.");
  return new Map<string, string>(
    rows.map((row: { key: string; value: string }) => [
      row.key,
      Buffer.from(row.value, "hex").toString("utf8"),
    ]),
  );
}

// The database will hold the API key, so it and its journals must be private files.
export function restrictDatabase(file: string) {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    if (!fs.existsSync(candidate)) continue;
    if (
      !fs.lstatSync(candidate).isFile() ||
      fs.lstatSync(candidate).isSymbolicLink()
    )
      throw new CnError(
        "Refusing to write an app database through a symbolic link.",
      );
    fs.chmodSync(candidate, 0o600);
  }
}

// Compare every row read before writing. If Cursor races the update, CHECK aborts
// the transaction and sqlite3 closes the connection without committing anything.
export function changeDatabaseRows(
  file: string,
  keys: string[],
  before: Map<string, string>,
  changes: Map<string, string | null>,
  env: Environment,
) {
  privateDatabase(file);
  restrictDatabase(file);
  const checks = keys.map((key) =>
    before.has(key)
      ? `EXISTS(SELECT 1 FROM ItemTable WHERE key=${literal(key)} AND value=${literal(before.get(key)!)})`
      : `NOT EXISTS(SELECT 1 FROM ItemTable WHERE key=${literal(key)})`,
  );
  const writes = [...changes].map(([key, value]) =>
    value === null
      ? `DELETE FROM ItemTable WHERE key=${literal(key)};`
      : `INSERT OR REPLACE INTO ItemTable(key,value) VALUES(${literal(key)},${literal(value)});`,
  );
  databaseCommand(
    file,
    `BEGIN IMMEDIATE;\nCREATE TEMP TABLE cn_guard(ok INTEGER CHECK(ok=1));\nINSERT INTO cn_guard VALUES(CASE WHEN ${checks.join(" AND ")} THEN 1 ELSE 0 END);\n${writes.join("\n")}\nCOMMIT;`,
    env,
    true,
  );
}
