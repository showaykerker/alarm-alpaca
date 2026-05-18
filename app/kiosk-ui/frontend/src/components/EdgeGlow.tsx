import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { useKioskEvents, type KioskFlashEvent } from "@/lib/useKioskEvents";

// Edge glow overlay. Two independent flash sources, last-wins:
//   * alarm    — red, 15s, on a fresh `last_alarm_us` (TAS callout placed).
//   * selftest — green, 5s, on a fresh `last_selftest_us` (test-press
//                button registered without dialling out).
// We used to paint an ambient green/orange glow tied to the watchdog state,
// but the dark UI already carries that signal via the main-page status
// tiles, and the constant border colour was visually noisy and
// indistinguishable from the alarm at a glance. The status tiles now own
// "system health"; this component is exclusively the event-flash overlay.
//
// The two kinds animate at different cadences (alarm is fast and urgent,
// selftest is a slow calm breath) so peripheral vision can tell them apart
// without staring at the panel — colour alone fails for red-green
// colour-blind operators and under bright ambient light. A corner badge
// reinforces the distinction with an icon.
//
// pointer-events:none on the overlay so touch input reaches the UI
// underneath; the badge is layered on the same coordinate but is also
// non-interactive.

type FlashKind = "alarm" | "selftest";

const ALARM_WINDOW_MS = 15_000;
const SELFTEST_WINDOW_MS = 5_000;
const ALARM_COLOR = "rgba(239, 68, 68, 0.85)"; // red-500
const SELFTEST_COLOR = "rgba(34, 197, 94, 0.85)"; // green-500
const THERMAL_COLOR = "rgba(234, 179, 8, 0.55)"; // yellow-500, lower alpha — ambient, not urgent
const THERMAL_WARN_C = 50;

type Flash = { kind: FlashKind; startedAt: number };

function flashFromEvent(ev: KioskFlashEvent | null): Flash | null {
  if (ev === null) return null;
  return { kind: ev.kind, startedAt: ev.receivedAt };
}

export function EdgeGlow() {
  const { lastFlash, cpuTempC } = useKioskEvents();
  // Last-wins: a fresh selftest while an alarm is already glowing will
  // briefly overwrite the red with green. That's intentional — the operator
  // pressed a test button, they should see test feedback.
  const [flash, setFlash] = useState<Flash | null>(null);

  useEffect(() => {
    setFlash(flashFromEvent(lastFlash));
  }, [lastFlash]);

  // Clear the flash when its window has elapsed. Using setTimeout (not a
  // per-render comparison) keeps the overlay immune to render-rate jitter.
  useEffect(() => {
    if (flash === null) return;
    const window_ms = flash.kind === "alarm" ? ALARM_WINDOW_MS : SELFTEST_WINDOW_MS;
    const remaining = window_ms - (Date.now() - flash.startedAt);
    if (remaining <= 0) {
      setFlash(null);
      return;
    }
    const id = window.setTimeout(() => setFlash(null), remaining);
    return () => window.clearTimeout(id);
  }, [flash]);

  // Sustained ambient warning when the SoC is running hot. The alarm/
  // selftest flash takes precedence when both apply — operators can fix the
  // alarm first; the thermal cue comes back the instant the flash window
  // ends. THERMAL_WARN_C matches the alarm-doctor warn threshold.
  const isHot = cpuTempC != null && cpuTempC > THERMAL_WARN_C;

  if (flash === null && !isHot) return null;

  if (flash === null) {
    // Ambient thermal-warning glow only.
    return (
      <div
        aria-hidden="true"
        className="edge-glow"
        style={{
          boxShadow: `inset 0 0 60px 12px ${THERMAL_COLOR}, inset 0 0 120px 36px ${THERMAL_COLOR}`,
        }}
        title={`SoC ${cpuTempC?.toFixed(0)}°C`}
      />
    );
  }

  const isAlarm = flash.kind === "alarm";
  const color = isAlarm ? ALARM_COLOR : SELFTEST_COLOR;
  const flashClass = isAlarm ? "edge-glow-flash-alarm" : "edge-glow-flash-selftest";

  return (
    <>
      <div
        aria-hidden="true"
        className={`edge-glow ${flashClass}`}
        style={{
          boxShadow: `inset 0 0 60px 12px ${color}, inset 0 0 120px 36px ${color}`,
        }}
      />
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-none fixed right-4 top-4 z-[61] flex h-14 w-14 items-center justify-center rounded-full shadow-lg ${
          isAlarm ? "bg-red-600" : "bg-emerald-600"
        }`}
      >
        {isAlarm ? (
          <AlertTriangle className="h-7 w-7 text-white" strokeWidth={2.5} />
        ) : (
          <CheckCircle2 className="h-7 w-7 text-white" strokeWidth={2.5} />
        )}
        <span className="sr-only">{isAlarm ? "Alarm active" : "Selftest received"}</span>
      </div>
    </>
  );
}
