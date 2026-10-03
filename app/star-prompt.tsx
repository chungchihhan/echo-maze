"use client";

import { useEffect, useState } from "react";
import styles from "./star-prompt.module.css";

const PROMPT_DELAY_MS = 3 * 60 * 1000;
const DISMISS_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_START_KEY = "echo-maze:star-prompt:session-start";
const HIDDEN_UNTIL_KEY = "echo-maze:star-prompt:hidden-until";

function rememberDismissal() {
  try {
    window.localStorage.setItem(HIDDEN_UNTIL_KEY, String(Date.now() + DISMISS_DURATION_MS));
  } catch {
    // Closing the prompt still works when browser storage is unavailable.
  }
}

export function StarPrompt() {
  const [phase, setPhase] = useState<"hidden" | "open" | "closing">("hidden");

  useEffect(() => {
    const now = Date.now();
    let startedAt = now;

    try {
      if (Number(window.localStorage.getItem(HIDDEN_UNTIL_KEY)) > now) return;

      const savedStart = Number(window.sessionStorage.getItem(SESSION_START_KEY));
      if (savedStart > 0 && savedStart <= now) {
        startedAt = savedStart;
      } else {
        window.sessionStorage.setItem(SESSION_START_KEY, String(now));
      }
    } catch {
      // The prompt still works when browser storage is unavailable.
    }

    const timer = window.setTimeout(() => {
      try {
        if (Number(window.localStorage.getItem(HIDDEN_UNTIL_KEY)) > Date.now()) return;
      } catch {
        // Continue without storage when it is unavailable.
      }
      setPhase("open");
    }, Math.max(0, PROMPT_DELAY_MS - (now - startedAt)));

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (phase !== "closing") return;
    const timer = window.setTimeout(() => setPhase("hidden"), 200);
    return () => window.clearTimeout(timer);
  }, [phase]);

  function dismiss() {
    setPhase("closing");
    rememberDismissal();
  }

  if (phase === "hidden") return null;

  return (
    <aside className={`${styles.toast}${phase === "closing" ? ` ${styles.closing}` : ""}`} role="status" aria-label="GitHub star invitation">
      <span className={styles.icon} aria-hidden="true">★</span>
      <div className={styles.content}>
        <strong>Enjoying Echo Maze?</strong>
        <p>A GitHub star helps others find this project.</p>
        <a href="https://github.com/chungchihhan/echo-maze" target="_blank" rel="noopener noreferrer" onClick={dismiss}>
          Star on GitHub <span aria-hidden="true">↗</span>
        </a>
      </div>
      <button className={styles.close} type="button" aria-label="Dismiss GitHub star invitation" onClick={dismiss}>×</button>
    </aside>
  );
}
