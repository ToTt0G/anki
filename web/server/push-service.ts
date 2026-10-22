import webpush from "web-push";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export const DEFAULT_VAPID_CONFIG: VapidConfig = {
  publicKey: "BLeGIxHLsB6mB7_RYNMw0wI55oR1vGCzPaOWxdjPxfwOHnc4GZkwoubPACQx6qnaTt16qQmXlzaKBy4NzEoKOvY",
  privateKey: "jFpw15Jrj9Grs3KAETrGSGXCNr30AvHqfQRCUB66iqE",
  subject: "mailto:support@anki.local"
};

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
  config: VapidConfig = DEFAULT_VAPID_CONFIG
): Promise<PushDeliveryResult> {
  try {
    const details = webpush.generateRequestDetails(
      sub,
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: config.subject,
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
