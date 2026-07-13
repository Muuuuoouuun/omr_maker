import type { CapacitorConfig } from "@capacitor/cli";

function remoteDevelopmentServer(): CapacitorConfig["server"] | undefined {
    const requestedUrl = process.env.CAP_SERVER_URL?.trim();
    if (!requestedUrl) return undefined;

    if (process.env.CAP_ALLOW_REMOTE_DEV !== "1") {
        throw new Error(
            "CAP_SERVER_URL is development-only. Set CAP_ALLOW_REMOTE_DEV=1 explicitly or use npm run android:dev.",
        );
    }

    const url = new URL(requestedUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("CAP_SERVER_URL must use http:// or https://.");
    }

    return {
        url: url.toString().replace(/\/$/, ""),
        cleartext: url.protocol === "http:",
    };
}

const developmentServer = remoteDevelopmentServer();

const config: CapacitorConfig = {
    appId: "com.omrmaker.app",
    appName: "OMR Maker",
    // The checked-in bundle is a safe local waiting screen. `android:dev` uses
    // Capacitor's temporary live-reload URL and adb reverse without committing it.
    webDir: "mobile/www",
    ...(developmentServer ? { server: developmentServer } : {}),
    loggingBehavior: "debug",
    android: {
        backgroundColor: "#f8fafc",
        minWebViewVersion: 60,
    },
};

export default config;
