/**
 * 「切换前 flush 编辑器」的窄接口。
 *
 * 为什么单独抽一个模块：`@milkdown/plugin-listener` 的 `markdownUpdated` 有 200ms
 * 尾沿防抖，而 `crepe.destroy()` 会在 listener 的 `view.destroy` 里 `cancel()` 掉
 * 那个防抖——切笔记 / 切模式 / 关笔记时，最后 ≤200ms 的输入**从未进 store**，
 * 随后的 `saveNow()` 也救不回来（S6）。
 *
 * 修法是：编辑器挂载后注册一个「立刻序列化当前完整 markdown」的函数；任何要
 * 改变 activePath / editorMode 的动作在改之前先同步调用它，把结果写回 store。
 *
 * 三条约束：
 *  1. **不能有依赖**（尤其不能 import store）：vault store 会 import 本模块，
 *     反向依赖即成环。这里只存一个闭包。
 *  2. 返回值 `null` = 与最近一次放行的内容无变化（`compareKey` 相同），
 *     调用方**不要**写 store，否则会把「伪变更」变成 dirty。
 *  3. 只有「即将改变编辑器身份」的动作可以调用它；`MilkdownHost` 的 cleanup
 *     绝对不许写 store——那时 activePath 可能已经是新笔记，会把旧内容写进新文件。
 *
 * 返回值由调用方负责落库；本模块不碰 store、不碰磁盘。
 */

type EditorFlush = () => string | null;

let flushFn: EditorFlush | null = null;

/**
 * 注册当前挂载编辑器的 flush 函数，返回注销函数。
 * 同一时刻只允许一个编辑器（产品里也只有一个 MilkdownHost 挂载），
 * 后注册者覆盖前者；注销只清掉自己，避免旧实例的异步清理误删新实例的注册。
 */
export function registerEditorFlush(fn: EditorFlush): () => void {
  flushFn = fn;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (flushFn === fn) flushFn = null;
  };
}

/**
 * 取当前编辑器的完整 markdown；无挂载编辑器或内容无变化时返回 `null`。
 * 调用方（store 动作 / App 生命周期）据返回值决定是否 `setContent`。
 */
export function flushEditorContent(): string | null {
  if (!flushFn) return null;
  try {
    return flushFn();
  } catch {
    // flush 是「尽量别丢字」的兜底，不能反过来把切笔记/落盘流程炸掉
    return null;
  }
}
