import { useCallback, useEffect, useState } from "react";
import {
  Cable,
  KeyRound,
  Loader2,
  Lock,
  Search,
  Signal,
  Trash2,
  Wifi as WifiIcon,
  WifiOff,
} from "lucide-react";

import { KioskShell } from "@/components/KioskShell";
import { OnScreenKeyboard } from "@/components/OnScreenKeyboard";
import { BackCard, EmptyCell, GridCell } from "@/components/PageGrid";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type WifiNetwork = {
  ssid: string;
  signal: number;
  security: string;
  in_use: boolean;
  saved: boolean;
};

type EthernetStatus = {
  present: boolean;
  device: string | null;
  connected: boolean;
  ip: string | null;
};

type WifiStatus = {
  connected: boolean;
  ssid: string | null;
  signal: number | null;
  device: string | null;
  networks: WifiNetwork[];
  ethernet: EthernetStatus;
};

const isOpen = (security: string) => security === "--" || security === "";

function signalIcon(signal: number) {
  if (signal >= 70) return <Signal className="h-5 w-5 text-emerald-400" />;
  if (signal >= 40) return <Signal className="h-5 w-5 text-amber-400" />;
  return <Signal className="h-5 w-5 text-muted-foreground" />;
}

// Internet config: 3-col landing grid.
//   row1: ethernet status · wifi status · 找尋 WiFi button
//   row2: empty · empty · back-to-settings
// The "find WiFi" button opens a dialog of scanned SSIDs; tap one to enter
// a password via the on-screen keyboard. Disconnect lives inline on the
// wifi status tile to avoid an extra drill-down.
export default function InternetConfig() {
  const [status, setStatus] = useState<WifiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [forgetTarget, setForgetTarget] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);

  const [target, setTarget] = useState<WifiNetwork | null>(null);
  const [psk, setPsk] = useState("");
  const [pskKeyboard, setPskKeyboard] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSuccess, setConnectSuccess] = useState(false);

  // /api/wifi blocks on `nmcli device wifi list` which can take 3-8s on a
  // cold radio. /api/wifi/ethernet is sub-100ms. We fetch the cheap one
  // first so the ethernet tile renders immediately, then kick off the
  // slow WiFi scan in the background.
  const fetchEthernetOnly = useCallback(async () => {
    try {
      const r = await fetch("/api/wifi/ethernet");
      if (r.ok) {
        const eth = await r.json();
        setStatus((prev) =>
          prev
            ? { ...prev, ethernet: eth }
            : {
                connected: false,
                ssid: null,
                signal: null,
                device: null,
                networks: [],
                ethernet: eth,
              },
        );
      }
    } catch { /* keep last-good */ }
  }, []);

  const fetchWifi = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/wifi");
      if (!r.ok) throw new Error(`GET /api/wifi ${r.status}`);
      setStatus(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void fetchEthernetOnly();
    void fetchWifi();
  }, [fetchEthernetOnly, fetchWifi]);

  const openScan = async () => {
    setScanOpen(true);
    setScanning(true);
    await fetchWifi();
  };

  // Shared connect path so saved-network tap can fire without password and
  // the password-dialog Submit button can fire with one — both routes hit
  // the same backend endpoint and share the success/error UX state.
  const performConnect = async (ssid: string, password?: string) => {
    setConnecting(true);
    setConnectError(null);
    try {
      const body: { ssid: string; password?: string } = { ssid };
      if (password) body.password = password;
      const r = await fetch("/api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const body2 = await r.json().catch(() => ({}));
        throw new Error(body2?.detail ?? `HTTP ${r.status}`);
      }
      setConnectSuccess(true);
      setTimeout(async () => {
        setTarget(null);
        setConnectSuccess(false);
        setScanOpen(false);
        await fetchWifi();
      }, 1500);
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  const openConnect = (net: WifiNetwork) => {
    setTarget(net);
    setPsk("");
    setConnectError(null);
    setConnectSuccess(false);
    // Saved network: NM already has the PSK on file — try it silently first.
    // The dialog still opens to show the connecting spinner; on failure it
    // surfaces the password input so the operator can re-enter (the common
    // failure mode is "router rotated the PSK", which needs manual entry).
    if (net.saved && !isOpen(net.security)) {
      void performConnect(net.ssid);
    }
  };

  const doConnect = () => {
    if (!target) return;
    void performConnect(target.ssid, !isOpen(target.security) && psk ? psk : undefined);
  };

  const doForget = async () => {
    if (!forgetTarget) return;
    setForgetting(true);
    setError(null);
    try {
      const r = await fetch("/api/wifi/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: forgetTarget }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.detail ?? `HTTP ${r.status}`);
      }
      setForgetTarget(null);
      await fetchWifi();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setForgetting(false);
    }
  };

  const doDisconnect = async () => {
    setDisconnecting(true);
    setError(null);
    try {
      const r = await fetch("/api/wifi/disconnect", { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.detail ?? `HTTP ${r.status}`);
      }
      await fetchWifi();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDisconnecting(false);
    }
  };

  const dialogIsSecured = target && !isOpen(target.security);
  // True while we're silently trying NM's saved PSK — keeps the password
  // input hidden so the operator isn't confused by a half-rendered form
  // while the radio is mid-handshake. Flips back to the input on failure.
  const autoTryingSaved =
    target?.saved && connecting && !connectError && !psk && !connectSuccess;

  return (
    <KioskShell title="網際網路設定">
      <div className="grid grid-cols-3 grid-rows-2 gap-4 flex-1 min-h-0">
        {/* Ethernet tile */}
        <GridCell tone={status?.ethernet.connected ? "ok" : "muted"}>
          <div className="flex flex-col gap-3 h-full justify-center items-center text-center">
            <Cable
              className={
                status?.ethernet.connected
                  ? "h-12 w-12 text-emerald-400"
                  : "h-12 w-12 text-muted-foreground"
              }
            />
            <div className="text-xl font-bold">有線網路</div>
            {!status?.ethernet.present ? (
              <p className="text-sm text-muted-foreground">無有線網卡</p>
            ) : status.ethernet.connected ? (
              <>
                <Badge className="bg-emerald-600 text-white">已連線</Badge>
                {status.ethernet.ip && (
                  <span className="font-mono text-sm">{status.ethernet.ip}</span>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">未插上網路線</p>
            )}
          </div>
        </GridCell>

        {/* WiFi status tile */}
        <GridCell tone={status?.connected ? "ok" : "muted"}>
          <div className="flex flex-col gap-3 h-full justify-center items-center text-center">
            {status?.connected ? (
              <WifiIcon className="h-12 w-12 text-emerald-400" />
            ) : (
              <WifiOff className="h-12 w-12 text-muted-foreground" />
            )}
            <div className="text-xl font-bold">WiFi</div>
            {/* Spinner while the WiFi scan is still in flight. The ethernet
                fetch populates `status` early with `device: null`, so the old
                `loading && !status` check fell through to "未連線" during the
                ~3-8 s WiFi scan even though we hadn't asked the radio yet.
                Gate on `device` instead: it only gets a value after
                /api/wifi finishes. */}
            {loading && status?.device == null ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : status?.connected ? (
              <>
                {/* truncate's overflow:hidden was still clipping CJK
                    descenders on certain SSIDs even with leading-7 — the
                    Chinese font's actual descender extends past the
                    line-height box. Switch to a block with explicit
                    min-height and generous padding so the box is taller
                    than any glyph instead of relying on line-height. */}
                <div
                  className="font-semibold text-base max-w-full min-h-9 leading-loose px-1 py-1 whitespace-nowrap overflow-hidden text-ellipsis"
                  style={{ lineHeight: "1.9" }}
                >
                  {status.ssid}
                </div>
                <div className="flex items-center gap-2">
                  {status.signal != null && signalIcon(status.signal)}
                  {status.signal != null && (
                    <Badge variant="secondary">{status.signal}%</Badge>
                  )}
                </div>
                {/* Disconnect stays — it's a different action from forget
                    (stop using now vs. delete saved profile). The forget
                    button used to live here but moved out: every saved
                    network already gets a trash icon in the WiFi list
                    dialog, so duplicating it on the tile was clutter. */}
                <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
                  <Button
                    variant="outline"
                    onClick={doDisconnect}
                    disabled={disconnecting}
                  >
                    {disconnecting ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <WifiOff className="h-5 w-5" />
                    )}
                    中斷連線
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">未連線</p>
            )}
          </div>
        </GridCell>

        {/* Find WiFi action card */}
        <button
          type="button"
          onClick={openScan}
          className="rounded-2xl border-2 p-5 flex flex-col items-center justify-center gap-3 bg-sky-900/30 border-sky-600/70 hover:brightness-110 active:scale-[0.98] transition-colors"
        >
          <Search className="h-12 w-12 text-sky-300" strokeWidth={2.2} />
          <div className="text-xl font-bold">搜尋 WiFi</div>
          <div className="text-sm text-muted-foreground">掃描可用網路</div>
        </button>

        <EmptyCell />
        <EmptyCell />
        <BackCard to="/settings" label="回設定" />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* WiFi scan dialog */}
      <Dialog
        open={scanOpen && target === null}
        onOpenChange={(o) => { if (!o) setScanOpen(false); }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              可用的 WiFi
              {scanning && <Loader2 className="h-5 w-5 animate-spin" />}
            </DialogTitle>
            <DialogDescription>點選網路後輸入密碼以連線。</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto -mx-6 px-6 divide-y">
            {status?.networks.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                未找到任何網路
              </p>
            ) : (
              status?.networks.map((net) => (
                <div
                  key={net.ssid}
                  className="w-full flex items-center justify-between gap-2 py-3 px-1 hover:bg-secondary/60 rounded-md transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => openConnect(net)}
                    className="flex-1 flex items-center justify-between gap-3 text-left min-w-0"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {signalIcon(net.signal)}
                      {/* `truncate` sets overflow:hidden which clips CJK
                          descenders when line-height drops below ~1.4.
                          leading-7 + py-0.5 keeps the box tall enough so
                          characters with low strokes (有 / 號 / etc.) don't
                          get sliced in half. */}
                      <span className="font-medium truncate leading-7 py-0.5">
                        {net.ssid}
                      </span>
                      {!isOpen(net.security) && (
                        <Lock className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      {net.in_use && (
                        <Badge className="bg-emerald-600 text-white text-xs">
                          已連線
                        </Badge>
                      )}
                      {net.saved && !net.in_use && (
                        <Badge variant="secondary" className="text-xs">
                          已儲存
                        </Badge>
                      )}
                    </div>
                    <Badge variant="secondary">{net.signal}%</Badge>
                  </button>
                  {net.saved && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive shrink-0"
                      aria-label={`忘記 ${net.ssid}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setForgetTarget(net.ssid);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => void fetchWifi()}
              disabled={scanning}
            >
              {scanning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              重新搜尋
            </Button>
            <Button variant="outline" size="lg" onClick={() => setScanOpen(false)}>
              關閉
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Connect dialog */}
      <Dialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) {
            setTarget(null);
            setConnectError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>連線至 {target?.ssid}</DialogTitle>
            <DialogDescription>
              {dialogIsSecured
                ? "此網路需要密碼。"
                : "此為開放網路，無需密碼。"}
            </DialogDescription>
          </DialogHeader>
          {connectSuccess ? (
            <div className="py-4 text-center text-emerald-400 font-medium">
              連線成功！
            </div>
          ) : autoTryingSaved ? (
            <div className="flex items-center justify-center gap-3 py-6 text-base text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              正在使用已儲存的密碼連線…
            </div>
          ) : (
            <>
              {dialogIsSecured && (
                <button
                  type="button"
                  onClick={() => setPskKeyboard(true)}
                  className="flex items-center gap-3 w-full rounded-lg border border-input bg-secondary px-4 py-4 text-left hover:bg-secondary/80 transition-colors"
                >
                  <KeyRound className="h-5 w-5 text-muted-foreground" />
                  <span
                    className={
                      psk
                        ? "font-mono tabular-nums text-lg break-all"
                        : "text-muted-foreground text-base"
                    }
                  >
                    {psk || "點此輸入 WiFi 密碼"}
                  </span>
                </button>
              )}
              {connectError && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {target?.saved
                      ? `已儲存的密碼無法連線,請重新輸入。(${connectError})`
                      : connectError}
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                setTarget(null);
                setConnectError(null);
              }}
              disabled={connecting}
            >
              取消
            </Button>
            <Button
              size="lg"
              onClick={doConnect}
              disabled={
                connecting || connectSuccess || (!!dialogIsSecured && !psk)
              }
            >
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              連線
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Forget confirm dialog */}
      <Dialog
        open={forgetTarget !== null}
        onOpenChange={(o) => { if (!o && !forgetting) setForgetTarget(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>忘記「{forgetTarget}」？</DialogTitle>
            <DialogDescription>
              將刪除已儲存的密碼與設定，下次開機不會再自動連線。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => setForgetTarget(null)}
              disabled={forgetting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="lg"
              onClick={doForget}
              disabled={forgetting}
            >
              {forgetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              忘記
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OnScreenKeyboard
        open={pskKeyboard}
        initial={psk}
        title={`輸入「${target?.ssid}」的密碼`}
        onCancel={() => setPskKeyboard(false)}
        onConfirm={(v) => {
          setPsk(v);
          setPskKeyboard(false);
        }}
      />
    </KioskShell>
  );
}
