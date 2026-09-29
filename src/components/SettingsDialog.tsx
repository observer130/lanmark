import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FolderOpen,
  HardDrive,
  Info,
  Loader2,
  Monitor,
  Palette,
  Pencil,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettingsStore, type SectionKey } from "../stores/settings";
import { useUpdateStore } from "../stores/update";
import { update as updateApi } from "../lib/update";
import { useVaultStore } from "../stores/vault";
import { vault, type AppInfo, type VaultStats } from "../lib/vault";
import { isAndroid } from "../lib/sync";
import { useSyncStore } from "../stores/sync";
import {
  AUTOSAVE_OPTIONS,
  EDITOR_MODE_OPTIONS,
  LINE_HEIGHT_OPTIONS,
  NEW_NOTE_LOCATION_OPTIONS,
  SIZE_OPTIONS,
  TRASH_RETENTION_OPTIONS,
  type EditorMode,
} from "../lib/settings";
import { dragWindow, isLinuxDesktop } from "./WindowControls";

/**
 * M4a 设置面板外壳（docs/08 §5.1）。
 *
 * 形态：宽屏（≥768）居中模态；窄屏（<768，与 `useIsNarrow` 同一阈值）全屏覆盖页。
 * 未配置 vault 时也可用——设置存在设备配置目录，与 vault 无关。
 */

const SECTIONS: { key: SectionKey; label: string; icon: typeof Palette }[] = [
  { key: "appearance", label: "外观", icon: Palette },
  { key: "editor", label: "编辑器", icon: Pencil },
  { key: "storage", label: "存储", icon: Monitor },
  { key: "sync", label: "同步", icon: Settings2 },
  { key: "about", label: "关于", icon: Info },
];

/* ── 通用控件（docs/08 §5.2：离散档位点一次即应用，无需防抖） ── */

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-2.5">
      <div className="min-w-[7rem] flex-1">
        <div className="text-sm text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-ink-3">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** 分段按钮：激活态浮起白片（复用 ModeButton 视觉） */
function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg bg-ink/5 p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={String(o.key)}
          onClick={() => onChange(o.key)}
          className={`min-h-[32px] rounded-md px-2.5 py-1 ${
            value === o.key ? "bg-card text-ink shadow-slider" : "text-ink-2 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors ${
        on ? "bg-accent" : "bg-ink/20"
      }`}
    >
      <span
        className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-all ${
          on ? "left-[19px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-1 text-[11px] font-medium text-ink-3">{title}</h3>
      <div className="divide-y divide-line rounded-xl border border-line bg-card px-3 shadow-card">
        {children}
      </div>
    </section>
  );
}

/* ── 分组内容 ── */

/** 外观（M5 减法后只剩排版两项；字体栈常驻 index.css，不再可调） */
function AppearanceSection() {
  const a = useSettingsStore((s) => s.settings.appearance);
  const patch = useSettingsStore((s) => s.patch);
  /** 外观小节的任何改动都整节提交（Rust 语义：传入即整体替换） */
  const set = (next: Partial<typeof a>) => void patch({ appearance: { ...a, ...next } });

  return (
    <>
      <Group title="排版">
        <Row label="正文字号">
          <Segmented value={a.textSize} options={SIZE_OPTIONS} onChange={(k) => set({ textSize: k })} />
        </Row>
        <Row label="行距">
          <Segmented
            value={a.lineHeight}
            options={LINE_HEIGHT_OPTIONS}
            onChange={(k) => set({ lineHeight: k })}
          />
        </Row>
      </Group>
    </>
  );
}

