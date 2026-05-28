import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useKioskEvents } from "@/lib/useKioskEvents";

const IS_KIOSK = ["localhost", "127.0.0.1", "::1"].includes(
  window.location.hostname,
);

const CONFIG_POLL_MS = 30_000;

export function SleepOverlay() {
  const { connectionState, snapshot, lastFlash } = useKioskEvents();
  const navigate = useNavigate();
  const [sleeping, setSleeping] = useState(false);
  const [waking, setWaking] = useState(false);
  const [time, setTime] = useState(() => new Date());
  const [timeoutMs, setTimeoutMs] = useState(2 * 60_000);
  const [sleepBrightnessPct, setSleepBrightnessPct] = useState(5);

  const savedBrightness = useRef<number | null>(null);
  const idleTimer = useRef(0);
  const sleepStartedAt = useRef(0);

  const connectionStateRef = useRef(connectionState);
  connectionStateRef.current = connectionState;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const timeoutMsRef = useRef(timeoutMs);
  timeoutMsRef.current = timeoutMs;
  const sleepBrightnessPctRef = useRef(sleepBrightnessPct);
  sleepBrightnessPctRef.current = sleepBrightnessPct;

  const fetchConfig = useCallback(async () => {
    try {
      const r = await fetch("/api/kiosk/sleep-config");
      if (r.ok) {
        const data: { timeout_minutes: number; sleep_brightness_pct: number } =
          await r.json();
        setTimeoutMs(data.timeout_minutes * 60_000);
        setSleepBrightnessPct(data.sleep_brightness_pct);
      }
    } catch {
      /* keep last-good */
    }
  }, []);

  useEffect(() => {
    if (!IS_KIOSK) return;
    void fetchConfig();
    const id = window.setInterval(() => void fetchConfig(), CONFIG_POLL_MS);
    return () => window.clearInterval(id);
  }, [fetchConfig]);

  const isHealthy = (): boolean => {
    if (connectionStateRef.current !== "open") return false;
    const s = snapshotRef.current;
    if (!s) return false;
    return s.components.every((c) => c.ok);
  };

  const enterSleep = useCallback(async () => {
    try {
      const r = await fetch("/api/kiosk/brightness");
      if (r.ok) {
        const data = await r.json();
        if (data.present) savedBrightness.current = data.value;
      }
    } catch {
      /* continue */
    }
    try {
      await fetch("/api/kiosk/brightness", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ percent: sleepBrightnessPctRef.current }),
      });
    } catch {
      /* best-effort */
    }
    sleepStartedAt.current = Date.now();
    setSleeping(true);
  }, []);

  const wake = useCallback(async () => {
    if (waking) return;
    setWaking(true);
    const v = savedBrightness.current;
    savedBrightness.current = null;
    if (v !== null) {
      try {
        await fetch("/api/kiosk/brightness", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: v }),
        });
      } catch {
        /* best-effort */
      }
    }
    void fetchConfig();
    navigate("/", { replace: true });
    setTimeout(() => {
      setSleeping(false);
      setWaking(false);
    }, 400);
  }, [fetchConfig, waking]);

  const enterSleepRef = useRef(enterSleep);
  enterSleepRef.current = enterSleep;
  const wakeRef = useRef(wake);
  wakeRef.current = wake;

  useEffect(() => {
    if (!IS_KIOSK || sleeping) return;

    const startTimer = () => {
      window.clearTimeout(idleTimer.current);
      const ms = timeoutMsRef.current;
      if (ms <= 0) return;
      idleTimer.current = window.setTimeout(() => {
        if (isHealthy()) {
          void enterSleepRef.current();
        } else {
          startTimer();
        }
      }, ms);
    };

    const onActivity = () => startTimer();
    // On-device kiosk (the only context where IS_KIOSK is true and this
    // effect runs) has a touchscreen + occasional USB-keyboard repair
    // session. The `cursor-park.service` in app/kiosk-display.nix calls
    // `ydotool mousemove --absolute -- 9999 9999` every 3 seconds to keep
    // the wayland cursor hidden in the corner — that synthesised event
    // surfaces in chromium as a `mousemove` on `document`, which would
    // reset this idle timer every 3s and prevent sleep mode from ever
    // triggering. `mousedown` would have the same problem if cursor-park
    // ever clicked; keep `keydown` for the keyboard-repair case.
    // touchstart/touchmove are sourced from the Goodix panel via wayland
    // and aren't synthesised by anything on the system.
    const events = ["touchstart", "touchmove", "keydown"];
    events.forEach((e) =>
      document.addEventListener(e, onActivity, { passive: true }),
    );
    startTimer();

    return () => {
      events.forEach((e) => document.removeEventListener(e, onActivity));
      window.clearTimeout(idleTimer.current);
    };
  }, [sleeping, timeoutMs]);

  const allOk = snapshot?.components.every((c) => c.ok) ?? true;
  useEffect(() => {
    if (!sleeping) return;
    if (connectionState === "down" || !allOk) {
      void wakeRef.current();
    }
  }, [sleeping, connectionState, allOk]);

  useEffect(() => {
    if (!sleeping || !lastFlash) return;
    if (lastFlash.receivedAt > sleepStartedAt.current) {
      void wakeRef.current();
    }
  }, [sleeping, lastFlash]);

  useEffect(() => {
    if (!sleeping) return;
    setTime(new Date());
    const id = window.setInterval(() => setTime(new Date()), 1_000);
    return () => window.clearInterval(id);
  }, [sleeping]);

  if (!sleeping && !waking) return null;

  const h = time.getHours().toString().padStart(2, "0");
  const m = time.getMinutes().toString().padStart(2, "0");

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center ${waking ? "opacity-0" : "bg-black"}`}
      onTouchStart={(e) => {
        e.stopPropagation();
        void wakeRef.current();
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        void wakeRef.current();
      }}
    >
      {!waking && (
        <div className="relative flex items-center justify-center">
          <div className="absolute w-44 h-44 rounded-full sleep-breathe-ring" />
          <div className="relative text-6xl font-mono tabular-nums text-blue-200/70 tracking-widest">
            {h}:{m}
          </div>
        </div>
      )}
    </div>
  );
}
