import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// Long-lived SSE subscription to /api/kiosk/events/stream. Replaces the old
// per-component polling of /api/kiosk/status. Backend emits four event kinds:
//   snapshot — full KioskStatus shape, sent on (re)connect.
//   alarm    — { us } when a fresh "TAS callout placed" lands in the journal.
//   selftest — { us } when a fresh "mapped=selftest" lands.
//   heartbeat — { t } every ~15s; drives the dead-connection watchdog.
//
// The hook owns reconnect logic so the rest of the app can treat the stream
// as "always on" and read connectionState to decide whether the data is
// trustworthy. EventSource's built-in retry uses a fixed delay; we layer
// exponential backoff on top because the kiosk can be on flaky WiFi.

export type ConnectionState = "connecting" | "open" | "down";

export type ComponentStatus = {
  id: string;
  label: string;
  ok: boolean;
  detail: string | null;
};

export type KioskSnapshot = {
  components: ComponentStatus[];
  last_alarm_us: number | null;
  last_selftest_us: number | null;
  cpu_temp_c: number | null;
};

export type KioskFlashEvent = {
  kind: "alarm" | "selftest";
  us: number;
  // Local wall-clock at which we received the event. EdgeGlow uses this
  // (not us) to time the on-screen pulse so a clock-skewed server can't
  // misfire the animation.
  receivedAt: number;
};

// Fast-changing host metrics carried on the SSE heartbeat. Each field is
// independently nullable so a partial read (e.g. /sys/class/thermal absent)
// can still surface the rest. Polled at _HEARTBEAT_PERIOD_S server-side
// (currently 5s) so consumers see the 即時狀態 card tick under the eye.
export type LiveMetrics = {
  cpu_c: number | null;
  load_1: number | null;
  load_5: number | null;
  load_15: number | null;
  mem_used_kb: number | null;
  mem_total_kb: number | null;
  fan_rpm: number | null;
};

export type KioskEvents = {
  connectionState: ConnectionState;
  snapshot: KioskSnapshot | null;
  lastFlash: KioskFlashEvent | null;
  // SoC temperature shortcut — same value as `liveMetrics.cpu_c`. Kept as a
  // top-level field for backwards compatibility with existing EdgeGlow
  // wiring; new consumers should read liveMetrics.
  cpuTempC: number | null;
  liveMetrics: LiveMetrics | null;
};

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_DEADLINE_MS = 35_000;

// One EventSource per app, fanned out via context. If each consumer called
// the connection hook directly they'd each open their own /events/stream,
// multiplying server load and per-client queues with no benefit.
const KioskEventsContext = createContext<KioskEvents | null>(null);

export function KioskEventsProvider({ children }: { children: ReactNode }) {
  const value = useKioskEventsConnection();
  return createElement(KioskEventsContext.Provider, { value }, children);
}

export function useKioskEvents(): KioskEvents {
  const ctx = useContext(KioskEventsContext);
  if (ctx === null) {
    throw new Error("useKioskEvents must be used inside <KioskEventsProvider>");
  }
  return ctx;
}

function useKioskEventsConnection(): KioskEvents {
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [snapshot, setSnapshot] = useState<KioskSnapshot | null>(null);
  const [lastFlash, setLastFlash] = useState<KioskFlashEvent | null>(null);
  const [liveMetrics, setLiveMetrics] = useState<LiveMetrics | null>(null);

  // Refs because the reconnect closure must reference the latest state
  // without triggering re-renders or recreating the effect.
  const esRef = useRef<EventSource | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const lastHeartbeatRef = useRef(Date.now());
  const reconnectTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const closeCurrent = () => {
      esRef.current?.close();
      esRef.current = null;
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = window.setTimeout(connect, delay);
    };

    const connect = () => {
      if (cancelled) return;
      setConnectionState("connecting");
      const es = new EventSource("/api/kiosk/events/stream");
      esRef.current = es;

      es.onopen = () => {
        backoffRef.current = INITIAL_BACKOFF_MS;
        lastHeartbeatRef.current = Date.now();
        setConnectionState("open");
      };
      es.addEventListener("snapshot", (e) => {
        lastHeartbeatRef.current = Date.now();
        try {
          const data = JSON.parse((e as MessageEvent).data) as KioskSnapshot;
          setSnapshot(data);
          // Seed liveMetrics from the snapshot so the cpu-temp glow / 即時狀態
          // card can paint before the first heartbeat tick (load/mem land
          // there too — see backend get_status).
          if (data.cpu_temp_c != null) {
            setLiveMetrics((prev) => ({
              cpu_c: data.cpu_temp_c,
              load_1: prev?.load_1 ?? null,
              load_5: prev?.load_5 ?? null,
              load_15: prev?.load_15 ?? null,
              mem_used_kb: prev?.mem_used_kb ?? null,
              mem_total_kb: prev?.mem_total_kb ?? null,
              fan_rpm: prev?.fan_rpm ?? null,
            }));
          }
        } catch {
          /* drop malformed frame */
        }
      });
      es.addEventListener("alarm", (e) => {
        lastHeartbeatRef.current = Date.now();
        try {
          const { us } = JSON.parse((e as MessageEvent).data) as { us: number };
          setLastFlash({ kind: "alarm", us, receivedAt: Date.now() });
        } catch {
          /* drop */
        }
      });
      es.addEventListener("selftest", (e) => {
        lastHeartbeatRef.current = Date.now();
        try {
          const { us } = JSON.parse((e as MessageEvent).data) as { us: number };
          setLastFlash({ kind: "selftest", us, receivedAt: Date.now() });
        } catch {
          /* drop */
        }
      });
      es.addEventListener("heartbeat", (e) => {
        lastHeartbeatRef.current = Date.now();
        try {
          const data = JSON.parse((e as MessageEvent).data) as {
            t: number;
          } & Partial<LiveMetrics>;
          setLiveMetrics({
            cpu_c: data.cpu_c ?? null,
            load_1: data.load_1 ?? null,
            load_5: data.load_5 ?? null,
            load_15: data.load_15 ?? null,
            mem_used_kb: data.mem_used_kb ?? null,
            mem_total_kb: data.mem_total_kb ?? null,
            fan_rpm: data.fan_rpm ?? null,
          });
        } catch {
          /* drop */
        }
      });
      es.onerror = () => {
        closeCurrent();
        setConnectionState("down");
        scheduleReconnect();
      };
    };

    connect();

    // Watchdog: if the server quietly stops sending heartbeats (NAT timeout,
    // dead TCP) the EventSource won't always fire onerror. Force a reconnect
    // if we've been silent past the deadline.
    const watchdog = window.setInterval(() => {
      if (
        esRef.current !== null &&
        Date.now() - lastHeartbeatRef.current > HEARTBEAT_DEADLINE_MS
      ) {
        closeCurrent();
        setConnectionState("down");
        scheduleReconnect();
      }
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(watchdog);
      window.clearTimeout(reconnectTimerRef.current);
      closeCurrent();
    };
  }, []);

  return {
    connectionState,
    snapshot,
    lastFlash,
    cpuTempC: liveMetrics?.cpu_c ?? null,
    liveMetrics,
  };
}