function EditorSection() {
  const e = useSettingsStore((s) => s.settings.editor);
  const patch = useSettingsStore((s) => s.patch);
  const set = (next: Partial<typeof e>) => void patch({ editor: { ...e, ...next } });

  return (
    <Group title="编辑器">
      <Row label="默认打开模式" hint="打开笔记与新建后的初始模式">
        <Segmented
          value={e.defaultMode}
          options={EDITOR_MODE_OPTIONS}
          onChange={(k) => set({ defaultMode: k as EditorMode })}
        />
      </Row>
      <Row label="自动保存延迟" hint="停止输入后多久自动保存">
        <Segmented
          value={e.autosaveMs}
          options={AUTOSAVE_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
          onChange={(k) => set({ autosaveMs: k })}
        />
      </Row>
      <Row label="源码模式显示行号">
        <Switch
          on={e.sourceLineNumbers}
          label="源码模式显示行号"
          onToggle={() => set({ sourceLineNumbers: !e.sourceLineNumbers })}
        />
      </Row>
      <Row label="新建笔记默认位置" hint="选「上次所在目录」时，关闭应用后不再记住">
        <Segmented
          value={e.newNoteLocation}
          options={NEW_NOTE_LOCATION_OPTIONS}
          onChange={(k) => set({ newNoteLocation: k })}
        />
      </Row>
    </Group>
  );
}

/** 只读行 + 复制（复用 SyncSection 的 CopyButton 视觉） */
function CopyRow({ value, title }: { value: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <span className="max-w-[22rem] truncate text-xs text-ink-2" title={title ?? value}>
        {value}
      </span>
      <button
        title="复制"
        aria-label="复制"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          );
        }}
        className="shrink-0 rounded-md p-1 text-ink-3 hover:bg-canvas hover:text-ink"
      >
        {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

/** 字节 → 人类可读（设置页统计用；<1KB 显示 B） */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function StorageSection() {
  const retention = useSettingsStore((s) => s.settings.storage.trashRetentionDays);
  const patch = useSettingsStore((s) => s.patch);
  const openDialog = useSettingsStore((s) => s.openDialog);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const status = useVaultStore((s) => s.status);
  const switchVault = useVaultStore((s) => s.switchVault);
  const reindex = useVaultStore((s) => s.reindex);
  const setError = useVaultStore.setState;
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [busy, setBusy] = useState(false);
  const android = isAndroid();

  const refresh = () => {
    if (status !== "ready") {
      setStats(null);
      return;
    }
    void vault
      .stats()
      .then(setStats)
      .catch(() => setStats(null));
  };
  useEffect(refresh, [status, vaultPath]);

  const doSwitch = async () => {
    // 桌面走系统选择器；Android 走 SAF（与首启页同一批命令）
    let path: string | null = null;
    if (android) {
      const { vaultPicker } = await import("../lib/sync");
      path = await vaultPicker.pickFolder();
    } else {
      const { open } = await import("@tauri-apps/plugin-dialog");
      path = ((await open({ directory: true, multiple: false })) as string | null) ?? null;
    }
    if (!path) return;
    if (!window.confirm(`切换到笔记库：\n${path}\n\n当前笔记会先保存。确定？`)) return;
    setBusy(true);
    const ok = await switchVault(path, "open");
    setBusy(false);
    if (ok) {
      refresh();
      // 手机端是同步中心：换库会重启 axum 服务器（端口可能 +1，配对码不变）
      if (android) {
        window.alert(
          "笔记库已切换。\n\n同步中心已在新笔记库上重启，配对码不变，桌面端无需重新配对。",
        );
      }
    }
  };

  return (
    <>
      <Group title="当前笔记库">
        <Row label="位置" hint={vaultPath ?? "尚未配置"}>
          {vaultPath ? <CopyRow value={vaultPath} /> : <span className="text-xs text-ink-3">—</span>}
        </Row>
        {android && vaultPath?.includes("/Android/data/") && (
          <Row label="注意">
            <span className="max-w-[22rem] text-xs text-warn">
              这是应用私有目录，卸载 App 会一并删除笔记库
            </span>
          </Row>
        )}
        <Row label="内容" hint={stats ? undefined : "统计需要先打开笔记库"}>
          {stats ? (
            <span className="text-xs text-ink-2">
              {stats.notes} 篇笔记 · {stats.folders} 个文件夹 · {stats.assets} 个附件 ·{" "}
              {fmtBytes(stats.bytes)}
            </span>
          ) : (
            <span className="text-xs text-ink-3">—</span>
          )}
        </Row>
        <Row label="操作">
          <span className="flex flex-wrap gap-1.5">
            <button
              disabled={busy}
              onClick={() => void doSwitch()}
              className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 hover:bg-canvas hover:text-ink disabled:opacity-50"
            >
              <FolderOpen size={13} />
              更改笔记库…
            </button>
            {!android && vaultPath && (
              <button
                onClick={() => void vault.reveal(vaultPath).catch((e) => setError({ error: String(e) }))}
                className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 hover:bg-canvas hover:text-ink"
              >
                <HardDrive size={13} />
                在文件管理器中打开
              </button>
            )}
            <button
              disabled={status !== "ready"}
              onClick={() => {
                void reindex().then(refresh);
              }}
              className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 hover:bg-canvas hover:text-ink disabled:opacity-50"
            >
              <RefreshCw size={13} />
              重新扫描
            </button>
          </span>
        </Row>
      </Group>

      <Group title="回收站">
        <Row
          label="自动清理"
          hint="删除的笔记会先移到这里，到期自动清理"
        >
          <Segmented
            value={retention}
            options={TRASH_RETENTION_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
            onChange={(k) => void patch({ storage: { trashRetentionDays: k } })}
          />
        </Row>
        <Row label="当前占用">
          {stats ? (
            <span className="text-xs text-ink-2">
              {stats.trashEntries} 项 · {fmtBytes(stats.trashBytes)}
            </span>
          ) : (
            <span className="text-xs text-ink-3">—</span>
          )}
        </Row>
        <Row label="立即清空" hint="清空后回收站里的笔记无法找回">
          <button
            disabled={!stats || stats.trashEntries === 0}
            onClick={() => {
              if (!stats) return;
              if (
                !window.confirm(
                  // window.confirm 是纯文本对话框：这里不能写 markdown 强调号，
                  // 否则用户看到字面的 ** 星号（真机走查发现）
                  `清空回收站？\n\n将删除 ${stats.trashEntries} 项（${fmtBytes(stats.trashBytes)}），删除后无法恢复。\n\n（笔记的删除已同步给其他设备，不受影响。）`,
                )
              ) {
                return;
              }
              void vault
                .trashClear()
                .then(refresh)
                .catch((e) => setError({ error: String(e) }));
            }}
            className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 hover:bg-canvas hover:text-ink disabled:opacity-50"
          >
            <Trash2 size={13} />
            清空回收站
          </button>
        </Row>
      </Group>

      {!android && (
        <p className="px-1 text-[11px] leading-4 text-ink-3">
          笔记都是纯 Markdown 文件，直接复制笔记库目录即可备份（无需先关闭同步）。
        </p>
      )}
      {/* 首启页齿轮入口打开本面板时也能换库 */}
      {status !== "ready" && (
        <button
          onClick={() => openDialog("storage")}
          className="mt-2 text-[11px] text-accent-text hover:underline"
        >
          尚未打开笔记库
        </button>
      )}
    </>
  );
}

function SyncSection2() {
  const syncAuto = useSyncStore((s) => s.syncAuto);
  const setSyncAuto = useSyncStore((s) => s.setSyncAuto);
  // D3：关设置页 + 展开侧栏同步面板（不在这里复制一套配对 UI）
  const requestSyncPanel = useSettingsStore((s) => s.requestSyncPanel);
  // `syncAuto` 为 null 表示尚未读到（取默认开；与侧栏同步条同一 store 同一状态）
  const on = syncAuto !== false;
  return (
    <>
      <Group title="自动同步">
        <Row label="自动同步" hint="自动把改动同步到已连接的设备">
          <Switch on={on} label="自动同步" onToggle={() => void setSyncAuto(!on)} />
        </Row>
      </Group>

      {/* M5-2：原「设备发现」组（局域网扫描开关）已移除——扫描只在点
          「自动查找手机」时发生，且开关从不持久化，属无意义设置。 */}

      {/* 配对 UI 只有一套：关掉设置面板并展开侧栏的同步面板（docs/08 §3.4 D3） */}
      <Group title="设备配对">
        <Row label="管理设备与配对" hint="配对、查看已连接设备">
          <button
            onClick={requestSyncPanel}
            className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 hover:bg-canvas hover:text-ink"
          >
            打开同步面板
          </button>
        </Row>
      </Group>
    </>
  );
}

/** M5-4/M5-5/M5-6 更新组：检测（全平台）+ 应用内更新（Windows/Linux）。
 *  Windows 走 updater 插件：拉 latest.json 验签下载 NSIS 包并静默安装，
 *  装完自动退出应用；Linux 走自定义自更新（验签 tar.gz 替换二进制后重启）；
 *  Android 插件不支持，保持「打开发布页」。 */
function UpdateGroup({ platform }: { platform?: string }) {
  const info = useUpdateStore((s) => s.info);
  const checking = useUpdateStore((s) => s.checking);
  const error = useUpdateStore((s) => s.error);
  const checkNow = useUpdateStore((s) => s.checkNow);
  const setError = useUpdateStore.setState;
  const autoCheck = useSettingsStore((s) => s.settings.update.autoCheck);
  const patch = useSettingsStore((s) => s.patch);
  // 安装进度（M5-5）：仅 Windows 应用内安装时出现，属组件内瞬时 UI 态
  const [installing, setInstalling] = useState(false);
  const [downloaded, setDownloaded] = useState(0);
  const [contentLength, setContentLength] = useState<number | null>(null);

  const openReleasePage = (url: string) => {
    void openUrl(url).catch((e) => setError({ error: String(e) }));
  };

  /** 从 UpdateInfo.htmlUrl（…/releases/tag/vX.Y.Z）提取 tag，供 Linux 自更新。 */
  const tagFromUrl = (url: string): string | null => {
    const m = url.match(/\/releases\/tag\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };

  /** Windows 应用内安装：updater 插件 check → 验签下载 → 运行 NSIS 安装器
   *  （安装器启动后插件会退出应用，promise 不必等待返回）。 */
  const installInApp = async () => {
    setInstalling(true);
    setDownloaded(0);
    setContentLength(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const u = await check();
      if (!u) {
        setError({ error: "上游未提供更新包（latest.json 缺失或已是最新）" });
        setInstalling(false);
        return;
      }
      await u.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setContentLength(event.data.contentLength ?? null);
        } else if (event.event === "Progress") {
          setDownloaded((d) => d + event.data.chunkLength);
        }
        // Finished 不处理：安装器接管后应用随即退出
      });
      // 走到这里 = 安装器已接管（Windows 上插件随后退出应用）
    } catch (e) {
      setError({ error: `应用内更新失败: ${e}` });
      setInstalling(false);
    }
  };

  /** M5-6 Linux 自更新：下载 tar.gz + .sig → minisign 验签 → 替换二进制 →
   *  自动重启（Rust 侧完成；下载大文件耗时，成功即重启，无需复位 installing）。 */
  const installLinux = async () => {
    if (!info?.htmlUrl) return;
    const tag = tagFromUrl(info.htmlUrl);
    if (!tag) {
      setError({ error: `无法从发布链接解析版本号: ${info.htmlUrl}` });
      return;
    }
    setInstalling(true);
    try {
      await updateApi.installLinux(tag);
      // 正常不会走到这里：Rust 替换完成后 app.restart() 会退出进程
    } catch (e) {
      setError({ error: `自更新失败: ${e}` });
      setInstalling(false);
    }
  };

  const progressHint = () => {
    if (contentLength != null && contentLength > 0) {
      return `下载中 ${Math.min(100, Math.round((downloaded / contentLength) * 100))}%`;
    }
    return `已下载 ${(downloaded / 1048576).toFixed(1)} MB`;
  };

  const hint = info?.checkedAtMs
    ? `上次检查 ${new Date(info.checkedAtMs).toLocaleString()}`
    : "从未检查";

  return (
    <Group title="更新">
      <Row label="自动检查更新" hint="每天最多一次，启动时静默进行">
        <Switch
          on={autoCheck}
          label="自动检查更新"
          onToggle={() => void patch({ update: { autoCheck: !autoCheck } })}
        />
      </Row>
      <Row label="检查更新" hint={hint}>
        <button
          disabled={checking || installing}
          onClick={() => void checkNow()}
          className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 hover:bg-canvas hover:text-ink disabled:opacity-50"
        >
          {checking ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {checking ? "检查中…" : "检查更新"}
        </button>
      </Row>
      {error && (
        <Row label="检查失败">
          <span className="max-w-[22rem] break-all text-xs text-red-500">{error}</span>
        </Row>
      )}
      {info?.hasUpdate && info.latestVersion && (
        <Row
          label={`发现新版本 v${info.latestVersion}`}
          hint={installing
            ? platform === "linux"
              ? "下载并验签更新包，完成后自动重启…"
              : progressHint()
            : (info.notes ?? undefined)}
        >
          {platform === "windows" ? (
            <button
              disabled={installing}
              onClick={() => void installInApp()}
              className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white shadow-slider hover:bg-accent-text disabled:opacity-50"
            >
              {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {installing ? "更新中…" : "立即更新"}
            </button>
          ) : platform === "linux" ? (
            <button
              disabled={installing}
              onClick={() => void installLinux()}
              className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white shadow-slider hover:bg-accent-text disabled:opacity-50"
            >
              {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {installing ? "更新中…" : "立即更新"}
            </button>
          ) : (
            <button
              onClick={() => info.htmlUrl && openReleasePage(info.htmlUrl)}
              className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white shadow-slider hover:bg-accent-text"
            >
              <Download size={13} />
              打开发布页
            </button>
          )}
        </Row>
      )}
      {info && !info.hasUpdate && !info.skipped && (
        <Row label="检查结果">
          <span className="text-xs text-ink-2">已是最新</span>
        </Row>
      )}
    </Group>
  );
}

function AboutSection() {
  const reset = useSettingsStore((s) => s.reset);
  const settings = useSettingsStore((s) => s.settings);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [stats, setStats] = useState<VaultStats | null>(null);
  const android = isAndroid();
  // E3 诊断信息里的同步状态：与侧栏同步面板同一 store（订阅而非 getState，
  // 否则面板开着时同步状态变化不会反映到复制的文本里）
  const pairing = useSyncStore((s) => s.pairing);
  const servers = useSyncStore((s) => s.servers);
  const probeStates = useSyncStore((s) => s.probeStates);
  const syncAuto = useSyncStore((s) => s.syncAuto);
  const conflictCount = useSyncStore((s) => s.conflictCount);
  const refreshPairing = useSyncStore((s) => s.refreshPairing);
  const refreshServers = useSyncStore((s) => s.refreshServers);

  // 打开关于页时补一次同步状态（关于页可能在同步面板没轮询时被单独打开）
  useEffect(() => {
    void refreshPairing();
    void refreshServers();
  }, [refreshPairing, refreshServers]);

  useEffect(() => {
    void vault
      .appInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
    void vault
      .stats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  /**
   * E3：一键复制诊断信息（纯函数 buildDiagnostics，见文件末尾）。
   *
   * 目的（docs/08 §3.5 E3）：替代完整错误上报。用户遇到问题把这段贴出来，
   * 就能判断是「库没打开 / 同步没连上 / 版本太旧」哪一类，不必来回追问。
   */
  const diagnostics = () =>
    buildDiagnostics({
      info,
      vaultPath,
      stats,
      pairing,
      servers,
      probeStates,
      syncAuto,
      conflictCount,
      settings,
    });

  return (
    <>
      <Group title="版本">
        <Row label="版本" hint={info?.platform}>
          <span className="text-xs text-ink-2">{info?.version ?? "…"}</span>
        </Row>
        <Row label="配置目录">
          {info?.configDir ? (
            <span className="flex items-center gap-1.5">
              <CopyRow value={info.configDir} />
              {!android && (
                <button
                  title="打开配置目录"
                  onClick={() =>
                    void vault
                      .reveal(info.configDir as string)
                      .catch((e) => useVaultStore.setState({ error: String(e) }))
                  }
                  className="rounded-md p-1 text-ink-3 hover:bg-canvas hover:text-ink"
                >
                  <FolderOpen size={13} />
                </button>
              )}
            </span>
          ) : (
            <span className="text-xs text-ink-3">—</span>
          )}
        </Row>
        <Row label="日志目录">
          {info?.logDir ? (
            <span className="flex items-center gap-1.5">
              <CopyRow value={info.logDir} />
              {!android && (
                <button
                  title="打开日志目录"
                  onClick={() =>
                    void vault
                      .reveal(info.logDir as string)
                      .catch((e) => useVaultStore.setState({ error: String(e) }))
                  }
                  className="rounded-md p-1 text-ink-3 hover:bg-canvas hover:text-ink"
                >
                  <FolderOpen size={13} />
                </button>
              )}
            </span>
          ) : (
            <span className="text-xs text-ink-3">—</span>
          )}
        </Row>
        <Row label="复制诊断信息" hint="遇到问题时复制给开发者">
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(diagnostics());
            }}
            className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 hover:bg-canvas hover:text-ink"
          >
            <Copy size={13} />
            复制
          </button>
        </Row>
      </Group>
      <UpdateGroup platform={info?.platform} />
      <Group title="重置">
        <Row label="恢复默认设置" hint="保留笔记库位置与已配对设备">
          <button
            onClick={() => {
              if (window.confirm("恢复默认设置？\n\n外观、编辑器与更新偏好将回到默认值；笔记库位置与已配对设备保留。")) {
                void reset();
              }
            }}
            className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 hover:bg-canvas hover:text-ink"
          >
            <RotateCcw size={13} />
            恢复默认
          </button>
        </Row>
      </Group>
    </>
  );
}

const SECTION_RENDER: Record<SectionKey, () => React.ReactElement> = {
  appearance: AppearanceSection,
  editor: EditorSection,
  storage: StorageSection,
  sync: SyncSection2,
  about: AboutSection,
};

/* ── 面板外壳 ── */

export function SettingsDialog({ narrow }: { narrow: boolean }) {
  const open = useSettingsStore((s) => s.dialogOpen);
  const active = useSettingsStore((s) => s.activeSection);
  const setActive = useSettingsStore((s) => s.setActiveSection);
  const close = useSettingsStore((s) => s.closeDialog);

  // Esc 关闭（窄屏也一致）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const Body = SECTION_RENDER[active];
  const title = SECTIONS.find((s) => s.key === active)?.label ?? "";

  /* 窄屏：全屏覆盖页，顶部标题 + 返回，导航改为纵向分节（无左栏） */
  if (narrow) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-canvas">
        <div className="flex items-center gap-2 border-b border-line bg-side px-3 py-3">
          <button
            aria-label="返回"
            onClick={close}
            className="rounded-lg p-2 text-ink-2 hover:bg-canvas hover:text-ink"
          >
            <ArrowLeft size={18} />
          </button>
          <span className="flex-1 text-sm font-semibold text-ink">设置 · {title}</span>
        </div>
        {/* 分组切换：横向滚动药丸（触控目标高度 ≥44px） */}
        <div className="flex gap-1.5 overflow-x-auto border-b border-line bg-side px-3 py-2">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setActive(s.key)}
              className={`min-h-[44px] shrink-0 rounded-lg px-3 text-xs ${
                active === s.key ? "bg-card text-ink shadow-card" : "text-ink-2"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <Body />
        </div>
      </div>
    );
  }

  /* 宽屏：居中模态，左导航 + 右滚动区 */
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      {/* 点遮罩关闭（内容卡上标 data-no-drag，避免 Linux 无边框窗口误拖） */}
      <div className="absolute inset-0" onClick={close} />
      <div
        data-no-drag
        className="relative flex h-[min(620px,88vh)] w-[760px] max-w-full overflow-hidden rounded-2xl border border-line bg-canvas shadow-pop"
      >
        <nav
          onMouseDown={isLinuxDesktop ? dragWindow : undefined}
          className="flex w-44 shrink-0 flex-col border-r border-line bg-side p-2"
        >
          <div className="px-3 py-3 text-xs font-semibold text-ink-3">设置</div>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.key}
                onClick={() => setActive(s.key)}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
                  active === s.key
                    ? "bg-card text-ink shadow-card"
                    : "text-ink-2 hover:bg-canvas hover:text-ink"
                }`}
              >
                <Icon size={15} className="shrink-0" />
                {s.label}
              </button>
            );
          })}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <span className="flex-1 text-sm font-semibold text-ink">{title}</span>
            <button
              aria-label="关闭设置"
              onClick={close}
              className="rounded-lg p-1.5 text-ink-3 hover:bg-canvas hover:text-ink"
            >
              <X size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <Body />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── E3 诊断信息（纯函数，便于单测；文本格式是契约——用户会把它贴出来求助） ── */

