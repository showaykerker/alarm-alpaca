import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Cpu,
  HardDrive,
  Loader2,
  Radio,
  RefreshCw,
  Rocket,
  Trash2,
  Wifi,
} from "lucide-react";

import { KioskShell } from "@/components/KioskShell";
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

type Tab = "zigbee" | "comms" | "system" | "deploy";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "zigbee", label: "Zigbee", icon: <Radio className="h-4 w-4" /> },
  { id: "comms", label: "通訊", icon: <Activity className="h-4 w-4" /> },
  { id: "system", label: "系統", icon: <Cpu className="h-4 w-4" /> },
  { id: "deploy", label: "部署", icon: <Rocket className="h-4 w-4" /> },
];

export default function EngineeringPage() {
  const [tab, setTab] = useState<Tab>("zigbee");

  return (
    <KioskShell>
      <div className="flex flex-col h-full min-h-0 gap-2">
        {/* Tab bar — replaces the title banner */}
        <div className="flex gap-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => window.history.back()}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          {TABS.map((t) => (
            <Button
              key={t.id}
              variant={tab === t.id ? "default" : "outline"}
              size="sm"
              onClick={() => setTab(t.id)}
              className="flex-1 gap-1.5"
            >
              {t.icon}
              {t.label}
            </Button>
          ))}
        </div>
        {/* Tab content */}
        <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-border bg-card/50 p-3">
          {tab === "zigbee" && <ZigbeeTab />}
          {tab === "comms" && <CommsTab />}
          {tab === "system" && <SystemTab />}
          {tab === "deploy" && <DeployTab />}
        </div>
      </div>
    </KioskShell>
  );
}

// ---------------------------------------------------------------------------
// Zigbee
// ---------------------------------------------------------------------------

type ZigbeeDevice = {
  friendly_name: string;
  ieee_address: string;
  type: string;
  model: string | null;
  battery: number | null;
  link_quality: number | null;
  last_seen: string | null;
};

type ZigbeeBridge = {
  version: string | null;
  coordinator_type: string | null;
  channel: number | null;
  pan_id: string | null;
  permit_join: boolean | null;
  state: string | null;
};

