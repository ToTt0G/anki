import React, { useState } from "react";
import { SignInButton, SignUpButton } from "@clerk/react";
import {
  Laptop,
  Bell,
  Download,
  RefreshCw,
  ArrowRight
} from "lucide-react";

interface DemoCard {
  id: number;
  front: string;
  back: string;
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
    front: "Do my Anki decks work here?",
    back: "Yes. Import and export .apkg decks with all your cards, images, and progress.",
    intervals: { again: "10m", hard: "4d", good: "10d", easy: "21d" }
  }
];

export const LandingPage: React.FC = () => {
  const [cardIndex, setCardIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [learnCount, setLearnCount] = useState(0);
  const [dueCount, setDueCount] = useState(1);

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
                  <div className="landing-card-front">{currentCard.front}</div>
                  {isFlipped && (
                    <>
                      <hr className="card-divider" style={{ margin: "14px 0" }} />
                      <div className="landing-card-back">{currentCard.back}</div>
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
                {/* Push notification pill */}
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
                  className="landing-flashcard landing-flashcard-phone"
                  onClick={handleFlip}
                >
                  <div className="landing-card-front landing-card-front-phone">
                    {currentCard.front}
                  </div>
                  {isFlipped && (
                    <>
                      <hr className="card-divider" style={{ margin: "10px 0" }} />
                      <div className="landing-card-back landing-card-back-phone">
                        {currentCard.back}
                      </div>
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
