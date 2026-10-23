// Web Push Client Manager (User-Scoped, Account-Switch Detachment & VAPID Rotation Aware) (S03, N03, N05)

import { TokenGetter } from "./sync-client";

const FALLBACK_VAPID_PUBLIC_KEY =
  "BMvc07ap8EiEgS3O3upQee-f8UUuB2pDgaaNoZtkx4pxxURiZUh-WEhCDo_NYfrnqYvXrVyMj2NiPfwSI9aV6WM";

const PUSH_USER_STORAGE_KEY = "klanki_push_user_id";
const PUSH_VAPID_STORAGE_KEY = "klanki_push_vapid_pub";
const PUSH_ENDPOINT_STORAGE_KEY = "klanki_push_endpoint";

function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function buildAuthHeaders(getToken?: TokenGetter): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (getToken) {
    const token = await getToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }
  return headers;
}

export function isPushSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function getNotificationPermission(): NotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "denied";
  }
  return Notification.permission;
}

export async function getVapidPublicKey(getToken?: TokenGetter): Promise<string> {
  try {
    const headers = await buildAuthHeaders(getToken);
    const res = await fetch("/api/push/vapid-public-key", { headers });
    if (res.ok) {
      const data = await res.json();
      if (data.publicKey) return data.publicKey;
    }
  } catch (err) {
    console.warn("Failed to fetch VAPID key from backend, using fallback:", err);
  }
  return FALLBACK_VAPID_PUBLIC_KEY;
}

export async function getCurrentPushSubscription(userId?: string): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    if (userId) {
      const boundUser = localStorage.getItem(PUSH_USER_STORAGE_KEY);
      if (boundUser && boundUser !== userId) {
        return null;
      }
    }
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch (err) {
    console.warn("Error getting push subscription:", err);
    return null;
  }
}

/**
 * Safely detach previous account's server-side push endpoint and verify VAPID key match (S03, N03).
 * Never silently transfers an existing push endpoint between two different users.
 */
export async function syncPushSubscriptionForUser(
  userId: string | null,
  getToken?: TokenGetter
): Promise<void> {
  if (!isPushSupported()) return;
  try {
    const boundUser = localStorage.getItem(PUSH_USER_STORAGE_KEY);
    const savedVapid = localStorage.getItem(PUSH_VAPID_STORAGE_KEY);
    const savedEndpoint = localStorage.getItem(PUSH_ENDPOINT_STORAGE_KEY);
    const registration = await navigator.serviceWorker.ready;
    const existingSub = await registration.pushManager.getSubscription();

    const currentEndpoint = existingSub?.endpoint || savedEndpoint;

    // 1. If user signed out or switched accounts (boundUser !== userId), detach old server record and unsubscribe browser endpoint (S03)
    if (!userId || (boundUser && boundUser !== userId)) {
      if (boundUser && currentEndpoint && userId && getToken) {
        const headers = await buildAuthHeaders(getToken);
        await fetch("/api/push/detach-previous", {
          method: "POST",
          headers,
          body: JSON.stringify({
            previousUserId: boundUser,
            endpoint: currentEndpoint
          })
        }).catch(() => {});
      }
      if (existingSub) {
        await existingSub.unsubscribe().catch(() => {});
      }
      localStorage.removeItem(PUSH_USER_STORAGE_KEY);
      localStorage.removeItem(PUSH_ENDPOINT_STORAGE_KEY);
      return;
    }

    if (!existingSub) return;

    // 2. Compare saved VAPID key against actual live server VAPID public key (N03)
    if (getToken) {
      const liveServerVapid = await getVapidPublicKey(getToken);
      if (savedVapid && savedVapid !== liveServerVapid) {
        await unsubscribeFromPush(getToken);
        return;
      }
    }
  } catch (err) {
    console.warn("Failed to sync push subscription for user:", err);
  }
}

