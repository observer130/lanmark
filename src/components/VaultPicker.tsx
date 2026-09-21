import { useEffect, useState } from "react";
import { FolderOpen, FolderPlus, Home, Keyboard } from "lucide-react";
import { useVaultStore } from "../stores/vault";
import { useSyncStore } from "../stores/sync";
import { isAndroid } from "../lib/sync";
import { ResizeEdges, WindowControls, dragWindow, isLinuxDesktop } from "./WindowControls";

/**
 * 首启选库。桌面走系统文件夹选择器；
 * Android（M2 真机验收修正）：Android 16 起 SAF 禁选 Documents/Download（「无法使用此
 * 文件夹」），SAF+映射路线整体作废——改为「应用私有外部目录」（零权限、std::fs 直写、
 * 同步场景数据以桌面为镜像）+「自定义路径」（MANAGE 授权下非 Documents/Download 直写）。
 */
export function VaultPicker() {
  const pickVault = useVaultStore((s) => s.pickVault);
  const pickAppDir = useVaultStore((s) => s.pickAppDir);
  const pickCustomAndroidDir = useVaultStore((s) => s.pickCustomAndroidDir);
  const error = useVaultStore((s) => s.error);
  const clearError = useVaultStore((s) => s.clearError);
  const checkAllFilesAccess = useSyncStore((s) => s.checkAllFilesAccess);
  const requestAllFilesAccess = useSyncStore((s) => s.requestAllFilesAccess);
  // 必须订阅：此前 render 里 getState() 非响应式读取，从系统授权页返回后
  // 组件不重渲染，「打开此目录」永远 disabled（只能重启 App）
  const hasAllFilesAccess = useSyncStore((s) => s.hasAllFilesAccess);
  const [android] = useState(isAndroid());
  const [customPath, setCustomPath] = useState("");
  const [showCustom, setShowCustom] = useState(false);

  // Android：进首启页即查授权状态（自定义路径需要；应用目录不需要）
  useEffect(() => {
    if (android) void checkAllFilesAccess();
  }, [android, checkAllFilesAccess]);

  // 从系统授权设置页返回时自动复查（activity 返回不会重跑挂载 effect）
  useEffect(() => {
    if (!android) return;
    const recheck = () => void checkAllFilesAccess();
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [android, checkAllFilesAccess]);

  return (
    <div
      className="relative flex h-screen items-center justify-center bg-canvas text-ink"
      onMouseDown={isLinuxDesktop ? dragWindow : undefined}
    >
      {/* Linux 无边框窗口：首启页也要有窗控/拖拽/缩放边缘（验收修正）；
          卡片标记 data-no-drag 豁免拖拽，正文文本可正常选中 */}
      {isLinuxDesktop && (
        <div className="absolute right-2 top-1.5 z-10">
          <WindowControls />
        </div>
      )}
      <ResizeEdges />
      <div
        data-no-drag
        className="w-full max-w-md rounded-2xl border border-line bg-card p-8 text-center shadow-card"
      >
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-2xl font-bold text-white shadow-slider">
          L
        </div>
        <h1 className="text-xl font-semibold">Lanmark</h1>
        <p className="mt-2 text-sm text-ink-2">
          选择一个目录作为你的笔记库（vault）。
          <br />
          所有笔记都是纯 Markdown 文件，随时可以用 Obsidian 打开。
        </p>
        {error && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-600">
            {error}
          </p>
        )}
        <div className="mt-6 space-y-2">
          {android ? (
            <>
              <button
                onClick={() => {
                  clearError();
                  void pickAppDir("create");
                }}
                className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-slider hover:bg-accent-text"
              >
                <Home size={16} />
                使用应用目录（推荐）
              </button>
              {!showCustom ? (
                <button
                  onClick={() => setShowCustom(true)}
                  className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink hover:bg-canvas"
                >
                  <Keyboard size={16} />
                  使用自定义目录…
                </button>
              ) : (
                <div className="space-y-1.5 rounded-[10px] border border-line p-3 text-left">
                  <input
                    value={customPath}
                    onChange={(e) => setCustomPath(e.target.value)}
                    placeholder="/sdcard/我的笔记"
                    className="w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
                  />
                  <p className="text-[11px] leading-4 text-ink-3">
                    需先授权「所有文件访问」；Android 16 不允许选择 Documents/Download。
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      disabled={!customPath.trim() || !hasAllFilesAccess}
                      onClick={() => {
                        clearError();
                        void pickCustomAndroidDir(customPath.trim(), "open");
                      }}
                      className="flex-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                    >
                      打开此目录
                    </button>
                    {!hasAllFilesAccess && (
                      <button
                        onClick={() => void requestAllFilesAccess()}
                        className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-white"
                      >
                        去授权
                      </button>
                    )}
                    <button
                      onClick={() => setShowCustom(false)}
                      className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-3"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              <p className="pt-1 text-[11px] leading-4 text-ink-3">
                应用目录：/Android/data/com.lanmark.app/files/lanmark-vault
                <br />
                （卸载 App 会删除；同步后桌面端有完整镜像）
              </p>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  clearError();
                  void pickVault("create");
                }}
                className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-slider hover:bg-accent-text"
              >
                <FolderPlus size={16} />
                创建新笔记库…
              </button>
              <button
                onClick={() => {
                  clearError();
                  void pickVault("open");
                }}
                className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink hover:bg-canvas"
              >
                <FolderOpen size={16} />
                打开现有笔记库…
              </button>
            </>
          )}
        </div>
        <p className="mt-4 text-xs text-ink-3">
          「创建」选择空目录，「打开」选择已有 .md 笔记的目录
        </p>
      </div>
    </div>
  );
}
