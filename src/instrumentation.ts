import type { Instrumentation } from "next";
import { reportServerError } from "@/lib/reportServerError";

export function register(): void {
    // The request-error hook below is the only runtime registration needed.
}

export const onRequestError: Instrumentation.onRequestError = async error => {
    await reportServerError("server-request-error", error);
};
