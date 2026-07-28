import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const successMarker = "OMR_DESKTOP_SMOKE_OK";
const releaseDir = path.resolve(
  process.env.OMR_DESKTOP_SMOKE_RELEASE_DIR || path.join(rootDir, "release"),
);
const timeoutMs = Number(process.env.OMR_DESKTOP_SMOKE_TIMEOUT_MS || 180_000);

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function listFiles(directory, depth = 0) {
  if (depth > 6 || !fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile()) return [entryPath];
      if (!entry.isDirectory() || entry.name === "resources" || entry.name === "locales") return [];
      return listFiles(entryPath, depth + 1);
    });
}

function isPlatformExecutable(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  const basename = path.basename(filePath).toLowerCase();
  const productName = packageJson.build.productName;
  const packageName = packageJson.name;

  if (process.platform === "darwin") {
    return normalized.includes(`/${productName}.app/Contents/MacOS/`)
      && path.basename(filePath) === productName;
  }
  if (process.platform === "win32") {
    return normalized.includes("/win-unpacked/")
      && basename === `${productName}.exe`.toLowerCase();
  }
  if (process.platform === "linux") {
    const linuxNames = new Set([
      productName.toLowerCase(),
      productName.toLowerCase().replace(/\s+/g, "-"),
      packageName.toLowerCase(),
    ]);
    return normalized.includes("/linux-unpacked/") && linuxNames.has(basename);
  }

  throw new Error(`Unsupported packaged smoke platform: ${process.platform}`);
}

function resolveExecutable() {
  const override = process.env.OMR_DESKTOP_SMOKE_EXECUTABLE;
  if (override) {
    const executable = path.resolve(override);
    if (!isFile(executable)) {
      throw new Error(`OMR_DESKTOP_SMOKE_EXECUTABLE is not a file: ${executable}`);
    }
    return executable;
  }

  const candidates = listFiles(releaseDir).filter(isPlatformExecutable);
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one unpacked ${process.platform} executable in ${releaseDir}, found ${candidates.length}`
      + `${candidates.length ? `:\n${candidates.join("\n")}` : ""}`,
    );
  }
  return candidates[0];
}

function runExecutable(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      cwd: rootDir,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        OMR_DESKTOP_SMOKE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", chunk => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[desktop-package] ${text}`);
    });
    child.stderr.on("data", chunk => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[desktop-package] ${text}`);
    });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout, timedOut });
    });
  });
}

async function runSmoke() {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`OMR_DESKTOP_SMOKE_TIMEOUT_MS must be a positive number, received ${timeoutMs}`);
  }

  const executable = resolveExecutable();
  const result = await runExecutable(executable);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const unexpectedRuntimeProblem = /unhandledRejection|uncaughtException|OMR_DESKTOP_SMOKE_FAILED/i
    .exec(combinedOutput)?.[0];

  if (result.timedOut) {
    throw new Error(`Packaged desktop smoke timed out after ${timeoutMs}ms`);
  }
  if (result.code !== 0) {
    throw new Error(`Packaged desktop smoke exited with code ${result.code} (signal ${result.signal || "none"})`);
  }
  if (unexpectedRuntimeProblem) {
    throw new Error(`Packaged desktop smoke emitted ${unexpectedRuntimeProblem}`);
  }
  if (!combinedOutput.includes(successMarker)) {
    throw new Error(`Packaged desktop smoke did not print ${successMarker}`);
  }

  console.log(`DESKTOP_PACKAGE_SMOKE_OK ${JSON.stringify({
    executable,
    marker: successMarker,
  })}`);
}

runSmoke().catch(error => {
  console.error("DESKTOP_PACKAGE_SMOKE_FAILED", error);
  process.exitCode = 1;
});
