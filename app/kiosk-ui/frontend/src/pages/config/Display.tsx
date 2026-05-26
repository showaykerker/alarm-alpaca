import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Minus, Moon, MoonStar, Plus, Sun } from "lucide-react";

import { KioskShell } from "@/components/KioskShell";
import { BackCard, EmptyCell } from "@/components/PageGrid";
import { cn } from "@/lib/utils";

type Brightness = { present: boolean; value: number; max: number; percent: number };
type SleepConfig = { timeout_minutes: number; sleep_brightness_pct: number };

export default function DisplayConfig() {
  // --- Brightness ---
  const [brightness, setBrightness] = useState<Brightness | null>(null);
  const writeTimer = useRef<number | null>(null);
  const pendingValue = useRef<number | null>(null);

  const fetchBrightness = useCallback(async () => {
    try {
      const r = await fetch("/api/kiosk/brightness");
      if (r.ok) setBrightness(await r.json());
    } catch {
      /* keep last-good */
    }
  }, []);

  useEffect(() => {
    void fetchBrightness();
  }, [fetchBrightness]);

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
      } catch {
        /* tile stays at the user-chosen value */
      }
    }, 120);
  };

  const adjustBrightness = (direction: 1 | -1) => {
    if (!brightness?.present) return;
    const step = Math.max(1, Math.round(brightness.max / 10));
    const start = pendingValue.current ?? brightness.value;
    const target = start + direction * step;
    const minVal = Math.max(1, Math.round(brightness.max / 20));
    writeBrightnessValue(Math.max(minVal, Math.min(brightness.max, target)));
  };

  const present = brightness?.present ?? false;
  const displayedPct = brightness ? Math.round(brightness.percent / 10) * 10 : 0;
  const minValue = brightness ? Math.max(1, Math.round(brightness.max / 20)) : 1;
  const atMin = present && brightness != null && brightness.value <= minValue;
  const atMax = present && brightness != null && brightness.value >= brightness.max;

  // --- Sleep timeout ---
  const [sleepConfig, setSleepConfig] = useState<SleepConfig | null>(null);
  const sleepWriteTimer = useRef<number | null>(null);
  const pendingSleep = useRef<number | null>(null);

  const fetchSleepConfig = useCallback(async () => {
    try {
      const r = await fetch("/api/kiosk/sleep-config");
      if (r.ok) setSleepConfig(await r.json());
    } catch {
      /* keep last-good */
    }
  }, []);

  useEffect(() => {
    void fetchSleepConfig();
  }, [fetchSleepConfig]);

  const writeSleepConfig = (patch: Partial<SleepConfig>) => {
    setSleepConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    if (sleepWriteTimer.current) window.clearTimeout(sleepWriteTimer.current);
    sleepWriteTimer.current = window.setTimeout(async () => {
      const cur = sleepConfig;
      if (!cur) return;
      const merged = { ...cur, ...patch };
      try {
        const r = await fetch("/api/kiosk/sleep-config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(merged),
        });
        if (r.ok) setSleepConfig(await r.json());
      } catch {
        /* tile stays at the user-chosen value */
      }
    }, 300);
  };

  const adjustSleepTimeout = (direction: 1 | -1) => {
    if (!sleepConfig) return;
    const start = pendingSleep.current ?? sleepConfig.timeout_minutes;
    const next = Math.max(0, Math.min(30, start + direction));
    pendingSleep.current = next;
    writeSleepConfig({ timeout_minutes: next });
  };

  const adjustSleepBrightness = (direction: 1 | -1) => {
    if (!sleepConfig) return;
    const next = Math.max(1, Math.min(15, sleepConfig.sleep_brightness_pct + direction));
    writeSleepConfig({ sleep_brightness_pct: next });
  };

  const sleepMinutes = sleepConfig?.timeout_minutes ?? 2;
  const sleepAtMin = sleepConfig != null && sleepMinutes <= 0;
  const sleepAtMax = sleepConfig != null && sleepMinutes >= 30;
  const sleepBrt = sleepConfig?.sleep_brightness_pct ?? 5;
  const sleepBrtAtMin = sleepConfig != null && sleepBrt <= 1;
  const sleepBrtAtMax = sleepConfig != null && sleepBrt >= 15;

  return (
    <KioskShell title="顯示設定">
      <div className="grid grid-cols-3 grid-rows-2 gap-4 flex-1 min-h-0">
        {/* Row 1 — backlight · sleep brightness · sleep timeout */}
        <SplitTile
          icon={<Sun className="h-10 w-10 text-amber-300" />}
          loading={!brightness}
          error={brightness != null && !present ? "找不到背光裝置" : undefined}
          value={`${displayedPct}%`}
          label="螢幕亮度"
          valueColor="text-amber-200"
          onDecrease={() => adjustBrightness(-1)}
          onIncrease={() => adjustBrightness(1)}
          decreaseDisabled={!present || atMin}
          increaseDisabled={!present || atMax}
        />
        <SplitTile
          icon={<MoonStar className="h-10 w-10 text-indigo-300" />}
          loading={!sleepConfig}
          value={`${sleepBrt}%`}
          label="休眠亮度"
          valueColor="text-indigo-200"
          onDecrease={() => adjustSleepBrightness(-1)}
          onIncrease={() => adjustSleepBrightness(1)}
          decreaseDisabled={!sleepConfig || sleepBrtAtMin}
          increaseDisabled={!sleepConfig || sleepBrtAtMax}
        />
        <SplitTile
          icon={<Moon className="h-10 w-10 text-blue-300" />}
          loading={!sleepConfig}
          value={sleepMinutes === 0 ? "關" : `${sleepMinutes}`}
          unit={sleepMinutes > 0 ? "分鐘" : undefined}
          label="自動休眠"
          valueColor={sleepMinutes === 0 ? "text-muted-foreground" : "text-blue-200"}
          onDecrease={() => adjustSleepTimeout(-1)}
          onIncrease={() => adjustSleepTimeout(1)}
          decreaseDisabled={!sleepConfig || sleepAtMin}
          increaseDisabled={!sleepConfig || sleepAtMax}
        />

        {/* Row 2 */}
        <EmptyCell />
        <EmptyCell />
        <BackCard to="/settings" label="回設定" />
      </div>
    </KioskShell>
  );
}

