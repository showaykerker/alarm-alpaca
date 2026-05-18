import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Square } from "lucide-react";
import { Navigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { KioskShell } from "@/components/KioskShell";
import { BackCard, GridCell } from "@/components/PageGrid";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

// Per-service page: rolling log on the left (2 cols), ops + back on the
// right (1 col). The status-card → service mapping is keyed on
// /api/kiosk/status's `id` field. NetworkManager is read-only here — the
// backend explicitly excludes it from /api/services MANAGED_UNITS to stop
// the kiosk-ui from ever stopping the very thing it needs to talk to the
// LAN, so we hide the ops column for that one.
type ServiceDef = {
  label: string;
  unit: string;
  canOps: boolean;
};

const SERVICES: Record<string, ServiceDef> = {
  "alarm-bridge": {
    label: "緊急通報",
    unit: "alarm-bridge.service",
    canOps: true,
  },
  zigbee: {
    label: "Zigbee 接收",
    unit: "podman-zigbee2mqtt.service",
    canOps: true,
  },
  mqtt: {
    label: "MQTT 交換",
    unit: "podman-mosquitto.service",
    canOps: true,
  },
};

type LogEntry = { timestamp: string; message: string; priority: number };
type LogsResp = { unit: string; entries: LogEntry[] };

const LOG_REFRESH_MS = 5000;
const LOG_LINES = 50;

function priorityClass(p: number): string {
  if (p <= 3) return "text-rose-300"; // err / crit / alert / emerg
  if (p === 4) return "text-amber-300"; // warning
  return "text-foreground/85";
}

// Strip ANSI escape codes and the in-message timestamp+logger boilerplate
// that python's `setup_logger` (and zigbee2mqtt's container logger) emit.
// We already render journald's parsed timestamp in the row prefix, so the
// in-line copy is pure visual duplication.
//
// Patterns we match off the front:
//   "2026-05-18 04:37:29.123 - msg_hdl - INFO - ..."
//   "2026-05-18T04:37:29 ..."
//   "[2026-05-18 04:37:29] info: ..."
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const LEADING_TS_RE =
  /^\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}([.,]\d+)?Z?\]?\s*-?\s*(?:[\w.-]+\s*-\s*[A-Z]+\s*-\s*)?/;

function cleanLogMessage(msg: string): string {
  return msg.replace(ANSI_RE, "").replace(LEADING_TS_RE, "");
}

export default function ServicePage() {
  const { id } = useParams<{ id: string }>();
  const def = id ? SERVICES[id] : undefined;
  // Unknown ids drop the user back at the main page rather than rendering
  // a dead screen — this is a kiosk, there's nowhere else to go.
  if (!def) return <Navigate to="/" replace />;

  return <ServiceInner def={def} />;
}

function ServiceInner({ def }: { def: ServiceDef }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [confirm, setConfirm] = useState<"restart" | "stop" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const r = await fetch(`/api/logs?unit=${encodeURIComponent(def.unit)}&n=${LOG_LINES}`);
      if (r.ok) {
        const data: LogsResp = await r.json();
        // Newest on top per the UI spec; journalctl returns oldest-first.
        setLogs([...data.entries].reverse());
      }
    } catch { /* keep last-good */ }
  }, [def.unit]);

  // Refresh on mount + every 5s. Each unit-switch resets the polling clock.
  useEffect(() => {
    void fetchLogs();
    const id = window.setInterval(() => void fetchLogs(), LOG_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [fetchLogs]);

  const actionLabel = { restart: "重啟", stop: "停止" } as const;

  const doAction = async () => {
    if (!confirm) return;
    setBusy(true);
    setErr(null);
    const verb = actionLabel[confirm];
    try {
      const r = await fetch(`/api/services/${confirm}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unit: def.unit }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.detail ?? `HTTP ${r.status}`);
      }
      setConfirm(null);
      toast.success(`已${verb} ${def.unit}`);
      // Pull fresh logs immediately so the user sees the restart line.
      await fetchLogs();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      toast.error(`${verb}失敗：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KioskShell title={`${def.label} · ${def.unit}`}>
      <div className="grid grid-cols-3 grid-rows-2 gap-4 flex-1 min-h-0">
        {/* Logs: spans 2 cols x 2 rows */}
        <GridCell className="col-span-2 row-span-2 bg-card/80">
          <LogStream logs={logs} onRefresh={fetchLogs} />
        </GridCell>

        {/* Top-right: ops (or read-only banner) */}
        <GridCell>
          <div className="flex flex-col gap-3 h-full justify-center">
            {def.canOps ? (
              <>
                <Button
                  size="xl"
                  className="h-20 text-lg"
                  onClick={() => setConfirm("restart")}
                >
                  <RefreshCw className="h-6 w-6" />
                  重啟
                </Button>
                <Button
                  size="xl"
                  variant="outline"
                  className="h-20 text-lg border-rose-700/60 hover:bg-rose-900/30 text-rose-200"
                  onClick={() => setConfirm("stop")}
                >
                  <Square className="h-6 w-6" />
                  停止
                </Button>
              </>
            ) : (
              <p className="text-base text-muted-foreground text-center leading-relaxed">
                此服務為唯讀。停止 / 重啟 NetworkManager 會切斷本機網路，請改用 SSH。
              </p>
            )}
          </div>
        </GridCell>

        {/* Bottom-right: back-to-main (cross-page rule: row2 col3) */}
        <BackCard to="/" label="回主頁" />
      </div>

      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => {
          if (!o) {
            setConfirm(null);
            setErr(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>確認操作</DialogTitle>
            <DialogDescription>
              {confirm && `確定要${actionLabel[confirm]} ${def.unit} 嗎？`}
            </DialogDescription>
          </DialogHeader>
          {err && (
            <Alert variant="destructive">
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                setConfirm(null);
                setErr(null);
              }}
              disabled={busy}
            >
              取消
            </Button>
            <Button size="lg" onClick={doAction} loading={busy}>
              確認
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </KioskShell>
  );
}

function LogStream({ logs, onRefresh }: { logs: LogEntry[]; onRefresh: () => void }) {
  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      <div className="flex items-center justify-between shrink-0">
        <h2 className="text-base font-semibold">最近 {LOG_LINES} 行</h2>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" />
          重新整理
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto font-mono text-xs bg-background/50 rounded-md p-3 space-y-0.5">
        {logs.length === 0 ? (
          <p className="text-muted-foreground text-center py-6 text-sm">無紀錄</p>
        ) : (
          logs.map((e, i) => (
            <div key={i} className="leading-tight whitespace-pre-wrap break-all">
              <span className="text-muted-foreground tabular-nums shrink-0">
                {e.timestamp}
              </span>{" "}
              <span className={cn(priorityClass(e.priority))}>
                {cleanLogMessage(e.message)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
