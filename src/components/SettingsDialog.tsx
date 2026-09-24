import { useEffect, useRef } from "react";
import {
  ArrowLeft,
  Info,
  Monitor,
  Palette,
  Pencil,
  RotateCcw,
  Settings2,
  X,
} from "lucide-react";
import { useSettingsStore, type SectionKey } from "../stores/settings";
import { useVaultStore } from "../stores/vault";
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

/** M4d/M4e 落地前的占位：明确告知「还没做」，不放假的禁用控件 */
function Placeholder({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-card/50 px-3 py-6 text-center text-xs text-ink-3">
      {text}
    </div>
  );
}

function StorageSection() {
  const retention = useSettingsStore((s) => s.settings.storage.trashRetentionDays);
  const patch = useSettingsStore((s) => s.patch);
  const vaultPath = useVaultStore((s) => s.vaultPath);

  return (
    <>
      <Group title="当前笔记库">
        <Row label="位置" hint={vaultPath ?? "尚未配置"}>
          <span className="max-w-[20rem] truncate text-xs text-ink-2">{vaultPath ?? "—"}</span>
        </Row>
      </Group>
      <Group title="回收站">
        <Row label="自动清理" hint="删除的笔记先移入回收站；此项与同步的删除传播无关">
          <Segmented
            value={retention}
            options={TRASH_RETENTION_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
            onChange={(k) => void patch({ storage: { trashRetentionDays: k } })}
          />
        </Row>
      </Group>
      <Placeholder text="笔记库统计与「更改笔记库」入口将在 M4d/M4e 落地" />
    </>
  );
}

function SyncSection2() {
  const syncAuto = useSyncStore((s) => s.syncAuto);
  const setSyncAuto = useSyncStore((s) => s.setSyncAuto);
  // `syncAuto` 为 null 表示尚未读到（取默认开；与侧栏同步条同一 store 同一状态）
  const on = syncAuto !== false;
  return (
    <>
      <Group title="自动同步">
        <Row label="自动同步" hint="与侧栏同步条的开关是同一个状态">
          <Switch on={on} label="自动同步" onToggle={() => void setSyncAuto(!on)} />
        </Row>
      </Group>
      <Placeholder text="设备配对入口将在 M4f 落地（届时复用侧栏同步面板，不另做一套 UI）" />
    </>
  );
}

function AboutSection() {
  const reset = useSettingsStore((s) => s.reset);
  return (
    <>
      <Placeholder text="版本、配置目录与诊断信息将在 M4f 落地" />
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
