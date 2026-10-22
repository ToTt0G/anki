// Web Push Client Manager

const FALLBACK_VAPID_PUBLIC_KEY =
  "BLeGIxHLsB6mB7_RYNMw0wI55oR1vGCzPaOWxdjPxfwOHnc4GZkwoubPACQx6qnaTt16qQmXlzaKBy4NzEoKOvY";

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

export async function getVapidPublicKey(): Promise<string> {
  try {
    const res = await fetch("/api/push/vapid-public-key");
    if (res.ok) {
      const data = await res.json();
      if (data.publicKey) return data.publicKey;
    }
  } catch (err) {
    console.warn("Failed to fetch VAPID key from backend, using fallback:", err);
  }
  return FALLBACK_VAPID_PUBLIC_KEY;
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch (err) {
    console.warn("Error getting push subscription:", err);
    return null;
  }
}

export async function subscribeToPush(): Promise<{ success: boolean; error?: string }> {
  if (!isPushSupported()) {
    return { success: false, error: "Push notifications are not supported on this browser or platform." };
  }

  // 1. Explicit user permission request
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      success: false,
      error: permission === "denied"
        ? "Notification permissions were blocked. Please enable them in your browser/system settings."
        : "Notification permission was dismissed."
    };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const publicKey = await getVapidPublicKey();
    const applicationServerKey = urlBase64ToUint8Array(publicKey);

    // 2. Subscribe via PushManager
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

    // 3. Send subscription to server
    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: { p256dh, auth }
      })
    });

    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }

    return { success: true };
  } catch (err: any) {
    console.error("Failed to subscribe to push notifications:", err);
    return { success: false, error: err.message || "Failed to subscribe" };
  }
}

export async function unsubscribeFromPush(): Promise<{ success: boolean; error?: string }> {
  try {
    const sub = await getCurrentPushSubscription();
    if (sub) {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint })
      }).catch(() => {});

      await sub.unsubscribe();
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to unsubscribe" };
  }
}

export async function sendTestPush(): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const sub = await getCurrentPushSubscription();
    const res = await fetch("/api/push/send-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: sub?.endpoint,
        title: "Anki Study Reminder",
        body: "Your spaced repetition notifications are working properly!"
      })
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function sendNotifyDue(count: number = 5): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const res = await fetch("/api/push/notify-due", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
