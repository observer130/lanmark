import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  FolderOpen,
  HardDrive,
  Info,
  Monitor,
  Palette,
  Pencil,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useSettingsStore, type SectionKey } from "../stores/settings";
import { useVaultStore } from "../stores/vault";
import { vault, type AppInfo, type VaultStats } from "../lib/vault";
import { isAndroid } from "../lib/sync";
import { useSyncStore } from "../stores/sync";
import {
  AUTOSAVE_OPTIONS,
  CONTENT_WIDTH_OPTIONS,
  EDITOR_MODE_OPTIONS,
  LINE_HEIGHT_OPTIONS,
  MONO_FONT_OPTIONS,
  NEW_NOTE_LOCATION_OPTIONS,
  SIZE_OPTIONS,
  TRASH_RETENTION_OPTIONS,
  UI_FONT_OPTIONS,
  type EditorMode,
  type FontKey,
  type MonoFontKey,
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

/** 自定义字体输入：失焦/回车提交；Rust 侧白名单校验，非法回退系统默认 */
function CustomFontInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (v: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.value !== value) ref.current.value = value;
  }, [value]);
  return (
    <input
      ref={ref}
      defaultValue={value}
      placeholder={placeholder}
      spellCheck={false}
      onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="w-56 rounded-lg border border-line bg-card px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
    />
  );
}

/* ── 分组内容 ── */

