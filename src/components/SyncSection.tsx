import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronUp,
  Copy,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { useSyncStore } from "../stores/sync";
import { useVaultStore } from "../stores/vault";
import { isAndroid } from "../lib/sync";

/**
 * 同步区收纳（方案 B，用户选定 2026-09-21，design/direction-approved.md）：
 * 侧栏底边只剩一行常驻条（状态点 + 自动同步开关 + 立即同步 + 展开箭头），
 * 服务器管理 / 配对 / 同步报告收进点击行后向上弹出的面板。
 * 视觉沿用「晨窗」基线；只动布局收纳，不动 store 与 Rust 逻辑。
 */

/** mtime(ms) → "HH:MM"（合并报告里展示输家版本的保存时间） */
function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** 复制到剪贴板的小按钮 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      title="复制"
      className="rounded-md p-1 text-ink-3 hover:bg-canvas hover:text-ink"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* 剪贴板不可用（无权限）时静默 */
        }
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

/** 手机端面板：服务器状态 + 配对码（给桌面端输入用）+ 冲突副本可发现性（docs/07 §6）。
 *  轮询在常驻条里做（面板收起时条上也要显示运行状态），这里只做展示。 */
function ServerPanel() {
  const pairing = useSyncStore((s) => s.pairing);
  const conflictCount = useSyncStore((s) => s.conflictCount);

  if (!pairing) {
    return <div className="px-3 py-2 text-xs text-ink-3">读取配对信息…</div>;
  }

  return (
    <div className="space-y-2 px-3">
      <div className="flex items-center gap-2 rounded-[10px] border border-line bg-card px-3 py-2.5 shadow-card">
        <Server size={14} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">
            {pairing.running ? "同步中心运行中" : "服务器未启动"}
          </div>
          <div className="text-[11px] text-ink-3">
            {pairing.running
              ? `端口 ${pairing.port} · 手机与桌面需在同一局域网`
              : "打开笔记库后自动启动"}
          </div>
        </div>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            pairing.running ? "bg-emerald-500" : "bg-ink-3/40"
          }`}
        />
      </div>

      {pairing.running && (
        <div className="flex items-center gap-2 rounded-[10px] border border-line bg-card px-3 py-2.5 shadow-card">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-ink-3">配对码（在桌面端输入）</div>
            <div className="font-mono text-lg tracking-[0.3em] text-ink tabular-nums">
              {pairing.pairingCode}
            </div>
          </div>
          <CopyButton text={pairing.pairingCode} />
        </div>
      )}

      {/* M3e 可发现性：最近回合时间 + 库中冲突副本（docs/07 §6） */}
      {pairing.running && (
        <div className="flex items-center gap-3 px-1 text-[11px] text-ink-3">
          <span>
            最近回合 {pairing.lastRoundAt ? fmtClock(pairing.lastRoundAt) : "本次启动后暂无"}
          </span>
          {conflictCount != null && conflictCount > 0 && (
            <span className="text-amber-600">库中 {conflictCount} 个冲突副本</span>
          )}
        </div>
      )}
    </div>
  );
}

/** 桌面端面板：服务器列表 + 最近报告 + 添加/配对（自动同步开关已上移到常驻条） */
function ClientPanel() {
  const {
    servers,
    discovered,
    discovering,
    syncing,
    lastReport,
    probeStates,
    discover,
    pair,
    removeServer,
    syncNow,
  } = useSyncStore();
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");

  const canPair = url.trim().startsWith("http") && code.trim().length === 8;

  return (
    <div className="space-y-3 px-3">
      {/* 已配对服务器（M3e：在线状态 + 最近同步时间） */}
      {servers.map((s) => {
        const online = probeStates[s.id]?.online ?? null;
        return (
        <div
          key={s.id}
          className="rounded-[10px] border border-line bg-card px-3 py-2.5 shadow-card"
        >
          <div className="flex items-center gap-2">
            <Smartphone size={14} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-ink">{s.name}</span>
                <span
                  title={online === true ? "在线" : online === false ? "离线" : "尚未探测"}
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    online === true
                      ? "bg-emerald-500"
                      : online === false
                        ? "bg-red-400"
                        : "bg-ink-3/40"
                  }`}
                />
              </div>
              <div className="truncate text-[11px] text-ink-3">
                {s.url}
                {s.lastSuccessAt != null && (
                  <span> · 上次同步 {fmtClock(s.lastSuccessAt)}</span>
                )}
              </div>
            </div>
            <button
              title="移除服务器"
              className="rounded-md p-1 text-ink-3 hover:bg-canvas hover:text-red-500"
              onClick={() => void removeServer(s.id)}
            >
              <Trash2 size={13} />
            </button>
          </div>
          <button
            disabled={syncing}
            onClick={() => void syncNow(s.id)}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-slider hover:bg-accent-text disabled:opacity-50"
          >
            {syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {syncing ? "同步中…" : "立即同步"}
          </button>
        </div>
        );
      })}

      {/* 最近一次同步结果 */}
      {lastReport && (
        <div className="rounded-[10px] border border-line bg-canvas px-3 py-2 text-xs text-ink-2">
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span className="text-emerald-600">拉取 {lastReport.pulled.length}</span>
            <span className="text-accent">推送 {lastReport.pushed.length}</span>
            {lastReport.merges.length > 0 && (
              <span className="text-amber-500">
                自动合并 {lastReport.merges.length}（较新留原名）
              </span>
            )}
            {lastReport.deleted.length > 0 && (
              <span>已同步删除 {lastReport.deleted.length}（进回收站）</span>
            )}
            <span>跳过 {lastReport.skipped}</span>
          </div>
          {lastReport.merges.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {lastReport.merges.map((m, i) => (
                <div key={i} className="break-all text-amber-600">
                  {m.path} →{" "}
                  <button
                    type="button"
                    title="打开保留的较旧版本副本"
                    className="underline decoration-dotted underline-offset-2 hover:text-amber-700"
                    onClick={() => {
                      void useVaultStore.getState().openNote(m.loserCopy).catch(() => {
                        /* 副本尚未同步到本端时打开失败，静默 */
                      });
                    }}
                  >
                    副本 {m.loserCopy}
                  </button>
                  {m.loserMtimeMs > 0 && (
                    <span className="text-ink-3">（保留 {fmtClock(m.loserMtimeMs)} 版）</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {lastReport.errors.length > 0 && (
            <div className="mt-1 text-red-500">{lastReport.errors.join("；")}</div>
          )}
        </div>
      )}

      {/* 添加服务器 */}
      <div className="rounded-[10px] border border-line bg-card px-3 py-2.5 shadow-card">
        <div className="text-xs font-medium text-ink">添加同步服务器（手机）</div>

        <button
          onClick={() => void discover()}
          disabled={discovering}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-canvas disabled:opacity-50"
        >
          {discovering ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
          {discovering ? "正在搜索…" : "自动发现（同一局域网）"}
        </button>

        {discovered.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {discovered.map((d) => (
              <li key={d.url}>
                <button
                  onClick={() => setUrl(d.url)}
                  className="w-full rounded-md px-2 py-1 text-left text-xs text-ink hover:bg-canvas"
                >
                  <span className="truncate font-medium">{d.name}</span>
                  <span className="ml-1.5 text-ink-3">{d.url}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 space-y-1.5">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://192.168.x.x:4180"
            className="w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
          />
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
            placeholder="8 位配对码"
            className="w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 font-mono text-xs tracking-[0.2em] text-ink outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-ink-3 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
          />
          <button
            disabled={!canPair || syncing}
            // url 必须 trim：canPair 按 url.trim() 校验，不 trim 传入会让
            // 尾随空格通过校验但在 Rust 侧解析失败
            onClick={() => void pair(url.trim(), code)}
            className="w-full rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-slider hover:bg-accent-text disabled:opacity-40"
          >
            配对并保存
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-ink-3">
          配对码显示在手机端「同步」面板；两台设备需在同一局域网。
        </p>
      </div>
    </div>
  );
}

/** 手动「立即同步」（常驻条按钮）：对所有在线（或未探测）服务器依次回合。
 *  runRound 自带串行锁与同步前 flush；手动触发不静默，错误会浮出到面板。 */
async function syncAllServers(): Promise<void> {
  const st = useSyncStore.getState();
  for (const s of st.servers) {
    if (st.probeStates[s.id]?.online === false) continue; // 离线 → 等探测恢复
    await st.runRound(s.id);
  }
}

/** 桌面端常驻条状态文案：未配对 / 已连接 / 离线 / 尚未探测。
 *  入参来自组件内订阅的 servers / probeStates（getState 会让状态点失去响应）。 */
function clientStatus(
  servers: { id: string; lastSuccessAt: number | null }[],
  probeStates: Record<string, { online: boolean | null }>,
) {
  if (servers.length === 0) {
    return { dot: "bg-ink-3/40", label: "同步 · 未配对", dim: "" };
  }
  const anyOnline = servers.some((s) => probeStates[s.id]?.online === true);
  const allOffline = servers.every((s) => probeStates[s.id]?.online === false);
  const lastSyncAt = servers.reduce((m, s) => Math.max(m, s.lastSuccessAt ?? 0), 0);
  const dim = lastSyncAt > 0 ? fmtClock(lastSyncAt) : "";
  if (anyOnline) return { dot: "bg-emerald-500", label: "同步 · 已连接", dim };
  if (allOffline) return { dot: "bg-red-400", label: "同步 · 离线", dim };
  return { dot: "bg-ink-3/40", label: `同步 · ${servers.length} 台设备`, dim };
}

/**
 * 侧栏底边常驻条（方案 B）：
 * - 手机（服务器角色）：状态点 + 「同步中心」+ 端口/最近回合，点开面板看配对码
 * - 桌面（客户端角色）：另有迷你自动同步开关 + 立即同步按钮
 * 点击整行在原位向上弹出管理面板；点面板外 / Esc 关闭。
 */
export function SyncSection() {
  const error = useSyncStore((s) => s.error);
  const clearError = useSyncStore((s) => s.clearError);
  const refreshServers = useSyncStore((s) => s.refreshServers);
  const refreshPairing = useSyncStore((s) => s.refreshPairing);
  const syncing = useSyncStore((s) => s.syncing);
  const syncAuto = useSyncStore((s) => s.syncAuto);
  const setSyncAuto = useSyncStore((s) => s.setSyncAuto);

  const [android] = useState(isAndroid());
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 桌面：拉取已配对服务器（本地 profile 读取，轻量）；手机：轮询配对信息
  // （常驻条要显示运行状态，面板收起时也得保持，与旧版 ServerPanel 同周期）
  useEffect(() => {
    if (android) {
      void refreshPairing();
      const t = setInterval(() => void refreshPairing(), 5000);
      return () => clearInterval(t);
    }
    void refreshServers();
  }, [android, refreshServers, refreshPairing]);

  // 面板打开时：Esc / 点击面板外关闭（捕获阶段，点其它行先关面板）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  const autoOn = syncAuto === true; // 尚未加载（null）按默认开渲染
  // 桌面状态条（订阅式：probeStates 变化即时反映到状态点）
  const servers = useSyncStore((s) => s.servers);
  const probeStates = useSyncStore((s) => s.probeStates);
  // 手机端条上状态：配对信息未加载 / 未运行 / 运行中
  const pairing = useSyncStore((s) => s.pairing);

  const status = android ? null : clientStatus(servers, probeStates);
  const dot = android
    ? pairing?.running
      ? "bg-emerald-500"
      : "bg-ink-3/40"
    : (status?.dot ?? "bg-ink-3/40");
  const label = android
    ? "同步中心"
    : syncing
      ? "同步中…"
      : (status?.label ?? "同步");
  const dim = android
    ? pairing?.running
      ? `端口 ${pairing.port}${pairing.lastRoundAt ? ` · 最近回合 ${fmtClock(pairing.lastRoundAt)}` : ""}`
      : pairing
        ? "未启动"
        : ""
    : (status?.dim ?? "");

  return (
    <div ref={wrapRef} className="relative">
      {/* 常驻单行：点击展开/收起面板；行内控件各自拦截冒泡 */}
      <div
        role="button"
        aria-expanded={open}
        title={error && !open ? error : "同步设置与状态"}
        onClick={() => setOpen((o) => !o)}
        className="flex h-[42px] cursor-pointer select-none items-center gap-2 border-t border-line px-2.5 text-xs text-ink-2 hover:bg-canvas/60"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="shrink-0 font-medium">{label}</span>
        {dim && <span className="min-w-0 truncate text-[11px] text-ink-3">{dim}</span>}
        <span className="flex-1" />

        {!android && (
          <>
            {/* 迷你自动同步开关（关掉后仅保留手动同步，docs/07 §7） */}
            <button
              role="switch"
              aria-checked={autoOn}
              title={autoOn ? "关闭自动同步" : "开启自动同步"}
              onClick={(e) => {
                e.stopPropagation();
                void setSyncAuto(!autoOn);
              }}
              className={`relative h-[17px] w-[30px] shrink-0 rounded-full transition-colors ${
                autoOn ? "bg-accent" : "bg-ink-3/30"
              }`}
            >
              <span
                className="absolute left-0.5 top-0.5 h-[13px] w-[13px] rounded-full bg-white shadow transition-transform"
                style={{ transform: autoOn ? "translateX(13px)" : "translateX(0)" }}
              />
            </button>
            <button
              title={
                servers.length === 0
                  ? "尚未配对手机（点行展开面板添加）"
                  : "立即同步（所有在线设备）"
              }
              disabled={syncing || servers.length === 0}
              onClick={(e) => {
                e.stopPropagation();
                void syncAllServers();
              }}
              className="rounded-md p-1 text-ink-3 hover:bg-canvas hover:text-ink disabled:opacity-40"
            >
              {syncing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
            </button>
          </>
        )}

        {/* 手动同步出错且面板收起时给一个红点提示（详见面板内错误框） */}
        {error && !open && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />}

        <ChevronUp
          size={14}
          className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </div>

      {/* 上拉管理面板：锚定在常驻条上方，略宽于侧栏（窄屏钳制在视口内） */}
      {open && (
        <div className="absolute bottom-full left-2 z-40 mb-2 w-[330px] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-card shadow-pop">
          <div className="flex items-center justify-between pb-1 pl-4 pr-2 pt-2.5">
            <span className="text-[13px] font-semibold text-ink">同步</span>
            <button
              title="收起"
              className="rounded-md p-1 text-ink-3 hover:bg-canvas hover:text-ink"
              onClick={() => setOpen(false)}
            >
              <X size={14} />
            </button>
          </div>
          <div className="max-h-[min(560px,calc(100vh-140px))] overflow-y-auto pb-3">
            {android ? <ServerPanel /> : <ClientPanel />}

            {error && (
              <div className="mx-3 mt-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-600">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 break-all">{error}</span>
                  <button
                    className="shrink-0 text-red-400 hover:text-red-600"
                    onClick={clearError}
                  >
                    ×
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
