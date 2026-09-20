import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useSyncStore } from "../stores/sync";
import { useVaultStore } from "../stores/vault";
import { isAndroid } from "../lib/sync";

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

/** 手机端面板：服务器状态 + 配对码（给桌面端输入用） */
function ServerPanel() {
  const pairing = useSyncStore((s) => s.pairing);
  const refreshPairing = useSyncStore((s) => s.refreshPairing);

  useEffect(() => {
    void refreshPairing();
    const t = setInterval(() => void refreshPairing(), 5000);
    return () => clearInterval(t);
  }, [refreshPairing]);

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
    </div>
  );
}

/** 桌面端面板：服务器列表 + 添加 + 立即同步 */
function ClientPanel() {
  const {
    servers,
    discovered,
    discovering,
    syncing,
    lastReport,
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
      {/* 已配对服务器 */}
      {servers.map((s) => (
        <div
          key={s.id}
          className="rounded-[10px] border border-line bg-card px-3 py-2.5 shadow-card"
        >
          <div className="flex items-center gap-2">
            <Smartphone size={14} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">{s.name}</div>
              <div className="truncate text-[11px] text-ink-3">{s.url}</div>
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
      ))}

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

/** 侧栏「同步」分区：手机=服务器面板，桌面=客户端面板 */
export function SyncSection() {
  const error = useSyncStore((s) => s.error);
  const clearError = useSyncStore((s) => s.clearError);
  const refreshServers = useSyncStore((s) => s.refreshServers);
  const [android] = useState(isAndroid());

  useEffect(() => {
    if (!android) void refreshServers();
  }, [android, refreshServers]);

  return (
    <div>
      <div className="mb-1 mt-4 px-3 text-[11px] font-medium text-ink-3">同步</div>
      {android ? <ServerPanel /> : <ClientPanel />}

      {error && (
        <div className="mx-3 mt-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-600">
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 break-all">{error}</span>
            <button className="shrink-0 text-red-400 hover:text-red-600" onClick={clearError}>
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
