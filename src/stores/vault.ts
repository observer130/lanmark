import { create } from "zustand";
import { vault, remapPath, type VaultNode, type SearchHit, type PathTitle, type TrashEntry } from "../lib/vault";
import { vaultPicker } from "../lib/sync";
import { useSettingsStore } from "./settings";
import { compareKey, formatMarkdown, trimDocTail } from "../lib/markdown-format";
import { flushEditorContent } from "../lib/editor-flush";

/** 「最近」固定 3 条（v0.5.1 用户定版：不折叠，多出的不看） */
const RECENTS_SHOWN = 3;

interface VaultStore {
  status: "loading" | "unconfigured" | "ready";
  vaultPath: string | null;
  tree: VaultNode[];
  activePath: string | null;
  content: string;
  /**
   * 外部修订号：**只**在「远端内容真的替换了当前笔记」时自增
   * （`remoteChanged` 拉到新内容 / 同步回合后重载）。
   *
   * 编辑器（`MilkdownHost`）订阅它：变化时把 store 内容灌进已挂载的 Crepe，
   * 否则已挂载的实例仍显示旧文档，用户下一次输入会把「旧文档 + 按键」写回去，
   * 覆盖刚拉取/推送的新版本（S3）。
   * 普通保存也会 `set({ content })`，但**不会**动这个号 ⇒ 不重置编辑器、不跳光标。
   */
  externalRev: number;
  /** 上次读取/落盘的文件原文；null = 基线未知（此时不启用 no-op 守卫） */
  savedContent: string | null;
  dirty: boolean;
  savedAt: number | null;
  editorMode: "read" | "wysiwyg" | "source";
  renamingPath: string | null;
  searchQuery: string;
  searchResults: SearchHit[];
  recents: PathTitle[];
  favorites: PathTitle[];
  /** v0.5.1：回收站条目（随 refreshMeta 一起刷新，删除/恢复/远端改动后自动更新） */
  trash: TrashEntry[];
  error: string | null;
  /** 收起的目录（relPath 集合；按 vault 持久化到 localStorage） */
  collapsedDirs: Set<string>;
  /**
   * v0.5.1：侧栏分区展开状态（"favorites" | "trash" 在集合里 = 展开）。
   * 默认收起（只展示 3 条 + 展开栏）；按 vault 持久化到 localStorage（硬约定 3）。
   */
  expandedSections: Set<string>;
  /** 新建对话框状态（null = 关闭） */
  pendingCreate: { kind: "note" | "folder"; parentDir: string } | null;

