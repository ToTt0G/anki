// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { useAuth } from "@clerk/react";
import {
    AlertCircle,
    Bell,
    BellOff,
    CheckCircle,
    Download,
    Info,
    Laptop,
    Monitor,
    Moon,
    RefreshCw,
    Send,
    Smartphone,
    Sun,
    Trash2,
    Undo2,
    X,
    XCircle,
} from "lucide-react";
import React, { useEffect, useState } from "react";
import { getClearDataOnSignOutPreference, OutboxEntry, setClearDataOnSignOutPreference } from "../core/idb-storage";
import {
    ClientPushPreferences,
    getCurrentPushSubscription,
    getNotificationPermission,
    getPushStatus,
    isPushSupported,
    PushStatusResponse,
    sendNotifyDue,
    sendTestPush,
    subscribeToPush,
    unsubscribeFromPush,
    updatePushPreferences,
} from "../core/push-manager";
import { canInstallPrompt, isIosDevice, isStandalone, promptPwaInstall } from "../core/pwa";
import { SyncStatus } from "../core/sync-client";
import { getStoredTheme, setStoredTheme, ThemeMode } from "../core/theme";
import { useAccessibleModal } from "./useAccessibleModal";

interface Props {
    syncStatus: SyncStatus;
    pendingOutboxCount?: number;
    /** Operations rejected by the server, parked for retry/discard (D13). */
    conflictedOps?: OutboxEntry[];
    onRetryConflict?: (opId: string) => Promise<void>;
    onDiscardConflict?: (opId: string) => Promise<void>;
    onForceSync: () => void;
    onClearOfflineData?: (options?: { forceDiscardPending?: boolean }) => Promise<void>;
    onDeleteAccountData?: () => Promise<void>;
    onClose: () => void;
    onShowInstallGuide?: () => void;
}

function describeConflictedOp(entry: OutboxEntry): string {
    switch (entry.msg.type) {
        case "answer_card":
            return "Card answer";
        case "upsert_deck":
            return `Deck update (${entry.msg.deck.name})`;
        case "delete_deck":
            return "Deck deletion";
        case "upsert_deck_config":
            return "Deck options update";
        case "upsert_note":
            return "Note update";
        case "delete_note":
            return "Note deletion";
        case "update_card":
            return "Card update";
        case "save_media":
            return "Media upload";
        case "import_collection":
            return "Collection import (overwrites cloud snapshot)";
        default:
            return entry.msg.type;
    }
}

