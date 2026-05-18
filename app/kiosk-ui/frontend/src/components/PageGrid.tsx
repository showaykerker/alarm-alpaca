import { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";

// Shared cell shell: rounded card-ish box used for every grid slot so all
// pages look like a uniform "screen of tiles". GridCell wraps either static
// content (status/info), a router-link tile (NavCard) or a button-like
// action (ActionCard). The look — border, hover, padding, height — lives
// here so we don't fight subtle drift across pages.
type CellTone = "default" | "ok" | "fail" | "warn" | "danger" | "muted";

const toneClass: Record<CellTone, string> = {
  default: "bg-card border-border",
  ok: "bg-emerald-900/30 border-emerald-600/70",
  fail: "bg-rose-900/30 border-rose-600/70",
  warn: "bg-amber-900/25 border-amber-600/70",
  danger: "bg-rose-950/40 border-rose-700",
  muted: "bg-card/40 border-border/60",
};

export function GridCell({
  children,
  tone = "default",
  className,
}: {
  children: ReactNode;
  tone?: CellTone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border-2 p-5 flex flex-col min-h-0 overflow-hidden",
        toneClass[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

// Empty slot in the grid. Renders an invisible placeholder so the surrounding
// grid keeps a stable 3-column rhythm — taps on it are ignored.
export function EmptyCell() {
  return <div aria-hidden="true" />;
}

// NavCard: tap-target tile that routes elsewhere. Used for both the main-page
// nav row and any "drill-down" card (status card → per-service page, etc.).
// The whole card is one button — touchscreen UX wants the biggest possible
// target.
//
// `size`: default is for sub-pages where the 3×2 grid carries 5-6 tiles
// already. "lg" bumps title + subtitle one tier for the main page, where
// the 6-tile grid has slack and the operator reads it from across the
// room. Don't push past lg without re-checking the settings tile subtitle
// "電話 · 網路 · Zigbee · 顯示 · 機器" — that string is at the width limit.
export function NavCard({
  to,
  icon,
  title,
  subtitle,
  tone = "default",
  size = "default",
}: {
  to: string;
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  tone?: CellTone;
  size?: "default" | "lg";
}) {
  const titleCls = size === "lg" ? "text-3xl" : "text-2xl";
  const subtitleCls = size === "lg" ? "text-lg" : "text-base";
  return (
    <Link
      to={to}
      className={cn(
        "rounded-2xl border-2 p-5 flex flex-col items-center justify-center gap-3",
        "transition-colors active:scale-[0.98]",
        toneClass[tone],
        "hover:brightness-110",
      )}
    >
      <div className="shrink-0">{icon}</div>
      <div className={cn("font-bold text-center", titleCls)}>{title}</div>
      {subtitle && (
        <div className={cn("text-muted-foreground text-center text-balance", subtitleCls)}>
          {subtitle}
        </div>
      )}
    </Link>
  );
}

// Back-to-{main,settings} button. Always lives in row 2, column 3 (cross-page
// rule from the UI spec) — having a single component prevents per-page drift.
export function BackCard({ to, label = "返回" }: { to: string; label?: string }) {
  return (
    <Link
      to={to}
      className={cn(
        "rounded-2xl border-2 p-5 flex flex-col items-center justify-center gap-3",
        "bg-secondary border-border/80 hover:brightness-110 active:scale-[0.98] transition-colors",
      )}
    >
      <ArrowLeft className="h-12 w-12" />
      <div className="text-2xl font-bold">{label}</div>
    </Link>
  );
}

// Two-row, three-column kiosk page grid. Per the UI spec, every primary page
// follows this shape: row1 = content (3 slots), row2 = controls + back. The
// grid is sized to fill the viewport below the optional header (the kiosk
// runs at 1280x720; with header off, we get ~720 vertical, with header ~660).
export function KioskGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-3 grid-rows-2 gap-4 flex-1 min-h-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
