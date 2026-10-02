const LOCAL_E2E_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function mayRunMutatingE2E(baseURL: string | undefined, externalOptIn: string | undefined): boolean {
    try {
        const url = new URL(baseURL || "http://localhost:3003");
        if (LOCAL_E2E_HOSTS.has(url.hostname)) return true;
        return externalOptIn === "1";
    } catch {
        return false;
    }
}