function AppearanceSection() {
  const a = useSettingsStore((s) => s.settings.appearance);
  const patch = useSettingsStore((s) => s.patch);
  /** 外观小节的任何改动都整节提交（Rust 语义：传入即整体替换） */
  const set = (next: Partial<typeof a>) => void patch({ appearance: { ...a, ...next } });

  return (
    <>
      <Group title="字体">
        <Row label="界面字体" hint="侧栏、对话框、按钮（不含正文）">
          <Segmented
            value={a.uiFont}
            options={UI_FONT_OPTIONS}
            onChange={(k) => set({ uiFont: k as FontKey })}
          />
        </Row>
        {a.uiFont === "custom" && (
          <Row label="自定义界面字体" hint="填系统已装字体名；取决于系统已装字体">
            <CustomFontInput
              value={a.customFonts.ui}
              placeholder="例如 Fira Sans"
              onCommit={(v) =>
                set({ customFonts: { ...a.customFonts, ui: v } })
              }
            />
          </Row>
        )}
        <Row label="正文字体" hint="笔记正文与标题">
          <Segmented
            value={a.textFont}
            options={UI_FONT_OPTIONS}
            onChange={(k) => set({ textFont: k as FontKey })}
          />
        </Row>
        {a.textFont === "custom" && (
          <Row label="自定义正文字体" hint="取决于系统已装字体">
            <CustomFontInput
              value={a.customFonts.text}
              placeholder="例如 LXGW WenKai"
              onCommit={(v) => set({ customFonts: { ...a.customFonts, text: v } })}
            />
          </Row>
        )}
        <Row label="等宽字体" hint="代码块与源码模式">
          <Segmented
            value={a.monoFont}
            options={MONO_FONT_OPTIONS}
            onChange={(k) => set({ monoFont: k as MonoFontKey })}
          />
        </Row>
        {a.monoFont === "custom" && (
          <Row label="自定义等宽字体" hint="取决于系统已装字体">
            <CustomFontInput
              value={a.customFonts.mono}
              placeholder="例如 Fira Code"
              onCommit={(v) => set({ customFonts: { ...a.customFonts, mono: v } })}
            />
          </Row>
        )}
      </Group>

      <Group title="排版">
        <Row label="正文字号">
          <Segmented value={a.textSize} options={SIZE_OPTIONS} onChange={(k) => set({ textSize: k })} />
        </Row>
        <Row label="源码字号">
          <Segmented value={a.codeSize} options={SIZE_OPTIONS} onChange={(k) => set({ codeSize: k })} />
        </Row>
        <Row label="行距">
          <Segmented
            value={a.lineHeight}
            options={LINE_HEIGHT_OPTIONS}
            onChange={(k) => set({ lineHeight: k })}
          />
        </Row>
        <Row label="正文宽度" hint="宽屏时限制每行长度，避免一行太长">
          <Segmented
            value={a.contentWidth}
            options={CONTENT_WIDTH_OPTIONS}
            onChange={(k) => set({ contentWidth: k })}
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
      <Row label="自动保存延迟" hint="停止输入后多久落盘（连续输入期间不中途写盘）">
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
      <Row label="新建笔记默认位置" hint="「上次所在目录」仅本次会话记忆">
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
          hint="删除的笔记先移到回收站；这里清的是本地回收站，与同步的删除传播无关"
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
  const lanScanEnabled = useSyncStore((s) => s.lanScanEnabled);
  const setLanScanEnabled = useSyncStore((s) => s.setLanScanEnabled);
  // D3：关设置页 + 展开侧栏同步面板（不在这里复制一套配对 UI）
  const requestSyncPanel = useSettingsStore((s) => s.requestSyncPanel);
  // `syncAuto` 为 null 表示尚未读到（取默认开；与侧栏同步条同一 store 同一状态）
  const on = syncAuto !== false;
  return (
    <>
      <Group title="自动同步">
        <Row label="自动同步" hint="与侧栏同步条的开关是同一个状态">
          <Switch on={on} label="自动同步" onToggle={() => void setSyncAuto(!on)} />
        </Row>
      </Group>

      <Group title="设备发现">
        <Row
          label="局域网扫描"
          hint="查找手机时并发探测本机局域网内的地址；关闭后只能用「手动连接」输地址"
        >
          <Switch
            on={lanScanEnabled}
            label="局域网扫描"
            onToggle={() => setLanScanEnabled(!lanScanEnabled)}
          />
        </Row>
      </Group>
      <p className="px-1 text-[11px] leading-4 text-ink-3">
        扫描只连本机局域网内的地址、只读取设备名与笔记数，不发送任何笔记内容。
      </p>

      {/* 配对 UI 只有一套：关掉设置面板并展开侧栏的同步面板（docs/08 §3.4 D3） */}
      <Group title="设备配对">
        <Row label="管理设备与配对" hint="在侧栏的同步面板里操作，不另做一套 UI">
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
   * E3：一键复制诊断信息——版本 + 平台 + 路径 + 规模 + **同步状态** + 当前设置。
   *
   * 目的（docs/08 §3.5 E3）：替代完整错误上报。用户遇到问题把这段贴出来，
   * 就能判断是「库没打开 / 同步没连上 / 版本太旧」哪一类，不必来回追问。
   */
  const diagnostics = () => {
    const syncLines: string[] = [];
    if (pairing) {
      syncLines.push(
        pairing.running
          ? `同步中心: 运行中 · 端口 ${pairing.port}`
          : "同步中心: 未运行",
      );
      if (pairing.lanIp) syncLines.push(`本机地址: ${pairing.lanIp}`);
      if (pairing.deviceId) syncLines.push(`设备身份: ${pairing.deviceId}`);
      if ((pairing.pendingPairs?.length ?? 0) > 0) {
        syncLines.push(`待确认配对: ${pairing.pendingPairs!.length} 条`);
      }
    }
    if (servers.length > 0) {
      for (const s of servers) {
        const st = probeStates[s.id]?.online;
        const health =
          st === true ? "在线" : st === false ? "离线" : "未探测";
        syncLines.push(
          `已配对: ${s.name} (${s.url}) · ${health}` +
            (s.lastSuccessAt ? ` · 上次同步 ${new Date(s.lastSuccessAt).toLocaleString()}` : ""),
        );
      }
    } else if (!pairing?.running) {
      syncLines.push("已配对设备: 无");
    }
    if (conflictCount != null && conflictCount > 0) {
      syncLines.push(`冲突副本: ${conflictCount} 个`);
    }
    if (syncAuto != null) {
      syncLines.push(`自动同步: ${syncAuto ? "开" : "关"}`);
    }

    return [
      `Lanmark ${info?.version ?? "?"} (${info?.platform ?? "?"})`,
      `笔记库: ${vaultPath ?? "未配置"}`,
      stats
        ? `规模: ${stats.notes} 篇 / ${stats.folders} 目录 / ${stats.assets} 附件 / ${fmtBytes(stats.bytes)}`
        : "规模: 未知",
      `回收站: ${stats ? `${stats.trashEntries} 项 · ${fmtBytes(stats.trashBytes)}` : "未知"}`,
      ...syncLines,
      `外观: 界面=${settings.appearance.uiFont} 正文=${settings.appearance.textFont} 字号=${settings.appearance.textSize}/${settings.appearance.codeSize} 行距=${settings.appearance.lineHeight}`,
      `编辑器: 默认模式=${settings.editor.defaultMode} 自动保存=${settings.editor.autosaveMs}ms`,
      `配置目录: ${info?.configDir ?? "?"}`,
      `日志目录: ${info?.logDir ?? "?"}`,
    ].join("\n");
  };

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
        <Row label="复制诊断信息" hint="版本、路径、规模与当前设置">
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
      <Group title="重置">
        <Row label="恢复默认设置" hint="保留笔记库位置与已配对设备">
          <button
            onClick={() => {
              if (window.confirm("恢复默认设置？\n\n外观与编辑器偏好将回到默认值；笔记库位置与已配对设备保留。")) {
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
