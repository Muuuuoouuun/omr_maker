import path from "node:path";
import { spawnSync } from "node:child_process";

const mode = process.argv[2] === "release" ? "release" : "debug";
const serverUrl = process.env.CAP_SERVER_URL?.trim();

if (process.env.CAP_ALLOW_REMOTE_DEV !== "1" || !serverUrl) {
    console.error(
        "Remote-development APK builds require CAP_ALLOW_REMOTE_DEV=1 and CAP_SERVER_URL. "
        + "For USB device development, use npm run android:dev instead.",
    );
    process.exit(1);
}

const parsedUrl = new URL(serverUrl);
if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    console.error("CAP_SERVER_URL must use http:// or https://.");
    process.exit(1);
}

if (mode === "release" && parsedUrl.protocol !== "https:") {
    console.error("The release-shaped remote test build requires an HTTPS CAP_SERVER_URL.");
    process.exit(1);
}

function run(command, args, cwd = process.cwd()) {
    const result = spawnSync(command, args, {
        cwd,
        env: process.env,
        shell: false,
        stdio: "inherit",
        windowsHide: true,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}

const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const gradleCommand = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
const gradleTask = mode === "release" ? "assembleRelease" : "assembleDebug";

run(npxCommand, ["cap", "sync", "android"]);
run(gradleCommand, [gradleTask], path.join(process.cwd(), "android"));
