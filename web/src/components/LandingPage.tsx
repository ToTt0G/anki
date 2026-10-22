import React, { useState } from "react";
import { SignIn, SignInButton, SignUpButton } from "@clerk/react";
import {
  Laptop,
  Smartphone,
  Bell,
  Download,
  RefreshCw,
  ArrowRight,
  RotateCcw,
  Check
} from "lucide-react";

interface DemoCard {
  id: number;
  tag: string;
  front: string;
  back: string;
  highlight: string;
  intervals: {
    again: string;
    hard: string;
    good: string;
    easy: string;
  };
  stabilityDays: {
    again: number;
    hard: number;
    good: number;
    easy: number;
  };
}

const DEMO_CARDS: DemoCard[] = [
  {
    id: 1,
    tag: "sync::realtime",
    front: "Why klanki instead of standard Anki?",
    back: "Everything Anki is — V3 scheduler, Cloze, LaTeX, images, and full .apkg import/export — but your collection syncs live across your phone, computer, and tablet over WebSockets without ever pressing a Sync button.",
    highlight: "Live WebSocket sync across phone & computer",
    intervals: { again: "<1m", hard: "6m", good: "10m", easy: "4d" },
    stabilityDays: { again: 0.4, hard: 1.8, good: 4.5, easy: 12 }
  },
  {
    id: 2,
    tag: "pwa::reminders",
    front: "What happens when you close the browser?",
    back: "Install klanki as a standalone PWA on iOS, Android, macOS, or Windows for offline access and enable native Web Push reminders so your devices nudge you when cards become due.",
    highlight: "Installable PWA + native due-card reminders",
    intervals: { again: "1m", hard: "1d", good: "3d", easy: "7d" },
    stabilityDays: { again: 0.6, hard: 2.5, good: 7, easy: 16 }
  },
  {
    id: 3,
    tag: "anki::apkg",
    front: "Can you bring existing Anki decks and progress?",
    back: "Drop any .apkg collection in or export back out at any time. Card queues, intervals, ease factors, lapses, review logs, and slide deck images transfer with 100% fidelity.",
    highlight: "Bidirectional .apkg with full scheduling history",
    intervals: { again: "10m", hard: "4d", good: "10d", easy: "21d" },
    stabilityDays: { again: 1, hard: 5, good: 14, easy: 28 }
  }
];

