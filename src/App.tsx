import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Menu, TriangleAlert, X } from "lucide-react";
import { useVaultStore } from "./stores/vault";
import { useSyncStore } from "./stores/sync";
import { isAndroid } from "./lib/sync";
import { VaultPicker } from "./components/VaultPicker";
import { Sidebar } from "./components/Sidebar";
import { EditorPane } from "./components/EditorPane";

/** 窄屏（手机竖屏）判定：侧栏改为覆盖式抽屉，编辑器占满全宽 */
function useIsNarrow() {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return narrow;
}

function Toast() {
  const error = useVaultStore((s) => s.error);
  const clearError = useVaultStore((s) => s.clearError);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 6000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  if (!error) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-red-200 bg-card p-3 text-sm text-red-600 shadow-pop">
      <div className="flex items-start gap-2">
        <TriangleAlert size={16} className="mt-0.5 shrink-0 text-red-500" />
        <span className="min-w-0 break-all">{error}</span>
        <button
          className="ml-auto shrink-0 p-0.5 text-ink-3 hover:text-ink"
          onClick={clearError}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function App() {
  const status = useVaultStore((s) => s.status);
  const syncAuto = useSyncStore((s) => s.syncAuto);
  const narrow = useIsNarrow();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    void useVaultStore.getState().init();
    void useSyncStore.getState().loadSyncAuto();
    // 窗口关闭前尽力落盘（best effort）
    const flush = () => void useVaultStore.getState().saveNow();
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  // M3f：手机端是同步服务器，远端 push/delete 会改动本地 vault（Rust 侧
  // 成功后 emit lanmark:vault-changed）。手机无客户端循环（桌面 runRound
  // 回合后自行刷新，且桌面不启动服务器），不刷新则目录仍列远端已删的
  // 笔记，点击报「笔记不存在」
  useEffect(() => {
    const apply = () => void useVaultStore.getState().remoteChanged();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen("lanmark:vault-changed", apply).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    // 熄屏兜底：同步发生在 WebView 暂停期间时事件可能丢失 → 回前台补刷
    // （仅 Android；桌面由自动循环触发器 D 覆盖）。3s 防抖避免事件与可见性连发
    let last = 0;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < 3000) return;
      last = now;
      apply();
    };
    if (isAndroid()) document.addEventListener("visibilitychange", onVis);
    return () => {
      disposed = true;
      unlisten?.();
      if (isAndroid()) document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // M3 自动同步循环：仅桌面端（手机是服务器，无循环）+ vault 已打开 + 开关开。
  // 桌面应用完全关闭后无后台同步（app 模型；手机侧才是常驻中心）
  useEffect(() => {
    if (isAndroid() || status !== "ready" || syncAuto !== true) {
      useSyncStore.getState().stopAutoLoop();
      return;
    }
    useSyncStore.getState().startAutoLoop();
    return () => useSyncStore.getState().stopAutoLoop();
  }, [status, syncAuto]);

  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas text-ink-2">
        <div className="text-sm">正在打开笔记库…</div>
      </div>
    );
  }

  if (status === "unconfigured") {
    return (
      <>
        <VaultPicker />
        <Toast />
      </>
    );
  }

  return (
    <>
      <div className="relative flex h-screen bg-canvas text-ink">
        {narrow ? (
          <>
            {/* 窄屏：侧栏为覆盖式抽屉（flex 让 aside 拉满高度，内部列表才能滚动） */}
            {navOpen && (
              <div
                className="fixed inset-0 z-30 bg-black/40"
                onClick={() => setNavOpen(false)}
              />
            )}
            <div
              className={`fixed inset-y-0 left-0 z-40 flex transform transition-transform duration-200 ${
                navOpen ? "translate-x-0" : "-translate-x-full"
              }`}
            >
              <Sidebar onNavigate={() => setNavOpen(false)} />
            </div>
            {/* 悬浮抽屉按钮：占据头部左侧 ~56px，EditorPane 窄屏头部需让出该宽度 */}
            <button
              aria-label="打开侧栏"
              onClick={() => setNavOpen(true)}
              className="fixed left-3 top-3 z-20 rounded-lg border border-line bg-card p-2 text-ink-2 shadow-card"
            >
              <Menu size={16} />
            </button>
            {/* flex-col 接续高度链：让 EditorPane 的 flex-1 生效，编辑卡占满剩余高度 */}
            <div className="flex min-w-0 flex-1 flex-col">
              <EditorPane narrow={narrow} />
            </div>
          </>
        ) : (
          <>
            <Sidebar />
            <EditorPane />
          </>
        )}
      </div>
      <Toast />
    </>
  );
}

export default App;