function ZigbeeTab() {
  const [devices, setDevices] = useState<ZigbeeDevice[]>([]);
  const [bridge, setBridge] = useState<ZigbeeBridge | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    try {
      const [rd, rb] = await Promise.all([
        fetch("/api/eng/zigbee/devices"),
        fetch("/api/eng/zigbee/bridge"),
      ]);
      if (rd.ok) setDevices(await rd.json());
      if (rb.ok) setBridge(await rb.json());
    } catch { /* keep last-good */ }
    setLoading(false);
  }, []);

  useEffect(() => { void fetch_(); }, [fetch_]);

  return (
    <div className="space-y-4">
      {/* Bridge info */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">Bridge</h3>
        <Button variant="ghost" size="sm" onClick={fetch_} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>
      {bridge && (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <KV label="State" value={bridge.state ?? "?"} tone={bridge.state === "online" ? "ok" : "fail"} />
          <KV label="Version" value={bridge.version ?? "?"} />
          <KV label="Channel" value={bridge.channel?.toString() ?? "?"} />
          <KV label="PAN ID" value={bridge.pan_id ?? "?"} />
          <KV label="Coordinator" value={bridge.coordinator_type ?? "?"} />
          <KV label="Permit Join" value={bridge.permit_join ? "YES" : "no"} tone={bridge.permit_join ? "warn" : "ok"} />
        </div>
      )}

      {/* Device table */}
      <h3 className="text-sm font-semibold text-muted-foreground">
        Devices ({devices.length})
      </h3>
      {loading && devices.length === 0 ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground text-left">
                <th className="py-1 pr-2">Name</th>
                <th className="py-1 pr-2">Model</th>
                <th className="py-1 pr-2">Battery</th>
                <th className="py-1 pr-2">LQI</th>
                <th className="py-1">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.ieee_address} className="border-b border-border/30">
                  <td className="py-1.5 pr-2 font-mono">{d.friendly_name}</td>
                  <td className="py-1.5 pr-2 text-muted-foreground">{d.model ?? "—"}</td>
                  <td className="py-1.5 pr-2">
                    {d.battery != null ? (
                      <span className={cn(
                        "font-mono",
                        d.battery <= 20 && "text-rose-400",
                        d.battery > 20 && d.battery <= 50 && "text-amber-300",
                        d.battery > 50 && "text-emerald-300",
                      )}>
                        {d.battery}%
                      </span>
                    ) : "—"}
                  </td>
                  <td className="py-1.5 pr-2">
                    {d.link_quality != null ? (
                      <span className={cn(
                        "font-mono",
                        d.link_quality <= 50 && "text-rose-400",
                        d.link_quality > 50 && d.link_quality <= 150 && "text-amber-300",
                        d.link_quality > 150 && "text-emerald-300",
                      )}>
                        {d.link_quality}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="py-1.5 text-muted-foreground">{formatLastSeen(d.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatLastSeen(ts: string | null): string {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    const ago = Math.floor((Date.now() - d.getTime()) / 1000);
    if (ago < 60) return `${ago}s ago`;
    if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
    if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
    return `${Math.floor(ago / 86400)}d ago`;
  } catch {
    return ts;
  }
}

// ---------------------------------------------------------------------------
// Comms (MQTT + alarm-bridge)
// ---------------------------------------------------------------------------

type MqttMessage = { type: string; topic?: string; payload?: string };

type AlarmBridgeStats = {
  debounce_filtered_24h: number;
  last_callout: string | null;
  last_discord: string | null;
  journal_lines: string[];
};

function CommsTab() {
  const [mqttActive, setMqttActive] = useState(false);
  const [mqttMessages, setMqttMessages] = useState<MqttMessage[]>([]);
  const [stats, setStats] = useState<AlarmBridgeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const evtSourceRef = useRef<EventSource | null>(null);
  const mqttEndRef = useRef<HTMLDivElement | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/eng/alarm-bridge/stats");
      if (r.ok) setStats(await r.json());
    } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { void fetchStats(); }, [fetchStats]);

  const toggleMqtt = () => {
    if (mqttActive) {
      evtSourceRef.current?.close();
      evtSourceRef.current = null;
      setMqttActive(false);
      return;
    }
    setMqttMessages([]);
    const src = new EventSource("/api/eng/mqtt/stream");
    src.onmessage = (e) => {
      try {
        const msg: MqttMessage = JSON.parse(e.data);
        if (msg.type === "closed") {
          src.close();
          setMqttActive(false);
          return;
        }
        if (msg.type === "message") {
          setMqttMessages((prev) => [...prev.slice(-99), msg]);
        }
      } catch { /* */ }
    };
    src.onerror = () => {
      src.close();
      setMqttActive(false);
    };
    evtSourceRef.current = src;
    setMqttActive(true);
  };

  useEffect(() => {
    return () => evtSourceRef.current?.close();
  }, []);

  useEffect(() => {
    mqttEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mqttMessages]);

  return (
    <div className="space-y-4">
      {/* MQTT live stream */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">MQTT Live</h3>
        <Button
          variant={mqttActive ? "destructive" : "outline"}
          size="sm"
          onClick={toggleMqtt}
        >
          <Wifi className="h-3.5 w-3.5" />
          {mqttActive ? "停止" : "開始監聽"}
        </Button>
      </div>
      <div className="bg-background/60 rounded-md p-2 max-h-40 overflow-y-auto font-mono text-xs">
        {mqttMessages.length === 0 ? (
          <span className="text-muted-foreground">
            {mqttActive ? "等待訊息…" : "按「開始監聽」接收 MQTT 訊息（60 秒）"}
          </span>
        ) : (
          mqttMessages.map((m, i) => (
            <div key={i} className="flex gap-2 py-0.5">
              <span className="text-sky-400 shrink-0">{m.topic}</span>
              <span className="text-foreground/80 truncate">{m.payload}</span>
            </div>
          ))
        )}
        <div ref={mqttEndRef} />
      </div>

      {/* alarm-bridge stats */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">alarm-bridge</h3>
        <Button variant="ghost" size="sm" onClick={fetchStats} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>
      {stats && (
        <>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <KV label="Debounce (24h)" value={stats.debounce_filtered_24h.toString()} />
            <KV label="Last TAS" value={stats.last_callout?.split(" ").slice(0, 2).join(" ") ?? "—"} />
            <KV label="Last Discord" value={stats.last_discord?.split(" ").slice(0, 2).join(" ") ?? "—"} />
          </div>
          <h4 className="text-xs font-semibold text-muted-foreground">Journal (last 50)</h4>
          <pre className="bg-background/60 rounded-md p-2 max-h-40 overflow-auto text-xs font-mono whitespace-pre-wrap break-all leading-tight">
            {stats.journal_lines.join("\n") || "no entries"}
          </pre>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

type RoutingInfo = { routes: string; dns_servers: string[] };
type ContainerStat = { name: string; cpu_percent: string; mem_usage: string; mem_percent: string; pids: string };
type SdHealth = { io_errors_24h: number; error_lines: string[] };
type ThrottleEvent = { timestamp: string; message: string };

function SystemTab() {
  const [routing, setRouting] = useState<RoutingInfo | null>(null);
  const [containers, setContainers] = useState<ContainerStat[]>([]);
  const [sdHealth, setSdHealth] = useState<SdHealth | null>(null);
  const [throttle, setThrottle] = useState<ThrottleEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    try {
      const [rr, rc, rs, rt] = await Promise.all([
        fetch("/api/eng/system/network"),
        fetch("/api/eng/system/containers"),
        fetch("/api/eng/system/sd-health"),
        fetch("/api/eng/system/throttle-history"),
      ]);
      if (rr.ok) setRouting(await rr.json());
      if (rc.ok) setContainers(await rc.json());
      if (rs.ok) setSdHealth(await rs.json());
      if (rt.ok) setThrottle(await rt.json());
    } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { void fetch_(); }, [fetch_]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">System Diagnostics</h3>
        <Button variant="ghost" size="sm" onClick={fetch_} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {/* Routes + DNS */}
      {routing && (
        <>
          <Section title="Routing Table">
            <pre className="bg-background/60 rounded-md p-2 text-xs font-mono whitespace-pre-wrap">
              {routing.routes}
            </pre>
          </Section>
          <Section title="DNS Servers">
            <div className="flex gap-2">
              {routing.dns_servers.map((s) => (
                <Badge key={s} variant="secondary" className="font-mono text-xs">{s}</Badge>
              ))}
              {routing.dns_servers.length === 0 && (
                <span className="text-xs text-muted-foreground">none found</span>
              )}
            </div>
          </Section>
        </>
      )}

      {/* Containers */}
      <Section title="Containers">
        {containers.length === 0 ? (
          <span className="text-xs text-muted-foreground">no containers running</span>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground text-left">
                <th className="py-1 pr-2">Name</th>
                <th className="py-1 pr-2">CPU</th>
                <th className="py-1 pr-2">Memory</th>
                <th className="py-1">PIDs</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.name} className="border-b border-border/30">
                  <td className="py-1 pr-2 font-mono">{c.name}</td>
                  <td className="py-1 pr-2 font-mono">{c.cpu_percent}</td>
                  <td className="py-1 pr-2 font-mono">{c.mem_usage}</td>
                  <td className="py-1 font-mono">{c.pids}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* SD Health */}
      <Section title={
        <span className="flex items-center gap-1.5">
          <HardDrive className="h-3.5 w-3.5" />
          SD Card Health (24h)
        </span>
      }>
        {sdHealth ? (
          sdHealth.io_errors_24h === 0 ? (
            <span className="text-xs text-emerald-300">No I/O errors</span>
          ) : (
            <div className="space-y-1">
              <Badge variant="destructive">{sdHealth.io_errors_24h} errors</Badge>
              <pre className="bg-background/60 rounded-md p-2 text-xs font-mono max-h-24 overflow-auto">
                {sdHealth.error_lines.join("\n")}
              </pre>
            </div>
          )
        ) : null}
      </Section>

      {/* Throttle */}
      <Section title={
        <span className="flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5" />
          Throttle Events (24h)
        </span>
      }>
        {throttle.length === 0 ? (
          <span className="text-xs text-emerald-300">No throttle events</span>
        ) : (
          <div className="space-y-0.5 text-xs font-mono">
            {throttle.map((e, i) => (
              <div key={i} className="text-amber-300">
                <span className="text-muted-foreground">{e.timestamp}</span> {e.message}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

type DeployStatus = {
  deploying: boolean;
  deploy_process: string | null;
  current_generation: number | null;
  current_profile: string | null;
  last_activated_unix: number | null;
};

type Generation = { id: number; date: string; current: boolean };

function DeployTab() {
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(true);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<string | null>(null);
  const [switchTarget, setSwitchTarget] = useState<Generation | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchResult, setSwitchResult] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    try {
      const [rs, rg] = await Promise.all([
        fetch("/api/eng/deploy/status"),
        fetch("/api/eng/deploy/generations"),
      ]);
      if (rs.ok) setStatus(await rs.json());
      if (rg.ok) setGenerations(await rg.json());
    } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { void fetch_(); }, [fetch_]);

  // Auto-refresh while deploying
  useEffect(() => {
    if (!status?.deploying) return;
    const id = setInterval(() => void fetch_(), 3000);
    return () => clearInterval(id);
  }, [status?.deploying, fetch_]);

  const doCleanup = async () => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const r = await fetch("/api/eng/deploy/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep: 3 }),
      });
      const data = await r.json();
      setCleanResult(data.stdout + "\n" + data.gc_stdout);
      await fetch_();
    } catch (e) {
      setCleanResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCleaning(false);
    }
  };

  const doSwitch = async () => {
    if (!switchTarget) return;
    setSwitching(true);
    setSwitchResult(null);
    try {
      const r = await fetch("/api/eng/deploy/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generation: switchTarget.id }),
      });
      const data = await r.json();
      setSwitchResult(data.stdout + (data.stderr ? "\n" + data.stderr : ""));
      if (data.ok) await fetch_();
    } catch (e) {
      setSwitchResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">Deploy Status</h3>
        <Button variant="ghost" size="sm" onClick={fetch_} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {status && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <KV
            label="Status"
            value={status.deploying ? "DEPLOYING" : "idle"}
            tone={status.deploying ? "warn" : "ok"}
          />
          <KV label="Generation" value={status.current_generation?.toString() ?? "?"} />
          <KV
            label="Last Deploy"
            value={status.last_activated_unix
              ? new Date(status.last_activated_unix * 1000).toLocaleString("zh-TW")
              : "?"
            }
          />
          {status.deploy_process && (
            <div className="col-span-2">
              <pre className="bg-background/60 rounded-md p-1.5 text-xs font-mono text-amber-300">
                {status.deploy_process}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Generations */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">
          Generations ({generations.length})
        </h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCleanupOpen(true)}
          disabled={generations.length <= 3}
        >
          <Trash2 className="h-3.5 w-3.5" />
          清理舊版
        </Button>
      </div>
      <div className="max-h-48 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-muted-foreground text-left">
              <th className="py-1 pr-2">#</th>
              <th className="py-1 pr-2">Date</th>
              <th className="py-1 pr-2">Status</th>
              <th className="py-1"></th>
            </tr>
          </thead>
          <tbody>
            {[...generations].reverse().map((g) => (
              <tr
                key={g.id}
                className={cn(
                  "border-b border-border/30",
                  g.current && "bg-emerald-900/20",
                )}
              >
                <td className="py-1 pr-2 font-mono">{g.id}</td>
                <td className="py-1 pr-2">{g.date}</td>
                <td className="py-1 pr-2">
                  {g.current && <Badge className="bg-emerald-600 text-white text-xs">current</Badge>}
                </td>
                <td className="py-1">
                  {!g.current && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] px-2"
                      onClick={() => { setSwitchTarget(g); setSwitchResult(null); }}
                    >
                      切換
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Cleanup dialog */}
      <Dialog open={cleanupOpen} onOpenChange={setCleanupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清理舊 Generations</DialogTitle>
            <DialogDescription>
              保留最新 3 個 generation，刪除其餘並執行 nix-collect-garbage 釋放空間。
            </DialogDescription>
          </DialogHeader>
          {cleanResult && (
            <pre className="bg-background/60 rounded-md p-2 text-xs font-mono max-h-40 overflow-auto whitespace-pre-wrap">
              {cleanResult}
            </pre>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => setCleanupOpen(false)}
              disabled={cleaning}
            >
              {cleanResult ? "關閉" : "取消"}
            </Button>
            {!cleanResult && (
              <Button
                variant="destructive"
                size="lg"
                onClick={doCleanup}
                disabled={cleaning}
              >
                {cleaning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                確認清理
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Switch generation dialog */}
      <Dialog open={switchTarget !== null} onOpenChange={(o) => { if (!o) setSwitchTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>切換至 Generation #{switchTarget?.id}</DialogTitle>
            <DialogDescription>
              回滾到 {switchTarget?.date}。所有服務會重新啟動，kiosk 畫面會中斷數秒。
            </DialogDescription>
          </DialogHeader>
          {switchResult && (
            <pre className="bg-background/60 rounded-md p-2 text-xs font-mono max-h-40 overflow-auto whitespace-pre-wrap">
              {switchResult}
            </pre>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => setSwitchTarget(null)}
              disabled={switching}
            >
              {switchResult ? "關閉" : "取消"}
            </Button>
            {!switchResult && (
              <Button
                variant="destructive"
                size="lg"
                onClick={doSwitch}
                disabled={switching}
              >
                {switching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                確認切換
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function KV({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "fail";
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-background/40 px-2 py-1.5">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</span>
      <span
        className={cn(
          "font-mono text-sm",
          tone === "ok" && "text-emerald-300",
          tone === "warn" && "text-amber-300",
          tone === "fail" && "text-rose-400",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}
