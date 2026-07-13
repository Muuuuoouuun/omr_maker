import type { CapacitorConfig } from "@capacitor/cli";

// This app is a Next.js app with server actions and dynamic routes, so it cannot
// be statically exported into the app bundle. Instead the native Android shell
// loads the live app over the network (the same model as the Electron dev shell,
// which points at the running server). Set CAP_SERVER_URL to your deployed HTTPS
// origin for release builds; the default targets a LAN dev server for testing.
//
//   Production:  CAP_SERVER_URL=https://omr.example.com   (remove cleartext)
//   LAN testing: phone + PC on the same Wi-Fi, PC running `npm start` on :3003
const serverUrl = process.env.CAP_SERVER_URL || "http://192.168.219.141:3003";
const isCleartext = serverUrl.startsWith("http://");

const config: CapacitorConfig = {
    appId: "com.omrmaker.app",
    appName: "OMR Maker",
    // Fallback splash shown while the shell connects to serverUrl (see mobile/www).
    webDir: "mobile/www",
    server: {
        url: serverUrl,
        // Cleartext is only needed for http LAN testing; a production https URL
        // does not need it and should leave it off.
        cleartext: isCleartext,
        androidScheme: isCleartext ? "http" : "https",
    },
    android: {
        backgroundColor: "#f8fafc",
    },
};

export default config;
