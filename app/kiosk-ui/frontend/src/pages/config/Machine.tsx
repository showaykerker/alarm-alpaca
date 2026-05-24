import { useEffect, useRef, useState } from "react";
import { FlaskConical, Loader2, Power, RefreshCw, Send, Stethoscope } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { KioskShell } from "@/components/KioskShell";
import { BackCard } from "@/components/PageGrid";
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

type PowerAction = "poweroff" | "reboot";

const POWER_LABEL: Record<PowerAction, string> = {
  poweroff: "關機",
  reboot: "重新開機",
};

type SmokeTarget = "discord" | "tas" | "zigbee";

const SMOKE_DETAIL: Record<SmokeTarget, string> = {
  discord: "傳送測試訊息到 Discord（USER + SYSTEM 兩個 channel）。",
  tas: "撥打真正的 TAS 緊急電話到所有號碼。確認前再次三思。",
  zigbee: "模擬一次 Zigbee 按鈕事件，驗證 MQTT 流程不會誤呼叫 TAS。",
};

// Machine ops:
//   row1: alarm-doctor · alarm-smoke · empty
//   row2: 重新開機 · 關機 · 回設定
// Power dialog runs a 3-second countdown before firing the request; smoke
// targets pop a confirm dialog (with a louder warning for TAS, which
// actually places a phone call). All paths return to /settings via back.
export default function MachineConfig() {
  const [pending, setPending] = useState<PowerAction | null>(null);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [smokeOpen, setSmokeOpen] = useState(false);

  return (
    <KioskShell title="機器操作" tone="warn">
      <div className="grid grid-cols-3 grid-rows-2 gap-4 flex-1 min-h-0">
        <ActionTile
          label="健康檢查"
          subtitle="alarm-doctor"
          icon={<Stethoscope className="h-12 w-12 text-emerald-300" strokeWidth={2.2} />}
          tone="ok"
          onClick={() => setDoctorOpen(true)}
        />
        <ActionTile
          label="煙霧測試"
          subtitle="alarm-smoke"
          icon={<FlaskConical className="h-12 w-12 text-amber-300" strokeWidth={2.2} />}
          tone="warn"
          onClick={() => setSmokeOpen(true)}
        />
        <EngEasterEgg />

        <ActionTile
          label="重新開機"
          icon={<RefreshCw className="h-12 w-12 text-amber-300" strokeWidth={2.2} />}
          tone="warn"
          onClick={() => setPending("reboot")}
        />
        <ActionTile
          label="關機"
          icon={<Power className="h-12 w-12 text-rose-300" strokeWidth={2.2} />}
          tone="danger"
          onClick={() => setPending("poweroff")}
        />
        <BackCard to="/settings" label="回設定" />
      </div>

      <PowerConfirmDialog action={pending} onClose={() => setPending(null)} />
      <DoctorDialog open={doctorOpen} onClose={() => setDoctorOpen(false)} />
      <SmokeDialog open={smokeOpen} onClose={() => setSmokeOpen(false)} />
    </KioskShell>
  );
}