  init: () => Promise<void>;
  pickVault: (mode: "open" | "create") => Promise<void>;
  /** Android：SAF 选择器已给出真实路径，直接开库 */
  pickAndroidFolder: (mode: "open" | "create") => Promise<void>;
  /** Android：应用私有外部目录（零权限，Android 16 唯一可靠路径） */
  pickAppDir: (mode: "open" | "create") => Promise<void>;
  /** Android：自定义路径（需 MANAGE_EXTERNAL_STORAGE；Documents/Download 不可用） */
  pickCustomAndroidDir: (path: string, mode: "open" | "create") => Promise<void>;
  refreshTree: () => Promise<void>;
  refreshMeta: () => Promise<void>;
  reindex: () => Promise<void>;
  /** M3f：远端同步改动后刷新（服务器侧 push 落盘 / delete 生效 → Rust 推事件） */
  remoteChanged: () => Promise<void>;
  /**
   * 把「外部来源」（同步拉取 / 远端推送）的新内容应用到当前笔记：
   * 更新 content + savedContent，清 dirty，并自增 `externalRev` 让编辑器替换文档。
   *
   * 只在 `activePath === path` 且当前无未保存编辑时生效（返回是否应用）。
   * **普通保存路径不要调用**——它就是 S3 的「外部内容替换」入口。
   */
  applyExternalContent: (path: string, content: string) => boolean;
  openNote: (path: string, silent?: boolean) => Promise<void>;
  closeNote: () => Promise<void>;
  setContent: (content: string) => void;
  scheduleSave: () => void;
  saveNow: () => Promise<boolean>;
  setEditorMode: (m: "read" | "wysiwyg" | "source") => void;
  setRenaming: (path: string | null) => void;
  /** 打开新建对话框（parentDir：文件夹模式为父目录；笔记模式为所在目录） */
  openCreate: (kind: "note" | "folder", parentDir: string) => void;
  closeCreate: () => void;
  /** 对话框确认：创建笔记（自动补 .md / 重名自动 -2）。返回是否成功 */
  createNoteIn: (name: string, dir: string) => Promise<boolean>;
  /** 对话框确认：创建文件夹（名称可含 `/` 直接建多级）。返回是否成功 */
  createFolderIn: (name: string, dir: string) => Promise<boolean>;
  /** M4d：切换笔记库（严格顺序见 docs/08 §6.1）。返回是否成功 */
  switchVault: (path: string, mode: "open" | "create") => Promise<boolean>;
  toggleDirCollapsed: (path: string) => void;
  /** 展开路径的全部祖先目录（打开笔记/新建文件落在收起目录里时用） */
  expandAncestors: (path: string) => void;
  /** v0.5.1：切换侧栏分区展开/收起（"favorites" | "trash"） */
  toggleMetaSection: (id: string) => void;
  /** v0.5.1：从回收站恢复条目，返回恢复后的路径（失败返回 null，error 已提示） */
  restoreFromTrash: (trashPath: string) => Promise<string | null>;
  commitRename: (path: string, newName: string) => Promise<void>;
  deleteNode: (path: string) => Promise<void>;
  moveNode: (path: string, newDir: string) => Promise<void>;
  toggleFavorite: (path: string) => Promise<void>;
  doSearch: (q: string) => Promise<void>;
  clearError: () => void;
}

/**
 * 读取当前编辑器偏好（M4c）。抽成函数而不是模块级常量：设置可在运行中改，
 * 常量会在改完设置后继续用旧值。设置 store 未加载时取它与 Rust 一致的默认值。
 */
function prefs() {
  return useSettingsStore.getState().settings.editor;
}

/** 新建笔记的默认父目录（B4）：`root` 固定根目录，`last` 用上次新建所在目录 */
function newNoteParentDir(): string {
  return prefs().newNoteLocation === "last" ? lastCreateDir : "";
}

/** `last` 模式下记住的上次新建位置（**仅前端会话**，不落库：跨设备无意义） */
let lastCreateDir = "";

/* ── 收起目录的 localStorage 持久化（按 vault 隔离） ── */
function collapsedKey(vaultPath: string | null): string {
  return `lanmark:collapsed-dirs:${vaultPath ?? ""}`;
}

