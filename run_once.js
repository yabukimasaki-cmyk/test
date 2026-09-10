const { spawnSync } = require("child_process");
const path = require("path");

const pythonPath = "D:\\Python\\python.exe";
const scriptPath = path.join(__dirname, "generate_numbers.py");
const result = spawnSync(pythonPath, [scriptPath, "1"], { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