export interface DiagnosticsInput {
  info: AppInfo | null;
  vaultPath: string | null;
  stats: VaultStats | null;
  pairing: import("../lib/sync").SyncPairingInfo | null;
  servers: import("../lib/sync").ServerProfile[];
  probeStates: Record<string, { online: boolean | null } | undefined>;
  syncAuto: boolean | null;
  conflictCount: number | null;
  settings: import("../lib/settings").Settings;
}

/**
 * 组装可一键复制的诊断文本。
 *
 * 分段理由：用户贴到 issue 里时，前几行就该能定位大类问题（版本/库/同步），
 * 细节（外观/编辑器偏好/目录）放后面。同步段尤其重要——「同步没连上」是
 * 最高频的问题，而它的成因（服务器没跑 / 设备离线 / 积压待确认）在这段里可辨。
 */
export function buildDiagnostics(i: DiagnosticsInput): string {
  const syncLines: string[] = [];
  if (i.pairing) {
    syncLines.push(
      i.pairing.running ? `同步中心: 运行中 · 端口 ${i.pairing.port}` : "同步中心: 未运行",
    );
    // M4h-4：代号是排障第一线索（对端看到的本机名）；deviceName 仅旧版兼容
    const alias = i.pairing.deviceAlias || i.pairing.deviceName;
    if (alias) syncLines.push(`设备代号: ${alias}`);
    if (i.pairing.lanIp) syncLines.push(`本机地址: ${i.pairing.lanIp}`);
    if (i.pairing.deviceId) syncLines.push(`设备身份: ${i.pairing.deviceId}`);
    const pending = i.pairing.pendingPairs?.length ?? 0;
    if (pending > 0) syncLines.push(`待确认配对: ${pending} 条`);
  }
  for (const s of i.servers) {
    const st = i.probeStates[s.id]?.online;
    const health = st === true ? "在线" : st === false ? "离线" : "未探测";
    syncLines.push(
      `已配对: ${s.name} (${s.url}) · ${health}` +
        (s.lastSuccessAt ? ` · 上次同步 ${new Date(s.lastSuccessAt).toLocaleString()}` : ""),
    );
  }
  if (i.servers.length === 0 && !i.pairing?.running) {
    syncLines.push("已配对设备: 无");
  }
  if (i.conflictCount != null && i.conflictCount > 0) {
    syncLines.push(`冲突副本: ${i.conflictCount} 个`);
  }
  if (i.syncAuto != null) {
    syncLines.push(`自动同步: ${i.syncAuto ? "开" : "关"}`);
  }

  const a = i.settings.appearance;
  return [
    `Lanmark ${i.info?.version ?? "?"} (${i.info?.platform ?? "?"})`,
    `笔记库: ${i.vaultPath ?? "未配置"}`,
    i.stats
      ? `规模: ${i.stats.notes} 篇 / ${i.stats.folders} 目录 / ${i.stats.assets} 附件 / ${fmtBytes(i.stats.bytes)}`
      : "规模: 未知",
    `回收站: ${i.stats ? `${i.stats.trashEntries} 项 · ${fmtBytes(i.stats.trashBytes)}` : "未知"}`,
    ...syncLines,
    `外观: 字号=${a.textSize} 行距=${a.lineHeight}`,
    `编辑器: 默认模式=${i.settings.editor.defaultMode} 自动保存=${i.settings.editor.autosaveMs}ms`,
    `配置目录: ${i.info?.configDir ?? "?"}`,
    `日志目录: ${i.info?.logDir ?? "?"}`,
  ].join("\n");
}
