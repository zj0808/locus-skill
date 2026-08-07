#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const AUTH_PROBE_PATH = "/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit";
const AUTH_TIMEOUT_MS = 10000;
const CREDENTIAL_SERVICE = "Ace.Locus.ApiKey";
const CREDENTIAL_ACCOUNT = "ACE";
const require = createRequire(import.meta.url);

let keyringModule;

function getKeyringModule() {
  if (keyringModule) return keyringModule;
  if (process.platform !== "win32" || process.arch !== "x64") {
    const error = new Error(
      "Persistent ACE credentials currently require Windows x64; use ACE_API_KEY on this platform.",
    );
    error.exitCode = 5;
    throw error;
  }
  keyringModule = require(
    "../runtime/vendor/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node",
  );
  return keyringModule;
}

function credentialEntry(service = CREDENTIAL_SERVICE) {
  const { Entry } = getKeyringModule();
  return new Entry(service, CREDENTIAL_ACCOUNT);
}

function readStoredKey() {
  const value = credentialEntry().getPassword();
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveCredential() {
  const environmentKey = String(process.env.ACE_API_KEY || "").trim();
  if (environmentKey) return { key: environmentKey, source: "ACE_API_KEY" };
  const storedKey = readStoredKey();
  if (storedKey) return { key: storedKey, source: "Windows Credential Manager" };
  return null;
}

function maskKey(key) {
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function promptHidden(promptText) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const error = new Error("An interactive terminal is required to enter the ACE API key.");
    error.exitCode = 1;
    throw error;
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          const error = new Error("ACE API key entry was cancelled.");
          error.exitCode = 130;
          reject(error);
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (character >= " ") value += character;
      }
    };

    process.stdout.write(promptText);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let i = 0; i < values.length; i += 1) {
    const token = values[i];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }

    const equalsAt = token.indexOf("=");
    const key = token.slice(2, equalsAt >= 0 ? equalsAt : undefined);
    let value;
    if (equalsAt >= 0) {
      value = token.slice(equalsAt + 1);
    } else if (i + 1 < values.length && !values[i + 1].startsWith("--")) {
      value = values[i + 1];
      i += 1;
    } else {
      value = true;
    }

    if (Object.hasOwn(parsed, key)) {
      parsed[key] = Array.isArray(parsed[key]) ? [...parsed[key], value] : [parsed[key], value];
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

function lastValue(value, fallback = undefined) {
  if (Array.isArray(value)) return value.at(-1);
  return value === undefined ? fallback : value;
}

function integerOption(args, name, fallback, min, max) {
  const raw = lastValue(args[name], fallback);
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function integerEnvironment(name, fallback, min, max) {
  const value = Number.parseInt(String(process.env[name] || ""), 10);
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function booleanOption(args, name, fallback) {
  const raw = lastValue(args[name], fallback);
  if (typeof raw === "boolean") return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`--${name} must be true or false.`);
}

function stringOption(args, name, fallback = "") {
  const value = lastValue(args[name], fallback);
  return String(value ?? "").trim();
}

function repeatedValues(args, name) {
  const value = args[name];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveBaseUrl() {
  const raw = String(process.env.ACE_BASE_URL || "https://ace.panrun.me/relay").trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("ACE_BASE_URL must be an absolute http(s) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("ACE_BASE_URL must be an absolute http(s) URL.");
  }
  return raw;
}

async function validateCredential(baseUrl, key) {
  if (!key) {
    const error = new Error("ACE authentication is required. Run: ace.ps1 auth login");
    error.exitCode = 2;
    throw error;
  }

  let response;
  try {
    response = await fetch(`${baseUrl}${AUTH_PROBE_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/proto",
        "Connect-Protocol-Version": "1",
      },
      body: Buffer.alloc(0),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (cause) {
    const error = new Error(`ACE authentication probe failed: ${cause?.message || cause}`);
    error.exitCode = 3;
    throw error;
  }

  if (response.ok) {
    await response.body?.cancel().catch(() => {});
    return;
  }

  await response.body?.cancel().catch(() => {});
  if (response.status === 401) {
    const error = new Error("ACE API key was rejected. Run: ace.ps1 auth set-key");
    error.exitCode = 4;
    throw error;
  }
  if (response.status === 403) {
    const error = new Error("ACE account or API key is disabled.");
    error.exitCode = 4;
    throw error;
  }
  const error = new Error(`ACE authentication service returned HTTP ${response.status}.`);
  error.exitCode = 3;
  throw error;
}

async function main() {
  const command = process.argv[2] || "help";
  const args = parseArgs(process.argv.slice(3));
  const baseUrl = resolveBaseUrl();

  if (!["validate", "search", "index-status", "auth-set", "auth-status", "auth-logout", "auth-doctor"].includes(command)) {
    throw new Error(`Unknown runtime command: ${command}`);
  }

  if (command === "auth-doctor") {
    const service = `${CREDENTIAL_SERVICE}.SelfTest.${process.pid}.${Date.now()}`;
    const secret = randomBytes(24).toString("hex");
    const entry = credentialEntry(service);
    try {
      entry.setPassword(secret);
      if (entry.getPassword() !== secret) {
        const error = new Error("Windows Credential Manager round-trip comparison failed.");
        error.exitCode = 5;
        throw error;
      }
    } finally {
      entry.deletePassword();
    }
    console.log("Windows Credential Manager: ready");
    return;
  }

  if (command === "auth-logout") {
    const deleted = credentialEntry().deletePassword();
    console.log(deleted ? "Stored ACE key removed." : "No stored ACE key was present.");
    if (String(process.env.ACE_API_KEY || "").trim()) {
      console.log("ACE_API_KEY remains active for this process environment.");
    }
    return;
  }

  if (command === "auth-set") {
    const supplied = stringOption(args, "key");
    const key = supplied || await promptHidden("ACE API key: ");
    if (!key) throw new Error("ACE API key is empty.");
    await validateCredential(baseUrl, key);
    credentialEntry().setPassword(key);
    console.log("ACE key saved in Windows Credential Manager.");
    return;
  }

  const credential = resolveCredential();
  if (!credential) {
    if (command === "auth-status") {
      console.log("Authenticated: no");
      console.log("Run: ace.ps1 auth login");
      process.exitCode = 1;
      return;
    }
    const error = new Error("ACE authentication is required. Run: ace.ps1 auth login");
    error.exitCode = 2;
    throw error;
  }

  await validateCredential(baseUrl, credential.key);
  if (command === "auth-status") {
    console.log("Authenticated: yes");
    console.log(`Source: ${credential.source}`);
    console.log(`Key: ${maskKey(credential.key)}`);
    console.log(`Base URL: ${baseUrl}`);
    return;
  }
  if (command === "validate") {
    if (!booleanOption(args, "quiet", false)) console.log("ACE credentials are valid.");
    return;
  }

  process.env.LOCUS_BASE_URL = baseUrl;
  process.env.LOCUS_TOKEN = credential.key;
  process.env.LOCUS_SQLITE ||= "wasm";
  process.env.ACE_AUTH_VALIDATED = "1";

  const runtime = await import("../runtime/runner.mjs");
  if (command === "search") {
    const query = stringOption(args, "query");
    if (!query) throw new Error("--query is required.");
    const resultMode = stringOption(args, "result-mode", "complete");
    if (!["complete", "focused"].includes(resultMode)) {
      throw new Error("--result-mode must be complete or focused.");
    }

    const excludePaths = [
      ...repeatedValues(args, "exclude-path"),
      ...repeatedValues(args, "exclude-paths"),
    ];
    const result = await runtime.runSearch({
      query,
      projectPath: stringOption(args, "project-path", process.cwd()),
      pathFilter: stringOption(args, "path-filter"),
      treeDepth: integerOption(args, "tree-depth", 3, 1, 6),
      maxTurns: integerOption(
        args,
        "max-turns",
        integerEnvironment("LOCUS_MAX_TURNS", 3, 1, 5),
        1,
        5,
      ),
      maxResults: integerOption(args, "max-results", 10, 1, 30),
      resultMode,
      cursor: stringOption(args, "cursor"),
      pageSize: integerOption(args, "page-size", 20, 1, 100),
      includeAllRanges: booleanOption(args, "include-all-ranges", true),
      exhaustive: booleanOption(args, "exhaustive", true),
      excludePaths,
    });
    process.stdout.write(`${result}\n`);
    return;
  }

  const status = await runtime.runIndexStatus({
    projectPath: stringOption(args, "project-path", process.cwd()),
    refresh: booleanOption(args, "refresh", false),
  });
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[ace] ${error?.message || error}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
