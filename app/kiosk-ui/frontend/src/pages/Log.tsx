import { useCallback, useEffect, useState } from "react";
import { Eraser, Loader2 } from "lucide-react";

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

type KioskEvent = { timestamp: string; category: string; text: string };
const REFRESH_MS = 8000;

function categoryDot(cat: string) {
  switch (cat) {
    case "alarm":    return "bg-rose-500";
    case "battery":  return "bg-amber-500";
    case "selftest": return "bg-sky-500";
    case "link":     return "bg-amber-500";
    default:         return "bg-slate-500";
  }
}

export default function LogPage() {
  const [events, setEvents] = useState<KioskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    try {
      const r = await fetch("/api/kiosk/events?n=100");
      if (r.ok) {
        const data = await r.json();
        setEvents(data.events ?? []);
      }
    } catch { /* keep last-good */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchEvents();
    const id = window.setInterval(() => void fetchEvents(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [fetchEvents]);

  const doClear = async () => {
    setClearing(true);
    setErr(null);
    try {
      const r = await fetch("/api/kiosk/events/clear", { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.detail ?? `HTTP ${r.status}`);
      }
      setEvents([]);
      await fetchEvents();
      setConfirmClear(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  };

  return (
    <KioskShell title="事件紀錄">
      <div className="grid grid-cols-3 grid-rows-2 gap-4 flex-1 min-h-0">
        {/* Left (2 cols × 2 rows): event list. */}
        <GridCell className="col-span-2 row-span-2 bg-card/80">
          {loading && events.length === 0 ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : events.length === 0 ? (
            <p className="text-muted-foreground text-center py-12 text-lg">
              目前沒有事件紀錄。
            </p>
          ) : (
            <ul className="divide-y divide-border overflow-y-auto h-full min-h-0">
              {events.map((e, i) => (
                <li key={i} className="flex items-start gap-3 py-2.5 px-1">
                  <span
                    className={cn(
                      "h-3 w-3 rounded-full shrink-0 mt-2",
                      categoryDot(e.category),
                    )}
                  />
                  <span className="text-xs text-muted-foreground tabular-nums w-44 shrink-0 pt-0.5">
                    {e.timestamp}
                  </span>
                  <span className="text-base leading-tight">{e.text}</span>
                </li>
              ))}
            </ul>
          )}
        </GridCell>

        {/* Top-right: full-height clear button. The whole cell is one
            press-target so a fingertip lands easily; helper text moves
            inside the button itself. */}
        <button
          type="button"
          onClick={() => setConfirmClear(true)}
          disabled={events.length === 0}
          className={cn(
            "rounded-2xl border-2 p-5 flex flex-col items-center justify-center gap-3",
            "bg-secondary border-border/80 transition-colors",
            "hover:brightness-110 active:scale-[0.98]",
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100",
          )}
        >
          <Eraser className="h-14 w-14" strokeWidth={2.2} />
          <div className="text-2xl font-bold">清除紀錄</div>
          <p className="text-xs text-muted-foreground text-center px-2 leading-relaxed">
            僅清除畫面顯示；系統日誌仍保留。
          </p>
        </button>

        <BackCard to="/" label="回主頁" />
      </div>

      <Dialog
        open={confirmClear}
        onOpenChange={(o) => {
          if (!o) {
            setConfirmClear(false);
            setErr(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清除事件清單？</DialogTitle>
            <DialogDescription>
              清單將會清空，但系統紀錄仍保留（管理員可透過 SSH 查看）。
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
                setConfirmClear(false);
                setErr(null);
              }}
              disabled={clearing}
            >
              取消
            </Button>
            <Button size="lg" onClick={doClear} disabled={clearing}>
              {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}
              清除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </KioskShell>
  );
}
