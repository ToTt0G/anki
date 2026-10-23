// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { RefObject, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
    "button:not([disabled]), [href], input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Accessible modal focus management hook (Section 5 Accessibility — Dialogs):
 * - Traps Tab / Shift+Tab focus within the dialog container
 * - Focuses initialFocusRef or the first interactive control on open
 * - Restores focus to the previously focused element when closed
 * - Handles Escape key to close
 */
export function useAccessibleModal<T extends HTMLElement = HTMLDivElement>(
    isOpen: boolean,
    onClose: () => void,
    initialFocusRef?: RefObject<HTMLElement | null>,
): RefObject<T | null> {
    const dialogRef = useRef<T | null>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        if (!isOpen || typeof document === "undefined") { return; }

        const previousActive = document.activeElement as HTMLElement | null;

        const focusTimer = window.setTimeout(() => {
            if (initialFocusRef?.current) {
                initialFocusRef.current.focus();
                return;
            }
            const container = dialogRef.current;
            if (!container) { return; }
            const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
            if (focusable.length > 0) {
                focusable[0].focus();
            } else {
                container.focus();
            }
        }, 0);

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onCloseRef.current();
                return;
            }

            if (e.key !== "Tab") { return; }
            const container = dialogRef.current;
            if (!container) { return; }
            const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
            if (focusable.length === 0) {
                e.preventDefault();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement as HTMLElement | null;

            if (e.shiftKey) {
                if (!active || active === first || !container.contains(active)) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (!active || active === last || !container.contains(active)) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.clearTimeout(focusTimer);
            window.removeEventListener("keydown", handleKeyDown);
            if (previousActive && typeof previousActive.focus === "function") {
                try {
                    previousActive.focus();
                } catch {
                    // ignore
                }
            }
        };
    }, [isOpen, initialFocusRef]);

    return dialogRef;
}
