import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Pencil, Radio, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { KioskShell } from "@/components/KioskShell";
import { OnScreenKeyboard } from "@/components/OnScreenKeyboard";
import { BackCard, EmptyCell, GridCell } from "@/components/PageGrid";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

type InterviewState = "PENDING" | "IN_PROGRESS" | "SUCCESSFUL" | "FAILED" | null;

type ZigbeeDevice = {
  ieee_address: string;
  friendly_name: string;
  type: string;
  model: string;
  // z2m newer builds report `interview_state`; older builds only set
  // `interview_completed` + the deprecated `interviewing` bool. We collapse
  // them into a single derived state on the client.
  interview_state?: InterviewState;
  interview_completed?: boolean | null;
  interviewing?: boolean | null;
  disabled?: boolean | null;
};

// Collapse z2m's three interview-state fields into one stable value.
// Priority order: explicit `interview_state` (newest) > `interviewing`
// in-progress shortcut > `interview_completed` SUCCESSFUL/PENDING fallback.
function deriveInterview(d: ZigbeeDevice): InterviewState {
  if (d.interview_state) return d.interview_state;
  if (d.interviewing) return "IN_PROGRESS";
  if (d.interview_completed === true) return "SUCCESSFUL";
  if (d.interview_completed === false) return "PENDING";
  return null;
}

// Per-row badge for non-default interview states. SUCCESSFUL is the steady
// state for every device that's been on the network more than a few seconds,
// so we hide it (a row with no badge = "ready"). PENDING/IN_PROGRESS/FAILED
// each get a distinct colour mirroring z2m's own UI.
function interviewBadge(s: InterviewState): { label: string; cls: string } | null {
  switch (s) {
    case "IN_PROGRESS":
      return { label: "正在識別", cls: "bg-amber-600 text-white animate-pulse" };
    case "PENDING":
      return { label: "等待中", cls: "bg-sky-600 text-white" };
    case "FAILED":
      return { label: "配對失敗", cls: "bg-rose-600 text-white" };
    case "SUCCESSFUL":
    default:
      return null;
  }
}

type ZigbeeStatus = {
  device_count: number;
  coordinator_present: boolean;
  devices: ZigbeeDevice[];
};