function SplitTile({
  icon,
  loading,
  error,
  value,
  unit,
  label,
  valueColor,
  onDecrease,
  onIncrease,
  decreaseDisabled,
  increaseDisabled,
}: {
  icon: React.ReactNode;
  loading: boolean;
  error?: string;
  value: string;
  unit?: string;
  label: string;
  valueColor: string;
  onDecrease: () => void;
  onIncrease: () => void;
  decreaseDisabled: boolean;
  increaseDisabled: boolean;
}) {
  return (
    <div className="rounded-2xl border-2 bg-card border-border relative overflow-hidden">
      {/* Split background hint — left slightly darker, right slightly lighter */}
      <div className="absolute inset-y-0 left-0 w-1/2 bg-white/[0.02] pointer-events-none" />
      <div className="absolute inset-y-0 right-0 w-1/2 bg-white/[0.05] pointer-events-none" />

      {/* Center divider */}
      <div className="absolute left-1/2 top-[12%] bottom-[12%] w-px bg-border/40 pointer-events-none" />

      {/* Faint ± hints at edges */}
      <Minus
        className={cn(
          "absolute left-3 top-1/2 -translate-y-1/2 h-6 w-6 pointer-events-none",
          decreaseDisabled
            ? "text-muted-foreground/10"
            : "text-muted-foreground/25",
        )}
      />
      <Plus
        className={cn(
          "absolute right-3 top-1/2 -translate-y-1/2 h-6 w-6 pointer-events-none",
          increaseDisabled
            ? "text-muted-foreground/10"
            : "text-muted-foreground/25",
        )}
      />

      {/* Content */}
      <div className="relative flex flex-col items-center justify-center h-full gap-2 pointer-events-none">
        {icon}
        {loading ? (
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        ) : error ? (
          <p className="text-base text-muted-foreground text-center px-2">
            {error}
          </p>
        ) : (
          <div className={cn("text-5xl font-bold tabular-nums", valueColor)}>
            {value}
            {unit && <span className="text-xl ml-1">{unit}</span>}
          </div>
        )}
        <div className="text-sm text-muted-foreground">{label}</div>
      </div>

      {/* Interactive halves — last in DOM so they sit on top */}
      <button
        type="button"
        onClick={onDecrease}
        disabled={loading || decreaseDisabled}
        aria-label={`${label} 減少`}
        className="absolute inset-y-0 left-0 w-1/2 active:bg-white/[0.06] disabled:active:bg-transparent"
      />
      <button
        type="button"
        onClick={onIncrease}
        disabled={loading || increaseDisabled}
        aria-label={`${label} 增加`}
        className="absolute inset-y-0 right-0 w-1/2 active:bg-white/[0.06] disabled:active:bg-transparent"
      />
    </div>
  );
}
