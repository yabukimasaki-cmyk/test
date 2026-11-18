const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");

const host = "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const pythonPath =
  process.env.PYTHON_PATH || (process.platform === "win32" ? "python" : "python3");
const scriptPath = path.join(__dirname, "generate_numbers.py");
const pagePath = path.join(__dirname, "index.html");
const bingoPagePath = path.join(__dirname, "bingo.html");
const trustProxy = process.env.TRUST_PROXY === "true";
const secureCookies =
  process.env.COOKIE_SECURE === "true" ||
  (process.env.COOKIE_SECURE !== "false" && process.env.NODE_ENV === "production");
const rateLimits = new Map();
const rateLimitWindowMs = 60_000;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
function runPython(args, operation) {
  const pythonArgs = [scriptPath, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      pythonPath,
      pythonArgs,
      {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      },
      (error, stdout = "", stderr = "") => {
        const exitCode = error
          ? Number.isInteger(error.code)
            ? error.code
            : null
          : 0;
        const spawnError =
          error && typeof error.code === "string"
            ? { code: error.code, message: error.message }
            : null;

        console.info(
          "[python]",
          JSON.stringify({
            executable: pythonPath,
            script: scriptPath,
            args,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode,
            spawnError,
          }),
        );

        if (!error) {
          resolve(stdout.trim());
          return;
        }

        if (error.code === "ETIMEDOUT") {
          const failure = new Error(`${operation} Python実行がタイムアウトしました。`);
          failure.publicMessage = "Pythonの処理がタイムアウトしました。時間をおいて再試行してください。";
          reject(failure);
          return;
        }
        if (spawnError) {
          const failure = new Error(
            `Python実行ファイル "${pythonPath}" を起動できません（${spawnError.code}）。PYTHON_PATHとPATHを確認してください。`,
            { cause: error },
          );
          failure.publicMessage =
            "Python実行ファイルを起動できません。PYTHON_PATHの設定と実行環境を確認してください。";
          reject(failure);
          return;
        }

        const failure = new Error(
          `${operation} Pythonスクリプトが終了コード ${exitCode} で失敗しました。`,
          { cause: error },
        );
        failure.publicMessage = "Pythonスクリプトでエラーが発生しました。サーバーログを確認してください。";
        reject(failure);
      },
    );
  });
}

async function drawNumbers(count) {
  const output = await runPython([String(count)], "抽選に失敗しました。");
  return output.split(/\r?\n/).filter(Boolean).map(Number);
}

async function getBingoCard(visitorId) {
  const output = await runPython(["--card", visitorId], "ビンゴカードの作成に失敗しました。");
  return JSON.parse(output);
}

async function resetDraws() {
  const output = await runPython(["--reset"], "抽選結果のリセットに失敗しました。");
  const deletedCount = Number(output);
  if (!Number.isInteger(deletedCount) || deletedCount < 0) {
    throw new Error(`抽選結果のリセット件数が不正です: ${output}`);
  }
  return deletedCount;
}

async function getDrawHistory() {
  const output = await runPython(["--history"], "抽選履歴を取得できませんでした。");
  return JSON.parse(output);
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
}

function isRateLimited(request, key, limit) {
  const now = Date.now();
  const forwardedFor = trustProxy ? request.headers["x-forwarded-for"] : null;
  const forwardedAddress =
    typeof forwardedFor === "string" ? forwardedFor.split(",")[0].trim() : "";
  const client =
    forwardedAddress && forwardedAddress.length <= 64
      ? forwardedAddress
      : request.socket.remoteAddress || "unknown";
  const bucketKey = `${key}:${client}`;
  let bucket = rateLimits.get(bucketKey);

  if (!bucket || now - bucket.startedAt >= rateLimitWindowMs) {
    bucket = { startedAt: now, count: 0 };
    rateLimits.set(bucketKey, bucket);
  }

  bucket.count += 1;
  return bucket.count > limit;
}

const cleanupRateLimits = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimits) {
    if (now - bucket.startedAt >= rateLimitWindowMs) rateLimits.delete(key);
  }
}, rateLimitWindowMs);
cleanupRateLimits.unref();

function isSameOriginRequest(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;

  let protocol = request.socket.encrypted ? "https" : "http";
  if (trustProxy) {
    const forwardedProtocol = request.headers["x-forwarded-proto"];
    if (typeof forwardedProtocol === "string") {
      protocol = forwardedProtocol.split(",")[0].trim();
    }
  }
  if (!["http", "https"].includes(protocol)) return false;

  try {
    const originUrl = new URL(origin);
    const requestOrigin = new URL(`${protocol}://${host}`).origin;
    return originUrl.origin === origin && originUrl.origin === requestOrigin;
  } catch {
    return false;
  }
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function sendFailure(response, operation, error) {
  console.error(`${operation}:`, error);
  sendJson(response, 500, { error: error.publicMessage || operation });
}

const server = http.createServer((request, response) => {
  setSecurityHeaders(response);
  let requestUrl;
  try {
    requestUrl = new URL(request.url, "http://localhost");
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad Request");
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(fs.readFileSync(pagePath));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/bingo") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(fs.readFileSync(bingoPagePath));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/history") {
    if (isRateLimited(request, "history", 60)) {
      sendJson(response, 429, { error: "アクセスが多すぎます。しばらくしてから再試行してください。" });
      return;
    }
    getDrawHistory()
      .then((history) => sendJson(response, 200, { history }))
      .catch((error) => sendFailure(response, "抽選履歴を取得できませんでした。", error));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/card") {
    if (isRateLimited(request, "card", 20)) {
      sendJson(response, 429, { error: "アクセスが多すぎます。しばらくしてから再試行してください。" });
      return;
    }
    const cookieHeader = request.headers.cookie || "";
    const visitorCookie = cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith("bingo_visitor="));
    const storedId = visitorCookie?.slice("bingo_visitor=".length);
    const visitorId =
      storedId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storedId)
        ? storedId
        : randomUUID();
    const cookieOptions = [
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=31536000",
      ...(secureCookies ? ["Secure"] : []),
    ];

    getBingoCard(visitorId)
      .then((numbers) =>
        sendJson(response, 200, { numbers }, {
          "Set-Cookie": `bingo_visitor=${visitorId}; ${cookieOptions.join("; ")}`,
        }),
      )
      .catch((error) => sendFailure(response, "ビンゴカードの作成に失敗しました。", error));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/draw") {
    if (isRateLimited(request, "draw", 20)) {
      sendJson(response, 429, { error: "抽選回数が多すぎます。1分後に再試行してください。" });
      return;
    }
    const count = Number(requestUrl.searchParams.get("count"));
    if (![1, 3].includes(count)) {
      sendJson(response, 400, { error: "countは1または3を指定してください。" });
      return;
    }

    drawNumbers(count)
      .then((numbers) => sendJson(response, 200, { numbers }))
      .catch((error) => sendFailure(response, "抽選に失敗しました。", error));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/reset") {
    if (!isSameOriginRequest(request)) {
      sendJson(response, 403, { error: "同一オリジンからの操作が必要です。" });
      return;
    }
    if (isRateLimited(request, "reset", 10)) {
      sendJson(response, 429, { error: "リセット操作が多すぎます。しばらくしてから再試行してください。" });
      return;
    }

    resetDraws()
      .then((deletedCount) => {
        console.info(`[reset] success deleted=${deletedCount}`);
        sendJson(response, 200, { ok: true, deletedCount });
      })
      .catch((error) => sendFailure(response, "抽選結果のリセットに失敗しました。", error));
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not Found");
});

server.listen(port, host, () => {
  console.log(`Listening on ${host}:${port}`);
});
