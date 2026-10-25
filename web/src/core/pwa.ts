// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// PWA Service Worker Registration, Update Recovery & Standalone Detection (U-07)

export interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface ServiceWorkerCallbacks {
    onUpdateAvailable?: (registration: ServiceWorkerRegistration) => void;
    onRegistrationError?: (errorMessage: string) => void;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
const installListeners: Array<(canInstall: boolean) => void> = [];

export function isStandalone(): boolean {
    if (typeof window === "undefined") { return false; }
    return (
        window.matchMedia("(display-mode: standalone)").matches
        || (window.navigator as any).standalone === true
        || document.referrer.includes("android-app://")
    );
}

export function isIosDevice(): boolean {
    if (typeof window === "undefined") { return false; }
    const ua = window.navigator.userAgent.toLowerCase();
    return (
        /iphone|ipad|ipod/.test(ua)
        || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
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
        if (idx !== -1) { installListeners.splice(idx, 1); }
    };
}

export async function promptPwaInstall(): Promise<boolean> {
    if (!deferredInstallPrompt) { return false; }
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

export function applyServiceWorkerUpdate(registration: ServiceWorkerRegistration): void {
    if (!registration.waiting) { return; }
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!reloaded) {
            reloaded = true;
            window.location.reload();
        }
    }, { once: true });
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
}

/**
 * Register Service Worker with visible update notification and error recovery (U-07).
 */
export async function registerServiceWorker(
    callbacks?: ServiceWorkerCallbacks,
): Promise<ServiceWorkerRegistration | null> {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
        return null;
    }

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
            scope: "/",
        });

        if (registration.waiting && navigator.serviceWorker.controller) {
            callbacks?.onUpdateAvailable?.(registration);
        }

        registration.addEventListener("updatefound", () => {
            const newWorker = registration.installing;
            if (newWorker) {
                newWorker.addEventListener("statechange", () => {
                    if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
                        callbacks?.onUpdateAvailable?.(registration);
                    }
                });
            }
        });

        return registration;
    } catch (err: any) {
        const msg = err?.message || "Service Worker registration failed";
        callbacks?.onRegistrationError?.(msg);
        return null;
    }
}
