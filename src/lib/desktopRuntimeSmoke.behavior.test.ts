import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const rootDir = process.cwd();
const portModulePath = path.join(rootDir, "electron", "desktop-port.mjs");
const logModulePath = path.join(rootDir, "scripts", "desktop-smoke-log.mjs");

it("requires signed Windows distribution and includes the runtime CSP configuration", () => {
  const config = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  expect(config.scripts["desktop:dist:win"]).toContain("-c.forceCodeSigning=true");
  expect(config.build.files).toContain("src/lib/contentSecurityPolicy.ts");
  expect(config.build.files).not.toContain(".env.local");
});

type PortModule = {
  selectDesktopServerPort(options: {
    getBoundPort: () => number | null;
    persistPort: (port: number) => void;
    preferredPort: number;
    readPersistedPort: () => number | null;
    smokeEnabled: boolean;
    tryListen: (port: number) => Promise<void>;
  }): Promise<number>;
};

type LogModule = {
  findDesktopSmokeFatalLog(output: string): string | null;
};

async function loadExpectedModule<T>(modulePath: string): Promise<T | null> {
  expect(fs.existsSync(modulePath), `Expected module to exist: ${modulePath}`).toBe(true);
  if (!fs.existsSync(modulePath)) return null;
  return import(pathToFileURL(modulePath).href) as Promise<T>;
}

describe("desktop server port selection", () => {
  it("binds an ephemeral smoke port without reading or persisting normal app state", async () => {
    const portModule = await loadExpectedModule<PortModule>(portModulePath);
    if (!portModule) return;

    let boundPort: number | null = null;
    const readPersistedPort = vi.fn(() => 41730);
    const persistPort = vi.fn();
    const tryListen = vi.fn(async (port: number) => {
      boundPort = port === 0 ? 53124 : port;
    });
    const getBoundPort = vi.fn(() => boundPort);

    const selectedPort = await portModule.selectDesktopServerPort({
      getBoundPort,
      persistPort,
      preferredPort: 41730,
      readPersistedPort,
      smokeEnabled: true,
      tryListen,
    });

    expect(selectedPort).toBe(53124);
    expect(tryListen).toHaveBeenCalledExactlyOnceWith(0);
    expect(getBoundPort).toHaveBeenCalledOnce();
    expect(readPersistedPort).not.toHaveBeenCalled();
    expect(persistPort).not.toHaveBeenCalled();
  });

  it("reuses and persists the normal app's valid stored port", async () => {
    const portModule = await loadExpectedModule<PortModule>(portModulePath);
    if (!portModule) return;

    const readPersistedPort = vi.fn(() => 41991);
    const persistPort = vi.fn();
    const tryListen = vi.fn(async () => undefined);
    const getBoundPort = vi.fn();

    const selectedPort = await portModule.selectDesktopServerPort({
      getBoundPort,
      persistPort,
      preferredPort: 41730,
      readPersistedPort,
      smokeEnabled: false,
      tryListen,
    });

    expect(selectedPort).toBe(41991);
    expect(readPersistedPort).toHaveBeenCalledOnce();
    expect(tryListen).toHaveBeenCalledExactlyOnceWith(41991);
    expect(persistPort).toHaveBeenCalledExactlyOnceWith(41991);
    expect(getBoundPort).not.toHaveBeenCalled();
  });

  it("preserves the normal fallback order and persists the bound ephemeral port", async () => {
    const portModule = await loadExpectedModule<PortModule>(portModulePath);
    if (!portModule) return;

    let boundPort: number | null = null;
    const attemptedPorts: number[] = [];
    const readPersistedPort = vi.fn(() => 41991);
    const persistPort = vi.fn();
    const tryListen = vi.fn(async (port: number) => {
      attemptedPorts.push(port);
      if (port !== 0) {
        const error = Object.assign(new Error("occupied"), { code: "EADDRINUSE" });
        throw error;
      }
      boundPort = 54812;
    });
    const getBoundPort = vi.fn(() => boundPort);

    const selectedPort = await portModule.selectDesktopServerPort({
      getBoundPort,
      persistPort,
      preferredPort: 41730,
      readPersistedPort,
      smokeEnabled: false,
      tryListen,
    });

    expect(selectedPort).toBe(54812);
    expect(attemptedPorts).toEqual([41991, 41730, 0]);
    expect(persistPort).toHaveBeenCalledExactlyOnceWith(54812);
  });
});

describe("packaged desktop fatal-log classification", () => {
  it("accepts clean logs and near-miss metric names", async () => {
    const logModule = await loadExpectedModule<LogModule>(logModulePath);
    if (!logModule) return;

    const cleanOutput = [
      "OMR_DESKTOP_SMOKE_OK status=200",
      "UnhandledPromiseRejectionWarningCount=0",
      "UnhandledPromiseRejectionTotal=0",
      "unhandledRejectionCount=0",
      "uncaughtExceptionMonitorCount=0",
      "OMR_DESKTOP_SMOKE_FAILED_COUNT=0",
    ].join("\n");

    expect(logModule.findDesktopSmokeFatalLog(cleanOutput)).toBeNull();
  });

  it.each([
    ["UnhandledPromiseRejectionWarning", "(node:1) UnhandledPromiseRejectionWarning: boom"],
    ["UnhandledPromiseRejection", "fatal UnhandledPromiseRejection at task"],
    ["unhandledRejection", "⨯ unhandledRejection: Error: boom"],
    ["uncaughtException", "uncaughtException: Error: boom"],
    ["OMR_DESKTOP_SMOKE_FAILED", "OMR_DESKTOP_SMOKE_FAILED Error: boom"],
  ])("rejects %s", async (expectedFatal: string, output: string) => {
    const logModule = await loadExpectedModule<LogModule>(logModulePath);
    if (!logModule) return;

    expect(logModule.findDesktopSmokeFatalLog(output)).toBe(expectedFatal);
  });
});
