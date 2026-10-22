import { verifyToken } from "@clerk/backend";

export interface AuthEnv {
  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_JWT_KEY?: string;
}

export interface VerifiedSession {
  userId: string;
  sessionId?: string;
}

export interface WsTicketPayload {
  sub: string;
  nonce: string;
  exp: number;
}

const WS_TICKET_TTL_MS = 60_000; // 60 seconds

function extractBearerOrCookieToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization") || request.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }

  const cookieHeader = request.headers.get("Cookie") || request.headers.get("cookie");
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)__session=([^;]+)/);
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  return null;
}

/**
 * Verify the incoming HTTP request using Clerk's session JWT verification.
 * Returns the verified Clerk user ID (`sub`), or null if unauthenticated.
 */
export async function verifyClerkRequest(
  request: Request,
  env: AuthEnv
): Promise<VerifiedSession | null> {
  const token = extractBearerOrCookieToken(request);
  if (!token) {
    return null;
  }

  if (!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY) {
    console.error("Missing CLERK_SECRET_KEY or CLERK_JWT_KEY in Worker environment");
    return null;
  }

  try {
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
      jwtKey: env.CLERK_JWT_KEY
    });

    if (!payload || typeof payload.sub !== "string" || !payload.sub.trim()) {
      return null;
    }

    return {
      userId: payload.sub,
      sessionId: typeof payload.sid === "string" ? payload.sid : undefined
    };
  } catch (err) {
    console.warn("Clerk token verification failed:", err);
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
      sigBytes,
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
