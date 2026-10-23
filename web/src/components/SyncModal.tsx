import React, { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { SyncStatus } from "../core/sync-client";
import {
  X,
  RefreshCw,
  Smartphone,
  Laptop,
  Bell,
  BellOff,
  Send,
  Download,
  CheckCircle,
  AlertCircle,
  Info,
  Sun,
  Moon,
  Monitor,
  Trash2
} from "lucide-react";
import {
  isPushSupported,
  getNotificationPermission,
  getCurrentPushSubscription,
  subscribeToPush,
  unsubscribeFromPush,
  sendTestPush,
  sendNotifyDue,
  getPushStatus,
  updatePushPreferences,
  ClientPushPreferences,
  PushStatusResponse
} from "../core/push-manager";
import {
  isStandalone,
  isIosDevice,
  canInstallPrompt,
  promptPwaInstall
} from "../core/pwa";
import { ThemeMode, getStoredTheme, setStoredTheme } from "../core/theme";

interface Props {
  syncStatus: SyncStatus;
  pendingOutboxCount?: number;
  onForceSync: () => void;
  onClearOfflineData?: () => Promise<void>;
  onDeleteAccountData?: () => Promise<void>;
  onClose: () => void;
  onShowInstallGuide?: () => void;
}

export const SyncModal: React.FC<Props> = ({
  syncStatus,
  pendingOutboxCount = 0,
  onForceSync,
  onClearOfflineData,
  onDeleteAccountData,
  onClose,
  onShowInstallGuide
}) => {
  const { userId, getToken } = useAuth();
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredTheme());
  const [pushSupported, setPushSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [hasSubscription, setHasSubscription] = useState(false);
  const [isPushLoading, setIsPushLoading] = useState(false);
  const [pushFeedback, setPushFeedback] = useState<{
    type: "success" | "error" | "info";
    msg: string;
  } | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushStatusResponse | null>(null);
  const [confirmWipe, setConfirmWipe] = useState<boolean>(false);

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

    if (supported) {
      setPermission(getNotificationPermission());
      getCurrentPushSubscription(userId || undefined).then(sub => {
        setHasSubscription(!!sub);
      });
      refreshServerPushStatus();
    }
  }, [userId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleThemeChange = (newTheme: ThemeMode) => {
    setThemeMode(newTheme);
    setStoredTheme(newTheme);
  };

  const handlePrefChange = async (patch: Partial<ClientPushPreferences>) => {
    const res = await updatePushPreferences(patch, getToken);
    if (res) {
      setPushStatus(prev => ({
        ...(prev || { subscriptions: 1, vapidConfigured: true }),
        ...res
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
            msg: "Push notifications enabled! You'll receive due review reminders."
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
          msg: "Test notification sent! Check your notification center."
        });
      } else {
        setPushFeedback({
          type: "error",
          msg: res.error || "Failed to send test notification."
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
          msg: "Triggered due card notification across active devices!"
        });
      } else {
        setPushFeedback({
          type: "error",
          msg: res.error || "Failed to trigger notification."
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
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
                flexWrap: "wrap"
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
                border: "1px solid var(--border-color)"
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className={`sync-status ${syncStatus}`} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500, textTransform: "capitalize" }}>
                    {syncStatus === "connected" ? "Real-time Connected" : syncStatus}
                  </div>
                  {pendingOutboxCount > 0 && (
                    <div style={{ fontSize: 11.5, color: "var(--color-learn)" }}>
                      {pendingOutboxCount} offline {pendingOutboxCount === 1 ? "change" : "changes"} queued
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
            <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--text-secondary)", fontSize: 12.5, padding: "2px 4px" }}>
              <Laptop size={15} />
              <span>↔</span>
              <Smartphone size={15} />
              <span>Isolated per-user real-time sync across devices</span>
            </div>
          </div>

          <hr style={{ border: "none", borderTop: "1px solid var(--border-color)", margin: "2px 0" }} />

          {/* Web Push Notifications Section */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
                Push Notifications
              </span>
              {hasSubscription ? (
                <span style={{ fontSize: 12, color: "var(--color-good)", fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}>
                  <CheckCircle size={13} /> Active
                </span>
              ) : permission === "denied" ? (
                <span style={{ fontSize: 12, color: "var(--color-again)", fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}>
                  <AlertCircle size={13} /> Blocked
                </span>
              ) : (
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
                border: "1px solid var(--border-color)"
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
                  {hasSubscription ? (
                    <>
                      <BellOff size={13} />
                      <span>Disable</span>
                    </>
                  ) : (
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
                    color: "var(--text-primary)"
                  }}
                >
                  <Info size={15} color="var(--color-new)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <strong>iOS requirement:</strong> Apple Web Push requires adding klanki to your Home Screen before notifications can be enabled.
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
                    color: "var(--text-primary)"
                  }}
                >
                  <AlertCircle size={15} color="var(--color-again)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div>
                    Notifications are blocked in your browser or OS settings. Please reset site permissions to enable.
                  </div>
                </div>
              )}

              {hasSubscription && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 6, borderTop: "1px solid var(--border-color)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>Reminder Schedule</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <select
                        value={pushStatus?.preferences?.dailyMode || "adaptive"}
                        onChange={e =>
                          handlePrefChange({
                            dailyMode: e.target.value as "adaptive" | "fixed"
                          })
                        }
                        style={{ padding: "4px 8px", fontSize: 12.5 }}
                      >
                        <option value="adaptive">
                          Smart ({String(pushStatus?.dueSummary?.adaptiveHour ?? 9).padStart(2, "0")}:00 habit)
                        </option>
                        <option value="fixed">Custom Time</option>
                      </select>

                      {pushStatus?.preferences?.dailyMode === "fixed" && (
                        <input
                          type="time"
                          value={pushStatus?.preferences?.dailyTime || "09:00"}
                          onChange={e => handlePrefChange({ dailyTime: e.target.value })}
                          style={{ padding: "3px 8px", fontSize: 12.5 }}
                        />
                      )}
                    </div>
                  </div>

                  <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, color: "var(--text-secondary)", cursor: "pointer" }}>
                    <span>Notify when short-term learning steps finish</span>
                    <input
                      type="checkbox"
                      checked={pushStatus?.preferences?.learningAlerts !== false}
                      onChange={e => handlePrefChange({ learningAlerts: e.target.checked })}
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
                style={{
                  fontSize: 12.5,
                  padding: "8px 12px",
                  borderRadius: 6,
                  backgroundColor:
                    pushFeedback.type === "success"
                      ? "rgba(22, 163, 74, 0.1)"
                      : pushFeedback.type === "error"
                      ? "rgba(220, 38, 38, 0.1)"
                      : "var(--bg-secondary)",
                  color:
                    pushFeedback.type === "success"
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
                  }`
                }}
              >
                {pushFeedback.msg}
              </div>
            )}
          </div>

          <hr style={{ border: "none", borderTop: "1px solid var(--border-color)", margin: "2px 0" }} />

          {/* Progressive Web App & Storage Management (S07, S10, U07) */}
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
                border: "1px solid var(--border-color)"
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

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingTop: 4 }}>
              {onClearOfflineData && (
                <button
                  type="button"
                  onClick={async () => {
                    await onClearOfflineData();
                    setPushFeedback({
                      type: "info",
                      msg: "Local offline cache cleared on this device."
                    });
                  }}
                  style={{ fontSize: 12, padding: "5px 10px" }}
                >
                  Clear Offline Cache
                </button>
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
                <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", paddingTop: 4 }}>
                  <span style={{ fontSize: 12, color: "var(--color-again)", flex: 1 }}>
                    Permanently wipe all cloud decks & history?
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmWipe(false)}
                    style={{ fontSize: 12, padding: "4px 8px" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await onDeleteAccountData();
                      setConfirmWipe(false);
                    }}
                    style={{
                      fontSize: 12,
                      padding: "4px 8px",
                      background: "var(--color-again)",
                      borderColor: "var(--color-again)",
                      color: "#fff"
                    }}
                  >
                    Confirm Wipe
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
