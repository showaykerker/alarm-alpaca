import { useKioskEvents } from "@/lib/useKioskEvents";
import { cn } from "@/lib/utils";

// Small status pill that surfaces the live SSE connection state. The kiosk
// is otherwise silent about backend availability — every page's data
// freshness depends on the stream being up, so the operator deserves a
// single always-visible cue.
//
// Two visual modes:
//   * connected — small green dot, no label (visible but unobtrusive).
//   * connecting / down — coloured dot + Chinese label so the operator knows
//     the panel is no longer reflecting reality.
//
// Lives in KioskShell so every drill-down page picks it up automatically.
export function ConnectionBadge() {
  const { connectionState } = useKioskEvents();

  if (connectionState === "open") {
    return (
      <span
        aria-label="後端已連線"
        title="後端已連線"
        className="block h-3 w-3 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"
      />
    );
  }

  const isDown = connectionState === "down";
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium",
        isDown ? "bg-rose-900/70 text-rose-100" : "bg-amber-900/70 text-amber-100",
      )}
    >
      <span
        className={cn(
          "block h-2.5 w-2.5 rounded-full",
          isDown ? "bg-rose-400" : "bg-amber-400 animate-pulse",
        )}
        aria-hidden="true"
      />
      <span>{isDown ? "後端離線" : "連線中"}</span>
    </div>
  );
}
