// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { CheckCircle2, Download, Monitor, PlusSquare, Share, Smartphone, X } from "lucide-react";
import React, { useEffect, useState } from "react";
import { canInstallPrompt, isIosDevice, isStandalone, onInstallPromptChange, promptPwaInstall } from "../core/pwa";

interface Props {
    externalOpenGuide?: boolean;
    onCloseExternalGuide?: () => void;
}

export const InstallPrompt: React.FC<Props> = ({
    externalOpenGuide,
    onCloseExternalGuide,
}) => {
    const [standalone, setStandalone] = useState(true);
    const [canPrompt, setCanPrompt] = useState(false);
    const [dismissed, setDismissed] = useState(true);
    const [showIosGuide, setShowIosGuide] = useState(false);
    const [installedSuccess, setInstalledSuccess] = useState(false);

    const isGuideVisible = showIosGuide || Boolean(externalOpenGuide);
    const closeGuide = () => {
        setShowIosGuide(false);
        onCloseExternalGuide?.();
    };

    useEffect(() => {
        const isApp = isStandalone();
        setStandalone(isApp);
        if (isApp) { return; }

        const isDismissed = localStorage.getItem("klanki_pwa_install_dismissed") === "true";
        setDismissed(isDismissed);

        const unsub = onInstallPromptChange(available => {
            setCanPrompt(available);
        });

        return () => unsub();
    }, []);

    if (standalone && !externalOpenGuide) { return null; }

    const handleInstallClick = async () => {
        if (isIosDevice()) {
            setShowIosGuide(true);
            return;
        }

        if (canPrompt) {
            const accepted = await promptPwaInstall();
            if (accepted) {
                setInstalledSuccess(true);
                setTimeout(() => {
                    setStandalone(true);
                }, 2000);
            }
        } else {
            setShowIosGuide(true);
        }
    };

    const handleDismiss = () => {
        setDismissed(true);
        localStorage.setItem("klanki_pwa_install_dismissed", "true");
    };

    const isIos = isIosDevice();

    return (
        <>
            {/* Discreet bottom banner / floating toast */}
            {!dismissed && (
                <aside
                    role="region"
                    aria-label="PWA install banner"
                    style={{
                        position: "fixed",
                        bottom: "20px",
                        right: "20px",
                        zIndex: 990,
                        maxWidth: "380px",
                        width: "calc(100vw - 40px)",
                        backgroundColor: "var(--bg-secondary)",
                        border: "1px solid var(--border-color)",
                        boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
                        borderRadius: "12px",
                        padding: "14px 16px",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "12px",
                        animation: "fadeIn 0.25s ease-out",
                    }}
                >
                    <div
                        style={{
                            width: 38,
                            height: 38,
                            borderRadius: 8,
                            backgroundColor: "rgba(2, 132, 199, 0.12)",
                            color: "var(--color-new)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                        }}
                    >
                        {isIos ? <Smartphone size={20} /> : <Download size={20} />}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                            style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: 2 }}
                        >
                            Install klanki App
                        </div>
                        <p style={{ fontSize: "12.5px", color: "var(--text-secondary)", lineHeight: 1.4, margin: 0 }}>
                            {isIos
                                ? "Install to Home Screen for push notifications and offline study."
                                : "Fast offline access, native window, and spaced repetition reminders."}
                        </p>

                        <div style={{ display: "flex", gap: "8px", marginTop: "10px", alignItems: "center" }}>
                            <button
                                className="primary"
                                onClick={handleInstallClick}
                                style={{
                                    padding: "5px 12px",
                                    fontSize: "12.5px",
                                    fontWeight: 500,
                                    borderRadius: "6px",
                                }}
                            >
                                {isIos ? "How to Install" : "Install"}
                            </button>
                            <button
                                onClick={handleDismiss}
                                style={{
                                    padding: "5px 10px",
                                    fontSize: "12.5px",
                                    background: "transparent",
                                    border: "none",
                                    color: "var(--text-muted)",
                                }}
                            >
                                Later
                            </button>
                        </div>
                    </div>

                    <button
                        onClick={handleDismiss}
                        aria-label="Close install prompt"
                        style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--text-muted)",
                            padding: "2px",
                            cursor: "pointer",
                            display: "flex",
                        }}
                    >
                        <X size={16} />
                    </button>
                </aside>
            )}

            {/* Success Notification */}
            {installedSuccess && (
                <div
                    style={{
                        position: "fixed",
                        bottom: "20px",
                        right: "20px",
                        zIndex: 1000,
                        backgroundColor: "var(--bg-secondary)",
                        border: "1px solid var(--color-good)",
                        borderRadius: "10px",
                        padding: "12px 18px",
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
                    }}
                >
                    <CheckCircle2 size={20} color="var(--color-good)" />
                    <span style={{ fontSize: "13.5px", fontWeight: 500 }}>
                        klanki successfully installed!
                    </span>
                </div>
            )}

            {/* iOS & Manual Installation Instructions Modal */}
            {isGuideVisible && (
                <div className="modal-backdrop" style={{ zIndex: 1001 }} onClick={closeGuide}>
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="install-guide-title"
                        className="modal-content"
                        style={{ maxWidth: 460 }}
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="modal-header">
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <Smartphone size={20} color="var(--color-new)" />
                                <h3 id="install-guide-title" style={{ fontSize: 16, fontWeight: 600 }}>
                                    Install klanki as an App
                                </h3>
                            </div>
                            <button
                                type="button"
                                aria-label="Close install instructions"
                                onClick={closeGuide}
                                style={{ border: "none", padding: 4, background: "transparent" }}
                            >
                                <X size={18} />
                            </button>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 0" }}>
                            <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.5, margin: 0 }}>
                                Installing provides fullscreen viewing, instant loading, and enables native push
                                notifications for due cards.
                            </p>

                            {isIos
                                ? (
                                    <div
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: 12,
                                            background: "var(--bg-secondary)",
                                            padding: 14,
                                            borderRadius: 8,
                                            border: "1px solid var(--border-color)",
                                        }}
                                    >
                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "flex-start",
                                                gap: 10,
                                                fontSize: 13.5,
                                            }}
                                        >
                                            <div
                                                style={{
                                                    width: 24,
                                                    height: 24,
                                                    borderRadius: "50%",
                                                    background: "var(--color-new)",
                                                    color: "#fff",
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    fontWeight: 600,
                                                    fontSize: 12,
                                                    flexShrink: 0,
                                                }}
                                            >
                                                1
                                            </div>
                                            <div>
                                                Tap the <strong>Share</strong> button in Safari's toolbar:
                                                <div
                                                    style={{
                                                        display: "inline-flex",
                                                        alignItems: "center",
                                                        gap: 4,
                                                        marginLeft: 6,
                                                        verticalAlign: "middle",
                                                    }}
                                                >
                                                    <Share size={15} color="var(--color-new)" />
                                                </div>
                                            </div>
                                        </div>

                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "flex-start",
                                                gap: 10,
                                                fontSize: 13.5,
                                            }}
                                        >
                                            <div
                                                style={{
                                                    width: 24,
                                                    height: 24,
                                                    borderRadius: "50%",
                                                    background: "var(--color-new)",
                                                    color: "#fff",
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    fontWeight: 600,
                                                    fontSize: 12,
                                                    flexShrink: 0,
                                                }}
                                            >
                                                2
                                            </div>
                                            <div>
                                                Scroll down and tap <strong>Add to Home Screen</strong>:
                                                <div
                                                    style={{
                                                        display: "inline-flex",
                                                        alignItems: "center",
                                                        gap: 4,
                                                        marginLeft: 6,
                                                        verticalAlign: "middle",
                                                    }}
                                                >
                                                    <PlusSquare size={15} color="var(--color-new)" />
                                                </div>
                                            </div>
                                        </div>

                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "flex-start",
                                                gap: 10,
                                                fontSize: 13.5,
                                            }}
                                        >
                                            <div
                                                style={{
                                                    width: 24,
                                                    height: 24,
                                                    borderRadius: "50%",
                                                    background: "var(--color-new)",
                                                    color: "#fff",
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    fontWeight: 600,
                                                    fontSize: 12,
                                                    flexShrink: 0,
                                                }}
                                            >
                                                3
                                            </div>
                                            <div>
                                                Tap <strong>Add</strong> in the top-right corner.
                                            </div>
                                        </div>

                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "flex-start",
                                                gap: 10,
                                                fontSize: 13.5,
                                            }}
                                        >
                                            <div
                                                style={{
                                                    width: 24,
                                                    height: 24,
                                                    borderRadius: "50%",
                                                    background: "var(--color-good)",
                                                    color: "#fff",
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    fontWeight: 600,
                                                    fontSize: 12,
                                                    flexShrink: 0,
                                                }}
                                            >
                                                ✓
                                            </div>
                                            <div>
                                                Launch <strong>klanki</strong>{" "}
                                                from your Home Screen to unlock native Push Notifications!
                                            </div>
                                        </div>
                                    </div>
                                )
                                : (
                                    <div
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: 12,
                                            background: "var(--bg-secondary)",
                                            padding: 14,
                                            borderRadius: 8,
                                            border: "1px solid var(--border-color)",
                                        }}
                                    >
                                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
                                            <Monitor size={18} color="var(--color-new)" />
                                            <span>
                                                Click the <strong>Install</strong>{" "}
                                                icon in the browser address bar (right side), or open the browser menu
                                                (⋮) and select <strong>Install klanki</strong>.
                                            </span>
                                        </div>
                                    </div>
                                )}
                        </div>

                        <div className="modal-footer" style={{ marginTop: 12 }}>
                            <button type="button" className="primary" onClick={closeGuide}>
                                Got it
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