function loadCollapsed(vaultPath: string | null): Set<string> {
  try {
    const raw = localStorage.getItem(collapsedKey(vaultPath));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(vaultPath: string | null, set: Set<string>): void {
  try {
    localStorage.setItem(collapsedKey(vaultPath), JSON.stringify([...set]));
  } catch {
    /* 存储不可用（隐私模式等）时静默，仅本次会话生效 */
  }
}

/* ── 侧栏分区展开状态的 localStorage 持久化（v0.5.1，按 vault 隔离） ──
   存「已展开」集合：缺省（无记录）= 全部收起，即需求默认态「3 条 + 展开栏」 */
function metaSectionsKey(vaultPath: string | null): string {
  return `lanmark:meta-sections:${vaultPath ?? ""}`;
}

function loadMetaSections(vaultPath: string | null): Set<string> {
  try {
    const raw = localStorage.getItem(metaSectionsKey(vaultPath));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveMetaSections(vaultPath: string | null, set: Set<string>): void {
  try {
    localStorage.setItem(metaSectionsKey(vaultPath), JSON.stringify([...set]));
  } catch {
    /* 存储不可用时静默，仅本次会话生效 */
  }
}

// 记录 collapsedDirs 已为哪个 vault 加载过，避免每次 refreshTree 重置用户操作
let collapsedLoadedFor: string | null | undefined;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
// openNote 单调序号：快速连开/开+关并发时，慢的旧响应不得覆盖新状态
// （错位后用户编辑会把 A 的内容存进 B 的文件）
let openSeq = 0;
// 搜索请求序号：连续搜索时慢的旧响应不得覆盖新结果
let searchSeq = 0;

/**
 * 把编辑器里仍在 200ms 防抖中的输入同步刷回 store（S6）。
 *
 * 必须在「改变 activePath / editorMode」**之前**调用：`markdownUpdated` 是尾沿防抖，
 * 而 `crepe.destroy()` 会 cancel 掉未触发的回调——不刷就会丢掉最后 ≤200ms 的输入。
 * 返回是否刷出了新内容（null = 无变化，不制造伪 dirty）。
 */
function flushEditorToStore(): boolean {
  const md = flushEditorContent();
  if (md === null) return false;
  const before = useVaultStore.getState().content;
  useVaultStore.getState().setContent(md);
  // 返回值语义：store 里的内容**真的**变了（flush 出来的内容偶尔与 store 相同，
  // 比如保存路径刚把规范化的内容写回），调用方据此区分「有未保存输入」与「无变化」。
  return useVaultStore.getState().content !== before;
}

export const useVaultStore = create<VaultStore>((set, get) => ({
  status: "loading",
  vaultPath: null,
  tree: [],
  activePath: null,
  content: "",
  externalRev: 0,
  savedContent: null,
  dirty: false,
  savedAt: null,
  // M4c：初值取「默认打开模式」设置（设置 store 未加载时 = wysiwyg，与 M3 一致）
  editorMode: useSettingsStore.getState().settings.editor.defaultMode,
  renamingPath: null,
  searchQuery: "",
  searchResults: [],
  recents: [],
  favorites: [],
  trash: [],
  error: null,
  collapsedDirs: new Set<string>(),
  expandedSections: new Set<string>(),
  pendingCreate: null,

  init: async () => {
    try {
      let s = await vault.status();
      // 启动时 Rust 侧异步自动开库，未就绪则短暂重试
      if (s.configured && !s.open) {
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 300));
          s = await vault.status();
          if (s.open) break;
        }
      }
      if (s.configured && s.open) {
        set({ status: "ready", vaultPath: s.path });
        await get().refreshTree();
        await get().refreshMeta();
        // 恢复上次打开的笔记（文件已被删除等异常静默降级）
        const first = get().recents[0];
        if (first) await get().openNote(first.path, true);
      } else {
        set({ status: "unconfigured", vaultPath: null });
      }
    } catch (e) {
      set({ status: "unconfigured", error: String(e) });
    }
  },

  pickVault: async (mode) => {
    try {
      const path = await vault.pickAndSet(mode);
      set({ status: "ready", vaultPath: path, activePath: null, content: "", savedContent: null, dirty: false });
      await get().refreshTree();
      await get().refreshMeta();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  pickAndroidFolder: async (mode) => {
    try {
      const path = await vaultPicker.pickFolder();
      if (!path) return; // 用户取消
      const ready = await vault.setPath(path, mode);
      set({ status: "ready", vaultPath: ready, activePath: null, content: "", savedContent: null, dirty: false });
      await get().refreshTree();
      await get().refreshMeta();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  pickAppDir: async (mode) => {
    try {
      // 应用私有外部目录必须经 getExternalFilesDir 由框架创建并取回真实路径
      // （v0.2.0 release 真机 P0：Android/data/<pkg> 系统懒创建，全新安装时
      // 硬编码整链路径 + std::fs mkdirs 被 FUSE 拒绝，os error 13 无法建库）。
      // null 时退回硬编码路径（老机型兜底，行为与旧版一致）。
      const base = await vaultPicker.appDir();
      const root = (base ?? "/storage/emulated/0/Android/data/com.lanmark.app/files").replace(/\/+$/, "");
      const path = `${root}/lanmark-vault`;
      const ready = await vault.setPathWithCreate(path, mode);
      set({ status: "ready", vaultPath: ready, activePath: null, content: "", savedContent: null, dirty: false });
      await get().refreshTree();
      await get().refreshMeta();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  pickCustomAndroidDir: async (path, mode) => {
    try {
      // 先按「打开」语义进；目录不存在（MANAGE 授权下可直写）自动转「创建」，
      // 此前死锁在「目录不存在」——用户无法在任何新目录建库（v0.2.0 真机反馈）。
      // mode 参数保留调用签名（当前 UI 固定传 "open"，回落创建一律走 create 校验）
      void mode;
      let ready: string;
      try {
        ready = await vault.setPath(path, "open");
      } catch (openErr) {
        if (!String(openErr).includes("目录不存在")) throw openErr;
        ready = await vault.setPathWithCreate(path, "create");
      }
      set({ status: "ready", vaultPath: ready, activePath: null, content: "", savedContent: null, dirty: false });
      await get().refreshTree();
      await get().refreshMeta();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  refreshTree: async () => {
    try {
      const tree = await vault.tree();
      set({ tree });
      // 换库后重载该 vault 的收起目录与分区展开状态（每个 vault 只重载一次）
      const vp = get().vaultPath;
      if (collapsedLoadedFor !== vp) {
        collapsedLoadedFor = vp;
        set({ collapsedDirs: loadCollapsed(vp), expandedSections: loadMetaSections(vp) });
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  refreshMeta: async () => {
    try {
      // trash 随 meta 一起刷：开库、删除、恢复、远端改动（都走这里）后侧栏同步更新
      const [recents, favorites, trash] = await Promise.all([
        vault.recents(),
        vault.favorites(),
        vault.trashList(),
      ]);
      set({
        // 「最近」固定 3 条（v0.5.1 定版，不折叠）；收藏不截断——展示交给侧栏折叠
        recents: recents.slice(0, RECENTS_SHOWN).map(([path, title]) => ({ path, title })),
        favorites: favorites.map(([path, title]) => ({ path, title })),
        trash,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  reindex: async () => {
    try {
      await vault.reindex();
      await get().refreshTree();
      await get().refreshMeta();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  /** 远端同步改动后刷新（手机端是服务器、无客户端循环：不刷新则目录仍列
   * 远端已删的笔记，点击报「笔记不存在」）。DB 已由服务器侧 handler 维护
   * （write_note upsert / remove_prefix 清三表），此处只重取树与 meta；
   * 当前打开的笔记若未在编辑则重载内容，防陈旧内容被下一次输入覆盖
   * （与桌面 runRound 同守卫）；读失败（远端已删）保留当前状态——
   * 用户编辑保存后按 LWW edit/delete 复活（docs/07 §4.2） */
  remoteChanged: async () => {
    if (get().status !== "ready") return;
    await get().refreshTree();
    await get().refreshMeta();
    const s = get();
    if (s.activePath && !s.dirty) {
      try {
        const { content } = await vault.readNote(s.activePath);
        // applyExternalContent 会再校验一次 activePath / dirty：
        // readNote 期间用户可能已开始输入或切到别的笔记，绝不能把这份内容写错笔记。
        get().applyExternalContent(s.activePath, content);
      } catch {
        // 笔记被远端删除：保留当前状态
      }
    }
  },

  applyExternalContent: (path, content) => {
    // 同步重载是异步的：store 可能还没收到编辑器最后 ≤200ms 的输入（dirty=false，
    // 但编辑器里已经有字）。先把编辑器刷回 store；一旦刷出真实变化，就按
    // 「用户正在编辑」处理、放弃这次外部替换——与 dirty 守卫同一语义，
    // 只是把判据从「防抖已触发」提前到「编辑器里真有内容」。
    if (flushEditorToStore()) return false;
    const s = get();
    if (s.activePath !== path || s.dirty) return false;
    if (content === s.content) {
      // 内容没变但基线可能滞后：只补 savedContent，避免下次保存误判
      if (s.savedContent !== content) set({ savedContent: content });
      return false;
    }
    set({
      content,
      savedContent: content,
      dirty: false,
      savedAt: Date.now(),
      // 只有真正替换内容才自增：编辑器据此把新文档灌进已挂载实例（S3）
      externalRev: s.externalRev + 1,
    });
    return true;
  },

  openNote: async (path, silent = false) => {
    // 切走之前先 flush（S6）：此时 activePath 仍是旧笔记，写回的是旧笔记
    flushEditorToStore();
    const seq = ++openSeq;
    // 切换前先把未保存的旧笔记落盘；失败则中止切换（未保存编辑不丢铁律，
    // 与 deleteNode 同守卫——error 已由 saveNow 提示）
    if (get().dirty && get().activePath) {
      await get().saveNow();
      if (get().dirty && get().activePath) return;
    }
    if (seq !== openSeq) return; // 期间又有新的 open/close
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      const { content } = await vault.readNote(path);
      if (seq !== openSeq) return; // 慢响应：丢弃，避免 activePath 与 content 错位
      // M4c B1：每次打开笔记都回到「默认打开模式」（而非沿用上一篇的模式）
      set({
        activePath: path,
        content,
        savedContent: content,
        dirty: false,
        savedAt: null,
        renamingPath: null,
        searchQuery: "",
        editorMode: prefs().defaultMode,
      });
      await get().refreshMeta();
    } catch (e) {
      if (!silent) set({ error: String(e) });
    }
  },

  closeNote: async () => {
    // 关闭前先 flush（S6）：activePath 仍是当前笔记，最后 ≤200ms 的输入不会丢
    flushEditorToStore();
    openSeq++; // 使在途 openNote 失效（关了就不该被慢响应重新打开）
    // 关闭前落盘（数据不丢铁律）；失败则保留笔记打开，内容不丢
    if (get().dirty && get().activePath) {
      await get().saveNow();
      if (get().dirty && get().activePath) return;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({ activePath: null, content: "", savedContent: null, dirty: false, savedAt: null });
  },

  setContent: (content) => {
    if (content === get().content) return;
    set({ content, dirty: true });
    // 尾沿防抖：每次输入都重排（此前只在首击锚定，连续输入约每 700ms
    // 落盘一次句中半成品——同步恰在打字中触发会把半成品推给手机端）
    void get().scheduleSave();
  },

  scheduleSave: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void get().saveNow();
    }, prefs().autosaveMs);
  },

  /**
   * 落盘前先做「规范化比较」：内容与磁盘等价就**不写**。
   *
   * 为什么必须有这一层：Milkdown 的 trailing 插件会在首次选区事务往文末插一个空段落，
   * 序列化成 markdown 就是多一个 `\n`。只在格式化层处理不够——`writeNote` 仍会被调用，
   * 文件 mtime / 同步版本号照样变。这里用 `savedContent`（上次读/写的原文）做基线：
   *  - `trimDocTail` 永远执行（修尾空行，即使 formatOnSave 关闭）；
   *  - `formatMarkdown` 仅在设置开启时执行（整理中间空白）；
   *  - `savedContent === null` 表示基线未知（测试/异常路径），此时照常写。
   *
   * 源码模式不把整理结果回写进 `content`：CodeMirror 是受控组件，外部改 value 会动光标。
   * 只更新 `savedContent` 基线；下一次输入仍按规范化比较，不会重复写盘。
   */
  saveNow: async () => {
    const { activePath, content, dirty, savedContent, editorMode } = get();
    if (!activePath || !dirty) return true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    const format = prefs().formatOnSave;
    const next = format ? formatMarkdown(content) : trimDocTail(content);

    if (savedContent !== null) {
      const base = format ? formatMarkdown(savedContent) : trimDocTail(savedContent);
      if (compareKey(next) === compareKey(base)) {
        // 伪变更（点一下 / 只差尾空行）：清 dirty，但不写盘、不触发同步。
        set(editorMode === "source" ? { dirty: false } : { dirty: false, content: next });
        return true;
      }
    }

    try {
      await vault.writeNote(activePath, next);
      set({
        dirty: false,
        savedAt: Date.now(),
        savedContent: next,
        ...(editorMode === "source" ? {} : { content: next }),
      });
      // M3d 触发 C：保存完成 → 通知自动同步循环（轻量 CustomEvent，避免两 store 循环依赖；
      // 循环侧 5s 尾沿后回合，docs/07 §7）
      window.dispatchEvent(new CustomEvent("lanmark:vault-saved"));
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  setEditorMode: (m) => {
    if (m === get().editorMode) return;
    // 切走 wysiwyg/read 之前先 flush（S6）：今天的编辑器实例即将被 key 重建，
    // 防抖中的最后输入必须先进 store（随后由 scheduleSave 落盘）。
    flushEditorToStore();
    if (m === "wysiwyg" && get().editorMode === "source") {
      // 从源码切回：内容已是最新，直接重建编辑器
      set({ editorMode: m });
      return;
    }
    set({ editorMode: m });
  },

  setRenaming: (path) => set({ renamingPath: path }),

  openCreate: (kind, parentDir) => {
    if (kind === "note" && parentDir) lastCreateDir = parentDir;
    set({ pendingCreate: { kind, parentDir } });
  },
  closeCreate: () => set({ pendingCreate: null }),

  createNoteIn: async (name, dir) => {
    try {
      // B4：调用方未指定位置（空串 = 根）时按设置决定 —— `root` 根目录，
      // `last` 用上次所在目录。侧栏「+ 笔记」走的就是这条路径。
      const target = dir || newNoteParentDir();
      const node = await vault.createNote(target, name);
      if (target) lastCreateDir = target;
      await get().refreshTree();
      await get().openNote(node.path);
      get().expandAncestors(node.path);
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  createFolderIn: async (name, dir) => {
    try {
      const node = await vault.createFolder(dir, name);
      await get().refreshTree();
      get().expandAncestors(node.path);
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  /**
   * M4d 切换笔记库（docs/08 §6.1，最高风险流程）。
   *
   * 严格顺序，任何一步失败都要保住原状：
   *   1. dirty → saveNow()；失败 → **中止**，不切库（未保存编辑不丢铁律）
   *   2. 停自动同步循环（先停，防止回合打到半切换状态）
   *   3. vault_set_path（与 VaultPicker 完全相同的调用路径）
   *   4. 成功：状态重置 + 重取树/meta + 按 B1 设默认模式 + 该库的折叠状态重载
   *   5. 失败：保留原 vault 与状态 + 错误提示（绝不出现「已切库但树是旧的」）
   *
   * 手机端：Rust 侧 open_vault_at 的 android 分支会幂等启动同步服务器
   * （端口可能 +1），配对码不变 ⇒ 桌面无需重新配对。
   */
  switchVault: async (path, mode) => {
    // 停循环 / 换库之前先 flush（S6）：编辑器实例随 activePath 一起被丢弃
    flushEditorToStore();
    const s = get();
    if (s.dirty && s.activePath) {
      const ok = await s.saveNow();
      if (!ok || get().dirty) return false; // 落盘失败：不切库
    }
    // 先停循环再切（此刻自动同步若正好在回合中，会打到半切换的 vault 上）
    const { useSyncStore } = await import("./sync");
    useSyncStore.getState().stopAutoLoop();
    try {
      const ready = await vault.setPathWithCreate(path, mode);
      // 折叠状态按库隔离：让 refreshTree 重新加载新库的那一份
      collapsedLoadedFor = undefined;
      set({
        status: "ready",
        vaultPath: ready,
        activePath: null,
        content: "",
        savedContent: null,
        dirty: false,
        savedAt: null,
        tree: [],
        searchQuery: "",
        searchResults: [],
        renamingPath: null,
        editorMode: prefs().defaultMode,
        error: null,
      });
      await get().refreshTree();
      await get().refreshMeta();
      return true;
    } catch (e) {
      // 失败：原 vault 与状态原样保留（Rust 侧开库失败不会改 state）
      set({ error: String(e) });
      return false;
    }
  },

  toggleDirCollapsed: (path) => {
    const next = new Set(get().collapsedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    saveCollapsed(get().vaultPath, next);
    set({ collapsedDirs: next });
  },

  expandAncestors: (path) => {
    const segs = path.split("/");
    const next = new Set(get().collapsedDirs);
    let changed = false;
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join("/");
      if (next.has(dir)) {
        changed = true;
        next.delete(dir);
      }
    }
    if (!changed) return;
    saveCollapsed(get().vaultPath, next);
    set({ collapsedDirs: next });
  },

  toggleMetaSection: (id) => {
    const next = new Set(get().expandedSections);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    saveMetaSections(get().vaultPath, next);
    set({ expandedSections: next });
  },

  restoreFromTrash: async (trashPath) => {
    try {
      const restored = await vault.trashRestore(trashPath);
      await get().refreshTree();
      await get().refreshMeta();
      // 恢复后展开其祖先目录，用户能在树里直接看到回来的笔记
      get().expandAncestors(restored);
      return restored;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  commitRename: async (path, newName) => {
    // 改名会让 activePath 被 remap、编辑器 key 随之重建 —— 先 flush，别丢最后输入
    flushEditorToStore();
    set({ renamingPath: null });
    if (!newName.trim() || newName.trim() === get().tree.find((n) => n.path === path)?.name) {
      return;
    }
    try {
      const node = get().tree.find((n) => n.path === path);
      const isNote = node?.kind === "note";
      // 笔记默认不带 .md 提交（Rust 侧保留原扩展名）
      const submit = isNote && newName.endsWith(".md") ? newName.slice(0, -3) : newName;
      const newPath = await vault.rename(path, submit);
      if (newPath !== path) {
        const tree = await vault.tree();
        set((s) => ({
          activePath: remapPath(s.activePath, path, newPath),
          tree,
        }));
      } else {
        await get().refreshTree();
      }
      // DB 里 recents/favorites 的路径已被 rename_paths 更新，前端必须重读，
      // 否则侧栏仍显示旧路径（点击报「笔记不存在」直到下次开笔记才自愈）
      await get().refreshMeta();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  deleteNode: async (path) => {
    const s = get();
    const containsActive =
      s.activePath === path || (s.activePath ?? "").startsWith(path + "/");
    if (containsActive) {
      if (!window.confirm("该笔记（或其所在文件夹）包含当前打开的笔记，删除前将先保存。确定删除？")) {
        return;
      }
      // 保存失败则中止删除（未保存编辑不丢铁律）
      // 先 flush：编辑器防抖里最后 ≤200ms 的输入也要进回收站副本
      flushEditorToStore();
      if (!(await s.saveNow())) return;
      set({ activePath: null, content: "", savedContent: null, dirty: false });
    } else {
      if (!window.confirm(`确定删除「${path.split("/").pop()}」？（移入回收站）`)) {
        return;
      }
    }
    try {
      await vault.remove(path);
      await get().refreshTree();
      await get().refreshMeta();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  moveNode: async (path, newDir) => {
    // 移动会让 activePath 被 remap、编辑器 key 随之重建 —— 先 flush
    flushEditorToStore();
    try {
      const newPath = await vault.move(path, newDir);
      set((s) => ({ activePath: remapPath(s.activePath, path, newPath) }));
      await get().refreshTree();
      // 同 commitRename：recents/favorites 路径已变，需重读
      await get().refreshMeta();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  toggleFavorite: async (path) => {
    try {
      await vault.toggleFavorite(path);
      await get().refreshMeta();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  doSearch: async (q) => {
    const seq = ++searchSeq; // 序号递增即作废此前在途请求
    set({ searchQuery: q });
    if (!q.trim()) {
      set({ searchResults: [] });
      return;
    }
    try {
      const results = await vault.search(q);
      if (seq !== searchSeq) return; // 慢的旧响应不得覆盖新结果
      set({ searchResults: results });
    } catch (e) {
      if (seq !== searchSeq) return;
      set({ error: String(e) });
    }
  },

  clearError: () => set({ error: null }),
}));
