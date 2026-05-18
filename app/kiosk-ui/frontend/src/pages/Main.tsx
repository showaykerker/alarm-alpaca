import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Info, Settings } from "lucide-react";
import { Link } from "react-router-dom";

import { KioskShell } from "@/components/KioskShell";
import { KioskGrid, NavCard } from "@/components/PageGrid";
import { useKioskEvents } from "@/lib/useKioskEvents";
import { cn } from "@/lib/utils";

// id is optional — kiosks running an older backend (pre-rework) don't
// populate it. We derive the route from the label in that case so the main
// page still navigates correctly during a rolling deploy.
type ComponentStatus = { id?: string; label: string; ok: boolean; detail: string | null };
type KioskStatus = { components: ComponentStatus[] };

// Minimal shapes for the System Info nav-card tone calculation. The full
// types live in pages/System.tsx; we re-declare only the fields used by
// computeSystemTone so this file doesn't need to import every disk/CPU
// detail. Compatible by structural typing.
type NetworkInfoMin = {
  interfaces: { ip: string | null }[];
  mdns: { ok: boolean; hostname: string; resolved_ip: string | null; detail: string | null };
};
type SystemInfoMin = {
  cpu_temp_c: number | null;
  throttled_flags: string[];
  disks: { mountpoint: string; total_bytes: number; used_bytes: number; free_bytes: number }[];
  discord_heartbeat: {
    last_seen_unix: number | null;
    interval_seconds: number | null;
    age_seconds: number | null;
    ok: boolean;
  };
};

const LABEL_TO_ID: Record<string, string> = {
  "緊急通報": "alarm-bridge",
  "Zigbee 接收": "zigbee",
  "MQTT 交換": "mqtt",
  // Legacy label from pre-rework backends: still navigates somewhere
  // reasonable rather than to /service/undefined.
  "網際網路": "mqtt",
};

function serviceId(s: ComponentStatus): string {
  return s.id ?? LABEL_TO_ID[s.label] ?? "alarm-bridge";
}

const STATUS_REFRESH_MS = 5000;

