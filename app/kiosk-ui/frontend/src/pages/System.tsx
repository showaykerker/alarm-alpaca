import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
  Cpu,
  Globe,
  HardDrive,
  Loader2,
  MessageSquare,
  Package,
  Thermometer,
  Wifi,
} from "lucide-react";
import { Link } from "react-router-dom";

import { KioskShell } from "@/components/KioskShell";
import { useKioskEvents } from "@/lib/useKioskEvents";
import { BackCard, GridCell } from "@/components/PageGrid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type NetIface = {
  device: string;
  type: string;
  state: string;
  ip: string | null;
  gateway: string | null;
};

type MdnsProbe = {
  hostname: string;
  resolved_ip: string | null;
  ok: boolean;
  detail: string | null;
};

type NetworkInfo = { interfaces: NetIface[]; mdns: MdnsProbe };

type DiskUsage = {
  mountpoint: string;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
};

type HeartbeatStatus = {
  last_seen_unix: number | null;
  interval_seconds: number | null;
  age_seconds: number | null;
  ok: boolean;
};

type VersionInfo = {
  git_rev: string | null;
  nixos_generation: number | null;
  last_activated_unix: number | null;
  installed_unix: number | null;
};

type SystemInfo = {
  hostname: string;
  kernel: string;
  nixos: string | null;
  uptime_seconds: number;
  load_1: number;
  load_5: number;
  load_15: number;
  mem_total_kb: number;
  mem_available_kb: number;
  mem_used_kb: number;
  cpu_temp_c: number | null;
  throttled_hex: string | null;
  throttled_flags: string[];
  disks: DiskUsage[];
  discord_heartbeat: HeartbeatStatus;
  version: VersionInfo;
};

function ifaceIcon(type: string) {
  if (type === "wifi") return <Wifi className="h-5 w-5 text-sky-400" />;
  if (type === "ethernet") return <Cable className="h-5 w-5 text-emerald-400" />;
  return <Globe className="h-5 w-5 text-muted-foreground" />;
}

