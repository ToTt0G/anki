import React, { useState } from "react";
import { DeckConfig } from "../core/types";
import { X } from "lucide-react";

interface Props {
  config: DeckConfig;
  onSave: (config: DeckConfig) => void;
  onClose: () => void;
}

export const DeckOptionsModal: React.FC<Props> = ({ config, onSave, onClose }) => {
  const [newPerDay, setNewPerDay] = useState<number>(config.new.perDay);
  const [revPerDay, setRevPerDay] = useState<number>(config.rev.perDay);
  const [learningSteps, setLearningSteps] = useState<string>(config.new.delays.join(" "));
  const [graduatingInt, setGraduatingInt] = useState<number>(config.new.ints[0] || 1);
  const [easyInt, setEasyInt] = useState<number>(config.new.ints[1] || 4);
  const [startingEase, setStartingEase] = useState<number>(Math.round(config.new.initialFactor / 10));
  const [relearnSteps, setRelearnSteps] = useState<string>(config.lapse.delays.join(" "));
  const [leechThreshold, setLeechThreshold] = useState<number>(config.lapse.leechFails);
  const [leechAction, setLeechAction] = useState<number>(config.lapse.leechAction);
  const [fsrsEnabled, setFsrsEnabled] = useState<boolean>(!!config.fsrsEnabled);
  const [retention, setRetention] = useState<number>(config.desiredRetention || 0.9);

  const handleSave = () => {
    const delays = learningSteps.split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0);
    const lapseDelays = relearnSteps.split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0);

    const updated: DeckConfig = {
      ...config,
      new: {
        ...config.new,
        perDay: newPerDay,
        delays: delays.length > 0 ? delays : [1, 10],
        ints: [graduatingInt, easyInt],
        initialFactor: startingEase * 10
      },
      rev: {
        ...config.rev,
        perDay: revPerDay
      },
      lapse: {
        ...config.lapse,
        delays: lapseDelays.length > 0 ? lapseDelays : [10],
        leechFails: leechThreshold,
        leechAction
      },
      fsrsEnabled,
      desiredRetention: retention
    };

    onSave(updated);
    onClose();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-content">
        <div className="modal-header">
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Deck Options</h3>
          <button onClick={onClose} style={{ border: "none", padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Daily Limits */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
              DAILY LIMITS
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  New / day
                </label>
                <input
                  type="number"
                  value={newPerDay}
                  onChange={e => setNewPerDay(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  Maximum reviews / day
                </label>
                <input
                  type="number"
                  value={revPerDay}
                  onChange={e => setRevPerDay(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </div>
            </div>
          </div>

          {/* New Cards */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
              NEW CARDS
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  Learning steps (m)
                </label>
                <input
                  type="text"
                  value={learningSteps}
                  onChange={e => setLearningSteps(e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                    Graduating (d)
                  </label>
                  <input
                    type="number"
                    value={graduatingInt}
                    onChange={e => setGraduatingInt(Number(e.target.value))}
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                    Easy (d)
                  </label>
                  <input
                    type="number"
                    value={easyInt}
                    onChange={e => setEasyInt(Number(e.target.value))}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>
              <div>
                <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  Starting ease (%)
                </label>
                <input
                  type="number"
                  value={startingEase}
                  onChange={e => setStartingEase(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </div>
            </div>
          </div>

          {/* Lapses */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
              LAPSES
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  Relearning steps (m)
                </label>
                <input
                  type="text"
                  value={relearnSteps}
                  onChange={e => setRelearnSteps(e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                    Leech threshold
                  </label>
                  <input
                    type="number"
                    value={leechThreshold}
                    onChange={e => setLeechThreshold(Number(e.target.value))}
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                    Leech action
                  </label>
                  <select
                    value={leechAction}
                    onChange={e => setLeechAction(Number(e.target.value))}
                    style={{ width: "100%" }}
                  >
                    <option value={0}>Suspend</option>
                    <option value={1}>Tag Only</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
};
