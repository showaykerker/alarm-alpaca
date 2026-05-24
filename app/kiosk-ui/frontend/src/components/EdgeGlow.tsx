import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { useKioskEvents, type KioskFlashEvent } from "@/lib/useKioskEvents";

// Edge glow overlay. Two flash sources, last-wins:
//   * alarm    — red, 15s, on a fresh `last_alarm_us` (TAS callout placed).
//   * selftest — green, 5s, on a fresh `last_selftest_us` (test-press
//                button registered without dialling out).
// Thermal state is intentionally NOT on the edge glow — adding amber on top
// of red/green made the three colours read as a severity ramp at a glance,
// which mis-signals what amber actually meant (sustained warning, not
// "between red and green"). Thermal warnings now live solely on the main-
// page 系統資訊 status tile (it turns amber for cpu_temp_c > 65°C via the
// existing tone calculation in Main.tsx).
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

type Flash = { kind: FlashKind; startedAt: number };

function flashFromEvent(ev: KioskFlashEvent | null): Flash | null {
  if (ev === null) return null;
  return { kind: ev.kind, startedAt: ev.receivedAt };
}

export function EdgeGlow() {
  const { lastFlash } = useKioskEvents();
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

  if (flash === null) return null;

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
