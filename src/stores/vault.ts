import { create } from "zustand";
import { vault, remapPath, type VaultNode, type SearchHit, type PathTitle } from "../lib/vault";
import { vaultPicker } from "../lib/sync";

const SAVE_DEBOUNCE_MS = 700;
const RECENTS_SHOWN = 8;
const FAVORITES_SHOWN = 8;

interface VaultStore {
  status: "loading" | "unconfigured" | "ready";
  vaultPath: string | null;
  tree: VaultNode[];
  activePath: string | null;
  content: string;
  dirty: boolean;
  savedAt: number | null;
  editorMode: "read" | "wysiwyg" | "source";
  renamingPath: string | null;
  searchQuery: string;
  searchResults: SearchHit[];
  recents: PathTitle[];
  favorites: PathTitle[];
  error: string | null;

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
  openNote: (path: string, silent?: boolean) => Promise<void>;
  closeNote: () => Promise<void>;
  setContent: (content: string) => void;
  scheduleSave: () => void;
  saveNow: () => Promise<boolean>;
  setEditorMode: (m: "read" | "wysiwyg" | "source") => void;
  setRenaming: (path: string | null) => void;
  createNote: (dir: string) => Promise<void>;
  createFolder: (dir: string) => Promise<void>;
  commitRename: (path: string, newName: string) => Promise<void>;
  deleteNode: (path: string) => Promise<void>;
  moveNode: (path: string, newDir: string) => Promise<void>;
  toggleFavorite: (path: string) => Promise<void>;
  doSearch: (q: string) => Promise<void>;
  clearError: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
// openNote 单调序号：快速连开/开+关并发时，慢的旧响应不得覆盖新状态
// （错位后用户编辑会把 A 的内容存进 B 的文件）
let openSeq = 0;
// 搜索请求序号：连续搜索时慢的旧响应不得覆盖新结果
let searchSeq = 0;

export const useVaultStore = create<VaultStore>((set, get) => ({
  status: "loading",
  vaultPath: null,
  tree: [],
  activePath: null,
  content: "",
  dirty: false,
  savedAt: null,
  editorMode: "wysiwyg",
  renamingPath: null,
  searchQuery: "",
  searchResults: [],
  recents: [],
  favorites: [],
  error: null,

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
      set({ status: "ready", vaultPath: path, activePath: null, content: "", dirty: false });
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
      set({ status: "ready", vaultPath: ready, activePath: null, content: "", dirty: false });
      await get().refreshTree();
      await get().refreshMeta();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  pickAppDir: async (mode) => {
    try {
      // Android 16 真机验收结论：SAF 禁选 Documents/Download，应用私有外部目录
      // 是唯一零权限且 std::fs 可靠可写的位置
      // Android 16 真机验收：SAF 禁选 Documents/Download 本身（子目录待验），
      // 应用私有外部目录是零权限兜底路径
      const path = "/storage/emulated/0/Android/data/com.lanmark.app/files/lanmark-vault";
      const ready = await vault.setPathWithCreate(path, mode);
      set({ status: "ready", vaultPath: ready, activePath: null, content: "", dirty: false });
      await get().refreshTree();
      await get().refreshMeta();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  pickCustomAndroidDir: async (path, mode) => {
    try {
      const ready = await vault.setPathWithCreate(path, mode);
      set({ status: "ready", vaultPath: ready, activePath: null, content: "", dirty: false });
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
    } catch (e) {
      set({ error: String(e) });
    }
  },

  refreshMeta: async () => {
    try {
      const [recents, favorites] = await Promise.all([vault.recents(), vault.favorites()]);
      set({
        recents: recents
          .slice(0, RECENTS_SHOWN)
          .map(([path, title]) => ({ path, title })),
        favorites: favorites
          .slice(0, FAVORITES_SHOWN)
          .map(([path, title]) => ({ path, title })),
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

  openNote: async (path, silent = false) => {
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
      set({ activePath: path, content, dirty: false, savedAt: null, renamingPath: null, searchQuery: "" });
      await get().refreshMeta();
    } catch (e) {
      if (!silent) set({ error: String(e) });
    }
  },

  closeNote: async () => {
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
    set({ activePath: null, content: "", dirty: false, savedAt: null });
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
    }, SAVE_DEBOUNCE_MS);
  },

  saveNow: async () => {
    const { activePath, content, dirty } = get();
    if (!activePath || !dirty) return true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      await vault.writeNote(activePath, content);
      set({ dirty: false, savedAt: Date.now() });
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
    if (m === "wysiwyg" && get().editorMode === "source") {
      // 从源码切回：内容已是最新，直接重建编辑器
      set({ editorMode: m });
      return;
    }
    set({ editorMode: m });
  },

  setRenaming: (path) => set({ renamingPath: path }),

  createNote: async (dir) => {
    try {
      const node = await vault.createNote(dir, "未命名");
      await get().refreshTree();
      await get().openNote(node.path);
      set({ renamingPath: node.path });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createFolder: async (dir) => {
    const before = new Set(get().tree.map((n) => n.path));
    try {
      await vault.createFolder(dir, "新建文件夹");
      const fresh = await vault.tree();
      // 用前后快照差集定位新建项（startsWith 匹配会误中旧的「新建文件夹」）
      const created = fresh.find((n) => n.kind === "folder" && !before.has(n.path));
      set({ tree: fresh, ...(created ? { renamingPath: created.path } : {}) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  commitRename: async (path, newName) => {
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
      if (!(await s.saveNow())) return;
      set({ activePath: null, content: "", dirty: false });
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
