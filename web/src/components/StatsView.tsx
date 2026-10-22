import React from "react";
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
  const today = calculateTodayStats(collection);
  const cardStates = calculateCardStateStats(collection);
  const forecast = calculateDueForecast(collection, 14);
  const history = calculateReviewHistory(collection, 30);

  const formatMinutes = (sec: number) => {
    const mins = Math.round(sec / 60);
    return mins > 0 ? `${mins}m` : `${sec}s`;
  };

  const maxDueInForecast = Math.max(1, ...forecast.map(f => f.dueCount));

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Today Recap */}
      <section style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 16 }}>
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
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Retention</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--color-due)" }}>
              {today.retentionRate}%
            </div>
          </div>
        </div>

        {today.totalStudied > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-around",
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
      <section style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Due Forecast</h3>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120, paddingTop: 16 }}>
          {forecast.map(item => {
            const heightPercent = Math.max(8, Math.round((item.dueCount / maxDueInForecast) * 100));
            return (
              <div
                key={item.dayOffset}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4
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
                <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>{item.dateStr}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Card Breakdown */}
      <section style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Card Counts</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, textAlign: "center" }}>
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

      {/* Review History Calendar Grid */}
      <section style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>History (30 Days)</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 6 }}>
          {history.map(day => {
            const opacity = day.count === 0 ? 0.08 : Math.min(1, 0.25 + day.count * 0.15);
            return (
              <div
                key={day.dateStr}
                title={`${day.dateStr}: ${day.count} cards (${formatMinutes(day.timeSec)})`}
                style={{
                  aspectRatio: "1",
                  borderRadius: 4,
                  background: "var(--color-due)",
                  opacity,
                  border: "1px solid var(--border-color)"
                }}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
};
