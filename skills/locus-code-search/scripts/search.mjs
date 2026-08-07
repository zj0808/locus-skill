#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const AUTH_PROBE_PATH = "/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit";
const AUTH_TIMEOUT_MS = 10000;
const CALLBACK_PATH = "/callback";
const CREDENTIAL_SERVICE =
  String(process.env.ACE_CREDENTIAL_SERVICE || "Ace.Locus.ApiKey").trim() ||
  "Ace.Locus.ApiKey";
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
          if (value) {
            value = Array.from(value).slice(0, -1).join("");
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          process.stdout.write("*");
        }
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
    const error = new Error("ACE authentication is required. Run the Locus authentication setup.");
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
    const error = new Error("ACE API key was rejected. Run the Locus authentication setup again.");
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

function resolveAuthorizationBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/relay\/?$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function secureStringEquals(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function writeCallbackPage(response, statusCode, title, message, closeWindow = false) {
  const nonce = randomBytes(16).toString("base64");
  const closeScript = closeWindow
    ? `<script nonce="${nonce}">setTimeout(() => window.close(), 1200);</script>`
    : "";
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0f1a; color: #e2e8f0; }
    main { width: min(420px, calc(100% - 32px)); padding: 28px; box-sizing: border-box; border: 1px solid #253044; border-radius: 8px; background: #0d1424; }
    h1 { margin: 0 0 10px; font-size: 18px; font-weight: 600; }
    p { margin: 0; color: #94a3b8; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main>${closeScript}</body>
</html>`;
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function startAuthorizationCallback(expectedState, timeoutMs) {
  let resolveCode;
  let rejectCode;
  let settled = false;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  codePromise.catch(() => {});

  const settle = (handler, value) => {
    if (settled) return;
    settled = true;
    handler(value);
  };

  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" });
      response.end();
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (requestUrl.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }

    const returnedState = requestUrl.searchParams.get("state") || "";
    if (!secureStringEquals(returnedState, expectedState)) {
      writeCallbackPage(response, 400, "授权请求无效", "请返回终端重新发起登录。", false);
      return;
    }

    const authorizationError = requestUrl.searchParams.get("error");
    if (authorizationError) {
      const error = new Error("ACE browser authorization was cancelled or rejected.");
      error.exitCode = 6;
      writeCallbackPage(response, 400, "授权未完成", "请返回终端重试。", false);
      settle(rejectCode, error);
      return;
    }

    const code = requestUrl.searchParams.get("code") || "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
      const error = new Error("ACE browser authorization returned an invalid code.");
      error.exitCode = 6;
      writeCallbackPage(response, 400, "授权请求无效", "请返回终端重新发起登录。", false);
      settle(rejectCode, error);
      return;
    }

    writeCallbackPage(response, 200, "授权成功", "凭据已发送到 Locus，可以关闭此页面。", true);
    settle(resolveCode, code);
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", (error) => settle(rejectCode, error));

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to start the local authorization callback.");
  }

  const timeout = setTimeout(() => {
    const error = new Error("ACE browser authorization timed out.");
    error.exitCode = 6;
    settle(rejectCode, error);
  }, timeoutMs);

  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    async waitForCode() {
      try {
        return await codePromise;
      } finally {
        clearTimeout(timeout);
        await new Promise((resolve) => server.close(resolve));
      }
    },
    async close() {
      clearTimeout(timeout);
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function openBrowser(url) {
  let command;
  let commandArgs;
  if (process.platform === "win32") {
    command = "rundll32.exe";
    commandArgs = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    command = "open";
    commandArgs = [url];
  } else {
    command = "xdg-open";
    commandArgs = [url];
  }

  const result = spawnSync(command, commandArgs, {
    stdio: "ignore",
    windowsHide: true,
    timeout: 10000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not open the browser automatically. Open this URL manually:\n${url}`);
  }
}

async function exchangeAuthorizationCode(authBaseUrl, redirectUri, code, verifier) {
  let response;
  try {
    response = await fetch(`${authBaseUrl}/api/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier, redirectUri }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (cause) {
    const error = new Error(`ACE token exchange failed: ${cause?.message || cause}`);
    error.exitCode = 3;
    throw error;
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`ACE token exchange returned HTTP ${response.status}.`);
    error.exitCode = response.status >= 500 ? 3 : 6;
    throw error;
  }
  if (typeof result.apiKey !== "string" || !result.apiKey.trim()) {
    const error = new Error("ACE token exchange did not return an API key.");
    error.exitCode = 6;
    throw error;
  }
  return result.apiKey.trim();
}

async function authenticateWithBrowser(baseUrl, args) {
  const authBaseUrl = resolveAuthorizationBaseUrl(baseUrl);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const callback = await startAuthorizationCallback(
    state,
    integerEnvironment("ACE_AUTH_TIMEOUT_MS", 5 * 60 * 1000, 1000, 15 * 60 * 1000),
  );

  const authorizationUrl = new URL(`${authBaseUrl}/cli/authorize`);
  authorizationUrl.searchParams.set("redirect_uri", callback.redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  try {
    if (booleanOption(args, "no-browser", false)) {
      console.log(`Open this URL to sign in:\n${authorizationUrl.href}`);
    } else {
      openBrowser(authorizationUrl.href);
      console.log("Browser opened for ACE sign-in.");
    }
    console.log("Waiting for browser authorization...");

    const code = await callback.waitForCode();
    const key = await exchangeAuthorizationCode(
      authBaseUrl,
      callback.redirectUri,
      code,
      verifier,
    );
    await validateCredential(baseUrl, key);
    credentialEntry().setPassword(key);
    console.log("ACE account connected. Key saved in Windows Credential Manager.");
  } finally {
    await callback.close();
  }
}

async function main() {
  const command = process.argv[2] || "help";
  const args = parseArgs(process.argv.slice(3));
  const baseUrl = resolveBaseUrl();

  if (!["validate", "search", "index-status", "auth-browser", "auth-set", "auth-status", "auth-logout", "auth-doctor"].includes(command)) {
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

  if (command === "auth-browser") {
    await authenticateWithBrowser(baseUrl, args);
    return;
  }

  if (command === "auth-set") {
    const supplied = stringOption(args, "key");
    if (supplied) {
      await validateCredential(baseUrl, supplied);
      credentialEntry().setPassword(supplied);
      console.log("ACE key saved in Windows Credential Manager.");
      return;
    }

    console.log("Paste your ACE API key below. Asterisks confirm input; press Enter once.");
    console.log("Press Ctrl+C to cancel.");
    while (true) {
      const key = await promptHidden("ACE API key: ");
      if (!key) {
        console.log("No key entered. Paste your ACE API key, then press Enter.");
        continue;
      }
      try {
        await validateCredential(baseUrl, key);
        credentialEntry().setPassword(key);
        console.log("ACE key saved in Windows Credential Manager.");
        return;
      } catch (error) {
        if (error?.exitCode !== 4) throw error;
        console.error(`[locus] ${error.message}`);
        console.log("Enter another ACE API key, or press Ctrl+C to cancel.");
      }
    }
  }

  const credential = resolveCredential();
  if (!credential) {
    if (command === "auth-status") {
      console.log("Authenticated: no");
      console.log("Run the Locus authentication setup.");
      process.exitCode = 1;
      return;
    }
    const error = new Error("ACE authentication is required. Run the Locus authentication setup.");
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
  process.stderr.write(`[locus] ${error?.message || error}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
