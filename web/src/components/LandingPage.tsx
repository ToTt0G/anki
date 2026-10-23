import React, { useState } from "react";
import { SignInButton, SignUpButton, useClerk } from "@clerk/react";
import {
  Laptop,
  Bell,
  Download,
  RefreshCw,
  ArrowRight,
  LogIn,
  Layers,
  PlusCircle,
  Search,
  BarChart2
} from "lucide-react";

interface DemoCard {
  id: number;
  front: string;
  back: string;
  isAuthCard?: boolean;
  intervals: {
    again: string;
    hard: string;
    good: string;
    easy: string;
  };
  forecastDayOffset: {
    again: number;
    hard: number;
    good: number;
    easy: number;
  };
}

const DEMO_CARDS: DemoCard[] = [
  {
    id: 1,
    front: "What is spaced repetition?",
    back: "Reviewing cards right before you forget them so they stay in long-term memory.",
    intervals: { again: "1m", hard: "6m", good: "1d", easy: "4d" },
    forecastDayOffset: { again: 0, hard: 0, good: 1, easy: 4 }
  },
  {
    id: 2,
    front: "How does klanki sync?",
    back: "Every card you review updates your decks and stats live across all your devices.",
    intervals: { again: "1m", hard: "1d", good: "3d", easy: "6d" },
    forecastDayOffset: { again: 0, hard: 1, good: 3, easy: 6 }
  },
  {
    id: 3,
    front: "Ready to start your own deck?",
    back: "Sign in to sync your decks, import .apkg files, and get study reminders.",
    isAuthCard: true,
    intervals: { again: "1m", hard: "1d", good: "2d", easy: "5d" },
    forecastDayOffset: { again: 0, hard: 1, good: 2, easy: 5 }
  }
];

