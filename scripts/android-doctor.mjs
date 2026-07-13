import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args = []) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
    });

    return {
        ok: result.status === 0,
        output: `${result.stdout || ""}\n${result.stderr || ""}`.trim(),
    };
}

function firstExisting(paths) {
    return paths.find(candidate => candidate && existsSync(candidate)) || "";
}

function androidSdkPath() {
    return firstExisting([
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk"),
        path.join(os.homedir(), "AppData", "Local", "Android", "Sdk"),
    ]);
}

function androidStudioPath() {
    if (process.platform !== "win32") return "";

    return firstExisting([
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Android", "Android Studio", "bin", "studio64.exe"),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Android Studio", "bin", "studio64.exe"),
    ]);
}

function commandVersion(command, args, pattern) {
    const result = run(command, args);
    return { ...result, version: result.output.match(pattern)?.[1] || "" };
}

const sdk = androidSdkPath();
const studio = androidStudioPath();
const adbFromSdk = sdk && path.join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const node = commandVersion(process.execPath, ["--version"], /v(\d+(?:\.\d+){0,2})/i);
const nodeMajor = Number.parseInt(node.version, 10);
const java = commandVersion("java", ["-version"], /version\s+"([^"]+)"/i);
const adb = adbFromSdk && existsSync(adbFromSdk)
    ? commandVersion(adbFromSdk, ["version"], /version\s+([\d.]+)/i)
    : commandVersion("adb", ["version"], /version\s+([\d.]+)/i);

const checks = [
    {
        label: "Node.js 22+",
        ok: node.ok && nodeMajor >= 22,
        detail: node.version ? `v${node.version}` : "실행 파일을 찾지 못함",
        fix: "Node.js 22 이상을 설치하세요.",
    },
    {
        label: "Java 런타임",
        ok: java.ok,
        detail: java.version || "실행 파일을 찾지 못함",
        fix: "Android Studio에 포함된 JDK를 사용하거나 JAVA_HOME을 설정하세요.",
    },
    {
        label: "Android Studio",
        ok: Boolean(studio) || process.platform !== "win32",
        detail: studio || (process.platform === "win32" ? "기본 설치 경로에서 찾지 못함" : "Windows 자동 검색 생략"),
        fix: "Android Studio 2025.2.1 이상을 설치하세요.",
    },
    {
        label: "Android SDK",
        ok: Boolean(sdk),
        detail: sdk || "ANDROID_HOME/ANDROID_SDK_ROOT 및 기본 경로에서 찾지 못함",
        fix: "Android Studio > SDK Manager에서 Android SDK와 API 24+ 플랫폼을 설치하세요.",
    },
    {
        label: "ADB",
        ok: adb.ok,
        detail: adb.version || "platform-tools/adb를 찾지 못함",
        fix: "SDK Manager에서 Android SDK Platform-Tools를 설치하세요.",
    },
    {
        label: "Capacitor Android 프로젝트",
        ok: existsSync(path.join(process.cwd(), "android", process.platform === "win32" ? "gradlew.bat" : "gradlew")),
        detail: path.join(process.cwd(), "android"),
        fix: "npm install 후 npx cap add android를 실행하세요.",
    },
];

console.log("OMR Maker Windows → Android 개발 환경\n");
for (const check of checks) {
    console.log(`${check.ok ? "[OK]" : "[필요]"} ${check.label}: ${check.detail}`);
    if (!check.ok) console.log(`       ${check.fix}`);
}

const failed = checks.filter(check => !check.ok);
if (failed.length) {
    console.log(`\n${failed.length}개 준비 항목이 남았습니다. 설정 후 npm run android:doctor를 다시 실행하세요.`);
    process.exitCode = 1;
} else {
    console.log("\n준비 완료. USB 디버깅 기기를 연결한 뒤 npm run android:dev를 실행하세요.");
}
