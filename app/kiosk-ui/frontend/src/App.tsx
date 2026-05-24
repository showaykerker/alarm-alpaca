import { Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";

import { EdgeGlow } from "@/components/EdgeGlow";
import { PullToRefresh } from "@/components/PullToRefresh";
import { KioskEventsProvider } from "@/lib/useKioskEvents";
import DisplayConfig from "@/pages/config/Display";
import InternetConfig from "@/pages/config/Internet";
import MachineConfig from "@/pages/config/Machine";
import PhoneConfig from "@/pages/config/Phone";
import ZigbeeConfig from "@/pages/config/Zigbee";
import EngineeringPage from "@/pages/Engineering";
import LogPage from "@/pages/Log";
import Main from "@/pages/Main";
import ServicePage from "@/pages/Service";
import Settings from "@/pages/Settings";
import SystemPage from "@/pages/System";

// Grid-of-cards drill-down navigation (see project-kiosk-ui-rework spec).
// No top navbar — every page owns its own back-button at row2/col3. Routes
// map straight to a screen; there is no nesting.
export default function App() {
  return (
    <KioskEventsProvider>
      <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
        <EdgeGlow />
        <PullToRefresh />
        {/* Sonner toasts. position=top-center keeps action confirmations
            inside the operator's gaze on the 5-inch panel (the bottom of
            the screen is where the thumb sits). theme=dark matches the
            kiosk palette; richColors gives success/error their own hues
            instead of the default neutral pill. */}
        <Toaster
          position="top-center"
          theme="dark"
          richColors
          closeButton
          duration={4000}
          toastOptions={{ className: "text-base" }}
        />
        <Routes>
          <Route path="/" element={<Main />} />
          <Route path="/service/:id" element={<ServicePage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="/log" element={<LogPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/phone" element={<PhoneConfig />} />
          <Route path="/settings/internet" element={<InternetConfig />} />
          <Route path="/settings/zigbee" element={<ZigbeeConfig />} />
          <Route path="/settings/display" element={<DisplayConfig />} />
          <Route path="/settings/machine" element={<MachineConfig />} />
          <Route path="/eng" element={<EngineeringPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </KioskEventsProvider>
  );
}
