import webpush from "web-push";
import { validatePushSubscriptionInput } from "./validation";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export const DEFAULT_VAPID_PUBLIC_KEY =
  "BMvc07ap8EiEgS3O3upQee-f8UUuB2pDgaaNoZtkx4pxxURiZUh-WEhCDo_NYfrnqYvXrVyMj2NiPfwSI9aV6WM";

export const DEFAULT_VAPID_SUBJECT = "mailto:rainryder4@gmail.com";

export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export interface PushDeliveryResult {
  endpoint: string;
  success: boolean;
  statusCode?: number;
  expired?: boolean;
  error?: string;
}

/**
 * Send Web Push notification to a validated subscription using RFC 8291 / RFC 8292 (S04).
 */
export async function sendWebPush(
  sub: PushSubscriptionData,
  payload: PushPayload,
  config: VapidConfig
): Promise<PushDeliveryResult> {
  if (!config.publicKey || !config.privateKey || !config.subject) {
    return {
      endpoint: sub.endpoint,
      success: false,
      error: "VAPID keys are not configured on the server"
    };
  }

  const validation = validatePushSubscriptionInput(sub);
  if (!validation.ok) {
    return {
      endpoint: sub.endpoint,
      success: false,
      expired: true,
      error: validation.error
    };
  }

  // Enforce strict payload size cap (S04, S05)
  const sanitizedPayload: PushPayload = {
    title: String(payload.title || "klanki").slice(0, 120),
    body: String(payload.body || "").slice(0, 300),
    url: typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/",
    tag: String(payload.tag || "klanki").slice(0, 64)
  };

  try {
    const details = webpush.generateRequestDetails(
      sub,
      JSON.stringify(sanitizedPayload),
      {
        vapidDetails: {
          subject: config.subject || DEFAULT_VAPID_SUBJECT,
          publicKey: config.publicKey,
          privateKey: config.privateKey
        },
        TTL: 60 * 60 * 24
      }
    );

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(details.headers)) {
      headers[k] = String(v);
    }

    const res = await fetch(details.endpoint, {
      method: details.method,
      headers,
      body: details.body as unknown as BodyInit,
      redirect: "manual"
    });

    if (res.status === 200 || res.status === 201 || res.status === 204) {
      return { endpoint: sub.endpoint, success: true, statusCode: res.status };
    }

    const isExpired = res.status === 404 || res.status === 410;
    const errorText = await res.text().catch(() => "");

    return {
      endpoint: sub.endpoint,
      success: false,
      statusCode: res.status,
      expired: isExpired,
      error: `Push service rejected (${res.status}): ${errorText.slice(0, 200)}`
    };
  } catch (err: any) {
    return {
      endpoint: sub.endpoint,
      success: false,
      error: err?.message || String(err)
    };
  }
}
