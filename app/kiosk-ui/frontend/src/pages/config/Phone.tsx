import { useEffect, useState } from "react";
import { AlertCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { KioskShell } from "@/components/KioskShell";
import { NumericKeypad } from "@/components/NumericKeypad";
import { BackCard, EmptyCell, GridCell } from "@/components/PageGrid";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Phone-number editor. Layout follows the spec: left 2-col holds the list +
// numeric keypad trigger, right 1-col is empty + back-to-settings. Persisting
// is per-edit (no save button) — the operator's mental model is "tap to
// edit, tap trash to remove, tap +".
type PhonesResponse = { phones: string[] };
type LoadState = "loading" | "idle" | "saving";

const PHONE_RE = /^\+?\d{3,20}$/;
const isValid = (s: string) => PHONE_RE.test(s.trim());

export default function PhoneConfig() {
  const [state, setState] = useState<LoadState>("loading");
  const [phones, setPhones] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ idx: number; initial: string } | null>(null);

  const fetchPhones = async () => {
    setState("loading");
    setError(null);
    try {
      const r = await fetch("/api/phones");
      if (!r.ok) throw new Error(`GET /api/phones ${r.status}`);
      const data: PhonesResponse = await r.json();
      setPhones(data.phones);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setState("idle");
    }
  };

  useEffect(() => { void fetchPhones(); }, []);

  const persist = async (next: string[], successMsg: string) => {
    setState("saving");
    setError(null);
    try {
      const cleaned = next.map((s) => s.trim()).filter((s) => s !== "");
      const r = await fetch("/api/phones", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: cleaned }),
      });
      if (r.status === 422) {
        const body = await r.json().catch(() => ({}));
        const bad: { index: number }[] = body?.detail?.invalid ?? [];
        const msg = `有 ${bad.length} 個號碼格式不正確，未儲存`;
        setError(msg);
        toast.error(msg);
        return;
      }
      if (!r.ok) throw new Error(`PUT /api/phones ${r.status}`);
      const data: PhonesResponse = await r.json();
      setPhones(data.phones);
      toast.success(successMsg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(`儲存失敗：${msg}`);
    } finally {
      setState("idle");
    }
  };

  const openAdd = () => setEditing({ idx: -1, initial: "" });
  const openEdit = (idx: number) => setEditing({ idx, initial: phones[idx] ?? "" });

  const onKeypadConfirm = async (value: string) => {
    if (editing == null) return;
    const v = value.trim();
    const adding = editing.idx === -1;
    const next = adding
      ? [...phones, v]
      : phones.map((x, i) => (i === editing.idx ? v : x));
    setEditing(null);
    await persist(next, adding ? `已新增 ${v}` : `已更新 ${v}`);
  };

  const removeAt = async (idx: number) => {
    const removed = phones[idx] ?? "";
    await persist(
      phones.filter((_, i) => i !== idx),
      `已移除 ${removed}`,
    );
  };

  return (
    <KioskShell title="通知電話">
      <div className="grid grid-cols-3 grid-rows-2 gap-4 flex-1 min-h-0">
        {/* Left 2x2: phone list + add */}
        <GridCell className="col-span-2 row-span-2 bg-card/80">
          <div className="flex items-center gap-3 shrink-0 mb-3">
            <Badge variant={phones.length > 0 ? "default" : "destructive"}>
              {phones.length} 個號碼
            </Badge>
            {state === "saving" && (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            )}
            <span className="text-sm text-muted-foreground">
              點號碼可以編輯，按下垃圾桶刪除。
            </span>
          </div>

          {error && (
            <Alert variant="destructive" className="shrink-0 mb-2">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>操作失敗</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
            {state === "loading" && phones.length === 0 ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : phones.length === 0 ? (
              <p className="text-muted-foreground text-center py-8 text-lg">
                尚未設定任何號碼。
              </p>
            ) : (
              phones.map((value, idx) => {
                const bad = !isValid(value);
                return (
                  <div key={`${idx}-${value}`} className="flex items-center gap-2">
                    <span className="w-8 text-right text-base text-muted-foreground tabular-nums">
                      {idx + 1}.
                    </span>
                    <button
                      type="button"
                      onClick={() => openEdit(idx)}
                      disabled={state === "saving"}
                      className={
                        "flex-1 text-left rounded-md px-4 py-3 font-mono text-xl tabular-nums " +
                        "bg-secondary hover:bg-secondary/80 transition-colors disabled:opacity-60 " +
                        (bad ? "ring-2 ring-destructive" : "")
                      }
                    >
                      {value}
                    </button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => removeAt(idx)}
                      disabled={state === "saving"}
                      aria-label={`刪除第 ${idx + 1} 行`}
                    >
                      <Trash2 className="h-6 w-6" />
                    </Button>
                  </div>
                );
              })
            )}
          </div>

          <Button
            variant="outline"
            size="xl"
            onClick={openAdd}
            disabled={state === "saving" || state === "loading"}
            className="w-full h-14 text-lg shrink-0 mt-3"
          >
            <Plus className="h-6 w-6" />
            新增號碼
          </Button>
        </GridCell>

        {/* Top-right: reserved for a future control (per spec). */}
        <EmptyCell />

        <BackCard to="/settings" label="回設定" />
      </div>

      <NumericKeypad
        open={editing !== null}
        initial={editing?.initial ?? ""}
        title={editing?.idx === -1 ? "新增號碼" : `編輯第 ${(editing?.idx ?? 0) + 1} 行`}
        onCancel={() => setEditing(null)}
        onConfirm={onKeypadConfirm}
      />
    </KioskShell>
  );
}
