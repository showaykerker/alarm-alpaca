import { useEffect, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { KioskShell } from "@/components/KioskShell";
import { NumericKeypad } from "@/components/NumericKeypad";
import { OnScreenKeyboard } from "@/components/OnScreenKeyboard";
import { BackCard, GridCell } from "@/components/PageGrid";
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

// Phone-number editor. Layout follows the spec: left 2-col holds the list +
// numeric keypad trigger, right 1-col is preset button + back-to-settings.
// Persisting is per-edit (no save button) — the operator's mental model is
// "tap to edit, tap trash to remove, tap +".
type PhonesResponse = { phones: string[] };
type PhonePreset = { name: string; phones: string[] };
type PresetsResponse = { presets: PhonePreset[] };
type LoadState = "loading" | "idle" | "saving";

const PHONE_RE = /^\+?\d{3,20}$/;
const isValid = (s: string) => PHONE_RE.test(s.trim());

export default function PhoneConfig() {
  const [state, setState] = useState<LoadState>("loading");
  const [phones, setPhones] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ idx: number; initial: string } | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);

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

        {/* Top-right: preset selector */}
        <button
          type="button"
          onClick={() => setPresetOpen(true)}
          className="rounded-2xl border-2 p-5 flex flex-col items-center justify-center gap-2 bg-sky-900/25 border-sky-600/70 hover:brightness-110 active:scale-[0.98] transition-colors"
        >
          <BookOpen className="h-12 w-12 text-sky-300" strokeWidth={2.2} />
          <div className="text-xl font-bold">預設號碼組</div>
          <div className="text-xs text-muted-foreground">快速切換</div>
        </button>

        <BackCard to="/settings" label="回設定" />
      </div>

      <NumericKeypad
        open={editing !== null}
        initial={editing?.initial ?? ""}
        title={editing?.idx === -1 ? "新增號碼" : `編輯第 ${(editing?.idx ?? 0) + 1} 行`}
        onCancel={() => setEditing(null)}
        onConfirm={onKeypadConfirm}
      />

      <PresetDialog
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        onApply={async (presetPhones) => {
          setPresetOpen(false);
          await persist(presetPhones, "已套用預設");
        }}
      />
    </KioskShell>
  );
}

// ---------------------------------------------------------------------------
// Preset dialog
// ---------------------------------------------------------------------------

type PresetPhase =
  | { kind: "list" }
  | { kind: "confirm-delete"; preset: PhonePreset }
  | { kind: "edit-name"; preset: PhonePreset | null }
  | { kind: "edit-phones"; name: string; phones: string[] }
  | { kind: "edit-phone-keypad"; name: string; phones: string[]; idx: number; initial: string };

