import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// chromium-on-cage has no on-screen keyboard, so any text input in the kiosk
// has to bring its own. This is the phone-number keypad — digits + leading
// `+` for international, no separators (the backend regex tolerates them but
// users on a 5-inch panel don't want to deal with them).

type Props = {
  open: boolean;
  initial?: string;
  title?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
};

const KEYS: { label: string; value: string; kind?: "digit" | "plus" | "del" }[][] = [
  [{ label: "1", value: "1" }, { label: "2", value: "2" }, { label: "3", value: "3" }],
  [{ label: "4", value: "4" }, { label: "5", value: "5" }, { label: "6", value: "6" }],
  [{ label: "7", value: "7" }, { label: "8", value: "8" }, { label: "9", value: "9" }],
  [{ label: "+", value: "+", kind: "plus" }, { label: "0", value: "0" }, { label: "⌫", value: "del", kind: "del" }],
];

const PHONE_RE = /^\+?\d{3,20}$/;

export function NumericKeypad({ open, initial = "", title = "輸入號碼", onCancel, onConfirm }: Props) {
  const [value, setValue] = useState(initial);

  // Reset to initial whenever the keypad opens for a new field.
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  const press = (k: { value: string; kind?: string }) => {
    if (k.kind === "del") {
      setValue((v) => v.slice(0, -1));
    } else if (k.value === "+") {
      // `+` only meaningful as first character; tap toggles it.
      setValue((v) => (v.startsWith("+") ? v.slice(1) : `+${v}`));
    } else {
      setValue((v) => (v.length >= 20 ? v : v + k.value));
    }
  };

  const valid = PHONE_RE.test(value);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {/* Display */}
        <div
          className={cn(
            "rounded-lg px-4 py-4 font-mono text-3xl text-center tabular-nums border-2 min-h-[3.5rem]",
            value === "" ? "text-muted-foreground" : valid ? "border-border" : "border-destructive"
          )}
        >
          {value === "" ? "—" : value}
        </div>

        {/* Keypad */}
        <div className="grid grid-cols-3 gap-2 select-none">
          {KEYS.flat().map((k) => (
            <Button
              key={k.label}
              variant={k.kind === "del" ? "outline" : k.kind === "plus" ? "secondary" : "default"}
              size="xl"
              className="h-16 text-2xl font-bold"
              onClick={() => press(k)}
            >
              {k.label}
            </Button>
          ))}
        </div>

        {/* Confirm / cancel */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <Button variant="outline" size="xl" className="h-14 text-lg" onClick={onCancel}>
            <X className="h-5 w-5" />
            取消
          </Button>
          <Button
            size="xl"
            className="h-14 text-lg"
            disabled={!valid}
            onClick={() => onConfirm(value)}
          >
            <Check className="h-5 w-5" />
            確定
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