// Zigbee config page:
//   row1: coordinator status · paired device count · pair-mode button
//   row2: reload · empty · back-to-settings
// Pair-mode button is bi-state — idle → "進入配對 (60s)"; in pairing →
// countdown + "停止配對". Tapping the device-count card opens a list dialog;
// rename per device is a TODO (no backend route yet, see UI rework spec).
export default function ZigbeeConfig() {
  const [status, setStatus] = useState<ZigbeeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pairing, setPairing] = useState(false);
  const [pairBusy, setPairBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<number | null>(null);

  const [listOpen, setListOpen] = useState(false);
  // Active rename target. We carry the original "from" identifier (friendly
  // name preferred — IEEE works too if the device was never renamed) so the
  // bridge knows which device to retarget.
  const [renaming, setRenaming] = useState<{ from: string; current: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  // Delete-device confirm carries the same `from` (friendly_name or IEEE)
  // the rename flow uses. `busy` blocks the dialog while the bridge ACKs.
  const [removing, setRemoving] = useState<{ id: string; display: string } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const fetchStatus = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/zigbee");
      if (!r.ok) throw new Error(`GET /api/zigbee ${r.status}`);
      setStatus(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  // Fast-poll the device list while pairing is open so the operator sees
  // a new device land + progress through its interview phases without
  // tapping refresh. 2s mirrors z2m's own UI cadence; outside pair mode we
  // rely on manual refresh because the list rarely changes day-to-day.
  useEffect(() => {
    if (!pairing) return;
    const id = window.setInterval(() => void fetchStatus(), 2000);
    return () => window.clearInterval(id);
  }, [pairing, fetchStatus]);

  useEffect(() => {
    if (pairing && countdown > 0) {
      countdownRef.current = window.setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            setPairing(false);
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    }
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [pairing, countdown]);

  const startPairing = async () => {
    setPairBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/zigbee/permit-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enable: true, duration_secs: 60 }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.detail ?? `HTTP ${r.status}`);
      }
      setPairing(true);
      setCountdown(60);
      // Auto-open the device list so a freshly-pairing device shows up in
      // the operator's view as soon as z2m emits the interview events —
      // they'd otherwise have to tap the device-count tile manually after
      // hearing the button click.
      setListOpen(true);
      // Pull fresh state immediately so the dialog has something to render
      // before the 2s pairing-poll tick fires.
      void fetchStatus();
      toast.success("已開啟配對模式，倒數 60 秒");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(`開啟配對失敗：${msg}`);
    } finally {
      setPairBusy(false);
    }
  };

  const stopPairing = async () => {
    setPairBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/zigbee/permit-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enable: false, duration_secs: 0 }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.detail ?? `HTTP ${r.status}`);
      }
      setPairing(false);
      setCountdown(0);
      if (countdownRef.current) clearInterval(countdownRef.current);
      toast.success("已關閉配對模式");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(`關閉配對失敗：${msg}`);
    } finally {
      setPairBusy(false);
    }
  };

  const endDevices = status?.devices.filter((d) => d.type !== "Coordinator") ?? [];

  const doRemove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      const r = await fetch("/api/zigbee/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: removing.id, force: true }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.detail ?? `HTTP ${r.status}`);
      }
      setRemoving(null);
      // Bridge removes the device asynchronously; refetch shortly after so
      // the list updates without requiring a manual reload.
      window.setTimeout(() => void fetchStatus(), 800);
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoveBusy(false);
    }
  };

  const doRename = async (newName: string) => {
    if (!renaming) return;
    const to = newName.trim();
    if (!to || to === renaming.current) {
      setRenaming(null);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      const r = await fetch("/api/zigbee/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: renaming.from, to }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.detail ?? `HTTP ${r.status}`);
      }
      setRenaming(null);
      // Bridge processes the rename asynchronously; pull fresh state shortly
      // after to surface the new friendly_name in the list.
      window.setTimeout(() => void fetchStatus(), 800);
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <KioskShell title="Zigbee 設定">
      <div className="grid grid-cols-3 grid-rows-2 gap-4 flex-1 min-h-0">
        {/* Coordinator status */}
        <GridCell tone={status?.coordinator_present ? "ok" : "fail"}>
          <div className="flex flex-col gap-3 h-full justify-center items-center text-center">
            <Radio
              className={
                status?.coordinator_present
                  ? "h-12 w-12 text-emerald-400"
                  : "h-12 w-12 text-rose-400"
              }
            />
            <div className="text-xl font-bold">協調器</div>
            {loading && !status ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : status?.coordinator_present ? (
              <Badge className="bg-emerald-600 text-white">已連線</Badge>
            ) : (
              <Badge variant="destructive">未偵測到</Badge>
            )}
          </div>
        </GridCell>

        {/* Paired device count (tap to view list) */}
        <button
          type="button"
          onClick={() => setListOpen(true)}
          disabled={!status}
          className="rounded-2xl border-2 p-5 flex flex-col items-center justify-center gap-3 bg-card border-border hover:brightness-110 active:scale-[0.98] transition-colors disabled:opacity-60"
        >
          <div className="text-6xl font-bold tabular-nums">
            {status?.device_count ?? "—"}
          </div>
          <div className="text-base text-muted-foreground">已配對裝置</div>
          <div className="text-xs text-muted-foreground">點選查看清單</div>
        </button>

        {/* Pair-mode button (bi-state) */}
        {pairing ? (
          <button
            type="button"
            onClick={stopPairing}
            disabled={pairBusy}
            className="rounded-2xl border-2 p-5 flex flex-col items-center justify-center gap-3 bg-emerald-900/40 border-emerald-500 hover:brightness-110 active:scale-[0.98] transition-colors disabled:opacity-60"
          >
            <div className="flex items-center gap-3">
              <div className="h-3 w-3 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-emerald-300 font-medium text-base">配對中</span>
            </div>
            <div className="text-5xl font-mono font-bold tabular-nums">
              {countdown}s
            </div>
            <div className="text-base">停止配對</div>
          </button>
        ) : (
          <button
            type="button"
            onClick={startPairing}
            disabled={pairBusy || !status?.coordinator_present}
            className="rounded-2xl border-2 p-5 flex flex-col items-center justify-center gap-3 bg-sky-900/30 border-sky-600/70 hover:brightness-110 active:scale-[0.98] transition-colors disabled:opacity-60"
          >
            {pairBusy ? (
              <Loader2 className="h-12 w-12 animate-spin" />
            ) : (
              <Radio className="h-12 w-12 text-sky-300" strokeWidth={2.2} />
            )}
            <div className="text-xl font-bold">開啟配對</div>
            <div className="text-sm text-muted-foreground">60 秒倒數</div>
          </button>
        )}

        {/* Row 2 */}
        <button
          type="button"
          onClick={() => void fetchStatus()}
          disabled={loading}
          className="rounded-2xl border-2 p-5 flex flex-col items-center justify-center gap-3 bg-card border-border hover:brightness-110 active:scale-[0.98] transition-colors disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-12 w-12 animate-spin" />
          ) : (
            <RefreshCw className="h-12 w-12" strokeWidth={2.2} />
          )}
          <div className="text-xl font-bold">重新整理</div>
        </button>
        <EmptyCell />
        <BackCard to="/settings" label="回設定" />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>操作失敗</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Device list dialog. When pair mode is active the list polls every
          2s and the header shows the countdown so the operator stays inside
          this dialog through the whole pairing flow. */}
      <Dialog open={listOpen} onOpenChange={(o) => setListOpen(o)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              已配對裝置
              {pairing && (
                <Badge className="bg-emerald-600 text-white animate-pulse">
                  配對中 · {countdown}s
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {pairing
                ? `共 ${endDevices.length} 個裝置。等待新裝置加入並完成識別…`
                : `共 ${endDevices.length} 個裝置。`}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto -mx-6 px-6 divide-y">
            {endDevices.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">無已配對裝置。</p>
            ) : (
              endDevices.map((d) => {
                // Friendly_name is the preferred "from"/"id" key; the bridge
                // falls back to ieee_address if the friendly_name is empty,
                // so we mirror that here.
                const fromKey = d.friendly_name || d.ieee_address;
                const display = d.friendly_name || d.ieee_address;
                const iv = interviewBadge(deriveInterview(d));
                return (
                  <div
                    key={d.ieee_address}
                    className="py-3 flex items-center justify-between gap-3 px-1"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setRenameError(null);
                        setRenaming({ from: fromKey, current: display });
                      }}
                      className="flex-1 min-w-0 text-left hover:bg-secondary/60 rounded-md p-2 -m-2 transition-colors flex items-center gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate leading-7 py-0.5">{display}</p>
                        <p className="text-xs text-muted-foreground">
                          {d.model || d.type || d.ieee_address}
                        </p>
                      </div>
                      <Pencil className="h-4 w-4 text-muted-foreground shrink-0" />
                    </button>
                    {iv && (
                      <Badge className={`shrink-0 ${iv.cls}`}>{iv.label}</Badge>
                    )}
                    <Badge variant="secondary" className="shrink-0">{d.type || "裝置"}</Badge>
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={() => {
                        setRemoveError(null);
                        setRemoving({ id: fromKey, display });
                      }}
                      className="shrink-0 border-rose-700/60 hover:bg-rose-900/30 text-rose-200"
                      aria-label={`刪除 ${display}`}
                    >
                      <Trash2 className="h-5 w-5" />
                    </Button>
                  </div>
                );
              })
            )}
          </div>
          {renameError && (
            <Alert variant="destructive">
              <AlertDescription>{renameError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" size="lg" onClick={() => setListOpen(false)}>
              關閉
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename keyboard. Carries the device's current friendly_name as the
          initial value so the operator can tweak rather than retype. */}
      <OnScreenKeyboard
        open={renaming !== null && !renameBusy}
        initial={renaming?.current ?? ""}
        title={`重新命名「${renaming?.current ?? ""}」`}
        onCancel={() => setRenaming(null)}
        onConfirm={(v) => void doRename(v)}
      />

      {/* Delete-device confirm. force=true on the backend side so the device
          gets dropped from z2m even if it's unreachable (battery dead). */}
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => { if (!o && !removeBusy) { setRemoving(null); setRemoveError(null); } }}
      >
        <DialogContent className="border-rose-700/60">
          <DialogHeader>
            <DialogTitle className="text-rose-300">刪除裝置</DialogTitle>
            <DialogDescription>
              將從 zigbee2mqtt 移除「{removing?.display ?? ""}」。此操作無法復原，刪除後需重新配對才能再次使用。
            </DialogDescription>
          </DialogHeader>
          {removeError && (
            <Alert variant="destructive">
              <AlertDescription>{removeError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => { setRemoving(null); setRemoveError(null); }}
              disabled={removeBusy}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="lg"
              onClick={() => void doRemove()}
              disabled={removeBusy}
            >
              {removeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              確認刪除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </KioskShell>
  );
}