function PresetDialog({
  open,
  onClose,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  onApply: (phones: string[]) => Promise<void>;
}) {
  const [presets, setPresets] = useState<PhonePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<PresetPhase>({ kind: "list" });

  const fetchPresets = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/phones/presets");
      if (r.ok) {
        const data: PresetsResponse = await r.json();
        setPresets(data.presets);
      }
    } catch { /* */ }
    setLoading(false);
  };

  useEffect(() => {
    if (open) {
      setPhase({ kind: "list" });
      void fetchPresets();
    }
  }, [open]);

  const savePreset = async (name: string, phones: string[]) => {
    try {
      const r = await fetch("/api/phones/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phones }),
      });
      if (r.ok) {
        const data: PresetsResponse = await r.json();
        setPresets(data.presets);
        toast.success(`已儲存預設「${name}」`);
      }
    } catch (e) {
      toast.error(`儲存失敗：${e instanceof Error ? e.message : String(e)}`);
    }
    setPhase({ kind: "list" });
  };

  const deletePreset = async (name: string) => {
    try {
      const r = await fetch(`/api/phones/presets/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (r.ok) {
        const data: PresetsResponse = await r.json();
        setPresets(data.presets);
        toast.success(`已刪除預設「${name}」`);
      }
    } catch (e) {
      toast.error(`刪除失敗：${e instanceof Error ? e.message : String(e)}`);
    }
    setPhase({ kind: "list" });
  };

  const dialogOpen = open && phase.kind !== "edit-name" && phase.kind !== "edit-phone-keypad";

  return (
    <>
      {/* Main preset list */}
      <Dialog open={dialogOpen && phase.kind === "list"} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>預設號碼組</DialogTitle>
            <DialogDescription>
              選擇一組預設套用，或新增 / 編輯預設。
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[50vh] overflow-y-auto -mx-6 px-6 divide-y">
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : presets.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                尚無預設。按下「＋ 新增預設」建立第一組。
              </p>
            ) : (
              presets.map((p) => (
                <div
                  key={p.name}
                  className="flex items-center gap-2 py-3 px-1 hover:bg-secondary/60 rounded-md transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => void onApply(p.phones)}
                    className="flex-1 min-w-0 text-left px-2 mx-2"
                  >
                    <div className="font-semibold text-xl truncate leading-9 py-0.5">
                      {p.name}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      {p.phones.join(", ") || "（無號碼）"}
                    </div>
                  </button>
                  <Badge variant="secondary" className="shrink-0 text-xs">
                    {p.phones.length} 號
                  </Badge>
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => setPhase({ kind: "edit-phones", name: p.name, phones: [...p.phones] })}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => setPhase({ kind: "confirm-delete", preset: p })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                const existing = new Set(presets.map((p) => p.name));
                let n = presets.length;
                let name: string;
                do { name = `default set ${n++}`; } while (existing.has(name));
                setPhase({ kind: "edit-phones", name, phones: [] });
              }}
            >
              <Plus className="h-4 w-4" />
              新增預設
            </Button>
            <Button size="lg" onClick={onClose}>
              關閉
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={dialogOpen && phase.kind === "confirm-delete"}
        onOpenChange={(o) => { if (!o) setPhase({ kind: "list" }); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              刪除「{phase.kind === "confirm-delete" ? phase.preset.name : ""}」？
            </DialogTitle>
            <DialogDescription>
              將永久移除此預設，無法復原。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => setPhase({ kind: "list" })}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="lg"
              onClick={() => {
                if (phase.kind !== "confirm-delete") return;
                void deletePreset(phase.preset.name);
              }}
            >
              <Trash2 className="h-4 w-4" />
              刪除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit phones sub-dialog */}
      <Dialog
        open={dialogOpen && phase.kind === "edit-phones"}
        onOpenChange={(o) => { if (!o) setPhase({ kind: "list" }); }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              <span className="shrink-0">編輯預設：</span>
              <button
                type="button"
                onClick={() => {
                  if (phase.kind === "edit-phones")
                    setPhase({ kind: "edit-name", preset: { name: phase.name, phones: phase.phones } });
                }}
                className="text-2xl font-bold px-3 py-1 underline underline-offset-4 decoration-dashed decoration-muted-foreground/50 hover:decoration-foreground transition-colors"
              >
                {phase.kind === "edit-phones" ? phase.name : ""}
              </button>
              <Pencil className="h-4 w-4 text-muted-foreground" />
            </DialogTitle>
            <DialogDescription>
              新增或移除此預設中的號碼。點名稱可改名。
            </DialogDescription>
          </DialogHeader>
          {phase.kind === "edit-phones" && (
            <PresetPhoneEditor
              phones={phase.phones}
              onChange={(next) => setPhase({ ...phase, phones: next })}
              onEditPhone={(idx, initial) =>
                setPhase({ kind: "edit-phone-keypad", name: phase.name, phones: phase.phones, idx, initial })
              }
            />
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => setPhase({ kind: "list" })}
            >
              取消
            </Button>
            <Button
              size="lg"
              onClick={() => {
                if (phase.kind !== "edit-phones") return;
                void savePreset(phase.name, phase.phones);
              }}
            >
              儲存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Name input keyboard (rename from edit-phones title tap) */}
      <OnScreenKeyboard
        open={phase.kind === "edit-name"}
        initial={phase.kind === "edit-name" && phase.preset ? phase.preset.name : ""}
        title="Rename preset"
        onCancel={() => {
          if (phase.kind !== "edit-name" || !phase.preset) { setPhase({ kind: "list" }); return; }
          setPhase({ kind: "edit-phones", name: phase.preset.name, phones: phase.preset.phones });
        }}
        onConfirm={(name) => {
          if (!name.trim()) return;
          if (phase.kind !== "edit-name") return;
          const phones = phase.preset?.phones ?? [];
          setPhase({ kind: "edit-phones", name: name.trim(), phones });
        }}
      />

      {/* Numeric keypad for editing a single phone within a preset */}
      <NumericKeypad
        open={phase.kind === "edit-phone-keypad"}
        initial={phase.kind === "edit-phone-keypad" ? phase.initial : ""}
        title={
          phase.kind === "edit-phone-keypad"
            ? phase.idx === -1
              ? "新增號碼"
              : `編輯第 ${phase.idx + 1} 行`
            : ""
        }
        onCancel={() => {
          if (phase.kind !== "edit-phone-keypad") return;
          setPhase({ kind: "edit-phones", name: phase.name, phones: phase.phones });
        }}
        onConfirm={(value) => {
          if (phase.kind !== "edit-phone-keypad") return;
          const v = value.trim();
          const next =
            phase.idx === -1
              ? [...phase.phones, v]
              : phase.phones.map((x, i) => (i === phase.idx ? v : x));
          setPhase({ kind: "edit-phones", name: phase.name, phones: next });
        }}
      />
    </>
  );
}

function PresetPhoneEditor({
  phones,
  onChange,
  onEditPhone,
}: {
  phones: string[];
  onChange: (phones: string[]) => void;
  onEditPhone: (idx: number, initial: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="max-h-[40vh] overflow-y-auto space-y-2 pr-1">
        {phones.length === 0 ? (
          <p className="text-muted-foreground text-center py-4">
            尚無號碼。按下「＋ 新增」加入。
          </p>
        ) : (
          phones.map((value, idx) => (
            <div key={`${idx}-${value}`} className="flex items-center gap-2">
              <span className="w-7 text-right text-sm text-muted-foreground tabular-nums">
                {idx + 1}.
              </span>
              <button
                type="button"
                onClick={() => onEditPhone(idx, value)}
                className={
                  "flex-1 text-left rounded-md px-3 py-2.5 font-mono text-lg tabular-nums " +
                  "bg-secondary hover:bg-secondary/80 transition-colors " +
                  (!isValid(value) ? "ring-2 ring-destructive" : "")
                }
              >
                {value}
              </button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => onChange(phones.filter((_, i) => i !== idx))}
              >
                <Trash2 className="h-5 w-5" />
              </Button>
            </div>
          ))
        )}
      </div>
      <Button
        variant="outline"
        size="lg"
        onClick={() => onEditPhone(-1, "")}
        className="w-full"
      >
        <Plus className="h-5 w-5" />
        新增
      </Button>
    </div>
  );
}
