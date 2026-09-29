import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Menu, TriangleAlert, X } from "lucide-react";
import { useVaultStore } from "./stores/vault";
import { useSyncStore } from "./stores/sync";
import { useSettingsStore } from "./stores/settings";
import { isAndroid } from "./lib/sync";
import { ResizeEdges, WindowControls, dragWindow, isLinuxDesktop } from "./components/WindowControls";
import { NewEntryFab } from "./components/NewEntryFab";
import { listenBackPress, reportBackHandler } from "./stores/back";
import { VaultPicker } from "./components/VaultPicker";
import { Sidebar } from "./components/Sidebar";
import { EditorPane } from "./components/EditorPane";
import { SettingsDialog } from "./components/SettingsDialog";

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
  // 窄屏：设置页「管理设备与配对」要求展开侧栏抽屉（否则同步面板在收起容器里
  // 渲染，被挤出屏幕左侧——真机走查发现）。与 SyncSection 同样用计数器订阅。
  const navDrawerRequest = useSettingsStore((s) => s.navDrawerRequest);
  const lastNavRequest = useRef(navDrawerRequest);
  useEffect(() => {
    if (navDrawerRequest !== lastNavRequest.current) {
      lastNavRequest.current = navDrawerRequest;
      setNavOpen(true);
    }
  }, [navDrawerRequest]);

  // M4i：返回手势——原生管「返回发生了」，这里管「返回该做什么」。
  // 优先级：抽屉 → 浮层 → 退出确认（后者在原生侧，见 BackPlugin.resolve）
  useEffect(() => {
    // 用 getState 读最新值：闭包若捕获渲染时的 state 会读到陈旧的开关状态
    // （用户可能在监听建立之后才打开设置页）
    const unlisten = listenBackPress(() => {
      if (useVaultStore.getState().pendingCreate) {
        useVaultStore.getState().closeCreate();
        return;
      }
      if (useSettingsStore.getState().dialogOpen) {
        useSettingsStore.getState().closeDialog();
        return;
      }
      setNavOpen(false);
    });
    return unlisten;
  }, []);

  // 抽屉 / 设置页 / 新建对话框 —— 任一开着，返回就先关它（而不是退出）。
  // 上报给原生（去重后下发，见 stores/back.ts）。
  // 同步面板是 SyncSection 的组件内 state，不在此列：它在抽屉里，抽屉开着时
  // 返回的语义已经是「关抽屉」，无需再细分。
  const dialogOpen = useSettingsStore((s) => s.dialogOpen);
  const pendingCreate = useVaultStore((s) => s.pendingCreate);
  useEffect(() => {
    if (navOpen) reportBackHandler("drawer");
    else if (dialogOpen || pendingCreate) reportBackHandler("overlay");
    else reportBackHandler("none");
  }, [navOpen, dialogOpen, pendingCreate]);

  useEffect(() => {
    void useVaultStore.getState().init();
    void useSyncStore.getState().loadSyncAuto();
    // M4a：设置在启动时与 vault.init() 并行加载；拿到结果立即写 CSS 变量
    // （不能等 vault 打开——首启页也要按用户字号渲染）
    void useSettingsStore.getState().load();
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
      // Linux 无边框窗口：loading 屏也要有窗控/拖拽/缩放边缘（验收修正）
      <div
        className="relative flex h-screen items-center justify-center bg-canvas text-ink-2"
        onMouseDown={isLinuxDesktop ? dragWindow : undefined}
      >
        <ResizeEdges />
        {isLinuxDesktop && (
          <div className="absolute right-2 top-1.5 z-10">
            <WindowControls />
          </div>
        )}
        <div className="text-sm">正在打开笔记库…</div>
      </div>
    );
  }

  if (status === "unconfigured") {
    return (
      <>
        <VaultPicker />
        <SettingsDialog narrow={narrow} />
        <Toast />
      </>
    );
  }

  return (
    <>
      {/* Linux 无边框窗口（decorations:false）：四周 4px 隐形缩放边缘 */}
      <div className="relative flex h-screen bg-canvas text-ink">
        <ResizeEdges />
        {narrow ? (
          <>
            {/* 窄屏：侧栏为 **半屏抽屉 + 遮罩**（M4i，Gmail / Obsidian Mobile 式）。
                 此前是全屏铺满：右侧没有可点的遮罩区，看着不像抽屉，用户只能靠
                 点条目或再点一次汉堡关掉它（走查反馈「像桌面端」的根因之一）。
                 改为 w-[85vw]（屏宽留出一竖条），右侧露出的部分即遮罩——点它关
                 抽屉，这是 Material Navigation Drawer 的标准行为。
                 内部列表沿用 truncate + min-w-0 flex-1，不依赖固定宽度。 */}
            <div
              className={`fixed inset-0 z-30 bg-black/40 transition-opacity duration-200 ${
                navOpen ? "opacity-100" : "pointer-events-none opacity-0"
              }`}
              onClick={() => setNavOpen(false)}
            />
            <div
              className={`fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-[320px] transform transition-transform duration-200 ${
                navOpen ? "translate-x-0" : "-translate-x-full"
              }`}
            >
              <Sidebar onNavigate={() => setNavOpen(false)} />
            </div>
            {/* 悬浮抽屉按钮：占头部左侧 ~56px，EditorPane 窄屏头部需让出该宽度。
                触控尺寸放大到 44px（M4i：原来只有 32px，手机上偏小） */}
            <button
              aria-label="打开侧栏"
              onClick={() => setNavOpen(true)}
              className="fixed left-3 top-3 z-20 flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-card text-ink-2 shadow-card"
            >
              <Menu size={18} />
            </button>
            {/* flex-col 接续高度链：让 EditorPane 的 flex-1 生效，编辑卡占满剩余高度 */}
            <div className="flex min-w-0 flex-1 flex-col">
              <EditorPane narrow={narrow} />
            </div>
            {/* M4i：右下角新建 FAB（手机上原入口在标题行右侧，太小且够不到） */}
            <NewEntryFab />
          </>
        ) : (
          <>
            <Sidebar />
            <EditorPane />
          </>
        )}
      </div>
      <SettingsDialog narrow={narrow} />
      <Toast />
    </>
  );
}

export default App;
