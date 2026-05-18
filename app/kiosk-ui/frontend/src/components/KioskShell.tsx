import { ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { ConnectionBadge } from "@/components/ConnectionBadge";
import { cn } from "@/lib/utils";

// Top-border tint by depth from the main page. Each extra click away
// from / picks the next colour in DEPTH_TINTS, so the operator gets a
// constant spatial cue for "how deep am I?" without having to memorise
// a per-page palette. When a page is reachable via multiple paths, we
// take the LONGEST chain — e.g. /settings/internet is depth 2 whether
// the operator entered from / → system → 設定網路 or
// / → settings → internet.
const ROUTE_DEPTH: { match: (p: string) => boolean; depth: number }[] = [
  { match: (p) => p === "/", depth: 0 },
  { match: (p) => p === "/system", depth: 1 },
  { match: (p) => p === "/log", depth: 1 },
  { match: (p) => p === "/settings", depth: 1 },
  { match: (p) => p.startsWith("/service/"), depth: 1 },
  { match: (p) => p === "/settings/phone", depth: 2 },
  { match: (p) => p === "/settings/internet", depth: 2 },
  { match: (p) => p === "/settings/zigbee", depth: 2 },
  { match: (p) => p === "/settings/display", depth: 2 },
  { match: (p) => p === "/settings/machine", depth: 2 },
];

// Cool → warm gradient, low intensity → bright as depth grows so the
// operator's eye notices "I'm a long way from the main page" before
// they think about it. Index = depth.
const DEPTH_TINTS = [
  "border-t-transparent",
  "border-t-sky-600",
  "border-t-amber-500",
];

function routeTintClass(pathname: string): string {
  const depth = ROUTE_DEPTH.find((r) => r.match(pathname))?.depth ?? 0;
  return DEPTH_TINTS[depth] ?? "border-t-transparent";
}

// Every drill-down page gets the same chrome:
//   - 4px route-tinted top strip (spatial cue for which page family you're in)
//   - thin title bar at the top (label only, no nav — back lives in the grid)
//   - body that fills the rest of the screen, hands flex layout to the grid
//   - SSE connection badge pinned bottom-right (out of EdgeGlow's badge
//     corner so the alarm flash icon fully owns its area)
// The title bar height stays small (h-12) so the 3×2 grid below has room
// to breathe on the 1280×720 panel.
export function KioskShell({
  title,
  tone,
  children,
}: {
  title?: ReactNode;
  tone?: "danger" | "warn";
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const tintClass = routeTintClass(pathname);
  return (
    <div
      className={cn(
        "relative h-full w-full flex flex-col overflow-hidden p-4 gap-4 border-t-4",
        tintClass,
      )}
    >
      {/* ConnectionBadge sits in the bottom-right corner so it can't be
          partially covered by EdgeGlow's top-right alarm/selftest badge
          (z-61, top-4 right-4). Bottom-right has no other floating
          chrome and the back-button card is in the same row anyway. */}
      <div className="pointer-events-auto absolute right-3 bottom-3 z-50">
        <ConnectionBadge />
      </div>
      {title && (
        <header
          className={cn(
            "h-12 shrink-0 flex items-center px-4 rounded-xl",
            tone === "danger" && "bg-rose-950/40 text-rose-100",
            tone === "warn" && "bg-amber-950/40 text-amber-100",
            !tone && "bg-card",
          )}
        >
          <h1 className="text-xl font-bold">{title}</h1>
        </header>
      )}
      {children}
    </div>
  );
}