export const LandingPage: React.FC = () => {
  const [cardIndex, setCardIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [newCount, setNewCount] = useState(3);
  const [learnCount, setLearnCount] = useState(1);
  const [dueCount, setDueCount] = useState(4);

  // Live stats state shown on the iPhone
  const [studiedToday, setStudiedToday] = useState(12);
  const [timeSec, setTimeSec] = useState(118);
  const [ratings, setRatings] = useState({ again: 1, hard: 2, good: 7, easy: 2 });
  const [forecast, setForecast] = useState([4, 6, 3, 5, 2, 4, 3]);
  const [syncPulse, setSyncPulse] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  const clerk = useClerk();

  const currentCard = DEMO_CARDS[cardIndex] || DEMO_CARDS[0];

  const triggerPulse = () => {
    setSyncPulse(true);
    window.setTimeout(() => setSyncPulse(false), 500);
  };

  const handleFlip = () => {
    if (!isFlipped) {
      setIsFlipped(true);
      setTimeSec(t => t + 4);
    }
  };

  const handleRate = (rating: "again" | "hard" | "good" | "easy") => {
    triggerPulse();
    setStudiedToday(s => s + 1);
    setTimeSec(t => t + 7);
    setRatings(prev => ({ ...prev, [rating]: prev[rating] + 1 }));

    const dayIdx = currentCard.forecastDayOffset[rating];
    setForecast(prev => prev.map((val, idx) => (idx === dayIdx ? val + 1 : val)));

    if (rating === "again") {
      setLearnCount(c => c + 1);
    } else {
      setNewCount(c => (c > 0 ? c - 1 : 2));
      setDueCount(c => Math.max(1, c - 1));
    }

    if (cardIndex < DEMO_CARDS.length - 1) {
      setCardIndex(i => i + 1);
    } else {
      setCardIndex(0);
    }
    setIsFlipped(false);
  };

  const handleGoogleSignIn = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsGoogleLoading(true);
    try {
      const clerkInstance = clerk || (typeof window !== "undefined" ? (window as any).Clerk : null);
      if (clerkInstance?.client?.signIn) {
        await clerkInstance.client.signIn.authenticateWithRedirect({
          strategy: "oauth_google",
          redirectUrl: "/sso-callback",
          redirectUrlComplete: "/",
          continueSignUp: true
        });
        return;
      }
      if (clerkInstance?.openSignIn) {
        clerkInstance.openSignIn();
      }
    } catch (err) {
      console.warn("Google OAuth redirect error, falling back to openSignIn:", err);
      try {
        const clerkInstance = clerk || (typeof window !== "undefined" ? (window as any).Clerk : null);
        if (clerkInstance?.openSignIn) {
          clerkInstance.openSignIn();
        }
      } catch (fallbackErr) {
        console.error("Clerk sign in failed:", fallbackErr);
      }
    } finally {
      window.setTimeout(() => setIsGoogleLoading(false), 2500);
    }
  };

  const totalRatings = ratings.again + ratings.hard + ratings.good + ratings.easy;
  const passedRatings = ratings.hard + ratings.good + ratings.easy;
  const retentionRate = Math.round((passedRatings / Math.max(1, totalRatings)) * 100);
  const maxForecast = Math.max(1, ...forecast);
  const formattedTime = `${Math.floor(timeSec / 60)}m ${timeSec % 60}s`;

  const renderCardBack = () => {
    if (!currentCard.isAuthCard) {
      return <div className="landing-card-back landing-reveal">{currentCard.back}</div>;
    }

    return (
      <div className="landing-auth-card-body landing-reveal" onClick={e => e.stopPropagation()}>
        <div className="landing-card-back">{currentCard.back}</div>

        <div className="landing-auth-card-actions">
          <button
            type="button"
            className={`landing-google-btn ${isGoogleLoading ? "loading" : ""}`}
            onClick={handleGoogleSignIn}
            disabled={isGoogleLoading}
          >
            {isGoogleLoading ? (
              <RefreshCw size={14} className="spin" />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
                />
              </svg>
            )}
            <span>{isGoogleLoading ? "Connecting..." : "Continue with Google"}</span>
          </button>

          <div className="landing-auth-card-split">
            <SignUpButton mode="modal">
              <button type="button" className="primary landing-auth-card-btn">
                <span>Sign Up</span>
                <ArrowRight size={13} />
              </button>
            </SignUpButton>

            <SignInButton mode="modal">
              <button type="button" className="landing-auth-card-btn">
                <LogIn size={13} />
                <span>Sign In</span>
              </button>
            </SignInButton>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="landing-shell">
      {/* Hero */}
      <section className="landing-hero">
        <div className="landing-hero-copy">
          <h1 className="landing-title">
            Everything Anki is.
            <br />
            <span className="landing-title-accent">Synced live across every device.</span>
          </h1>

          <p className="landing-subtitle">
            Study on your computer, pick up your phone mid-deck, install as a web app,
            and get reminded when cards are due. Full <code>.apkg</code> import and export.
          </p>

          <div className="landing-cta-row">
            <SignUpButton mode="modal">
              <button className="primary landing-btn-primary">
                <span>Start Studying</span>
                <ArrowRight size={15} />
              </button>
            </SignUpButton>

            <SignInButton mode="modal">
              <button className="landing-btn-secondary">Sign In</button>
            </SignInButton>
          </div>
        </div>
      </section>

      {/* Interactive Desktop Monitor (Study) + Modern iPhone (Live Stats) Stage */}
      <section className="landing-stage" aria-label="Interactive live sync demo">
        <div className="landing-hardware-showcase">
          {/* Desktop Monitor Silhouette */}
          <div className="landing-monitor-wrap">
            <div className="landing-monitor-bezel">
              <div className="landing-monitor-screen">
                <div className="landing-screen-topbar">
                  <span className="landing-screen-brand">klanki</span>
                  <div className="landing-card-dots">
                    {DEMO_CARDS.map((c, idx) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`landing-dot ${idx === cardIndex ? "active" : ""}`}
                        onClick={() => {
                          setCardIndex(idx);
                          setIsFlipped(idx === 2);
                        }}
                        title={`Card ${idx + 1}`}
                      />
                    ))}
                  </div>
                  <div className="landing-counts-pill">
                    <span className="count-new">{newCount}</span>
                    <span className="count-learn">{learnCount}</span>
                    <span className="count-due">{dueCount}</span>
                  </div>
                </div>

                <div
                  key={`desktop-card-${currentCard.id}`}
                  className="landing-flashcard landing-card-transition"
                  onClick={handleFlip}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      handleFlip();
                    }
                  }}
                >
                  <div className="landing-card-front">{currentCard.front}</div>
                  {isFlipped && (
                    <>
                      <hr className="card-divider" style={{ margin: "14px 0", width: "100%" }} />
                      {renderCardBack()}
                    </>
                  )}
                </div>

                <div className="landing-device-footer">
                  {!isFlipped ? (
                    <button
                      type="button"
                      className="primary landing-show-btn"
                      onClick={handleFlip}
                    >
                      Show Answer
                    </button>
                  ) : (
                    <div className="rating-bar">
                      <button
                        type="button"
                        className="btn-rating btn-again"
                        onClick={() => handleRate("again")}
                      >
                        <span>Again</span>
                        <span>{currentCard.intervals.again}</span>
                      </button>
                      <button
                        type="button"
                        className="btn-rating btn-hard"
                        onClick={() => handleRate("hard")}
                      >
                        <span>Hard</span>
                        <span>{currentCard.intervals.hard}</span>
                      </button>
                      <button
                        type="button"
                        className="btn-rating btn-good"
                        onClick={() => handleRate("good")}
                      >
                        <span>Good</span>
                        <span>{currentCard.intervals.good}</span>
                      </button>
                      <button
                        type="button"
                        className="btn-rating btn-easy"
                        onClick={() => handleRate("easy")}
                      >
                        <span>Easy</span>
                        <span>{currentCard.intervals.easy}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="landing-monitor-neck" />
            <div className="landing-monitor-base" />
          </div>

          {/* Modern iPhone 14 Pro Silhouette Showing Live-Synced Stats */}
          <div className="landing-iphone-wrap">
            <div className="landing-iphone-frame">
              <div className="landing-iphone-btn-vol-up" />
              <div className="landing-iphone-btn-vol-down" />
              <div className="landing-iphone-btn-power" />

              <div className="landing-iphone-screen">
                {/* Dynamic Island */}
                <div className="landing-dynamic-island">
                  <div className="landing-island-camera" />
                </div>

                {/* App Header on Phone */}
                <div className="landing-screen-topbar" style={{ marginTop: 2 }}>
                  <span className="landing-screen-brand">klanki</span>
                  <span className={`sync-status ${syncPulse ? "connecting" : ""}`} />
                </div>

                {/* Live Synced Stats Content */}
                <div className="landing-iphone-stats">
                  {/* Default Deck Row */}
                  <div className={`landing-iphone-card ${syncPulse ? "pulse-border" : ""}`}>
                    <div className="landing-iphone-deck-row">
                      <span style={{ fontWeight: 600, fontSize: 12 }}>Default</span>
                      <div className="landing-counts-pill" style={{ background: "transparent", padding: 0 }}>
                        <span className="count-new">{newCount}</span>
                        <span className="count-learn">{learnCount}</span>
                        <span className="count-due">{dueCount}</span>
                      </div>
                    </div>
                  </div>

                  {/* Today Stats Box */}
                  <div className={`landing-iphone-card ${syncPulse ? "pulse-border" : ""}`}>
                    <div className="landing-iphone-section-title">Today</div>
                    <div className="landing-iphone-metrics">
                      <div>
                        <div className="landing-iphone-metric-label">Studied</div>
                        <div className="landing-iphone-metric-val">{studiedToday}</div>
                      </div>
                      <div>
                        <div className="landing-iphone-metric-label">Time</div>
                        <div className="landing-iphone-metric-val">{formattedTime}</div>
                      </div>
                      <div>
                        <div className="landing-iphone-metric-label">Retention</div>
                        <div
                          className="landing-iphone-metric-val"
                          style={{ color: "var(--color-due)" }}
                        >
                          {retentionRate}%
                        </div>
                      </div>
                    </div>

                    <div className="landing-iphone-ratings-row">
                      <span style={{ color: "var(--color-again)" }}>Again: {ratings.again}</span>
                      <span style={{ color: "var(--color-hard)" }}>Hard: {ratings.hard}</span>
                      <span style={{ color: "var(--color-good)" }}>Good: {ratings.good}</span>
                      <span style={{ color: "var(--color-easy)" }}>Easy: {ratings.easy}</span>
                    </div>
                  </div>

                  {/* Due Forecast Mini Chart */}
                  <div className="landing-iphone-card">
                    <div className="landing-iphone-section-title">Due Forecast</div>
                    <div className="landing-iphone-bars">
                      {forecast.map((val, idx) => {
                        const hPct = Math.max(12, Math.round((val / maxForecast) * 100));
                        return (
                          <div key={idx} className="landing-iphone-bar-col">
                            <span className="landing-iphone-bar-num">{val}</span>
                            <div className="landing-iphone-bar-track">
                              <div
                                className="landing-iphone-bar-fill"
                                style={{
                                  height: `${hPct}%`,
                                  background: idx === 0 ? "var(--color-due)" : "var(--color-new)"
                                }}
                              />
                            </div>
                            <span className="landing-iphone-bar-day">
                              {idx === 0 ? "Today" : `+${idx}d`}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Mobile Bottom Nav */}
                <div className="landing-iphone-nav">
                  <div className="landing-iphone-nav-item">
                    <Layers size={13} />
                    <span>Decks</span>
                  </div>
                  <div className="landing-iphone-nav-item">
                    <PlusCircle size={13} />
                    <span>Add</span>
                  </div>
                  <div className="landing-iphone-nav-item">
                    <Search size={13} />
                    <span>Browse</span>
                  </div>
                  <div className="landing-iphone-nav-item active">
                    <BarChart2 size={13} />
                    <span>Stats</span>
                  </div>
                </div>

                {/* iPhone Home Indicator */}
                <div className="landing-iphone-homebar" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 4 Concise Feature Cards */}
      <section className="landing-spec-strip">
        <div className="landing-spec-item">
          <div className="landing-spec-head">
            <RefreshCw size={14} color="var(--color-new)" />
            <span>Live Sync</span>
          </div>
          <p>Your decks and reviews stay in sync across your phone and computer in real time.</p>
        </div>

        <div className="landing-spec-item">
          <div className="landing-spec-head">
            <Download size={14} color="var(--color-due)" />
            <span>Installable App</span>
          </div>
          <p>Install klanki on your phone or computer for fast offline study.</p>
        </div>

        <div className="landing-spec-item">
          <div className="landing-spec-head">
            <Bell size={14} color="var(--color-learn)" />
            <span>Study Reminders</span>
          </div>
          <p>Get notified when your cards are ready so you never miss a day.</p>
        </div>

        <div className="landing-spec-item">
          <div className="landing-spec-head">
            <Laptop size={14} color="var(--text-primary)" />
            <span>Anki Compatible</span>
          </div>
          <p>Import and export <code>.apkg</code> decks with all your progress intact.</p>
        </div>
      </section>
    </div>
  );
};