export async function subscribeToPush(
  userId?: string,
  getToken?: TokenGetter
): Promise<{ success: boolean; error?: string }> {
  if (!isPushSupported()) {
    return {
      success: false,
      error: "Push notifications are not supported on this browser or platform."
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      success: false,
      error:
        permission === "denied"
          ? "Notification permissions were blocked. Please enable them in your browser/system settings."
          : "Notification permission was dismissed."
    };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const publicKey = await getVapidPublicKey(getToken);
    const applicationServerKey = urlBase64ToUint8Array(publicKey);

    // Unsubscribe any prior subscription if VAPID key or user changed (S03, N03)
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      const savedVapid = localStorage.getItem(PUSH_VAPID_STORAGE_KEY);
      const boundUser = localStorage.getItem(PUSH_USER_STORAGE_KEY);
      if (savedVapid !== publicKey || (boundUser && userId && boundUser !== userId)) {
        if (boundUser && userId && boundUser !== userId) {
          const headers = await buildAuthHeaders(getToken);
          await fetch("/api/push/detach-previous", {
            method: "POST",
            headers,
            body: JSON.stringify({
              previousUserId: boundUser,
              endpoint: existing.endpoint
            })
          }).catch(() => {});
        }
        await existing.unsubscribe().catch(() => {});
      }
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey as unknown as BufferSource
    });

    const rawKey = subscription.getKey("p256dh");
    const rawAuth = subscription.getKey("auth");
    if (!rawKey || !rawAuth) {
      throw new Error("Unable to obtain encryption keys from subscription");
    }

    const p256dh = btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(rawKey))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const auth = btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(rawAuth))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const headers = await buildAuthHeaders(getToken);
    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      headers,
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: { p256dh, auth },
        tzOffsetMinutes: new Date().getTimezoneOffset(),
        timeZone: getBrowserTimeZone()
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `Server returned HTTP ${response.status}`);
    }

    if (userId) {
      localStorage.setItem(PUSH_USER_STORAGE_KEY, userId);
    }
    localStorage.setItem(PUSH_VAPID_STORAGE_KEY, publicKey);
    localStorage.setItem(PUSH_ENDPOINT_STORAGE_KEY, subscription.endpoint);

    return { success: true };
  } catch (err: any) {
    console.error("Failed to subscribe to push notifications:", err);
    return { success: false, error: err.message || "Failed to subscribe" };
  }
}

export async function unsubscribeFromPush(
  getToken?: TokenGetter
): Promise<{ success: boolean; error?: string }> {
  try {
    const sub = await getCurrentPushSubscription();
    const endpoint = sub?.endpoint || localStorage.getItem(PUSH_ENDPOINT_STORAGE_KEY);
    if (endpoint) {
      const headers = await buildAuthHeaders(getToken);
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers,
        body: JSON.stringify({ endpoint })
      }).catch(() => {});
    }
    if (sub) {
      await sub.unsubscribe().catch(() => {});
    }
    localStorage.removeItem(PUSH_USER_STORAGE_KEY);
    localStorage.removeItem(PUSH_ENDPOINT_STORAGE_KEY);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to unsubscribe" };
  }
}

export async function sendTestPush(
  getToken?: TokenGetter
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const sub = await getCurrentPushSubscription();
    const headers = await buildAuthHeaders(getToken);
    const res = await fetch("/api/push/send-test", {
      method: "POST",
      headers,
      body: JSON.stringify({
        endpoint: sub?.endpoint,
        title: "klanki Study Reminder",
        body: "Your spaced repetition notifications are working properly!"
      })
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function sendNotifyDue(
  count: number = 5,
  getToken?: TokenGetter
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const headers = await buildAuthHeaders(getToken);
    const res = await fetch("/api/push/notify-due", {
      method: "POST",
      headers,
      body: JSON.stringify({ count })
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export interface ClientPushPreferences {
  dailyMode: "adaptive" | "fixed";
  dailyTime: string;
  tzOffsetMinutes: number;
  timeZone?: string;
  learningAlerts: boolean;
}

export interface PushStatusResponse {
  subscriptions: number;
  vapidConfigured: boolean;
  preferences?: ClientPushPreferences;
  nextAlarmAt?: number | null;
  dueSummary?: {
    learnDueCount: number;
    reviewDueCount: number;
    newCount: number;
    topDeckName: string;
    studiedToday: boolean;
    streakDays: number;
    adaptiveHour: number;
  };
}

export async function getPushStatus(
  getToken?: TokenGetter
): Promise<PushStatusResponse | null> {
  try {
    const headers = await buildAuthHeaders(getToken);
    const res = await fetch("/api/push/status", { headers });
    if (!res.ok) return null;
    return (await res.json()) as PushStatusResponse;
  } catch {
    return null;
  }
}

export async function updatePushPreferences(
  prefs: Partial<ClientPushPreferences>,
  getToken?: TokenGetter
): Promise<PushStatusResponse | null> {
  try {
    const headers = await buildAuthHeaders(getToken);
    const res = await fetch("/api/push/preferences", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...prefs,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
        timeZone: prefs.timeZone || getBrowserTimeZone()
      })
    });
    if (!res.ok) return null;
    return (await res.json()) as PushStatusResponse;
  } catch {
    return null;
  }
}