export const SyncModal: React.FC<Props> = ({
    syncStatus,
    pendingOutboxCount = 0,
    conflictedOps = [],
    onRetryConflict,
    onDiscardConflict,
    onForceSync,
    onClearOfflineData,
    onDeleteAccountData,
    onClose,
    onShowInstallGuide,
}) => {
    const { userId, getToken } = useAuth();
    const dialogRef = useAccessibleModal<HTMLDivElement>(true, onClose);
    const [busyConflict, setBusyConflict] = useState<string | null>(null);
    const [conflictError, setConflictError] = useState<string | null>(null);
    const resolveConflict = async (opId: string, action?: (id: string) => Promise<void>) => {
        setBusyConflict(opId);
        setConflictError(null);
        try {
            await action?.(opId);
        } catch (error) {
            setConflictError(
                error instanceof Error ? error.message : "Could not resolve this change. Please try again.",
            );
        } finally {
            setBusyConflict(null);
        }
    };
    const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredTheme());
    const [clearOnSignOut, setClearOnSignOut] = useState<boolean>(() => getClearDataOnSignOutPreference());
    const [pushSupported, setPushSupported] = useState(false);
    const [permission, setPermission] = useState<NotificationPermission>("default");
    const [hasSubscription, setHasSubscription] = useState(false);
    const [isPushLoading, setIsPushLoading] = useState(false);
    const [pushFeedback, setPushFeedback] = useState<
        {
            type: "success" | "error" | "info";
            msg: string;
        } | null
    >(null);
    const [standalone, setStandalone] = useState(false);
    const [canPrompt, setCanPrompt] = useState(false);
    const [pushStatus, setPushStatus] = useState<PushStatusResponse | null>(null);
    const [confirmWipe, setConfirmWipe] = useState<boolean>(false);
    const [isDeletingCloud, setIsDeletingCloud] = useState<boolean>(false);
    const [confirmClearCache, setConfirmClearCache] = useState<boolean>(false);

    const refreshServerPushStatus = async () => {
        const status = await getPushStatus(getToken);
        if (status) {
            setPushStatus(status);
        }
    };

    useEffect(() => {
        const supported = isPushSupported();
        setPushSupported(supported);
        setStandalone(isStandalone());
        setCanPrompt(canInstallPrompt());
        setThemeMode(getStoredTheme());
        setClearOnSignOut(getClearDataOnSignOutPreference());

        if (supported) {
            setPermission(getNotificationPermission());
            getCurrentPushSubscription(userId || undefined).then(sub => {
                setHasSubscription(!!sub);
            });
            refreshServerPushStatus();
        }
    }, [userId]);

    const handleThemeChange = (newTheme: ThemeMode) => {
        setThemeMode(newTheme);
        setStoredTheme(newTheme);
    };

    const handlePrefChange = async (patch: Partial<ClientPushPreferences>) => {
        const res = await updatePushPreferences(patch, getToken);
        if (res) {
            setPushStatus(prev => ({
                ...(prev || { subscriptions: 1, vapidConfigured: true }),
                ...res,
            }));
        }
    };

    const handleTogglePush = async () => {
        setIsPushLoading(true);
        setPushFeedback(null);
        try {
            if (hasSubscription) {
                const res = await unsubscribeFromPush(getToken);
                if (res.success) {
                    setHasSubscription(false);
                    setPushFeedback({ type: "info", msg: "Push notifications disabled on this device." });
                } else {
                    setPushFeedback({ type: "error", msg: res.error || "Failed to unsubscribe." });
                }
            } else {
                const res = await subscribeToPush(userId || undefined, getToken);
                if (res.success) {
                    setHasSubscription(true);
                    setPermission("granted");
                    setPushFeedback({
                        type: "success",
                        msg: "Push notifications enabled! You'll receive due review reminders.",
                    });
                    await refreshServerPushStatus();
                } else {
                    setPushFeedback({ type: "error", msg: res.error || "Failed to enable notifications." });
                    setPermission(getNotificationPermission());
                }
            }
        } catch (err: any) {
            setPushFeedback({ type: "error", msg: err.message || "An error occurred." });
        } finally {
            setIsPushLoading(false);
        }
    };

    const handleSendTest = async () => {
        setIsPushLoading(true);
        setPushFeedback(null);
        try {
            const res = await sendTestPush(getToken);
            if (res.success) {
                setPushFeedback({
                    type: "success",
                    msg: "Test notification sent! Check your notification center.",
                });
            } else {
                setPushFeedback({
                    type: "error",
                    msg: res.error || "Failed to send test notification.",
                });
            }
        } catch (err: any) {
            setPushFeedback({ type: "error", msg: err.message || "Failed to send notification." });
        } finally {
            setIsPushLoading(false);
        }
    };

    const handleNotifyDue = async () => {
        setIsPushLoading(true);
        setPushFeedback(null);
        try {
            const res = await sendNotifyDue(7, getToken);
            if (res.success) {
                setPushFeedback({
                    type: "success",
                    msg: "Triggered due card notification across active devices!",
                });
            } else {
                setPushFeedback({
                    type: "error",
                    msg: res.error || "Failed to trigger notification.",
                });
            }
        } catch (err: any) {
            setPushFeedback({ type: "error", msg: err.message || "Failed to send due reminder." });
        } finally {
            setIsPushLoading(false);
        }
    };

    const handleInstallClick = async () => {
        if (canPrompt) {
            await promptPwaInstall();
            setStandalone(isStandalone());
        } else if (onShowInstallGuide) {
            onShowInstallGuide();
        }
    };

    const isIos = isIosDevice();
    const iosNeedsInstall = isIos && !standalone;
    const totalUnsynced = pendingOutboxCount + conflictedOps.length;

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="sync-modal-title"
                className="modal-content"
                style={{ maxWidth: 460 }}
                onClick={e => e.stopPropagation()}
            >
                <div className="modal-header">
                    <h3 id="sync-modal-title" style={{ fontSize: 16, fontWeight: 600 }}>
                        Settings & Sync
                    </h3>
                    <button
                        type="button"
                        aria-label="Close settings"
                        onClick={onClose}
                        style={{ border: "none", padding: 4, background: "transparent" }}
                    >
                        <X size={18} />
                    </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                    {/* Appearance / Theme Section */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
                            Appearance
                        </span>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                padding: "10px 14px",
                                background: "var(--bg-secondary)",
                                borderRadius: 8,
                                border: "1px solid var(--border-color)",
                                gap: 12,
                                flexWrap: "wrap",
                            }}
                        >
                            <div>
                                <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text-primary)" }}>
                                    Theme
                                </div>
                                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                                    {themeMode === "system"
                                        ? "Matching device system theme."
                                        : `Active: ${themeMode.charAt(0).toUpperCase() + themeMode.slice(1)} mode.`}
                                </div>
                            </div>

                            <div className="theme-selector">
                                <button
                                    type="button"
                                    className={`theme-option ${themeMode === "system" ? "active" : ""}`}
                                    onClick={() => handleThemeChange("system")}
                                    title="Follow device theme"
                                >
                                    <Monitor size={14} />
                                    <span>System</span>
                                </button>
                                <button
                                    type="button"
                                    className={`theme-option ${themeMode === "light" ? "active" : ""}`}
                                    onClick={() => handleThemeChange("light")}
                                    title="Light theme"
                                >
                                    <Sun size={14} />
                                    <span>Light</span>
                                </button>
                                <button
                                    type="button"
                                    className={`theme-option ${themeMode === "dark" ? "active" : ""}`}
                                    onClick={() => handleThemeChange("dark")}
                                    title="Dark theme"
                                >
                                    <Moon size={14} />
                                    <span>Dark</span>
                                </button>
                            </div>
                        </div>
                    </div>

                    <hr style={{ border: "none", borderTop: "1px solid var(--border-color)", margin: "2px 0" }} />

                    {/* Real-time Sync Section */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
                            Cloud & Multi-Device Sync
                        </span>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                padding: "12px 14px",
                                background: "var(--bg-secondary)",
                                borderRadius: 8,
                                border: "1px solid var(--border-color)",
                            }}
                        >
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span className={`sync-status ${syncStatus}`} />
                                <div role="status" aria-live="polite">
                                    <div style={{ fontSize: 14, fontWeight: 500, textTransform: "capitalize" }}>
                                        {syncStatus === "connected" ? "Real-time Connected" : syncStatus}
                                    </div>
                                    {pendingOutboxCount > 0 && (
                                        <div style={{ fontSize: 11.5, color: "var(--color-learn)" }}>
                                            {pendingOutboxCount} offline{" "}
                                            {pendingOutboxCount === 1 ? "change" : "changes"} queued
                                        </div>
                                    )}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={onForceSync}
                                style={{ padding: "4px 10px", fontSize: 13 }}
                            >
                                <RefreshCw size={13} className={syncStatus === "connecting" ? "spin" : ""} />
                                <span>Sync Now</span>
                            </button>
                        </div>
                        <div
                            style={{
                                display: "flex",
                                gap: 8,
                                alignItems: "center",
                                color: "var(--text-secondary)",
                                fontSize: 12.5,
                                padding: "2px 4px",
                            }}
                        >
                            <Laptop size={15} />
                            <span>↔</span>
                            <Smartphone size={15} />
                            <span>Isolated per-user real-time sync across devices</span>
                        </div>

                        {/* Conflicted operations queue (D13): rejected ops are parked for retry/discard */}
                        {conflictedOps.length > 0 && (
                            <div
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 8,
                                    padding: "12px 14px",
                                    background: "rgba(217, 119, 6, 0.08)",
                                    border: "1px solid rgba(217, 119, 6, 0.35)",
                                    borderRadius: 8,
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <AlertCircle size={14} color="var(--color-again)" />
                                    <span style={{ fontSize: 13, fontWeight: 500 }}>
                                        {conflictedOps.length} conflicted{" "}
                                        {conflictedOps.length === 1 ? "change" : "changes"} awaiting your decision
                                    </span>
                                </div>
                                {conflictedOps.map(entry => (
                                    <div
                                        key={entry.opId}
                                        style={{
                                            display: "flex",
                                            alignItems: "flex-start",
                                            gap: 8,
                                            justifyContent: "space-between",
                                            flexWrap: "wrap",
                                            fontSize: 12.5,
                                        }}
                                    >
                                        <div style={{ flex: 1, minWidth: 160 }}>
                                            <div style={{ fontWeight: 500 }}>{describeConflictedOp(entry)}</div>
                                            <div style={{ color: "var(--color-again)" }}>
                                                {entry.error || "Rejected by the server."}
                                            </div>
                                        </div>
                                        <div style={{ display: "flex", gap: 6 }}>
                                            <button
                                                type="button"
                                                disabled={busyConflict !== null}
                                                onClick={() => void resolveConflict(entry.opId, onRetryConflict)}
                                                style={{ fontSize: 12, padding: "4px 8px" }}
                                                title="Send this change to the server again"
                                            >
                                                <Undo2 size={11} className="inline" />{" "}
                                                {entry.msg.type === "import_collection" ? "Force Overwrite" : "Retry"}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={busyConflict !== null}
                                                onClick={() => void resolveConflict(entry.opId, onDiscardConflict)}
                                                style={{ fontSize: 12, padding: "4px 8px" }}
                                                title="Discard this change (server state stays authoritative)"
                                            >
                                                <XCircle size={11} /> Discard
                                            </button>
                                        </div>
                                    </div>
                                ))}
                                {conflictError && <div role="alert">{conflictError}</div>}
                            </div>
                        )}
                    </div>

                    <hr style={{ border: "none", borderTop: "1px solid var(--border-color)", margin: "2px 0" }} />

                    {/* Web Push Notifications Section */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
                                Push Notifications
                            </span>
                            {hasSubscription
                                ? (
                                    <span
                                        style={{
                                            fontSize: 12,
                                            color: "var(--color-good)",
                                            fontWeight: 500,
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 4,
                                        }}
                                    >
                                        <CheckCircle size={13} /> Active
                                    </span>
                                )
                                : permission === "denied"
                                ? (
                                    <span
                                        style={{
                                            fontSize: 12,
                                            color: "var(--color-again)",
                                            fontWeight: 500,
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 4,
                                        }}
                                    >
                                        <AlertCircle size={13} /> Blocked
                                    </span>
                                )
                                : (
                                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                                        Disabled
                                    </span>
                                )}
                        </div>

                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 12,
                                padding: "12px 14px",
                                background: "var(--bg-secondary)",
                                borderRadius: 8,
                                border: "1px solid var(--border-color)",
                            }}
                        >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <div>
                                    <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text-primary)" }}>
                                        Daily Review & Due Reminders
                                    </div>
                                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                                        Spaced repetition reminders delivered even when app is closed.
                                    </div>
                                </div>

                                <button
                                    type="button"
                                    className={hasSubscription ? "" : "primary"}
                                    onClick={handleTogglePush}
                                    disabled={isPushLoading || (!pushSupported && !iosNeedsInstall)}
                                    style={{ padding: "5px 12px", fontSize: 12.5, whiteSpace: "nowrap" }}
                                >
                                    {hasSubscription
                                        ? (
                                            <>
                                                <BellOff size={13} />
                                                <span>Disable</span>
                                            </>
                                        )
                                        : (
                                            <>
                                                <Bell size={13} />
                                                <span>Enable</span>
                                            </>
                                        )}
                                </button>
                            </div>

                            {iosNeedsInstall && (
                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "flex-start",
                                        gap: 8,
                                        background: "rgba(2, 132, 199, 0.08)",
                                        border: "1px solid rgba(2, 132, 199, 0.2)",
                                        borderRadius: 6,
                                        padding: "8px 10px",
                                        fontSize: 12,
                                        color: "var(--text-primary)",
                                    }}
                                >
                                    <Info size={15} color="var(--color-new)" style={{ flexShrink: 0, marginTop: 1 }} />
                                    <div>
                                        <strong>iOS requirement:</strong>{" "}
                                        Apple Web Push requires adding klanki to your Home Screen before notifications
                                        can be enabled.
                                    </div>
                                </div>
                            )}

                            {permission === "denied" && (
                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "flex-start",
                                        gap: 8,
                                        background: "rgba(220, 38, 38, 0.08)",
                                        border: "1px solid rgba(220, 38, 38, 0.2)",
                                        borderRadius: 6,
                                        padding: "8px 10px",
                                        fontSize: 12,
                                        color: "var(--text-primary)",
                                    }}
                                >
                                    <AlertCircle
                                        size={15}
                                        color="var(--color-again)"
                                        style={{ flexShrink: 0, marginTop: 1 }}
                                    />
                                    <div>
                                        Notifications are blocked in your browser or OS settings. Please reset site
                                        permissions to enable.
                                    </div>
                                </div>
                            )}

                            {hasSubscription && (
                                <div
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 10,
                                        paddingTop: 6,
                                        borderTop: "1px solid var(--border-color)",
                                    }}
                                >
                                    <div
                                        style={{
                                            display: "flex",
                                            justifyContent: "space-between",
                                            alignItems: "center",
                                            gap: 8,
                                            flexWrap: "wrap",
                                        }}
                                    >
                                        <label
                                            htmlFor="push-pref-daily-mode"
                                            style={{ fontSize: 12.5, color: "var(--text-secondary)" }}
                                        >
                                            Reminder Schedule
                                        </label>
                                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                            <select
                                                id="push-pref-daily-mode"
                                                value={pushStatus?.preferences?.dailyMode || "adaptive"}
                                                onChange={e =>
                                                    handlePrefChange({
                                                        dailyMode: e.target.value as "adaptive" | "fixed",
                                                    })}
                                                style={{ padding: "4px 8px", fontSize: 12.5 }}
                                            >
                                                <option value="adaptive">
                                                    Smart ({String(pushStatus?.dueSummary?.adaptiveHour ?? 9).padStart(
                                                        2,
                                                        "0",
                                                    )}:00 habit)
                                                </option>
                                                <option value="fixed">Custom Time</option>
                                            </select>

                                            {pushStatus?.preferences?.dailyMode === "fixed" && (
                                                <input
                                                    id="push-pref-daily-time"
                                                    aria-label="Daily reminder time"
                                                    type="time"
                                                    value={pushStatus?.preferences?.dailyTime || "09:00"}
                                                    onChange={e => handlePrefChange({ dailyTime: e.target.value })}
                                                    style={{ padding: "3px 8px", fontSize: 12.5 }}
                                                />
                                            )}
                                        </div>
                                    </div>

                                    <label
                                        htmlFor="push-pref-learning-alerts"
                                        style={{
                                            display: "flex",
                                            justifyContent: "space-between",
                                            alignItems: "center",
                                            fontSize: 12.5,
                                            color: "var(--text-secondary)",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <span>Notify when short-term learning steps finish</span>
                                        <input
                                            id="push-pref-learning-alerts"
                                            type="checkbox"
                                            checked={pushStatus?.preferences?.learningAlerts !== false}
                                            onChange={e => handlePrefChange({ learningAlerts: e.target.checked })}
                                        />
                                    </label>

                                    {/* SEC-10: Lock-screen notification privacy preference (default off) */}
                                    <label
                                        htmlFor="push-pref-include-deck-name"
                                        style={{
                                            display: "flex",
                                            justifyContent: "space-between",
                                            alignItems: "center",
                                            fontSize: 12.5,
                                            color: "var(--text-secondary)",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <span>
                                            Include deck names in notifications (disable for lock-screen privacy)
                                        </span>
                                        <input
                                            id="push-pref-include-deck-name"
                                            type="checkbox"
                                            checked={Boolean(pushStatus?.preferences?.includeDeckName)}
                                            onChange={e => handlePrefChange({ includeDeckName: e.target.checked })}
                                        />
                                    </label>

                                    {pushStatus?.nextAlarmAt && (
                                        <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                                            Next check scheduled: {new Date(pushStatus.nextAlarmAt).toLocaleString()}
                                        </div>
                                    )}

                                    <div style={{ display: "flex", gap: 8, paddingTop: 2, flexWrap: "wrap" }}>
                                        <button
                                            type="button"
                                            onClick={handleSendTest}
                                            disabled={isPushLoading}
                                            style={{ fontSize: 12, padding: "4px 10px" }}
                                        >
                                            <Send size={12} />
                                            <span>Send Test Notification</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleNotifyDue}
                                            disabled={isPushLoading}
                                            style={{ fontSize: 12, padding: "4px 10px" }}
                                        >
                                            <Bell size={12} />
                                            <span>Simulate Due Reminder</span>
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {pushFeedback && (
                            <div
                                role={pushFeedback.type === "error" ? "alert" : "status"}
                                aria-live="polite"
                                style={{
                                    fontSize: 12.5,
                                    padding: "8px 12px",
                                    borderRadius: 6,
                                    backgroundColor: pushFeedback.type === "success"
                                        ? "rgba(22, 163, 74, 0.1)"
                                        : pushFeedback.type === "error"
                                        ? "rgba(220, 38, 38, 0.1)"
                                        : "var(--bg-secondary)",
                                    color: pushFeedback.type === "success"
                                        ? "var(--color-good)"
                                        : pushFeedback.type === "error"
                                        ? "var(--color-again)"
                                        : "var(--text-primary)",
                                    border: `1px solid ${
                                        pushFeedback.type === "success"
                                            ? "var(--color-good)"
                                            : pushFeedback.type === "error"
                                            ? "var(--color-again)"
                                            : "var(--border-color)"
                                    }`,
                                }}
                            >
                                {pushFeedback.msg}
                            </div>
                        )}
                    </div>

                    <hr style={{ border: "none", borderTop: "1px solid var(--border-color)", margin: "2px 0" }} />

                    {/* Progressive Web App & Storage Management (SEC-04, DATA-04, DATA-05) */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
                            App & Data Management
                        </span>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                padding: "10px 14px",
                                background: "var(--bg-secondary)",
                                borderRadius: 8,
                                border: "1px solid var(--border-color)",
                            }}
                        >
                            <div>
                                <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text-primary)" }}>
                                    {standalone ? "Installed PWA" : "Running in Web Browser"}
                                </div>
                                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                                    {standalone
                                        ? "Running in standalone window with offline support."
                                        : "Install as a native desktop or mobile app."}
                                </div>
                            </div>

                            {!standalone && (
                                <button
                                    type="button"
                                    onClick={handleInstallClick}
                                    style={{ padding: "4px 10px", fontSize: 12.5, whiteSpace: "nowrap" }}
                                >
                                    <Download size={13} />
                                    <span>{isIos ? "Instructions" : "Install App"}</span>
                                </button>
                            )}
                        </div>

                        {/* SEC-04: Shared-device sign-out data cleanup preference */}
                        <label
                            htmlFor="pref-clear-on-signout"
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                padding: "8px 12px",
                                background: "var(--bg-secondary)",
                                borderRadius: 8,
                                border: "1px solid var(--border-color)",
                                fontSize: 12.5,
                                color: "var(--text-secondary)",
                                cursor: "pointer",
                            }}
                        >
                            <span>Remove downloaded study data when signing out</span>
                            <input
                                id="pref-clear-on-signout"
                                type="checkbox"
                                checked={clearOnSignOut}
                                onChange={e => {
                                    setClearOnSignOut(e.target.checked);
                                    setClearDataOnSignOutPreference(e.target.checked);
                                }}
                            />
                        </label>

                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingTop: 4 }}>
                            {onClearOfflineData && !confirmClearCache && (
                                <button
                                    type="button"
                                    onClick={async () => {
                                        // DATA-05: Require explicit confirmation if unsynced outbox ops exist
                                        if (totalUnsynced > 0) {
                                            setConfirmClearCache(true);
                                            return;
                                        }
                                        try {
                                            await onClearOfflineData({ forceDiscardPending: false });
                                            setPushFeedback({
                                                type: "info",
                                                msg: "Local offline cache cleared on this device.",
                                            });
                                        } catch (err: any) {
                                            setPushFeedback({
                                                type: "error",
                                                msg: err?.message || "Failed to clear offline cache.",
                                            });
                                        }
                                    }}
                                    style={{ fontSize: 12, padding: "5px 10px" }}
                                >
                                    Clear Offline Cache
                                </button>
                            )}

                            {confirmClearCache && onClearOfflineData && (
                                <div
                                    role="alert"
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 8,
                                        width: "100%",
                                        padding: "10px 12px",
                                        borderRadius: 8,
                                        background: "rgba(217, 119, 6, 0.1)",
                                        border: "1px solid rgba(217, 119, 6, 0.4)",
                                        fontSize: 12.5,
                                    }}
                                >
                                    <div style={{ color: "var(--color-again)", fontWeight: 500 }}>
                                        Warning: You have {totalUnsynced} unsynced offline{" "}
                                        {totalUnsynced === 1 ? "change" : "changes"}. Clearing the offline cache now
                                        will permanently discard those unsynced changes.
                                    </div>
                                    <div
                                        style={{
                                            display: "flex",
                                            gap: 6,
                                            justifyContent: "flex-end",
                                            flexWrap: "wrap",
                                        }}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setConfirmClearCache(false);
                                                onForceSync();
                                            }}
                                            style={{ fontSize: 12, padding: "4px 8px" }}
                                        >
                                            Sync First
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setConfirmClearCache(false)}
                                            style={{ fontSize: 12, padding: "4px 8px" }}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onClick={async () => {
                                                try {
                                                    await onClearOfflineData({ forceDiscardPending: true });
                                                    setConfirmClearCache(false);
                                                    setPushFeedback({
                                                        type: "info",
                                                        msg: "Offline cache and unsynced changes discarded.",
                                                    });
                                                } catch (err: any) {
                                                    setPushFeedback({
                                                        type: "error",
                                                        msg: err?.message || "Failed to clear offline cache.",
                                                    });
                                                }
                                            }}
                                            style={{
                                                fontSize: 12,
                                                padding: "4px 8px",
                                                background: "var(--color-again)",
                                                borderColor: "var(--color-again)",
                                                color: "#fff",
                                            }}
                                        >
                                            Discard Unsynced & Clear
                                        </button>
                                    </div>
                                </div>
                            )}

                            {onDeleteAccountData && !confirmWipe && (
                                <button
                                    type="button"
                                    onClick={() => setConfirmWipe(true)}
                                    style={{ fontSize: 12, padding: "5px 10px", color: "var(--color-again)" }}
                                >
                                    <Trash2 size={12} />
                                    <span>Delete Cloud Data</span>
                                </button>
                            )}

                            {confirmWipe && onDeleteAccountData && (
                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 6,
                                        width: "100%",
                                        paddingTop: 4,
                                    }}
                                >
                                    <span style={{ fontSize: 12, color: "var(--color-again)", flex: 1 }}>
                                        Permanently wipe all cloud decks & history?
                                    </span>
                                    <button
                                        type="button"
                                        disabled={isDeletingCloud}
                                        onClick={() => setConfirmWipe(false)}
                                        style={{ fontSize: 12, padding: "4px 8px" }}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        disabled={isDeletingCloud}
                                        onClick={async () => {
                                            setIsDeletingCloud(true);
                                            setPushFeedback(null);
                                            try {
                                                // DATA-04: Do not claim success or wipe local state if server deletion fails
                                                await onDeleteAccountData();
                                                setConfirmWipe(false);
                                            } catch (err: any) {
                                                setPushFeedback({
                                                    type: "error",
                                                    msg: err?.message || "Failed to delete cloud account data.",
                                                });
                                            } finally {
                                                setIsDeletingCloud(false);
                                            }
                                        }}
                                        style={{
                                            fontSize: 12,
                                            padding: "4px 8px",
                                            background: "var(--color-again)",
                                            borderColor: "var(--color-again)",
                                            color: "#fff",
                                        }}
                                    >
                                        {isDeletingCloud ? "Deleting..." : "Confirm Wipe"}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="modal-footer" style={{ marginTop: 8 }}>
                    <button type="button" onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};
