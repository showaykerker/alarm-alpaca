import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";

import App from "./App";
import "./index.css";

// Only hide the cursor on the on-device chromium (loopback). LAN viewers
// keep their normal pointer — gating here drops the LAN inconvenience
// without weakening the touchscreen UX. Pair with index.css selectors
// scoped to `html.kiosk-hide-cursor`.
if (["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
  document.documentElement.classList.add("kiosk-hide-cursor");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
