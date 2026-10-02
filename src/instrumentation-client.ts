type ClientRuntimeFailureKind = "error" | "unhandledrejection";

const CLIENT_EVENT_ENDPOINT = "/api/internal/operational-events/client";
let remainingReports = 3;

function safeErrorName(value: unknown): string {
    if (value instanceof Error) return value.name;
    return "Error";
}

function reportClientRuntimeFailure(kind: ClientRuntimeFailureKind, value: unknown): void {
    if (remainingReports <= 0) return;
    remainingReports -= 1;
    void fetch(CLIENT_EVENT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, name: safeErrorName(value) }),
        cache: "no-store",
        credentials: "same-origin",
        keepalive: true,
        redirect: "error",
    }).catch(() => undefined);
}

globalThis.addEventListener("error", event => {
    reportClientRuntimeFailure("error", event instanceof ErrorEvent ? event.error : undefined);
});

globalThis.addEventListener("unhandledrejection", event => {
    reportClientRuntimeFailure(
        "unhandledrejection",
        event instanceof PromiseRejectionEvent ? event.reason : undefined,
    );
});
