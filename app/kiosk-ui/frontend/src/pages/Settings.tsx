import { Monitor, Phone, Power, Radio, Wifi } from "lucide-react";

import { KioskShell } from "@/components/KioskShell";
import { BackCard, KioskGrid, NavCard } from "@/components/PageGrid";

// Settings hub: 6-cell grid, last cell is the back-to-main button per the
// cross-page rule. Tone choices keep destructive/sensitive surfaces visually
// distinct from the everyday config tiles.
export default function Settings() {
  return (
    <KioskShell title="設定">
      {/* 3×2 row-major grid. Current order (operator-requested 2026-05-18):
            row1: 通知電話   · Zigbee · 顯示
            row2: 網際網路   · 機器操作 · 回主頁
          Pairing-time tiles (phone + Zigbee) sit on the top row; networking
          and destructive ops live below. */}
      <KioskGrid>
        <NavCard
          to="/settings/phone"
          icon={<Phone className="h-14 w-14 text-sky-300" strokeWidth={2.2} />}
          title="通知電話"
          subtitle="撥號清單"
        />
        <NavCard
          to="/settings/zigbee"
          icon={<Radio className="h-14 w-14 text-emerald-300" strokeWidth={2.2} />}
          title="Zigbee"
          subtitle="配對 · 裝置列表"
        />
        <NavCard
          to="/settings/display"
          icon={<Monitor className="h-14 w-14 text-amber-300" strokeWidth={2.2} />}
          title="顯示"
          subtitle="亮度"
        />
        <NavCard
          to="/settings/internet"
          icon={<Wifi className="h-14 w-14 text-sky-300" strokeWidth={2.2} />}
          title="網際網路"
          subtitle="WiFi · 有線網路"
        />
        {/* Machine ops carries destructive actions (reboot/shutdown) — warm
            tint mirrors the in-page color to set expectations on touch. */}
        <NavCard
          to="/settings/machine"
          icon={<Power className="h-14 w-14 text-rose-300" strokeWidth={2.2} />}
          title="機器操作"
          subtitle="關機 · 重新開機"
          tone="warn"
        />
        <BackCard to="/" label="回主頁" />
      </KioskGrid>
    </KioskShell>
  );
}
