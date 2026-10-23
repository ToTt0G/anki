import { verifyToken } from "@clerk/backend";

export interface AuthEnv {
  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_JWT_KEY?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
}

export interface VerifiedSession {
  userId: string;
  sessionId?: string;
  authSource: "bearer" | "cookie";
}

export interface WsTicketPayload {
  sub: string;
  nonce: string;
  exp: number;
}

const WS_TICKET_TTL_MS = 60_000; // 60 seconds

export const DEFAULT_AUTHORIZED_ORIGINS = [
  "https://klanki.ezryder.us",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

export function getAuthorizedParties(env: AuthEnv): string[] {
  if (env.CLERK_AUTHORIZED_PARTIES) {
    const custom = env.CLERK_AUTHORIZED_PARTIES.split(",")
      .map(s => s.trim())
      .filter(Boolean);
    if (custom.length > 0) {
      return Array.from(new Set([...DEFAULT_AUTHORIZED_ORIGINS, ...custom]));
    }
  }
  return DEFAULT_AUTHORIZED_ORIGINS;
}

/**
 * Redact sensitive query parameters (`ticket`, `token`, `code`) before logging URLs (S11, Q07).
 */
export function redactUrlForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    for (const key of ["ticket", "token", "code", "__clerk_db_jwt"]) {
      if (u.searchParams.has(key)) {
        u.searchParams.set(key, "[REDACTED]");
      }
    }
    return u.toString();
  } catch {
    return "[INVALID_URL]";
  }
}

/**
 * Apply defense-in-depth HTTP security headers to Worker responses (S08).
 */
export function withSecurityHeaders(response: Response): Response {
  // WebSocket 101 Switching Protocols responses must be returned as-is
  if (response.status === 101 || (response as any).webSocket) {
    return response;
  }

  const headers = new Headers(response.headers);
  if (!headers.has("X-Content-Type-Options")) {
    headers.set("X-Content-Type-Options", "nosniff");
  }
  if (!headers.has("Referrer-Policy")) {
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  if (!headers.has("X-Frame-Options")) {
    headers.set("X-Frame-Options", "DENY");
  }
  if (!headers.has("Permissions-Policy")) {
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  }
  if (!headers.has("Strict-Transport-Security")) {
    headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  if (!headers.has("Content-Security-Policy")) {
    headers.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.klanki.ezryder.us https://*.clerk.accounts.dev https://cdn.jsdelivr.net https://challenges.cloudflare.com",
        "connect-src 'self' wss://klanki.ezryder.us https://clerk.klanki.ezryder.us https://*.clerk.accounts.dev https://cdn.jsdelivr.net",
        "img-src 'self' data: blob: https://img.clerk.com https://*.clerk.com",
        "media-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data: https://cdn.jsdelivr.net",
        "frame-src 'self' blob: https://challenges.cloudflare.com https://clerk.klanki.ezryder.us https://*.clerk.accounts.dev",
        "worker-src 'self' blob:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        " object-src 'none'"
      ].join("; ")
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function extractBearerOrCookieToken(
  request: Request
): { token: string; source: "bearer" | "cookie" } | null {
  const authHeader = request.headers.get("Authorization") || request.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return { token, source: "bearer" };
  }

  const cookieHeader = request.headers.get("Cookie") || request.headers.get("cookie");
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)__session=([^;]+)/);
    if (match?.[1]) {
      return { token: decodeURIComponent(match[1]), source: "cookie" };
    }
  }

  return null;
}

/**
 * Validate Origin header for state-changing requests (S02 CSRF defense).
 */
export function isAllowedRequestOrigin(request: Request, env: AuthEnv): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }

  const origin = request.headers.get("Origin") || request.headers.get("origin");
  const reqOrigin = new URL(request.url).origin;
  const allowed = new Set([...getAuthorizedParties(env), reqOrigin]);

  if (origin) {
    return allowed.has(origin);
  }

  // If no Origin header is present, only allow Bearer-authenticated requests, never cookie-authenticated mutations
  const extracted = extractBearerOrCookieToken(request);
  return extracted?.source === "bearer";
}

/**
 * Verify the incoming HTTP request using Clerk's session JWT verification
 * with explicit authorizedParties and CSRF Origin validation (S02).
 */
export async function verifyClerkRequest(
  request: Request,
  env: AuthEnv
): Promise<VerifiedSession | null> {
  if (!isAllowedRequestOrigin(request, env)) {
    return null;
  }

  const extracted = extractBearerOrCookieToken(request);
  if (!extracted) {
    return null;
  }

  const { token, source } = extracted;

  if (!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY) {
    console.error("Missing CLERK_SECRET_KEY or CLERK_JWT_KEY in Worker environment");
    return null;
  }

  const reqOrigin = new URL(request.url).origin;
  const authorizedParties = Array.from(new Set([...getAuthorizedParties(env), reqOrigin]));

  try {
    let payload: any = null;
    if (env.CLERK_JWT_KEY) {
      try {
        payload = await verifyToken(token, {
          jwtKey: env.CLERK_JWT_KEY,
          authorizedParties
        });
      } catch {
        payload = null;
      }
    }
    if (!payload && env.CLERK_SECRET_KEY) {
      payload = await verifyToken(token, {
        secretKey: env.CLERK_SECRET_KEY,
        authorizedParties
      });
    }

    if (!payload || typeof payload.sub !== "string" || !payload.sub.trim()) {
      return null;
    }

    // Extra defense: if the token contains an `azp` claim, ensure it is in authorizedParties
    if (typeof payload.azp === "string" && !authorizedParties.includes(payload.azp)) {
      return null;
    }

    return {
      userId: payload.sub,
      sessionId: typeof payload.sid === "string" ? payload.sid : undefined,
      authSource: source
    };
  } catch (err) {
    console.warn("Clerk token verification failed for", redactUrlForLog(request.url), err);
    return null;
  }
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeBytes(str: string): Uint8Array {
  const padding = "=".repeat((4 - (str.length % 4)) % 4);
  const base64 = (str + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Issue a short-lived (60s), single-use HMAC-signed WebSocket connection ticket
 * bound to the authenticated Clerk user ID.
 */
export async function issueSignedWsTicket(
  userId: string,
  secretKey: string
): Promise<{ ticket: string; nonce: string; exp: number }> {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = base64UrlEncodeBytes(nonceBytes);
  const exp = Date.now() + WS_TICKET_TTL_MS;

  const payload: WsTicketPayload = { sub: userId, nonce, exp };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const payloadB64 = base64UrlEncodeBytes(payloadBytes);

  const key = await getHmacKey(secretKey);
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64)
  );
  const sigB64 = base64UrlEncodeBytes(new Uint8Array(sigBuffer));

  return {
    ticket: `${payloadB64}.${sigB64}`,
    nonce,
    exp
  };
}

/**
 * Verify a short-lived WebSocket connection ticket's signature and expiration.
 */
export async function verifySignedWsTicket(
  ticket: string,
  secretKey: string
): Promise<WsTicketPayload | null> {
  if (!ticket || !secretKey) return null;
  const parts = ticket.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, sigB64] = parts;
  try {
    const key = await getHmacKey(secretKey);
    const sigBytes = base64UrlDecodeBytes(sigB64);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes as unknown as BufferSource,
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;

    const payloadJson = new TextDecoder().decode(base64UrlDecodeBytes(payloadB64));
    const payload = JSON.parse(payloadJson) as WsTicketPayload;

    if (
      !payload ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.nonce !== "string" ||
      !payload.nonce ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }

    if (Date.now() > payload.exp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