function formatUptime(s: number): string {
  if (s <= 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小時 ${m} 分`;
  if (h > 0) return `${h} 小時 ${m} 分`;
  return `${m} 分`;
}

function formatBytes(n: number): string {
  if (n <= 0) return "—";
  const gib = n / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  return `${(n / 1024 ** 2).toFixed(0)} MiB`;
}

function formatKb(kb: number): string {
  return formatBytes(kb * 1024);
}

function tempTone(c: number | null): "ok" | "warn" | "fail" | null {
  if (c == null) return null;
  if (c >= 80) return "fail";
  if (c >= 70) return "warn";
  return "ok";
}

function diskPercent(d: DiskUsage): number {
  if (d.total_bytes <= 0) return 0;
  return Math.round((d.used_bytes / d.total_bytes) * 100);
}

function diskTone(d: DiskUsage): "ok" | "warn" | "fail" {
  const p = diskPercent(d);
  if (p >= 90) return "fail";
  if (p >= 75) return "warn";
  return "ok";
}

// "Internet broken" = no interface has an IP. mDNS-failure doesn't escalate
// past warning because broadcast on a private LAN can lag without losing
// outbound reachability.
export function computeInternetTone(net: NetworkInfo | null): "ok" | "warn" | "fail" {
  if (!net) return "ok";
  const hasIp = net.interfaces.some((i) => !!i.ip);
  if (!hasIp) return "fail";
  if (!net.mdns.ok) return "warn";
  return "ok";
}

// Host-info tone — heuristic, since the user delegated the call:
//   fail: CPU >= 80°C, any throttle flag active, disk >= 95% on /
//   warn: CPU >= 70°C, disk >= 85% on /
// Throttle "happened since boot" flags are NOT escalated to fail because
// they can persist long after the condition resolved (e.g. a single
// brown-out at boot leaves the sticky bit set forever).
export function computeHostTone(sys: SystemInfo | null): "ok" | "warn" | "fail" {
  if (!sys) return "ok";
  if (sys.cpu_temp_c != null && sys.cpu_temp_c >= 80) return "fail";
  if (sys.throttled_flags.length > 0) return "fail";
  const root = sys.disks.find((d) => d.mountpoint === "/");
  if (root && diskPercent(root) >= 95) return "fail";
  if (sys.cpu_temp_c != null && sys.cpu_temp_c >= 70) return "warn";
  if (root && diskPercent(root) >= 85) return "warn";
  return "ok";
}

export function computeHeartbeatTone(hb: HeartbeatStatus | undefined): "ok" | "warn" | "fail" {
  // Heartbeat failure is non-fatal per the user spec: discord is a
  // notification path, not the dial-out one. Just warn.
  if (!hb || hb.last_seen_unix == null) return "warn";
  return hb.ok ? "ok" : "warn";
}

// Aggregate for the main-page System Info nav-card colour. fail > warn > ok.
export function computeSystemTone(
  net: NetworkInfo | null,
  sys: SystemInfo | null,
): "ok" | "warn" | "fail" {
  const tones = [
    computeInternetTone(net),
    computeHostTone(sys),
    computeHeartbeatTone(sys?.discord_heartbeat),
  ];
  if (tones.includes("fail")) return "fail";
  if (tones.includes("warn")) return "warn";
  return "ok";
}

// Format heartbeat age compactly: "2 分鐘前", "1 小時 5 分鐘前", "—".
function formatAge(s: number | null): string {
  if (s == null) return "—";
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  if (h < 24) return `${h} 小時 ${mr} 分鐘前`;
  return `${Math.floor(h / 24)} 天前`;
}

// Convert an absolute unix timestamp to a "seconds ago" value suitable for
// `formatAge`. Clamps negative ages (clock skew) to zero so we never render
// "—" simply because the backend's mtime is a few seconds in the future.
function ageSeconds(unix: number | null): number | null {
  if (unix == null) return null;
  return Math.max(0, Math.floor(Date.now() / 1000) - unix);
}

// System info page: superset of the old "IP info" tile. Sections (top→bottom
// in row 1): network interfaces + mDNS + Discord heartbeat; row 2 hosts
// machine details (uptime, load, memory, CPU temp, throttle, disks) and the
// back button.
export default function SystemPage() {
  const [net, setNet] = useState<NetworkInfo | null>(null);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [hostDetailOpen, setHostDetailOpen] = useState(false);
  // Live metrics come through the shared SSE stream so the 即時狀態 card
  // ticks on heartbeat ticks (~5s) instead of waiting on the page-local
  // /api/system/info poll. We still fetch /api/system/info for the
  // static-ish fields (disks, kernel, NixOS, throttle), just at a slower
  // cadence.
  const { liveMetrics } = useKioskEvents();

  const fetchAll = useCallback(async () => {
    try {
      const [rn, rs] = await Promise.all([
        fetch("/api/network/info"),
        fetch("/api/system/info"),
      ]);
      if (rn.ok) setNet(await rn.json());
      if (rs.ok) setSys(await rs.json());
    } catch { /* keep last-good */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchAll();
    // Static-ish fields (disks/kernel/throttle/heartbeat) refresh every 15s.
    // Live values (cpu/load/mem) come through SSE heartbeats, so this poll
    // can stay slow without making 即時狀態 feel stale.
    const id = window.setInterval(() => void fetchAll(), 15000);
    return () => window.clearInterval(id);
  }, [fetchAll]);

  // Prefer SSE live values when available; fall back to the periodically
  // polled sys snapshot so the page is usable before the first heartbeat.
  const liveCpuC = liveMetrics?.cpu_c ?? sys?.cpu_temp_c ?? null;
  const liveLoad1 = liveMetrics?.load_1 ?? sys?.load_1 ?? null;
  const liveLoad5 = liveMetrics?.load_5 ?? sys?.load_5 ?? null;
  const liveLoad15 = liveMetrics?.load_15 ?? sys?.load_15 ?? null;
  const liveMemUsed = liveMetrics?.mem_used_kb ?? sys?.mem_used_kb ?? null;
  const liveMemTotal = liveMetrics?.mem_total_kb ?? sys?.mem_total_kb ?? null;

  const hb = sys?.discord_heartbeat;
  const cpuTone = tempTone(liveCpuC);
  const internetTone = computeInternetTone(net);
  const hostTone = computeHostTone(sys);

  return (
    <KioskShell title="系統資訊">
      <div className="grid grid-cols-3 grid-rows-2 gap-4 flex-1 min-h-0">
        {/* Row 1: separate cells for internet vs Discord heartbeat vs spare. */}
        <Link
          to="/settings/internet"
          className={cn(
            "rounded-2xl border-2 p-5 flex flex-col min-h-0 overflow-hidden transition-colors active:scale-[0.98] hover:brightness-110",
            internetTone === "fail"
              ? "bg-rose-900/30 border-rose-600/70"
              : "bg-card border-border",
          )}
        >
          {/* mDNS first per the spec — operators want "what do I ssh to"
              visible before they hunt through per-interface IPs. */}
          {net && (
            <div className="flex items-baseline gap-2 flex-wrap pb-2 border-b mb-2">
              <span className="text-xs text-muted-foreground shrink-0">mDNS</span>
              <span className="font-mono text-base truncate">
                {net.mdns.hostname}
              </span>
              {net.mdns.ok ? (
                <Badge className="bg-emerald-600 text-white text-xs">已廣播</Badge>
              ) : (
                <Badge variant="destructive" className="text-xs">無法解析</Badge>
              )}
            </div>
          )}
          <h2 className="text-base font-semibold text-muted-foreground flex items-center gap-2">
            <Globe className="h-5 w-5" />
            網際網路
          </h2>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-1 mt-1">
            {loading && !net ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : net && net.interfaces.length > 0 ? (
              net.interfaces.map((i) => (
                <div
                  key={i.device}
                  className="flex items-baseline gap-2 flex-wrap"
                >
                  <span className="shrink-0">{ifaceIcon(i.type)}</span>
                  <Badge variant="outline" className="font-mono shrink-0 text-xs">
                    {i.device}
                  </Badge>
                  {i.ip ? (
                    <span className="font-mono text-base tabular-nums">{i.ip}</span>
                  ) : (
                    <span className="text-muted-foreground text-sm">未取得 IP</span>
                  )}
                </div>
              ))
            ) : (
              <p className="text-muted-foreground text-sm">無可用網卡。</p>
            )}
          </div>
          <div className="text-xs text-muted-foreground/70 text-right pt-1">
            點選進入網路設定 →
          </div>
        </Link>

        <GridCell
          tone={hb && hb.last_seen_unix != null && !hb.ok ? "warn" : "default"}
        >
          <div className="flex flex-col h-full min-h-0">
            <h2 className="text-base font-semibold text-muted-foreground flex items-center gap-2 shrink-0">
              <MessageSquare className="h-5 w-5" />
              Discord 心跳
            </h2>
            <div className="flex-1 flex items-center justify-center">
              {hb ? (
                <DiscordHeartbeat hb={hb} />
              ) : (
                <Loader2 className="h-5 w-5 animate-spin" />
              )}
            </div>
          </div>
        </GridCell>

        <GridCell className="bg-card/80 border-border">
          <div className="flex flex-col gap-2 min-h-0 h-full">
            <h2 className="text-base font-semibold text-muted-foreground flex items-center gap-2 shrink-0">
              <Package className="h-5 w-5" />
              版本資訊
            </h2>
            {loading && !sys ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : sys ? (
              <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm flex-1 min-h-0 items-center">
                <InfoRow
                  label="Git"
                  value={
                    sys.version.git_rev == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : sys.version.git_rev.endsWith("-dirty") ? (
                      <span className="font-mono text-xs">
                        {sys.version.git_rev.slice(0, -"-dirty".length)}
                        <span className="text-muted-foreground"> (dirty)</span>
                      </span>
                    ) : (
                      <span className="font-mono text-xs">{sys.version.git_rev}</span>
                    )
                  }
                />
                <InfoRow
                  label="Generation"
                  value={
                    sys.version.nixos_generation == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="font-mono tabular-nums">
                        #{sys.version.nixos_generation}
                      </span>
                    )
                  }
                />
                <InfoRow
                  label="本次部署"
                  value={
                    sys.version.last_activated_unix == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span>{formatAge(ageSeconds(sys.version.last_activated_unix))}</span>
                    )
                  }
                />
                <InfoRow
                  label="首次安裝"
                  value={
                    sys.version.installed_unix == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="flex flex-col">
                        <span>{formatAge(ageSeconds(sys.version.installed_unix))}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(sys.version.installed_unix * 1000).toLocaleDateString(
                            "zh-TW",
                            { year: "numeric", month: "2-digit", day: "2-digit" },
                          )}
                        </span>
                      </span>
                    )
                  }
                />
              </div>
            ) : (
              <p className="text-muted-foreground">無法讀取版本資訊。</p>
            )}
          </div>
        </GridCell>

        {/* Row 2: static host card (col1) · live resource card (col2) · back (col3).
            Operator-requested split (2026-05-18) — keeping load/mem/temp on
            their own card stops them being lost in the wall of identity fields
            (hostname/kernel/nixos), and lets the resource card carry a
            distinct warn/fail tint without staining the unchanging host
            metadata around it. */}
        {/* Whole-card tap target — mirrors the Internet tile which is a
            <Link> to /settings/internet, so the two "click-through"
            surfaces on this page look and react the same. The
            stand-alone 「詳細」 Button is gone; the operator just taps
            anywhere on the card to open the host-detail dialog. */}
        <button
          type="button"
          onClick={() => sys && setHostDetailOpen(true)}
          disabled={!sys}
          className={cn(
            "rounded-2xl border-2 p-5 flex flex-col min-h-0 overflow-hidden text-left",
            "transition-colors active:scale-[0.98] hover:brightness-110",
            "bg-card/80 border-border disabled:opacity-60",
          )}
        >
          <div className="flex flex-col gap-2 min-h-0 h-full w-full">
            <h2 className="text-base font-semibold text-muted-foreground flex items-center gap-2 shrink-0">
              <Cpu className="h-5 w-5" />
              主機
            </h2>
            {loading && !sys ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : sys ? (
              // Card shows only the four signals an operator checks at a
              // glance: who is this machine, how long has it been up, is it
              // throttling, and is the rootfs filling up. Kernel / NixOS /
              // every mountpoint live in a 「詳細」 dialog (2026-05-18 — the
              // old multi-row layout forced touch scrolling, which is
              // awkward without a mouse).
              <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm flex-1 min-h-0 items-center">
                <InfoRow
                  label="Hostname"
                  value={<span className="font-mono">{sys.hostname}</span>}
                />
                <InfoRow label="運行時間" value={formatUptime(sys.uptime_seconds)} />
                <InfoRow
                  label="節流"
                  value={
                    sys.throttled_hex == null ? (
                      <span className="text-muted-foreground text-xs">vcgencmd 未安裝</span>
                    ) : sys.throttled_flags.length === 0 ? (
                      <span className="flex items-center gap-1.5 text-emerald-300">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span className="font-mono text-xs">{sys.throttled_hex}</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-rose-400">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        <span className="text-xs">
                          {sys.throttled_flags.join("、")}
                        </span>
                      </span>
                    )
                  }
                />
                {(() => {
                  // Surface the rootfs disk on the card — it's the only one
                  // that actually matters for "is the device about to wedge?".
                  // Everything else (boot partition, tmpfs mounts) lives in
                  // the detail dialog.
                  const rootfs = sys.disks.find((d) => d.mountpoint === "/")
                    ?? sys.disks[0];
                  if (!rootfs) return null;
                  const tone = diskTone(rootfs);
                  return (
                    <InfoRow
                      label={
                        <span className="flex items-center gap-1.5">
                          <HardDrive className="h-3.5 w-3.5" />
                          {rootfs.mountpoint}
                        </span>
                      }
                      value={
                        <span
                          className={cn(
                            "font-mono tabular-nums text-xs",
                            tone === "fail" && "text-rose-400",
                            tone === "warn" && "text-amber-300",
                          )}
                        >
                          {formatBytes(rootfs.used_bytes)} /{" "}
                          {formatBytes(rootfs.total_bytes)}{" "}
                          <span className="opacity-70">
                            ({diskPercent(rootfs)}%)
                          </span>
                        </span>
                      }
                    />
                  );
                })()}
              </div>
            ) : (
              <p className="text-muted-foreground">無法讀取系統資訊。</p>
            )}
            <div className="text-xs text-muted-foreground/70 text-right pt-1 mt-auto">
              點選查看詳細 →
            </div>
          </div>
        </button>

        {/* Live resource card: changes per poll, owns the warn/fail tint
            (the host-card stays neutral because it's identity, not state). */}
        <GridCell
          className={cn(
            hostTone === "fail" && "bg-rose-900/30 border-rose-600/70",
            hostTone === "warn" && "bg-amber-900/20 border-amber-600/70",
            hostTone === "ok" && "bg-card/80",
          )}
        >
          <div className="flex flex-col gap-2 min-h-0 h-full overflow-y-auto">
            <h2 className="text-base font-semibold text-muted-foreground flex items-center gap-2">
              <Thermometer className="h-5 w-5" />
              即時狀態
            </h2>
            {loading && !sys && liveMetrics == null ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm items-center">
                <InfoRow
                  label="負載"
                  value={
                    liveLoad1 != null && liveLoad5 != null && liveLoad15 != null ? (
                      <span className="font-mono tabular-nums">
                        {liveLoad1.toFixed(2)} / {liveLoad5.toFixed(2)} /{" "}
                        {liveLoad15.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )
                  }
                />
                <InfoRow
                  label="記憶體"
                  value={
                    liveMemUsed != null && liveMemTotal != null ? (
                      <span className="flex items-center gap-2">
                        <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono tabular-nums">
                          {formatKb(liveMemUsed)} / {formatKb(liveMemTotal)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )
                  }
                />
                <InfoRow
                  label={
                    <span className="flex items-center gap-1.5">
                      <Thermometer className="h-3.5 w-3.5" />
                      CPU 溫度
                    </span>
                  }
                  value={
                    liveCpuC == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          "font-mono tabular-nums",
                          cpuTone === "fail" && "text-rose-400",
                          cpuTone === "warn" && "text-amber-300",
                          cpuTone === "ok" && "text-emerald-300",
                        )}
                      >
                        {liveCpuC.toFixed(1)} ℃
                      </span>
                    )
                  }
                />
              </div>
            )}
          </div>
        </GridCell>
        <BackCard to="/" label="回主頁" />
      </div>

      {/* Host detail dialog — every field that doesn't fit on the 主機
          card. Carries the full disk list, Kernel, NixOS, etc. */}
      <Dialog open={hostDetailOpen} onOpenChange={setHostDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>主機詳細資訊</DialogTitle>
            <DialogDescription>身份識別、版本與所有掛載點。</DialogDescription>
          </DialogHeader>
          {sys ? (
            <div className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-base">
              <InfoRow
                label="Hostname"
                value={<span className="font-mono">{sys.hostname}</span>}
              />
              <InfoRow label="運行時間" value={formatUptime(sys.uptime_seconds)} />
              <InfoRow
                label="Kernel"
                value={<span className="font-mono text-sm">{sys.kernel}</span>}
              />
              <InfoRow
                label="NixOS"
                value={
                  sys.nixos ? (
                    <span className="font-mono text-sm">{sys.nixos}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
              />
              {sys.disks.map((d) => {
                const tone = diskTone(d);
                return (
                  <InfoRow
                    key={d.mountpoint}
                    label={
                      <span className="flex items-center gap-1.5">
                        <HardDrive className="h-4 w-4" />
                        {d.mountpoint}
                      </span>
                    }
                    value={
                      <span
                        className={cn(
                          "font-mono tabular-nums",
                          tone === "fail" && "text-rose-400",
                          tone === "warn" && "text-amber-300",
                        )}
                      >
                        {formatBytes(d.used_bytes)} / {formatBytes(d.total_bytes)}{" "}
                        <span className="opacity-70">({diskPercent(d)}%)</span>
                      </span>
                    }
                  />
                );
              })}
            </div>
          ) : (
            <p className="text-muted-foreground">無法讀取系統資訊。</p>
          )}
          <DialogFooter>
            <Button size="lg" onClick={() => setHostDetailOpen(false)}>
              關閉
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </KioskShell>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground/90">{value}</span>
    </>
  );
}

function DiscordHeartbeat({ hb }: { hb: HeartbeatStatus }) {
  if (hb.last_seen_unix == null) {
    return (
      <div className="space-y-1">
        <Badge variant="destructive">未收到任何心跳</Badge>
        <p className="text-xs text-muted-foreground">
          alarm-bridge 啟動後將每 15 分鐘更新一次。
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        {hb.ok ? (
          <Badge className="bg-emerald-600 text-white">
            <CheckCircle2 className="h-3.5 w-3.5" />
            已連線
          </Badge>
        ) : (
          <Badge variant="destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            可能斷線
          </Badge>
        )}
        <span className="text-sm">{formatAge(hb.age_seconds)}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        每 {hb.interval_seconds ?? "?"} 秒更新一次；超過 3 倍視為斷線。
      </p>
    </div>
  );
}
