import webpush from "web-push";

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
 * Send Web Push notification to a subscription using RFC 8291 / RFC 8292.
 * Uses webpush.generateRequestDetails to encrypt payload and sign VAPID JWT,
 * then dispatches using the native fetch() API.
 */
export async function sendWebPush(
  sub: PushSubscriptionData,
  payload: PushPayload,
  config: VapidConfig
): Promise<PushDeliveryResult> {
  if (!config.publicKey || !config.privateKey) {
    return {
      endpoint: sub.endpoint,
      success: false,
      error: "VAPID keys are not configured on the server"
    };
  }

  try {
    const details = webpush.generateRequestDetails(
      sub,
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: config.subject || DEFAULT_VAPID_SUBJECT,
          publicKey: config.publicKey,
          privateKey: config.privateKey
        },
        TTL: 60 * 60 * 24 // 24 hours
      }
    );

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(details.headers)) {
      headers[k] = String(v);
    }

    const res = await fetch(details.endpoint, {
      method: details.method,
      headers,
      body: details.body
    });

    if (res.status === 200 || res.status === 201 || res.status === 204) {
      return { endpoint: sub.endpoint, success: true, statusCode: res.status };
    }

    // 404 Not Found or 410 Gone means the subscription has expired or was unsubscribed
    const isExpired = res.status === 404 || res.status === 410;
    const errorText = await res.text().catch(() => "");

    return {
      endpoint: sub.endpoint,
      success: false,
      statusCode: res.status,
      expired: isExpired,
      error: `Push service rejected (${res.status}): ${errorText}`
    };
  } catch (err: any) {
    return {
      endpoint: sub.endpoint,
      success: false,
      error: err?.message || String(err)
    };
  }
}
