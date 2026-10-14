import { Crepe, CrepeFeature } from "@milkdown/crepe";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";

import { blockDragPlugins } from "./block-drag";
import { blockMovePlugins } from "./block-move";

/**
 * 产品编辑器配置的**唯一来源**。
 *
 * 为什么要有这个文件：`EditorPane.tsx` 与 `src/milkdown/roundtrip.test.ts` 原先各自
 * 抄了一份 feature 开关表——两边一旦漂移，护栏就白设了（测试跑的和产品跑的不是同一套
 * 配置）。这里收敛成一份，两边都必须经由 `createProductCrepe` 建实例。
 *
 * ⚠️ **Crepe 的两个配置通道不能混**（2026-10-13 实测踩过）：
 *  - feature **开关** → 构造函数的 `features`
 *  - feature **配置** → 构造函数的 `featureConfigs`（独立字段）
 * 把 `{ buildToolbar }` 之类塞进 `features[CrepeFeature.Toolbar]` 会**静默无效**——
 * 不报错、不生效，只有界面上少了个按钮。M8 批次 3 加荧光笔按钮时要走 `featureConfigs`。
 */

/**
 * feature 开关。`readOnly` 为真时（阅读模式）关掉全部**交互**特性：
 * 选区气泡条 / 块手柄与斜杠菜单 / 链接浮层。内容类特性（表格、公式、代码块高亮、
 * 占位符、任务列表）保持开启——它们决定「文档长什么样」，不是「能不能操作」。
 */
export function productFeatures(readOnly = false): Partial<Record<CrepeFeature, boolean>> {
  return {
    // 精简：关掉 AI 光标 / 顶栏
    [CrepeFeature.AI]: false,
    [CrepeFeature.Cursor]: false,
    [CrepeFeature.TopBar]: false,
    // ImageBlock 关闭：其序列化会把缩放比例写进 alt（![1.00](…)），破坏原始 markdown。
    // 图片走 commonmark 原生节点：粘贴（insertImageCommand）或手写 ![](...)
    [CrepeFeature.ImageBlock]: false,
    [CrepeFeature.Latex]: true,
    [CrepeFeature.Table]: true,
    [CrepeFeature.CodeMirror]: true,
    [CrepeFeature.Toolbar]: !readOnly, // 选区气泡条（bold/italic/…）
    [CrepeFeature.BlockEdit]: !readOnly, // 左侧 +/拖拽手柄 + 斜杠菜单
    [CrepeFeature.ListItem]: true,
    [CrepeFeature.LinkTooltip]: !readOnly,
    [CrepeFeature.Placeholder]: true,
  };
}

/**
 * 产品自研插件的**唯一注册点**。
 * 顺序无所谓（Milkdown 内部按 timer 阶段装配），但必须都经过这里——`EditorPane` 与
 * 往返护栏测试都走 `createProductCrepe`，否则「测试绿」不代表「产品对」。
 */
export const PRODUCT_PLUGINS: MilkdownPlugin[] = [...blockMovePlugins, ...blockDragPlugins];

export interface ProductCrepeOptions {
  root: HTMLElement | string;
  defaultValue: string;
  readOnly?: boolean;
}

/** 按产品配置建一个 Crepe 实例（**未** create；调用方自行 `await create()`）。 */
export function createProductCrepe({
  root,
  defaultValue,
  readOnly = false,
}: ProductCrepeOptions): Crepe {
  const crepe = new Crepe({
    root,
    defaultValue,
    features: productFeatures(readOnly),
  });
  crepe.editor.use(PRODUCT_PLUGINS);
  return crepe;
}
