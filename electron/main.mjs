import { app, BrowserWindow, shell } from "electron";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import next from "next";

if (!process.env.NEXT_TELEMETRY_DISABLED) {
  process.env.NEXT_TELEMETRY_DISABLED = "1";
}

// A STABLE loopback port keeps the app origin constant across launches. The
// browser scopes localStorage/IndexedDB (drafts, roster, plan, exams) by origin,
// so a random ephemeral port would wipe all client data on every launch.
const PREFERRED_DESKTOP_PORT = 41730;

let nextServer;
let packagedStartUrl = null;

function desktopPortFile() {
  return path.join(app.getPath("userData"), "desktop-server-port.json");
}

function readPersistedPort() {
  try {
    const parsed = JSON.parse(fs.readFileSync(desktopPortFile(), "utf8"));
    if (Number.isInteger(parsed?.port) && parsed.port > 0 && parsed.port < 65536) {
      return parsed.port;
    }
  } catch {
    /* no persisted port yet */
  }
  return null;
}

function persistPort(port) {
  try {
    fs.writeFileSync(desktopPortFile(), JSON.stringify({ port }), "utf8");
  } catch {
    /* best effort — a non-persisted port just risks origin churn next launch */
  }
}

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function listenOnStablePort(server) {
  // Prefer the previously used port, then the fixed default, so the origin stays
  // identical between launches. Only fall back to an ephemeral port if both are
  // occupied (rare, and a single-instance lock already prevents our own dupes).
  const candidates = [...new Set([readPersistedPort(), PREFERRED_DESKTOP_PORT].filter(Boolean))];
  for (const candidate of candidates) {
    try {
      await tryListen(server, candidate);
      persistPort(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : PREFERRED_DESKTOP_PORT;
  persistPort(port);
  return port;
}

function isSameOrigin(targetUrl, baseUrl) {
  try {
    const target = new URL(targetUrl);
    const base = new URL(baseUrl);
    return target.origin === base.origin;
  } catch {
    return false;
  }
}

async function startPackagedNextServer() {
  const appDir = app.getAppPath();
  const nextApp = next({ dev: false, dir: appDir });
  const requestHandler = nextApp.getRequestHandler();

  await nextApp.prepare();

  nextServer = http.createServer((request, response) => {
    requestHandler(request, response).catch((error) => {
      console.error("Next request failed", error);
      response.statusCode = 500;
      response.end("Internal server error");
    });
  });

  const port = await listenOnStablePort(nextServer);
  return `http://127.0.0.1:${port}`;
}

async function resolveStartUrl() {
  if (!app.isPackaged) {
    return process.env.ELECTRON_START_URL || "http://127.0.0.1:3003";
  }
  // Reuse the already-running packaged server (e.g. on macOS "activate") instead
  // of spawning a second Next server and leaking the first.
  if (!packagedStartUrl) {
    packagedStartUrl = await startPackagedNextServer();
  }
  return packagedStartUrl;
}

async function createWindow() {
  const startUrl = await resolveStartUrl();

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: "OMR Maker",
    backgroundColor: "#f8fafc",
    icon: path.join(app.getAppPath(), "public", "icons", "icon-512.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The exam app needs no camera/mic/geolocation/notification access; deny all
  // permission requests by default rather than relying on Electron's grants.
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSameOrigin(url, startUrl)) {
      return { action: "allow" };
    }

    shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (url !== "about:blank" && !isSameOrigin(url, startUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  await window.loadURL(startUrl);
}

app.setAppUserModelId("com.omrmaker.desktop");

// Single-instance lock: a second launch would otherwise bind a second server on
// a different port (new origin → split/lost client data). Focus the existing
// window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });

  app.whenReady().then(createWindow).catch((error) => {
    console.error("Failed to start OMR Maker desktop app", error);
    app.quit();
  });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error) => {
      console.error("Failed to reopen OMR Maker desktop app", error);
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (nextServer) {
    nextServer.close();
  }
});
