import React, { useState } from "react";
import { SignInButton, SignUpButton, useSignIn } from "@clerk/react";
import {
  Laptop,
  Bell,
  Download,
  RefreshCw,
  ArrowRight,
  LogIn
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
}

const DEMO_CARDS: DemoCard[] = [
  {
    id: 1,
    front: "What is spaced repetition?",
    back: "Reviewing cards right before you forget them so they stay in long-term memory.",
    intervals: { again: "1m", hard: "6m", good: "10m", easy: "4d" }
  },
  {
    id: 2,
    front: "How does klanki sync?",
    back: "Every card you review updates live on your phone and computer at the same time.",
    intervals: { again: "1m", hard: "1d", good: "3d", easy: "7d" }
  },
  {
    id: 3,
    front: "Ready to start your own deck?",
    back: "Sign in to sync your decks, import .apkg files, and get study reminders.",
    isAuthCard: true,
    intervals: { again: "1m", hard: "6m", good: "10m", easy: "4d" }
  }
];

export const LandingPage: React.FC = () => {
  const [cardIndex, setCardIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [learnCount, setLearnCount] = useState(0);
  const [dueCount, setDueCount] = useState(1);
  const { signIn } = useSignIn();

  const currentCard = DEMO_CARDS[cardIndex] || DEMO_CARDS[0];
  const remainingNew = Math.max(1, DEMO_CARDS.length - cardIndex);

  const handleFlip = () => {
    if (!isFlipped) {
      setIsFlipped(true);
    }
  };

  const handleRate = (rating: "again" | "hard" | "good" | "easy") => {
    if (rating === "again") {
      setLearnCount(c => c + 1);
    } else {
      setLearnCount(c => Math.max(0, c - 1));
      setDueCount(c => c + 1);
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
    try {
      if (signIn && typeof (signIn as any).authenticateWithRedirect === "function") {
        await (signIn as any).authenticateWithRedirect({
          strategy: "oauth_google",
          redirectUrl: "/",
          redirectUrlComplete: "/"
        });
      }
    } catch {
      // Fallback handled by SignInButton modal wrapper
    }
  };

  const renderCardBack = (compact?: boolean) => {
    if (!currentCard.isAuthCard) {
      return (
        <div className={`landing-card-back ${compact ? "landing-card-back-phone" : ""} landing-reveal`}>
          {currentCard.back}
        </div>
      );
    }

    return (
      <div
        className={`landing-auth-card-body ${compact ? "compact" : ""} landing-reveal`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`landing-card-back ${compact ? "landing-card-back-phone" : ""}`}>
          {currentCard.back}
        </div>

        <div className="landing-auth-card-actions">
          <SignInButton mode="modal">
            <button
              type="button"
              className="landing-google-btn"
              onClick={handleGoogleSignIn}
            >
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
              <span>Continue with Google</span>
            </button>
          </SignInButton>

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

  const renderControls = (compact?: boolean) =>
    !isFlipped ? (
      <button
        type="button"
        className={`primary landing-show-btn ${compact ? "compact" : ""}`}
        onClick={handleFlip}
      >
        Show Answer
      </button>
    ) : (
      <div className={`rating-bar ${compact ? "landing-rating-compact" : ""}`}>
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
    );

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

      {/* Interactive Desktop Monitor + Mobile Phone Stage */}
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
                    <span className="count-new">{remainingNew}</span>
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
                      {renderCardBack(false)}
                    </>
                  )}
                </div>

                <div className="landing-device-footer">{renderControls(false)}</div>
              </div>
            </div>
            <div className="landing-monitor-neck" />
            <div className="landing-monitor-base" />
          </div>

          {/* Mobile Phone Silhouette */}
          <div className="landing-phone-wrap">
            <div className="landing-phone-bezel">
              <div className="landing-phone-notch" />
              <div className="landing-phone-screen">
                <div className="landing-phone-toast">
                  <Bell size={12} color="var(--color-new)" style={{ flexShrink: 0 }} />
                  <span>{remainingNew + dueCount} cards ready to review</span>
                </div>

                <div className="landing-screen-topbar">
                  <span className="landing-screen-brand">klanki</span>
                  <div className="landing-counts-pill">
                    <span className="count-new">{remainingNew}</span>
                    <span className="count-learn">{learnCount}</span>
                    <span className="count-due">{dueCount}</span>
                  </div>
                </div>

                <div
                  key={`phone-card-${currentCard.id}`}
                  className="landing-flashcard landing-flashcard-phone landing-card-transition"
                  onClick={handleFlip}
                >
                  <div className="landing-card-front landing-card-front-phone">
                    {currentCard.front}
                  </div>
                  {isFlipped && (
                    <>
                      <hr className="card-divider" style={{ margin: "10px 0", width: "100%" }} />
                      {renderCardBack(true)}
                    </>
                  )}
                </div>

                <div className="landing-device-footer">{renderControls(true)}</div>
              </div>
              <div className="landing-phone-homebar" />
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
