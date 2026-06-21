#!/usr/bin/env node

import { readFile } from "node:fs/promises";

function usage() {
    return [
        "Usage:",
        "  npm run pwa:proof < pwa-report.txt",
        "  npm run pwa:proof -- --file pwa-report.txt",
        "",
        "The input must be the copied report from /pwa-check after opening the installed home-screen app.",
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

function validateProof(parsed) {
    const errors = [];
    const installedModes = new Set(["standalone", "fullscreen"]);
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
        "handoff-origin",
        "overflow",
        "storage",
        "install-prompt",
    ];

    if (parsed.header !== "OMR Maker PWA device check") {
        errors.push("Report header is not an OMR Maker PWA device check report.");
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

    const parsed = parseReport(reportText);
    const errors = validateProof(parsed);
    const result = {
        checks: Object.fromEntries(Object.entries(parsed.checks).map(([id, check]) => [id, `${check.tone}:${check.value}`])),
        displayMode: parsed.fields.displayMode || "",
        errors,
        installedDisplay: parsed.fields.installedDisplay || "",
        proofStatus: parsed.fields.proofStatus || "",
        status: errors.length === 0 ? "passed" : "failed",
        url: parsed.fields.url || "",
        verdict: parsed.fields.verdict || "",
    };

    console.log(JSON.stringify(result, null, 2));
    return errors.length === 0 ? 0 : 1;
}

main()
    .then(code => {
        process.exitCode = code;
    })
    .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