export const LandingPage: React.FC = () => {
  const [cardIndex, setCardIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [stability, setStability] = useState(4.5);
  const [lastRating, setLastRating] = useState<{ label: string; ivl: string } | null>(null);
  const [syncPulse, setSyncPulse] = useState(false);
  const [showAuthPanel, setShowAuthPanel] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);

  const currentCard = DEMO_CARDS[cardIndex] || DEMO_CARDS[0];
  const remainingNew = Math.max(0, DEMO_CARDS.length - cardIndex);
  const learnCount = lastRating?.label === "Again" ? 1 : 0;
  const dueCount = reviewedCount;

  const triggerSyncPulse = () => {
    setSyncPulse(true);
    window.setTimeout(() => setSyncPulse(false), 550);
  };

  const handleFlip = () => {
    if (!isFlipped) {
      setIsFlipped(true);
      triggerSyncPulse();
    }
  };

  const handleRate = (
    rating: "again" | "hard" | "good" | "easy",
    label: string
  ) => {
    const nextStability = currentCard.stabilityDays[rating];
    const ivl = currentCard.intervals[rating];
    setStability(nextStability);
    setLastRating({ label, ivl });
    setReviewedCount(c => c + 1);
    triggerSyncPulse();

    if (cardIndex < DEMO_CARDS.length - 1) {
      setCardIndex(i => i + 1);
      setIsFlipped(false);
    } else {
      setCardIndex(0);
      setIsFlipped(false);
    }
  };

  const handleResetDemo = () => {
    setCardIndex(0);
    setIsFlipped(false);
    setStability(4.5);
    setLastRating(null);
    setReviewedCount(0);
    triggerSyncPulse();
  };

  // Generate SVG path for R(t) = exp(-t / S) over t = 0..14 days
  const svgWidth = 360;
  const svgHeight = 84;
  const padX = 8;
  const padY = 10;
  const plotW = svgWidth - padX * 2;
  const plotH = svgHeight - padY * 2;

  const points: string[] = [];
  for (let i = 0; i <= 28; i++) {
    const t = (i / 28) * 14;
    const r = Math.exp(-t / Math.max(0.35, stability));
    const x = padX + (t / 14) * plotW;
    const y = padY + (1 - r) * plotH;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const curvePath = `M ${points.join(" L ")}`;
  const areaPath = `${curvePath} L ${(padX + plotW).toFixed(1)},${(padY + plotH).toFixed(1)} L ${padX},${(padY + plotH).toFixed(1)} Z`;

  return (
    <div className="landing-shell">
      {/* Top Hero Header + Direct Auth Actions */}
      <section className="landing-hero">
        <div className="landing-hero-copy">
          <div className="landing-status-pill">
            <span className={`sync-status ${syncPulse ? "connecting" : ""}`} />
            <span>Anki V3 · Live Multi-Device Sync · PWA + Push Reminders</span>
          </div>

          <h1 className="landing-title">
            Everything Anki is.
            <br />
            <span className="landing-title-accent">Synced live across every device.</span>
          </h1>

          <p className="landing-subtitle">
            Study on your computer, pick up your phone mid-deck, install as a native app,
            and get reminded when cards come due. Full bidirectional <code>.apkg</code> support.
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

            <button
              type="button"
              className="landing-btn-ghost"
              onClick={() => setShowAuthPanel(v => !v)}
            >
              {showAuthPanel ? "Hide Inline Login" : "Inline Login"}
            </button>
          </div>
        </div>

        {/* Optional inline Clerk Sign-In card when toggled */}
        {showAuthPanel && (
          <div className="landing-inline-auth">
            <SignIn routing="hash" />
          </div>
        )}
      </section>

      {/* Interactive Dual-Device Live Sync Stage */}
      <section className="landing-stage" aria-label="Interactive live sync demonstration">
        <div className="landing-stage-topbar">
          <div className="landing-stage-label">
            <RefreshCw size={13} className={syncPulse ? "spin" : ""} />
            <span>
              Interactive Demo — flip &amp; rate a card below to watch desktop and phone sync in real time
            </span>
          </div>

          <div className="landing-stage-meta">
            <span>Card {cardIndex + 1} / {DEMO_CARDS.length}</span>
            {reviewedCount > 0 && (
              <button
                type="button"
                onClick={handleResetDemo}
                className="landing-reset-btn"
                title="Reset demo"
              >
                <RotateCcw size={12} />
                <span>Reset</span>
              </button>
            )}
          </div>
        </div>

        <div className="landing-devices-grid">
          {/* Desktop Viewport Frame */}
          <div className="landing-device-card landing-device-desktop">
            <div className="landing-device-chrome">
              <div className="landing-device-title">
                <Laptop size={14} />
                <span>Desktop · klanki.ezryder.us</span>
              </div>
              <div className="landing-counts-pill">
                <span className="count-new">{remainingNew}</span>
                <span className="count-learn">{learnCount}</span>
                <span className="count-due">{dueCount}</span>
              </div>
            </div>

            <div
              className="landing-flashcard"
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
              <div className="landing-card-tag">{currentCard.tag}</div>
              <div className="landing-card-front">{currentCard.front}</div>

              {isFlipped ? (
                <>
                  <hr className="card-divider" style={{ margin: "14px 0" }} />
                  <div className="landing-card-back">{currentCard.back}</div>
                </>
              ) : (
                <div className="landing-card-prompt">Click card to show answer</div>
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
                    onClick={() => handleRate("again", "Again")}
                  >
                    <span>Again</span>
                    <span>{currentCard.intervals.again}</span>
                  </button>
                  <button
                    type="button"
                    className="btn-rating btn-hard"
                    onClick={() => handleRate("hard", "Hard")}
                  >
                    <span>Hard</span>
                    <span>{currentCard.intervals.hard}</span>
                  </button>
                  <button
                    type="button"
                    className="btn-rating btn-good"
                    onClick={() => handleRate("good", "Good")}
                  >
                    <span>Good</span>
                    <span>{currentCard.intervals.good}</span>
                  </button>
                  <button
                    type="button"
                    className="btn-rating btn-easy"
                    onClick={() => handleRate("easy", "Easy")}
                  >
                    <span>Easy</span>
                    <span>{currentCard.intervals.easy}</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Live WebSocket Bridge Column */}
          <div className={`landing-sync-bridge ${syncPulse ? "pulsing" : ""}`}>
            <div className="landing-bridge-line" />
            <div className="landing-bridge-node">
              <RefreshCw size={14} className={syncPulse ? "spin" : ""} />
              <span>wss://live</span>
              <span className="landing-bridge-latency">
                {lastRating ? `${lastRating.label} → ${lastRating.ivl}` : "0ms delta"}
              </span>
            </div>
            <div className="landing-bridge-line" />
          </div>

          {/* Mobile PWA + Push Reminder Viewport Frame */}
          <div className="landing-device-card landing-device-phone">
            <div className="landing-device-chrome">
              <div className="landing-device-title">
                <Smartphone size={14} />
                <span>Phone PWA · Installed</span>
              </div>
              <div className="landing-counts-pill">
                <span className="count-new">{remainingNew}</span>
                <span className="count-learn">{learnCount}</span>
                <span className="count-due">{dueCount}</span>
              </div>
            </div>

            {/* Simulated Native Push Notification Banner on Phone */}
            <div className="landing-phone-push">
              <div className="landing-phone-push-icon">
                <Bell size={13} />
              </div>
              <div className="landing-phone-push-body">
                <div className="landing-phone-push-title">
                  <span>klanki Reminder</span>
                  <span>now</span>
                </div>
                <div className="landing-phone-push-text">
                  {lastRating
                    ? `Synced "${lastRating.label}" (${lastRating.ivl}) from Desktop`
                    : `${remainingNew} cards ready for review — tap to study`}
                </div>
              </div>
            </div>

            {/* Mirrored Live Card State on Phone */}
            <div className="landing-phone-mirror" onClick={handleFlip}>
              <div className="landing-phone-mirror-header">
                <span>{currentCard.highlight}</span>
                <span className="landing-mirror-badge">
                  <Check size={11} /> Mirrored
                </span>
              </div>
              <div className="landing-phone-mirror-q">{currentCard.front}</div>
              {isFlipped && (
                <div className="landing-phone-mirror-a">{currentCard.back}</div>
              )}
            </div>

            {/* Live Memory Retention Curve SVG */}
            <div className="landing-curve-box">
              <div className="landing-curve-header">
                <span>Memory Retention Curve</span>
                <span>Stability: {stability.toFixed(1)}d</span>
              </div>
              <svg
                viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                className="landing-curve-svg"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id="klankiCurveFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0284c7" stopOpacity="0.26" />
                    <stop offset="100%" stopColor="#0284c7" stopOpacity="0.0" />
                  </linearGradient>
                </defs>
                <line
                  x1={padX}
                  y1={padY + plotH * 0.2}
                  x2={padX + plotW}
                  y2={padY + plotH * 0.2}
                  stroke="var(--border-color)"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
                <path d={areaPath} fill="url(#klankiCurveFill)" />
                <path
                  d={curvePath}
                  fill="none"
                  stroke="var(--color-new)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </div>
        </div>
      </section>

      {/* Minimal 4-Pillar Spec Strip */}
      <section className="landing-spec-strip">
        <div className="landing-spec-item">
          <div className="landing-spec-head">
            <RefreshCw size={14} color="var(--color-new)" />
            <span>Live Multi-Device Sync</span>
          </div>
          <p>
            Reviews, edits, and imports broadcast instantly between your phone and computer via Durable Object WebSockets.
          </p>
        </div>

        <div className="landing-spec-item">
          <div className="landing-spec-head">
            <Download size={14} color="var(--color-due)" />
            <span>Installable Web App</span>
          </div>
          <p>
            Add to your Home Screen or desktop dock as a standalone offline-capable PWA on iOS, Android, macOS, and Windows.
          </p>
        </div>

        <div className="landing-spec-item">
          <div className="landing-spec-head">
            <Bell size={14} color="var(--color-learn)" />
            <span>Study Reminders</span>
          </div>
          <p>
            Standards-based Web Push notifications remind you when cards are due even while the app is closed.
          </p>
        </div>

        <div className="landing-spec-item">
          <div className="landing-spec-head">
            <Laptop size={14} color="var(--text-primary)" />
            <span>100% Anki Compatible</span>
          </div>
          <p>
            Full V3 scheduler, Cloze deletions, LaTeX, slide images, and bidirectional <code>.apkg</code> import &amp; export.
          </p>
        </div>
      </section>
    </div>
  );
};
