#!/usr/bin/env node

import { readFile } from "node:fs/promises";

function usage() {
    return [
        "Usage:",
        "  npm run pwa:proof < pwa-report.txt",
        "  npm run pwa:proof -- --file pwa-report.txt",
        "  npm run pwa:proof < pwa-dual-proof.txt",
        "",
        "The input must be a copied report from /pwa-check after opening the installed home-screen app,",
        "or the Android/iOS dual device proof bundle copied after both reports pass.",
    ].join("\n");
}

function parseArgs(argv) {
    const args = { file: "", help: false };

    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === "--help" || value === "-h") {
            args.help = true;
            continue;
        }
        if (value === "--file") {
            args.file = argv[index + 1] || "";
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${value}`);
    }

    return args;
}

async function readStdin() {
    let data = "";
    for await (const chunk of process.stdin) {
        data += chunk;
    }
    return data;
}

function isDeviceReachableHttps(urlValue) {
    try {
        const url = new URL(urlValue);
        const hostname = url.hostname.toLowerCase();
        const isLocalhost = hostname === "localhost"
            || hostname === "127.0.0.1"
            || hostname === "::1"
            || hostname.endsWith(".localhost");
        return url.protocol === "https:" && !isLocalhost;
    } catch {
        return false;
    }
}

function proofPlatformLabel(platform) {
    if (platform === "android") return "Android";
    if (platform === "ios") return "iOS";
    return "unknown";
}

function readProofPlatform(fields) {
    const userAgent = fields.userAgent || "";
    const displayEvidence = fields.displayEvidence || "";

    if (/Android/i.test(userAgent)) return "android";
    if (/(iPhone|iPad|iPod)/i.test(userAgent) || /ios-navigator-standalone=yes/i.test(displayEvidence)) {
        return "ios";
    }
    return "unknown";
}

function parseReport(reportText) {
    const lines = reportText
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);
    const fields = {};
    const checks = {};

    for (const line of lines.slice(1)) {
        if (line.startsWith("- ")) {
            const match = line.match(/^- ([^=]+)=([^:]+):([^(]+?)(?: \((.*)\))?$/);
            if (match) {
                checks[match[1]] = {
                    detail: match[4] || "",
                    tone: match[2],
                    value: match[3].trim(),
                };
            }
            continue;
        }

        const separator = line.indexOf("=");
        if (separator > 0) {
            fields[line.slice(0, separator)] = line.slice(separator + 1);
        }
    }

    return {
        checks,
        fields,
        header: lines[0] || "",
    };
}

function validateProof(parsed, expectedPlatform = "") {
    const errors = [];
    const platform = readProofPlatform(parsed.fields);
    const installedModes = new Set(["standalone", "fullscreen"]);
    const expectedCachePrefix = "omr-maker-v9";
    const requiredPassChecks = [
        "secure-context",
        "display-mode",
        "launch-proof",
        "service-worker",
        "offline-cache",
        "manifest",
        "viewport",
        "viewport-height",
        "keyboard-safe-area",
        "mobile-meta",
        "ios-startup-image",
        "handoff-origin",
        "overflow",
        "storage",
        "install-prompt",
    ];

    if (parsed.header !== "OMR Maker PWA device check") {
        errors.push("Report header is not an OMR Maker PWA device check report.");
    }
    if (expectedPlatform && platform !== expectedPlatform) {
        errors.push(`Report must come from ${proofPlatformLabel(expectedPlatform)}, got ${proofPlatformLabel(platform)}.`);
    }
    if (!isDeviceReachableHttps(parsed.fields.url || "")) {
        errors.push("Report URL must be the deployed HTTPS URL, not localhost or an invalid URL.");
    }
    if (parsed.fields.verdict !== "앱 실행 통과") {
        errors.push("Report verdict is not 앱 실행 통과.");
    }
    if (!installedModes.has(parsed.fields.displayMode)) {
        errors.push("displayMode must be standalone or fullscreen.");
    }
    if (parsed.fields.installedDisplay !== "yes") {
        errors.push("installedDisplay must be yes.");
    }
    if (parsed.fields.proofStatus !== "pass") {
        errors.push("proofStatus must be pass.");
    }
    if (!/0 fail/.test(parsed.fields.summary || "")) {
        errors.push("Report summary must include 0 fail.");
    }
    if (!/yes/.test(parsed.fields.displayEvidence || "")) {
        errors.push("displayEvidence must include at least one yes signal.");
    }
    if (!parsed.checks["offline-cache"]?.detail.includes(expectedCachePrefix)) {
        errors.push(`offline-cache must include ${expectedCachePrefix}.`);
    }
    if (
        parsed.checks["service-worker"]
        && (
            parsed.checks["service-worker"].value !== "제어 중"
            || !parsed.checks["service-worker"].detail.includes("controller=yes")
        )
    ) {
        errors.push("service-worker must be controlled by the active PWA worker.");
    }

    for (const checkId of requiredPassChecks) {
        const check = parsed.checks[checkId];
        if (!check) {
            errors.push(`Missing check: ${checkId}.`);
            continue;
        }
        if (check.tone !== "pass") {
            errors.push(`Check ${checkId} must be pass, got ${check.tone}:${check.value}.`);
        }
    }

    return errors;
}

function resultForReport(reportText, expectedPlatform = "") {
    const parsed = parseReport(reportText);
    const errors = validateProof(parsed, expectedPlatform);

    return {
        checks: Object.fromEntries(Object.entries(parsed.checks).map(([id, check]) => [id, `${check.tone}:${check.value}`])),
        displayMode: parsed.fields.displayMode || "",
        errors,
        installedDisplay: parsed.fields.installedDisplay || "",
        platform: readProofPlatform(parsed.fields),
        proofStatus: parsed.fields.proofStatus || "",
        status: errors.length === 0 ? "passed" : "failed",
        url: parsed.fields.url || "",
        userAgent: parsed.fields.userAgent || "",
        verdict: parsed.fields.verdict || "",
    };
}

function parseBundleFields(bundleText) {
    const lines = bundleText
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);
    const fields = {};

    for (const line of lines.slice(1)) {
        if (line.startsWith("-----BEGIN ")) break;
        const separator = line.indexOf("=");
        if (separator > 0) {
            fields[line.slice(0, separator)] = line.slice(separator + 1);
        }
    }

    return {
        fields,
        header: lines[0] || "",
    };
}

function extractBundleReport(bundleText, platform) {
    const label = platform.toUpperCase();
    const pattern = new RegExp(`-----BEGIN ${label} PWA REPORT-----\\n([\\s\\S]*?)\\n-----END ${label} PWA REPORT-----`);
    return pattern.exec(bundleText)?.[1]?.trim() || "";
}

function resultForDualBundle(bundleText) {
    const bundle = parseBundleFields(bundleText);
    const errors = [];

    if (bundle.header !== "OMR Maker PWA dual device proof") {
        errors.push("Bundle header is not an OMR Maker PWA dual device proof bundle.");
    }
    if (bundle.fields.status !== "passed") {
        errors.push("Bundle status must be passed.");
    }
    if (!/Android/.test(bundle.fields.requiredDevices || "") || !/iOS/.test(bundle.fields.requiredDevices || "")) {
        errors.push("Bundle must require Android and iOS.");
    }

    const androidText = extractBundleReport(bundleText, "android");
    const iosText = extractBundleReport(bundleText, "ios");
    const android = androidText ? resultForReport(androidText, "android") : null;
    const ios = iosText ? resultForReport(iosText, "ios") : null;

    if (!androidText) errors.push("Missing Android PWA report section.");
    if (!iosText) errors.push("Missing iOS PWA report section.");
    if (android && android.status !== "passed") errors.push("Android proof report must pass.");
    if (ios && ios.status !== "passed") errors.push("iOS proof report must pass.");

    return {
        android,
        errors,
        ios,
        mode: "dual",
        status: errors.length === 0 ? "passed" : "failed",
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(usage());
        return 0;
    }

    const reportText = args.file ? await readFile(args.file, "utf8") : await readStdin();
    if (!reportText.trim()) {
        throw new Error(`No PWA proof report provided.\n${usage()}`);
    }

    const result = reportText.trim().startsWith("OMR Maker PWA dual device proof")
        ? resultForDualBundle(reportText)
        : resultForReport(reportText);

    console.log(JSON.stringify(result, null, 2));
    return result.status === "passed" ? 0 : 1;
}

main()
    .then(code => {
        process.exitCode = code;
    })
    .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
