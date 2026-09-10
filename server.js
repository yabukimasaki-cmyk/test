const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const host = "127.0.0.1";
const port = 3000;
const pythonPath = "D:\\Python\\python.exe";
const scriptPath = path.join(__dirname, "generate_numbers.py");
const pagePath = path.join(__dirname, "index.html");

function drawNumbers(count) {
  const result = spawnSync(pythonPath, [scriptPath, String(count)], {
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "抽選に失敗しました。");
  }

  return result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(Number);
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && requestUrl.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fs.readFileSync(pagePath));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/draw") {
    const count = Number(requestUrl.searchParams.get("count"));

    if (![1, 3].includes(count)) {
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "countは1または3を指定してください。" }));
      return;
    }

    try {
      const numbers = drawNumbers(count);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ numbers }));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not Found");
});

server.listen(port, host, () => {
  console.log(`http://${host}:${port}`);
});