function ActionTile({
  label,
  subtitle,
  icon,
  tone,
  onClick,
}: {
  label: string;
  subtitle?: string;
  icon: React.ReactNode;
  tone: "warn" | "danger" | "ok";
  onClick: () => void;
}) {
  const cls =
    tone === "danger"
      ? "bg-rose-950/40 border-rose-700"
      : tone === "warn"
        ? "bg-amber-900/25 border-amber-600/70"
        : "bg-emerald-900/25 border-emerald-600/70";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-2xl border-2 p-5 flex flex-col items-center justify-center gap-2 ${cls} hover:brightness-110 active:scale-[0.98] transition-colors`}
    >
      {icon}
      <div className="text-2xl font-bold">{label}</div>
      {subtitle && (
        <div className="text-xs font-mono text-muted-foreground">{subtitle}</div>
      )}
    </button>
  );
}

function PowerConfirmDialog({
  action,
  onClose,
}: {
  action: PowerAction | null;
  onClose: () => void;
}) {
  // 5-second countdown (was 3s): touchscreens get bumped, and reboot/
  // shutdown are irreversible-on-cage-restart for the on-device kiosk
  // experience. Extra two seconds is plenty for the operator to notice
  // and tap 取消.
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fired = useRef(false);

  useEffect(() => {
    if (action === null) return;
    setCount(5);
    setBusy(false);
    setErr(null);
    fired.current = false;
  }, [action]);

  useEffect(() => {
    if (action === null || busy || err) return;
    if (count <= 0) {
      if (fired.current) return;
      fired.current = true;
      setBusy(true);
      fetch(`/api/system/${action}`, { method: "POST" })
        .then(async (r) => {
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body?.detail ?? `HTTP ${r.status}`);
          }
        })
        .catch((e) => {
          setErr(e instanceof Error ? e.message : String(e));
          setBusy(false);
          fired.current = false;
        });
      return;
    }
    const id = window.setTimeout(() => setCount((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [action, count, busy, err]);

  const open = action !== null;
  const label = action ? POWER_LABEL[action] : "";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="border-amber-600/60">
        <DialogHeader>
          <DialogTitle className="text-amber-300">確認{label}</DialogTitle>
          <DialogDescription className="text-base">
            {err
              ? "請求失敗，請重試或檢查連線。"
              : busy
                ? `正在${label}…`
                : `${count} 秒後${label}。按下「取消」可中止。`}
          </DialogDescription>
        </DialogHeader>
        {err && (
          <Alert variant="destructive">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}
        {!err && !busy && (
          <div className="flex items-center justify-center py-4">
            <div className="text-7xl font-bold tabular-nums text-amber-300">{count}</div>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            size="xl"
            className="flex-1"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Per-line tone based on alarm-doctor's symbol markers + smoke-script
// output cues. alarm-doctor strips ANSI when stdout isn't a tty, so the
// `✓ / ⚠ / ✗` symbols are what we key off; for smoke scripts we additionally
// catch `[ERROR]` / `[exit code: N]` markers so the dialog reads naturally.
function logLineClass(line: string): string {
  if (/^\s*✗|✗ |✗$|\[ERROR\]/.test(line)) return "text-rose-300";
  if (/^\s*⚠|⚠ |⚠$|WARN|WARNING/.test(line)) return "text-amber-300";
  if (/^\s*✓|✓ |✓$|\bok\b|\bdone\b/.test(line)) return "text-emerald-300";
  if (/^==/.test(line)) return "text-sky-300 font-bold";
  if (/^\[exit code:/.test(line)) {
    return /\[exit code: 0\]/.test(line) ? "text-emerald-300" : "text-rose-300";
  }
  return "text-foreground/85";
}

// Colored log view used by both Doctor and Smoke dialogs. Splits on
// newlines and emits a coloured row per line.
function ColoredLog({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="bg-background/60 rounded-md p-3 text-xs font-mono max-h-[55vh] overflow-auto whitespace-pre-wrap break-all leading-tight">
      {lines.map((line, i) => (
        <div key={i} className={logLineClass(line)}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

// Health-check dialog: runs alarm-doctor, shows the captured stdout in a
// pre block. Operators use this to triage "is something obviously wrong?"
// without having to ssh in for a manual journalctl + nmcli + vcgencmd dance.
function DoctorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  // stdout is kept separately from the combined display string so we can send
  // exactly what alarm-doctor produced (without the "--- stderr ---" banner)
  // to the Discord endpoint, which parses it back into sections.
  const [stdout, setStdout] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [rc, setRc] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setStdout(null);
      setOutput(null);
      setRc(null);
      setErr(null);
      setSending(false);
      return;
    }
    void runDoctor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const runDoctor = async () => {
    setBusy(true);
    setErr(null);
    setStdout(null);
    setOutput(null);
    setRc(null);
    try {
      const r = await fetch("/api/alarm/doctor", { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.detail ?? `HTTP ${r.status}`);
      }
      const data = await r.json();
      setStdout(data.stdout ?? "");
      setOutput(`${data.stdout}\n${data.stderr ? `\n--- stderr ---\n${data.stderr}` : ""}`);
      setRc(data.returncode);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // If alarm-doctor flagged the system webhook as failed/unreachable, the
  // send-discord endpoint will only error out — disable the button up-front
  // so the operator gets the signal without having to tap and read a toast.
  // The regex matches both ✗ (fail) and ⚠ (warn / not loaded).
  const discordSystemDown =
    stdout != null && /[✗⚠]\s+Discord system webhook/.test(stdout);

  const sendToDiscord = async () => {
    if (stdout == null || rc == null) return;
    setSending(true);
    try {
      const r = await fetch("/api/alarm/doctor/send-discord", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stdout, returncode: rc }),
      });
      const data: { ok?: boolean; status_code?: number; error?: string; detail?: string } =
        await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        throw new Error(data.error ?? data.detail ?? `HTTP ${r.status}`);
      }
      toast.success("健康檢查結果已傳送到 Discord");
    } catch (e) {
      toast.error(`傳送失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>系統健康檢查</DialogTitle>
          <DialogDescription>
            執行 alarm-doctor，檢查服務、網路、MQTT、Zigbee 與系統指標。
          </DialogDescription>
        </DialogHeader>
        {err && (
          <Alert variant="destructive">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}
        {busy && !output ? (
          <div className="flex items-center justify-center py-8 gap-3">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-muted-foreground">執行中…</span>
          </div>
        ) : output ? (
          <ColoredLog text={output} />
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="lg" onClick={runDoctor} disabled={busy || sending}>
            <RefreshCw className="h-4 w-4" />
            重新執行
          </Button>
          <Button
            variant="outline"
            size="lg"
            onClick={sendToDiscord}
            loading={sending}
            disabled={busy || stdout == null || rc == null || discordSystemDown}
            title={discordSystemDown ? "Discord 系統 webhook 連線失敗" : undefined}
          >
            <Send className="h-4 w-4" />
            {discordSystemDown ? "Discord 連線失敗" : "傳送到 Discord"}
          </Button>
          <Button size="lg" onClick={onClose} disabled={sending}>
            {rc != null && rc !== 0 ? `關閉 (rc=${rc})` : "關閉"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// SmokeDialog: pick a target, optionally confirm, then stream the smoke
// script's stdout into a colored log view until it exits (or the user
// aborts). alarm-bridge is paused for the duration; OnSuccess/OnFailure on
// the systemd-run unit brings it back on completion.
function SmokeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  type Phase = "picker" | "confirm" | "streaming" | "done";
  const [phase, setPhase] = useState<Phase>("picker");
  const [target, setTarget] = useState<SmokeTarget | null>(null);
  const [output, setOutput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) return;
    // Closing the dialog resets all phase state AND aborts any in-flight
    // stream so a half-finished smoke run doesn't keep firing in the
    // background.
    setPhase("picker");
    setTarget(null);
    setOutput("");
    setErr(null);
    abortRef.current?.abort();
    abortRef.current = null;
  }, [open]);

  const startStream = async (explicitTarget?: SmokeTarget) => {
    // Accept an explicit target so callers from pickTarget can run the
    // smoke immediately without waiting for the setTarget state update to
    // flush. Without this, discord/zigbee picks read target === null and
    // bail before the request fires.
    const t = explicitTarget ?? target;
    if (!t) return;
    setPhase("streaming");
    setOutput("");
    setErr(null);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const r = await fetch("/api/alarm/smoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: t }),
        signal: ctl.signal,
      });
      if (!r.ok || !r.body) {
        const text = await r.text().catch(() => "");
        throw new Error(text || `HTTP ${r.status}`);
      }
      // Read the response body as a stream of UTF-8 chunks and append to
      // the dialog's output buffer. TextDecoder with `stream: true` handles
      // multibyte characters that span chunk boundaries.
      const reader = r.body.getReader();
      const decoder = new TextDecoder("utf-8");
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setOutput((prev) => prev + chunk);
      }
      setOutput((prev) => prev + decoder.decode());
      setPhase("done");
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("done");
    } finally {
      abortRef.current = null;
    }
  };

  const pickTarget = (t: SmokeTarget) => {
    setTarget(t);
    // TAS gets an extra warn-screen; everything else goes straight to
    // streaming. (You can still cancel via "返回選擇".)
    setPhase(t === "tas" ? "confirm" : "streaming");
    if (t !== "tas") void startStream(t);
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("done");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            煙霧測試{target ? ` · ${target}` : ""}
          </DialogTitle>
          <DialogDescription>
            {phase === "picker"
              ? "選擇要測試的整合點。測試期間 alarm-bridge 會暫停。"
              : SMOKE_DETAIL[target!]}
          </DialogDescription>
        </DialogHeader>

        {phase === "picker" && (
          <div className="grid grid-cols-1 gap-3 py-2">
            {(["discord", "zigbee", "tas"] as SmokeTarget[]).map((t) => (
              <Button
                key={t}
                variant={t === "tas" ? "destructive" : "outline"}
                size="xl"
                onClick={() => pickTarget(t)}
                className="justify-start text-left h-auto py-3"
              >
                <div className="flex flex-col items-start gap-0.5">
                  <span className="text-lg font-bold">
                    {t === "tas" ? "📞 TAS（真實撥號）" : t === "discord" ? "💬 Discord" : "📡 Zigbee"}
                  </span>
                  <span className="text-xs opacity-80 whitespace-normal">
                    {SMOKE_DETAIL[t]}
                  </span>
                </div>
              </Button>
            ))}
          </div>
        )}

        {phase === "confirm" && target === "tas" && (
          <Alert variant="destructive">
            <AlertDescription>
              ⚠️ 此選項會撥打真正的 TAS 緊急電話到所有設定的號碼。請確認所有相關人員都知情。
            </AlertDescription>
          </Alert>
        )}

        {(phase === "streaming" || phase === "done") && (
          <>
            {err && (
              <Alert variant="destructive">
                <AlertDescription>{err}</AlertDescription>
              </Alert>
            )}
            <ColoredLog text={output || "啟動中…"} />
            {phase === "streaming" && (
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                測試進行中，可隨時按下「停止」中斷。
              </p>
            )}
          </>
        )}

        <DialogFooter>
          {phase === "picker" && (
            <Button size="lg" onClick={onClose}>
              關閉
            </Button>
          )}
          {phase === "confirm" && (
            <>
              <Button
                variant="outline"
                size="lg"
                onClick={() => { setTarget(null); setPhase("picker"); }}
              >
                返回選擇
              </Button>
              <Button size="lg" variant="destructive" onClick={() => void startStream()}>
                確認執行
              </Button>
            </>
          )}
          {phase === "streaming" && (
            <Button variant="outline" size="lg" onClick={stop}>
              停止
            </Button>
          )}
          {phase === "done" && (
            <Button size="lg" onClick={onClose}>
              關閉
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ENG_TAPS = 20;
const ENG_WINDOW_MS = 8000;

function EngEasterEgg() {
  const navigate = useNavigate();
  const tapsRef = useRef<number[]>([]);

  const handleTap = () => {
    const now = Date.now();
    tapsRef.current = tapsRef.current.filter((t) => now - t < ENG_WINDOW_MS);
    tapsRef.current.push(now);
    if (tapsRef.current.length >= ENG_TAPS) {
      tapsRef.current = [];
      navigate("/eng");
    }
  };

  return (
    <button
      type="button"
      onClick={handleTap}
      className="rounded-2xl bg-transparent"
      aria-hidden="true"
    />
  );
}
