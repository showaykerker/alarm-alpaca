import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Minus, Plus, Sun } from "lucide-react";

import { KioskShell } from "@/components/KioskShell";
import { BackCard, EmptyCell, GridCell } from "@/components/PageGrid";
import { cn } from "@/lib/utils";

type Brightness = { present: boolean; value: number; max: number; percent: number };

// Display config: brightness is the only setting today, surfaced as three
// side-by-side tiles per the rework spec — `−` button, value readout,
// `+` button.
//
// Why we step by raw `value` not by percent: the DSI panel's backlight
// exposes only 32 discrete levels (max_brightness=31). At that resolution,
// requesting "20%" quantises to the same hardware value as "19%" and the
// re-read percent comes back unchanged, so percent-based +/- buttons get
// stuck at the same number. Stepping `value` (with a step of ~mx/10) gives
// each click visible progress, and we round the displayed percent to the
// nearest 10 so the number reads cleanly (10, 20, 30, …).
export default function DisplayConfig() {
  const [brightness, setBrightness] = useState<Brightness | null>(null);
  const writeTimer = useRef<number | null>(null);
  const pendingValue = useRef<number | null>(null);

  const fetchBrightness = useCallback(async () => {
    try {
      const r = await fetch("/api/kiosk/brightness");
      if (r.ok) setBrightness(await r.json());
    } catch { /* keep last-good */ }
  }, []);

  useEffect(() => { void fetchBrightness(); }, [fetchBrightness]);

  // Debounced write keyed on the raw sysfs value. We optimistically update
  // the local state so the percent readout flips immediately; the backend
  // round-trip then returns the canonical state. A pending-write ref lets
  // rapid clicks chain off the LATEST target rather than the (possibly
  // stale) rendered state — important because React batches renders.
  const writeBrightnessValue = (value: number) => {
    const max = brightness?.max ?? 1;
    pendingValue.current = value;
    const pct = max > 0 ? Math.round((value / max) * 100) : 0;
    setBrightness((b) => (b ? { ...b, value, percent: pct } : b));
    if (writeTimer.current) window.clearTimeout(writeTimer.current);
    writeTimer.current = window.setTimeout(async () => {
      const target = pendingValue.current;
      if (target == null) return;
      try {
        const r = await fetch("/api/kiosk/brightness", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: target }),
        });
        if (r.ok) setBrightness(await r.json());
      } catch { /* tile stays at the user-chosen value */ }
    }, 120);
  };

  const adjust = (direction: 1 | -1) => {
    if (!brightness?.present) return;
    // Step size = ~10% of the hardware range, rounded but clamped to a
    // minimum of 1 so very coarse panels (mx<10) still move.
    const step = Math.max(1, Math.round(brightness.max / 10));
    const start = pendingValue.current ?? brightness.value;
    const target = start + direction * step;
    const minValue = Math.max(1, Math.round(brightness.max / 20)); // mirror backend 5% floor
    writeBrightnessValue(Math.max(minValue, Math.min(brightness.max, target)));
  };

  const present = brightness?.present ?? false;
  // Displayed percent rounds to the nearest 10 so the panel quantisation
  // doesn't surface as "23%, 26%, 29%" — operator wants clean tens.
  const displayedPct = brightness ? Math.round(brightness.percent / 10) * 10 : 0;
  const minValue = brightness ? Math.max(1, Math.round(brightness.max / 20)) : 1;
  const atMin = present && brightness != null && brightness.value <= minValue;
  const atMax = present && brightness != null && brightness.value >= brightness.max;

  return (
    <KioskShell title="顯示設定">
      <div className="grid grid-cols-3 grid-rows-2 gap-4 flex-1 min-h-0">
        <StepperButton
          icon={<Minus className="h-20 w-20" strokeWidth={3} />}
          ariaLabel="降低亮度"
          disabled={!present || atMin}
          onClick={() => adjust(-1)}
        />

        <GridCell>
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Sun className="h-12 w-12 text-amber-300" />
            {!brightness ? (
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            ) : !present ? (
              <p className="text-base text-muted-foreground text-center px-2">
                找不到背光裝置
              </p>
            ) : (
              <>
                <div className="text-7xl font-bold tabular-nums text-amber-200">
                  {displayedPct}%
                </div>
                <div className="text-sm text-muted-foreground">螢幕亮度</div>
              </>
            )}
          </div>
        </GridCell>

        <StepperButton
          icon={<Plus className="h-20 w-20" strokeWidth={3} />}
          ariaLabel="提高亮度"
          disabled={!present || atMax}
          onClick={() => adjust(1)}
        />

        <EmptyCell />
        <EmptyCell />
        <BackCard to="/settings" label="回設定" />
      </div>
    </KioskShell>
  );
}

function StepperButton({
  icon,
  ariaLabel,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  ariaLabel: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "rounded-2xl border-2 flex items-center justify-center",
        "bg-secondary border-border/80 transition-colors",
        "hover:brightness-110 active:scale-[0.97]",
        "disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100",
      )}
    >
      {icon}
    </button>
  );
}
