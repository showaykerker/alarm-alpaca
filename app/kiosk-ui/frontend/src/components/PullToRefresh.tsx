import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

// Touch pull-to-refresh. The kiosk has no keyboard shortcut for reload
// (cage swallows the chromium menu) and the operator was previously stuck
// either tapping per-page refresh buttons or hard-rebooting the panel for
// stale state. Pulling down from the top fires a full page reload, which
// re-mounts the SSE stream, re-runs initial fetches, and re-paints from
// scratch.
//
// We intercept at window level rather than wrapping each route because:
//   * many pages have their own scroll containers (log, device list) and
//     we want the gesture to work everywhere
//   * the indicator visually lives above the route content, not inside it
//
// Activation rule: touch must start with the page itself scrolled to the
// top (window.scrollY === 0) AND not over an interactive scrollable
// dialog. If the user is scrolled mid-list, dragging down should let them
// keep reading the list rather than reloading.

const THRESHOLD_PX = 100;
// Cap how far the indicator can travel below the top — without this the
// pull distance follows the finger arbitrarily and the spinner feels
// untethered.
const MAX_TRAVEL_PX = 140;
const TRIGGER_PX = THRESHOLD_PX;

export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let startY: number | null = null;
    let lastY = 0;

    const insideScrollable = (target: EventTarget | null): boolean => {
      let el = target as HTMLElement | null;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        const oy = style.overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollTop > 0) {
          return true;
        }
        el = el.parentElement;
      }
      return false;
    };

    const onStart = (e: TouchEvent) => {
      if (refreshing) return;
      if (window.scrollY > 0) return;
      if (insideScrollable(e.target)) return;
      startY = e.touches[0].clientY;
      lastY = startY;
    };

    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      lastY = e.touches[0].clientY;
      const dy = lastY - startY;
      if (dy <= 0) {
        setPull(0);
        return;
      }
      // Rubber-band: pull follows finger linearly until MAX_TRAVEL_PX,
      // then asymptotes (resistance grows so the indicator can't be
      // dragged off-screen).
      const eased =
        dy < MAX_TRAVEL_PX ? dy : MAX_TRAVEL_PX + (dy - MAX_TRAVEL_PX) * 0.25;
      setPull(Math.min(eased, MAX_TRAVEL_PX * 1.2));
    };

    const onEnd = () => {
      if (startY === null) return;
      const triggered = pull >= TRIGGER_PX;
      startY = null;
      if (triggered) {
        setRefreshing(true);
        // Small delay so the spinner is visible long enough to read as
        // "refreshing" rather than "page just blinked".
        window.setTimeout(() => {
          window.location.reload();
        }, 200);
      } else {
        setPull(0);
      }
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [pull, refreshing]);

  if (pull <= 0 && !refreshing) return null;

  const ready = pull >= TRIGGER_PX || refreshing;
  // Visual position: indicator sits at -56px when idle and slides down
  // proportional to the pull, capped at ~24px below the top.
  const translateY = refreshing ? 24 : Math.min(pull - 56, 24);
  const opacity = refreshing ? 1 : Math.min(pull / TRIGGER_PX, 1);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed left-1/2 top-0 z-[70] -translate-x-1/2"
      style={{ transform: `translate(-50%, ${translateY}px)`, opacity }}
    >
      <div
        className={
          "flex h-12 w-12 items-center justify-center rounded-full bg-card shadow-lg ring-1 ring-border " +
          (ready ? "text-emerald-300" : "text-muted-foreground")
        }
      >
        <RefreshCw
          className={`h-6 w-6 ${refreshing ? "animate-spin" : ""}`}
          style={{ transform: refreshing ? undefined : `rotate(${pull * 3}deg)` }}
        />
      </div>
    </div>
  );
}
