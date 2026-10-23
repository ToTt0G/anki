import React, { useMemo } from "react";
import { Collection } from "../core/types";
import {
  calculateTodayStats,
  calculateCardStateStats,
  calculateDueForecast,
  calculateReviewHistory
} from "../core/stats";

interface Props {
  collection: Collection;
}

export const StatsView: React.FC<Props> = ({ collection }) => {
  const today = useMemo(() => calculateTodayStats(collection), [collection]);
  const cardStates = useMemo(() => calculateCardStateStats(collection), [collection]);
  const forecast = useMemo(() => calculateDueForecast(collection, 14), [collection]);
  const history = useMemo(() => calculateReviewHistory(collection, 30), [collection]);

  const formatMinutes = (sec: number) => {
    const mins = Math.round(sec / 60);
    return mins > 0 ? `${mins}m` : `${sec}s`;
  };

  const maxDueInForecast = Math.max(1, ...forecast.map(f => f.dueCount));
  const activeDays30 = history.filter(d => d.count > 0).length;
  const totalReviews30 = history.reduce((sum, d) => sum + d.count, 0);

  return (
    <div style={{ maxWidth: 720, width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 20, boxSizing: "border-box" }}>
      {/* Today Recap */}
      <section style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 16, boxSizing: "border-box", maxWidth: "100%" }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Today</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, textAlign: "center" }}>
          <div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Studied</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{today.totalStudied}</div>
          </div>
          <div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Time</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{formatMinutes(today.totalTimeSec)}</div>
          </div>
          <div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Pass Rate</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--color-due)" }}>
              {today.retentionRate !== null ? `${today.retentionRate}%` : "—"}
            </div>
          </div>
        </div>

        {today.totalStudied > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-around",
              flexWrap: "wrap",
              gap: 8,
              marginTop: 16,
              paddingTop: 12,
              borderTop: "1px solid var(--border-color)",
              fontSize: 13
            }}
          >
            <span style={{ color: "var(--color-again)" }}>Again: {today.againCount}</span>
            <span style={{ color: "var(--color-hard)" }}>Hard: {today.hardCount}</span>
            <span style={{ color: "var(--color-good)" }}>Good: {today.goodCount}</span>
            <span style={{ color: "var(--color-easy)" }}>Easy: {today.easyCount}</span>
          </div>
        )}
      </section>

      {/* Due Forecast */}
      <section style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 16, boxSizing: "border-box", maxWidth: "100%", overflow: "hidden" }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Due Forecast</h3>
        <div style={{ overflowX: "auto", maxWidth: "100%", paddingBottom: 6, WebkitOverflowScrolling: "touch" }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120, paddingTop: 16, minWidth: 340 }}>
            {forecast.map(item => {
              const heightPercent = Math.max(8, Math.round((item.dueCount / maxDueInForecast) * 100));
              return (
                <div
                  key={item.dayOffset}
                  aria-label={`${item.dateStr}: ${item.dueCount} cards due`}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    minWidth: 20
                  }}
                >
                  <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                    {item.dueCount > 0 ? item.dueCount : ""}
                  </div>
                  <div
                    style={{
                      width: "100%",
                      height: `${heightPercent}%`,
                      background: item.dayOffset === 0 ? "var(--color-due)" : "var(--color-new)",
                      borderRadius: 3
                    }}
                  />
                  <div style={{ fontSize: 9, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{item.dateStr}</div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Card Breakdown */}
      <section style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 16, boxSizing: "border-box", maxWidth: "100%" }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Card Counts</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(58px, 1fr))", gap: 8, textAlign: "center" }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Mature</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-due)" }}>{cardStates.matureCount}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Young</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-hard)" }}>{cardStates.youngCount}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Learn</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-learn)" }}>{cardStates.learnCount}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>New</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-new)" }}>{cardStates.newCount}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Suspended</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text-muted)" }}>{cardStates.suspendedCount}</div>
          </div>
        </div>
      </section>

      {/* Accessible Review History Calendar Grid (U11) */}
      <section style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 16, boxSizing: "border-box", maxWidth: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 6 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>History (30 Days)</h3>
          <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
            {activeDays30} / 30 days studied · {totalReviews30} reviews
          </span>
        </div>
        <div
          role="grid"
          aria-label="30-day review history"
          style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 6, maxWidth: "100%" }}
        >
          {history.map(day => {
            const opacity = day.count === 0 ? 0.12 : Math.min(1, 0.28 + day.count * 0.12);
            const label = `${day.dateStr}: ${day.count} reviews (${formatMinutes(day.timeSec)})`;
            return (
              <div
                key={day.dateStr}
                role="gridcell"
                tabIndex={0}
                aria-label={label}
                title={label}
                style={{
                  aspectRatio: "1",
                  borderRadius: 5,
                  background: day.count > 0 ? "rgba(22, 163, 74, 0.18)" : "var(--bg-secondary)",
                  border: `1px solid ${day.count > 0 ? "var(--color-due)" : "var(--border-color)"}`,
                  opacity: day.count > 0 ? Math.max(0.55, opacity) : 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  fontWeight: 600,
                  color: day.count > 0 ? "var(--color-due)" : "var(--text-muted)",
                  fontVariantNumeric: "tabular-nums"
                }}
              >
                {day.count > 0 ? day.count : ""}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
