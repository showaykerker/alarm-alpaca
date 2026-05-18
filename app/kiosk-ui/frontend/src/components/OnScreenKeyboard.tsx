import { useEffect, useState } from "react";
import { ArrowBigUp, Check, Delete, Space, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// Alphanumeric on-screen keyboard for kiosk text input (chromium-on-cage has
// no native OSK). Three layers: letters, shifted letters, symbols. Designed
// for finger-tap on the 1280x720 landscape panel; keys are h-12 by default
// and the dialog is wide enough that the row of 10 sits comfortably.

type Props = {
  open: boolean;
  initial?: string;
  title?: string;
  // Mask the displayed value with bullets (passwords). The internal value
  // is the raw text either way.
  mask?: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
};

const ROW_DIGITS = "1234567890".split("");
const ROW_QWERTY_TOP = "qwertyuiop".split("");
const ROW_QWERTY_MID = "asdfghjkl".split("");
const ROW_QWERTY_BOT = "zxcvbnm".split("");

// Two rows of symbols. Picked to cover common WiFi PSK characters without
// turning the keyboard into a giant grid. Anything more exotic can still be
// entered by the user via SSH if they really need it.
const ROW_SYM_TOP = "!@#$%^&*()".split("");
const ROW_SYM_MID = "-_=+[]{}:;".split("");
const ROW_SYM_BOT = '"\'<>,.?/'.split("");

type Layer = "letters" | "symbols";

export function OnScreenKeyboard({
  open,
  initial = "",
  title = "輸入",
  mask = false,
  onCancel,
  onConfirm,
}: Props) {
  const [value, setValue] = useState(initial);
  const [shift, setShift] = useState(false);
  const [layer, setLayer] = useState<Layer>("letters");

  useEffect(() => {
    if (open) {
      setValue(initial);
      setShift(false);
      setLayer("letters");
    }
  }, [open, initial]);

  const append = (ch: string) => {
    setValue((v) => (v.length >= 63 ? v : v + ch));
    // Shift auto-releases after one key (mobile-keyboard convention). Caps-lock
    // can be added later if needed — kiosk PSKs rarely have multiple capitals
    // in a row.
    if (shift) setShift(false);
  };
  const backspace = () => setValue((v) => v.slice(0, -1));

  const lettersTop = shift ? ROW_QWERTY_TOP.map((c) => c.toUpperCase()) : ROW_QWERTY_TOP;
  const lettersMid = shift ? ROW_QWERTY_MID.map((c) => c.toUpperCase()) : ROW_QWERTY_MID;
  const lettersBot = shift ? ROW_QWERTY_BOT.map((c) => c.toUpperCase()) : ROW_QWERTY_BOT;

  const keyClass = "h-12 px-0 text-lg font-medium min-w-0";

  const renderKey = (label: string, ch: string = label, extraCls = "") => (
    <Button
      key={label}
      variant="secondary"
      size="default"
      className={cn(keyClass, extraCls)}
      onClick={() => append(ch)}
    >
      {label}
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {/* Display */}
        <div className="rounded-lg px-4 py-3 font-mono text-2xl text-center tabular-nums border-2 border-border min-h-[3rem] break-all">
          {value === "" ? (
            <span className="text-muted-foreground">—</span>
          ) : mask ? (
            "•".repeat(value.length)
          ) : (
            value
          )}
        </div>

        {/* Top row: digits (always visible) */}
        <div className="grid grid-cols-10 gap-1.5 select-none">
          {ROW_DIGITS.map((d) => renderKey(d))}
        </div>

        {layer === "letters" ? (
          <>
            <div className="grid grid-cols-10 gap-1.5 select-none">
              {lettersTop.map((c) => renderKey(c))}
            </div>
            {/* a-l is 9 keys; pad with spacer so the column grid centres */}
            <div className="grid grid-cols-10 gap-1.5 select-none">
              <div />
              {lettersMid.map((c) => renderKey(c))}
            </div>
            <div className="grid grid-cols-10 gap-1.5 select-none">
              <Button
                variant={shift ? "default" : "outline"}
                size="default"
                className={cn(keyClass, "col-span-1")}
                onClick={() => setShift((s) => !s)}
                aria-label="切換大小寫"
              >
                <ArrowBigUp className="h-5 w-5" />
              </Button>
              {lettersBot.map((c) => renderKey(c, c, ""))}
              <Button
                variant="outline"
                size="default"
                className={cn(keyClass, "col-span-2")}
                onClick={backspace}
                aria-label="刪除一字"
              >
                <Delete className="h-5 w-5" />
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-10 gap-1.5 select-none">
              {ROW_SYM_TOP.map((c) => renderKey(c))}
            </div>
            <div className="grid grid-cols-10 gap-1.5 select-none">
              {ROW_SYM_MID.map((c) => renderKey(c))}
            </div>
            <div className="grid grid-cols-10 gap-1.5 select-none">
              {ROW_SYM_BOT.map((c) => renderKey(c))}
              <Button
                variant="outline"
                size="default"
                className={cn(keyClass, "col-span-2")}
                onClick={backspace}
                aria-label="刪除一字"
              >
                <Delete className="h-5 w-5" />
              </Button>
            </div>
          </>
        )}

        {/* Action row */}
        <div className="grid grid-cols-10 gap-1.5 select-none">
          <Button
            variant="outline"
            size="default"
            className={cn(keyClass, "col-span-2 text-sm")}
            onClick={() => setLayer((l) => (l === "letters" ? "symbols" : "letters"))}
          >
            {layer === "letters" ? "?#$" : "ABC"}
          </Button>
          <Button
            variant="secondary"
            size="default"
            className={cn(keyClass, "col-span-6")}
            onClick={() => append(" ")}
            aria-label="空格"
          >
            <Space className="h-5 w-5" />
          </Button>
          <Button
            variant="outline"
            size="default"
            className={cn(keyClass, "col-span-1")}
            onClick={onCancel}
            aria-label="取消"
          >
            <X className="h-5 w-5" />
          </Button>
          <Button
            size="default"
            className={cn(keyClass, "col-span-1")}
            onClick={() => onConfirm(value)}
            aria-label="確定"
            disabled={value.length === 0}
          >
            <Check className="h-5 w-5" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
