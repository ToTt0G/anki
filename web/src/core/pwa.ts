// PWA Service Worker Registration & Standalone Detection

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
const installListeners: Array<(canInstall: boolean) => void> = [];

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as any).standalone === true ||
    document.referrer.includes("android-app://")
  );
}

export function isIosDevice(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent.toLowerCase();
  return (
    /iphone|ipad|ipod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function canInstallPrompt(): boolean {
  return deferredInstallPrompt !== null && !isStandalone();
}

export function onInstallPromptChange(listener: (canInstall: boolean) => void): () => void {
  installListeners.push(listener);
  listener(canInstallPrompt());
  return () => {
    const idx = installListeners.indexOf(listener);
    if (idx !== -1) installListeners.splice(idx, 1);
  };
}

export async function promptPwaInstall(): Promise<boolean> {
  if (!deferredInstallPrompt) return false;
  try {
    await deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installListeners.forEach(fn => fn(false));
    return choice.outcome === "accepted";
  } catch (err) {
    console.warn("PWA install prompt failed:", err);
    return false;
  }
}

/**
 * Register Service Worker with auto-update handling
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  // Set up install event capture
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e as BeforeInstallPromptEvent;
    installListeners.forEach(fn => fn(true));
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installListeners.forEach(fn => fn(false));
  });

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/"
    });

    // Check for updates
    registration.addEventListener("updatefound", () => {
      const newWorker = registration.installing;
      if (newWorker) {
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            console.log("New version of klanki available.");
          }
        });
      }
    });

    return registration;
  } catch (err) {
    console.warn("Service Worker registration failed:", err);
    return null;
  }
}
