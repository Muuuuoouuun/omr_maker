import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "./lib/contentSecurityPolicy";

export function proxy(request: NextRequest) {
    const nonce = randomBytes(32).toString("base64");
    const policy = contentSecurityPolicy(process.env, nonce);
    const requestHeaders = new Headers(request.headers);
    // Always replace client-supplied values before the renderer sees them.
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", policy);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", policy);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
}

export const config = {
    matcher: ["/", "/create/:path*", "/groups/:path*", "/teacher/:path*", "/student/:path*", "/solve/:path*", "/pwa-check"],
};
