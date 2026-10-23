// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { X } from "lucide-react";
import React, { useState } from "react";
import { Deck, DeckConfig } from "../core/types";
import { useAccessibleModal } from "./useAccessibleModal";

interface Props {
    config: DeckConfig;
    deck?: Deck;
    sharedDeckCount?: number;
    onSave: (config: DeckConfig, createSeparateForDeckId?: number) => void;
    onClose: () => void;
}

export const DeckOptionsModal: React.FC<Props> = ({
    config,
    deck,
    sharedDeckCount = 1,
    onSave,
    onClose,
}) => {
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
    // UX-05: When multiple decks share the same preset, allow isolating changes to this deck only
    const [isolatePreset, setIsolatePreset] = useState<boolean>(
        Boolean(deck && deck.id !== 1 && sharedDeckCount > 1),
    );
    const dialogRef = useAccessibleModal<HTMLDivElement>(true, onClose);

    const handleSave = () => {
        const delays = learningSteps
            .split(/\s+/)
            .map(Number)
            .filter(n => !isNaN(n) && n > 0);
        const lapseDelays = relearnSteps
            .split(/\s+/)
            .map(Number)
            .filter(n => !isNaN(n) && n > 0);

        const updated: DeckConfig = {
            ...config,
            new: {
                ...config.new,
                perDay: Math.max(0, newPerDay),
                delays: delays.length > 0 ? delays : [1, 10],
                ints: [Math.max(1, graduatingInt), Math.max(1, easyInt)],
                initialFactor: Math.max(1300, startingEase * 10),
            },
            rev: {
                ...config.rev,
                perDay: Math.max(0, revPerDay),
            },
            lapse: {
                ...config.lapse,
                delays: lapseDelays.length > 0 ? lapseDelays : [10],
                leechFails: Math.max(1, leechThreshold),
                leechAction,
            },
            fsrsEnabled,
            desiredRetention: Math.min(0.97, Math.max(0.7, retention)),
        };

        onSave(updated, isolatePreset && deck ? deck.id : undefined);
        onClose();
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="deck-options-title"
                className="modal-content"
                onClick={e => e.stopPropagation()}
            >
                <div className="modal-header">
                    <h3 id="deck-options-title" style={{ fontSize: 16, fontWeight: 600 }}>
                        Deck Options{deck ? ` — ${deck.name}` : ""}
                    </h3>
                    <button
                        type="button"
                        aria-label="Close dialog"
                        onClick={onClose}
                        style={{ border: "none", padding: 4, background: "transparent" }}
                    >
                        <X size={18} />
                    </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {/* UX-05: Shared preset explanation & per-deck isolation toggle */}
                    {deck && sharedDeckCount > 1 && (
                        <div
                            style={{
                                padding: "10px 12px",
                                borderRadius: 8,
                                background: "var(--bg-secondary)",
                                border: "1px solid var(--border-color)",
                                fontSize: 12.5,
                                display: "flex",
                                flexDirection: "column",
                                gap: 6,
                            }}
                        >
                            <div style={{ color: "var(--text-secondary)" }}>
                                Preset <strong>{config.name}</strong> is currently shared by{" "}
                                <strong>{sharedDeckCount}</strong> decks.
                            </div>
                            <label
                                htmlFor="deck-opt-isolate-preset"
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: 8,
                                    cursor: "pointer",
                                    color: "var(--text-primary)",
                                    fontWeight: 500,
                                }}
                            >
                                <span>Apply changes only to “{deck.name}” (create separate preset)</span>
                                <input
                                    id="deck-opt-isolate-preset"
                                    type="checkbox"
                                    checked={isolatePreset}
                                    onChange={e => setIsolatePreset(e.target.checked)}
                                />
                            </label>
                        </div>
                    )}

                    {/* Daily Limits */}
                    <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
                            Daily Limits
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            <div>
                                <label
                                    htmlFor="deck-opt-new-per-day"
                                    style={{
                                        fontSize: 13,
                                        color: "var(--text-secondary)",
                                        display: "block",
                                        marginBottom: 4,
                                    }}
                                >
                                    New / day
                                </label>
                                <input
                                    id="deck-opt-new-per-day"
                                    type="number"
                                    min={0}
                                    value={newPerDay}
                                    onChange={e => setNewPerDay(Number(e.target.value))}
                                    style={{ width: "100%" }}
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="deck-opt-rev-per-day"
                                    style={{
                                        fontSize: 13,
                                        color: "var(--text-secondary)",
                                        display: "block",
                                        marginBottom: 4,
                                    }}
                                >
                                    Maximum reviews / day
                                </label>
                                <input
                                    id="deck-opt-rev-per-day"
                                    type="number"
                                    min={0}
                                    value={revPerDay}
                                    onChange={e => setRevPerDay(Number(e.target.value))}
                                    style={{ width: "100%" }}
                                />
                            </div>
                        </div>
                    </div>

                    {/* FSRS Scheduler Section (C03) */}
                    <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
                            FSRS Scheduler
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <label
                                htmlFor="deck-opt-fsrs-enabled"
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    fontSize: 13.5,
                                    cursor: "pointer",
                                }}
                            >
                                <span>Enable FSRS (Free Spaced Repetition Scheduler)</span>
                                <input
                                    id="deck-opt-fsrs-enabled"
                                    type="checkbox"
                                    checked={fsrsEnabled}
                                    onChange={e => setFsrsEnabled(e.target.checked)}
                                />
                            </label>
                            {fsrsEnabled && (
                                <div>
                                    <label
                                        htmlFor="deck-opt-retention"
                                        style={{
                                            fontSize: 13,
                                            color: "var(--text-secondary)",
                                            display: "block",
                                            marginBottom: 4,
                                        }}
                                    >
                                        Desired retention (0.70 – 0.97)
                                    </label>
                                    <input
                                        id="deck-opt-retention"
                                        type="number"
                                        step="0.01"
                                        min="0.70"
                                        max="0.97"
                                        value={retention}
                                        onChange={e => setRetention(Number(e.target.value))}
                                        style={{ width: "100%" }}
                                    />
                                </div>
                            )}
                        </div>
                    </div>

                    {/* New Cards */}
                    <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
                            New Cards
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <div>
                                <label
                                    htmlFor="deck-opt-learn-steps"
                                    style={{
                                        fontSize: 13,
                                        color: "var(--text-secondary)",
                                        display: "block",
                                        marginBottom: 4,
                                    }}
                                >
                                    Learning steps (m)
                                </label>
                                <input
                                    id="deck-opt-learn-steps"
                                    type="text"
                                    value={learningSteps}
                                    onChange={e => setLearningSteps(e.target.value)}
                                    style={{ width: "100%" }}
                                />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                                <div>
                                    <label
                                        htmlFor="deck-opt-graduating"
                                        style={{
                                            fontSize: 13,
                                            color: "var(--text-secondary)",
                                            display: "block",
                                            marginBottom: 4,
                                        }}
                                    >
                                        Graduating (d)
                                    </label>
                                    <input
                                        id="deck-opt-graduating"
                                        type="number"
                                        value={graduatingInt}
                                        onChange={e => setGraduatingInt(Number(e.target.value))}
                                        style={{ width: "100%" }}
                                    />
                                </div>
                                <div>
                                    <label
                                        htmlFor="deck-opt-easy-int"
                                        style={{
                                            fontSize: 13,
                                            color: "var(--text-secondary)",
                                            display: "block",
                                            marginBottom: 4,
                                        }}
                                    >
                                        Easy (d)
                                    </label>
                                    <input
                                        id="deck-opt-easy-int"
                                        type="number"
                                        value={easyInt}
                                        onChange={e => setEasyInt(Number(e.target.value))}
                                        style={{ width: "100%" }}
                                    />
                                </div>
                            </div>
                            <div>
                                <label
                                    htmlFor="deck-opt-starting-ease"
                                    style={{
                                        fontSize: 13,
                                        color: "var(--text-secondary)",
                                        display: "block",
                                        marginBottom: 4,
                                    }}
                                >
                                    Starting ease (%)
                                </label>
                                <input
                                    id="deck-opt-starting-ease"
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
                            Lapses
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <div>
                                <label
                                    htmlFor="deck-opt-relearn-steps"
                                    style={{
                                        fontSize: 13,
                                        color: "var(--text-secondary)",
                                        display: "block",
                                        marginBottom: 4,
                                    }}
                                >
                                    Relearning steps (m)
                                </label>
                                <input
                                    id="deck-opt-relearn-steps"
                                    type="text"
                                    value={relearnSteps}
                                    onChange={e => setRelearnSteps(e.target.value)}
                                    style={{ width: "100%" }}
                                />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                                <div>
                                    <label
                                        htmlFor="deck-opt-leech-threshold"
                                        style={{
                                            fontSize: 13,
                                            color: "var(--text-secondary)",
                                            display: "block",
                                            marginBottom: 4,
                                        }}
                                    >
                                        Leech threshold
                                    </label>
                                    <input
                                        id="deck-opt-leech-threshold"
                                        type="number"
                                        value={leechThreshold}
                                        onChange={e => setLeechThreshold(Number(e.target.value))}
                                        style={{ width: "100%" }}
                                    />
                                </div>
                                <div>
                                    <label
                                        htmlFor="deck-opt-leech-action"
                                        style={{
                                            fontSize: 13,
                                            color: "var(--text-secondary)",
                                            display: "block",
                                            marginBottom: 4,
                                        }}
                                    >
                                        Leech action
                                    </label>
                                    <select
                                        id="deck-opt-leech-action"
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
                    <button type="button" onClick={onClose}>
                        Cancel
                    </button>
                    <button type="button" className="primary" onClick={handleSave}>
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
};