function useInterval(fn: () => void, ms: number) {
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    cb.current();
    const id = window.setInterval(() => cb.current(), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

// Tone helpers (mirrors the heuristics in System.tsx). Inlined rather than
// imported to avoid coupling Main's lightweight polling shapes to the full
// SystemInfo/NetworkInfo types.
type Tone = "ok" | "warn" | "fail";

function diskPct(d: { used_bytes: number; total_bytes: number }): number {
  return d.total_bytes > 0 ? Math.round((d.used_bytes / d.total_bytes) * 100) : 0;
}

function aggregateSystemTone(net: NetworkInfoMin | null, sys: SystemInfoMin | null): Tone {
  const tones: Tone[] = [];

  // Internet: no interface has an IP → fatal. mDNS-only failure → warn.
  if (net) {
    const hasIp = net.interfaces.some((i) => !!i.ip);
    if (!hasIp) tones.push("fail");
    else if (!net.mdns.ok) tones.push("warn");
  }

  // Host: CPU >=80 / throttle flags / root >=95% → fatal. Lighter
  // thresholds → warn. CPU warn threshold (50°C) matches the EdgeGlow
  // thermal overlay so the operator never sees the yellow edge with the
  // 系統資訊 card still showing "一切正常".
  if (sys) {
    if (sys.cpu_temp_c != null && sys.cpu_temp_c >= 80) tones.push("fail");
    else if (sys.throttled_flags.length > 0) tones.push("fail");
    else {
      const root = sys.disks.find((d) => d.mountpoint === "/");
      if (root && diskPct(root) >= 95) tones.push("fail");
      else if (sys.cpu_temp_c != null && sys.cpu_temp_c > 50) tones.push("warn");
      else if (root && diskPct(root) >= 85) tones.push("warn");
    }

    // Discord heartbeat is non-fatal per spec: not-receiving heartbeats means
    // the notification path is degraded but the dial-out path is unaffected.
    const hb = sys.discord_heartbeat;
    if (hb && hb.last_seen_unix == null) tones.push("warn");
    else if (hb && !hb.ok) tones.push("warn");
  }

  if (tones.includes("fail")) return "fail";
  if (tones.includes("warn")) return "warn";
  return "ok";
}

// Status tile: routes to /service/:id when tapped. Whole tile is the touch
// target — keeps the main page legible from across the room (the operator
// reads the label/detail without needing to spot a small button). The
// label/detail typography is one tier above the sub-page NavCard default
// because main is the across-the-room view.
function StatusTile({ s }: { s: ComponentStatus }) {
  const ok = s.ok;
  return (
    <Link
      to={`/service/${serviceId(s)}`}
      className={cn(
        "rounded-2xl border-2 p-5 flex flex-col items-center justify-center gap-3",
        "transition-colors active:scale-[0.98] hover:brightness-110",
        ok
          ? "bg-emerald-900/30 border-emerald-600/70"
          : "bg-rose-900/30 border-rose-600/70",
      )}
    >
      {ok ? (
        <CheckCircle2 className="h-16 w-16 text-emerald-400" strokeWidth={2.5} />
      ) : (
        <AlertTriangle className="h-16 w-16 text-rose-400" strokeWidth={2.5} />
      )}
      <div className="text-3xl font-bold text-center">{s.label}</div>
      {s.detail && (
        <div className={cn("text-lg", ok ? "text-emerald-200" : "text-rose-200")}>
          {s.detail}
        </div>
      )}
    </Link>
  );
}

export default function Main() {
  const [status, setStatus] = useState<KioskStatus | null>(null);
  const [net, setNet] = useState<NetworkInfoMin | null>(null);
  const [sys, setSys] = useState<SystemInfoMin | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/kiosk/status");
      if (r.ok) setStatus(await r.json());
    } catch { /* keep last-good */ }
  }, []);

  // Aux pollers feed the System Info nav-card colour. The endpoints are
  // cheap server-side; we poll on a longer cadence than the main status
  // tiles because uptime / disk / heartbeat don't change every 5 s.
  const fetchAux = useCallback(async () => {
    try {
      const [rn, rs] = await Promise.all([
        fetch("/api/network/info"),
        fetch("/api/system/info"),
      ]);
      if (rn.ok) setNet(await rn.json());
      if (rs.ok) setSys(await rs.json());
    } catch { /* keep last-good */ }
  }, []);

  useInterval(fetchStatus, STATUS_REFRESH_MS);
  useInterval(fetchAux, 15000);

  // CPU temperature comes through the SSE heartbeat (5s) much faster than
  // the 15s /api/system/info poll, so we override the polled value with the
  // live one when available. Keeps the 系統資訊 card and the EdgeGlow
  // thermal overlay in sync — without this you can see the yellow edge
  // glow on while the nav-tile still reads "一切正常".
  const { liveMetrics } = useKioskEvents();
  const fusedSys: SystemInfoMin | null = sys
    ? { ...sys, cpu_temp_c: liveMetrics?.cpu_c ?? sys.cpu_temp_c }
    : null;

  // aggregateSystemTone tolerates nulls — pre-first-fetch shows "ok" tone.
  const systemTone = aggregateSystemTone(net, fusedSys);
  // Prefer a specific cause in the subtitle so the operator knows what to
  // open (thermal vs. disk vs. network) without drilling in. Thermal wins
  // when ≥50°C because the edge-glow already cued it; the other causes
  // only surface when no thermal warning is present.
  const cpuC = fusedSys?.cpu_temp_c ?? null;
  const systemSubtitle = (() => {
    if (cpuC != null && cpuC >= 80) return `🌡 SoC ${cpuC.toFixed(0)}°C`;
    if (systemTone === "fail") return "⚠️ 連線異常";
    if (cpuC != null && cpuC > 50) return `🌡 SoC ${cpuC.toFixed(0)}°C`;
    if (systemTone === "warn") return "需注意";
    return "✓ 一切正常";
  })();

  // Operator-requested layout (2026-05-18): MQTT lives in row 2 alongside
  // the nav tiles; the event-log card moves up into the status row so it
  // sits next to alarm-bridge + zigbee — the three things that move when
  // a button gets pressed. The backend's `components` order is stable
  // ([alarm-bridge, zigbee, mqtt]); we partition rather than reslice so a
  // future component rename can't silently land MQTT in the wrong row.
  const mqttTile = status?.components.find((c) => c.id === "mqtt") ?? null;
  const upperTiles = status?.components.filter((c) => c.id !== "mqtt") ?? [];

  return (
    <KioskShell>
      <KioskGrid>
        {/* Row 1 — alarm-bridge · zigbee · event log. */}
        {status ? (
          upperTiles.map((c) => <StatusTile key={serviceId(c)} s={c} />)
        ) : (
          <>
            <PlaceholderTile />
            <PlaceholderTile />
          </>
        )}
        <NavCard
          to="/log"
          icon={<FileText className="h-16 w-16 text-amber-300" strokeWidth={2.2} />}
          title="事件紀錄"
          subtitle="最近活動"
          size="lg"
        />

        {/* Row 2 — system info · MQTT status · settings. The System card's
            tone reflects aggregate health (internet / host / discord
            heartbeat); fail = red, warn = amber, ok = green so the
            operator gets a positive "all-clear" signal at a glance. */}
        <NavCard
          to="/system"
          icon={
            <Info
              className={cn(
                "h-16 w-16",
                systemTone === "fail" && "text-rose-400",
                systemTone === "warn" && "text-amber-300",
                systemTone === "ok" && "text-emerald-300",
              )}
              strokeWidth={2.2}
            />
          }
          title="系統資訊"
          subtitle={systemSubtitle}
          tone={systemTone}
          size="lg"
        />
        {mqttTile ? <StatusTile s={mqttTile} /> : <PlaceholderTile />}
        <NavCard
          to="/settings"
          icon={<Settings className="h-16 w-16" strokeWidth={2.2} />}
          title="設定"
          // Render the subtitle as item+separator chunks rather than a
          // single string so the `·` divider always glues to the
          // preceding word. When the line wraps, the new line starts
          // with a word (not a stranded dot), which reads as a list
          // continuation instead of a typo.
          subtitle={<SettingsSubtitle />}
          size="lg"
        />
      </KioskGrid>
    </KioskShell>
  );
}

function PlaceholderTile() {
  return (
    <div className="rounded-2xl border-2 border-border bg-card/60 p-5 flex items-center justify-center text-muted-foreground text-xl">
      載入中…
    </div>
  );
}

// Settings nav-card subtitle. Each entry + its trailing dot lives in a
// `whitespace-nowrap` span; the breakable space between spans is the only
// wrap opportunity. Result: when the subtitle wraps to a second line,
// the new line always starts with a word, never with a stranded `·`.
const SETTINGS_ITEMS = ["電話", "網路", "Zigbee", "顯示", "機器"];

function SettingsSubtitle() {
  return (
    <>
      {SETTINGS_ITEMS.map((item, i) => {
        const isLast = i === SETTINGS_ITEMS.length - 1;
        return (
          <Fragment key={item}>
            <span className="whitespace-nowrap">
              {item}
              {!isLast && <span className="ml-1.5 opacity-50">·</span>}
            </span>
            {!isLast && " "}
          </Fragment>
        );
      })}
    </>
  );
}
