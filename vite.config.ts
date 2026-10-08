import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

/**
 * M6d：剥掉 @fontsource 字体 CSS 里的 `woff` 回退。
 *
 * 这些包的每个切片都写 `src: url(x.woff2) format('woff2'), url(x.woff) format('woff')`，
 * 而 Vite 会把两种格式**都**当资源打包（实测：226 个多余 .woff ≈ 7.7MB；
 * 这条链路上的 lightningcss 不会按 target 丢掉它）。Tauri 三端的 WebView
 * （WebKitGTK / WebView2 / Android WebView）全都支持 woff2，回退没有意义。
 *
 * 为什么写在 `generateBundle` 而不是 `transform`：字体包的 @font-face 文本
 * 在 transform 阶段不可见（`@import` 由 Tailwind 插件内联，pre/post 都改不到
 * 字体包自身的文本——实测 transform 方案无效）。到 generateBundle 时 CSS 与
 * 资源都已在产物里，改写 + 删文件是确定性的。
 */
function stripWoffFallback() {
  return {
    name: "lanmark-strip-woff-fallback",
    apply: "build" as const,
    generateBundle(_options: unknown, bundle: Record<string, { type: string; fileName: string; source?: unknown }>) {
      let removed = 0;
      for (const [file, out] of Object.entries(bundle)) {
        if (out.type === "asset" && file.endsWith(".woff")) {
          delete bundle[file];
          removed++;
        }
      }
      let rewritten = 0;
      for (const out of Object.values(bundle)) {
        if (out.type !== "asset" || !out.fileName.endsWith(".css")) continue;
        const src = typeof out.source === "string" ? out.source : Buffer.from(out.source as Uint8Array).toString("utf8");
        const next = src.replace(/,\s*url\([^)]+\.woff\)\s*format\((['"])woff\1\)/g, "");
        if (next !== src) {
          out.source = next;
          rewritten++;
        }
      }
      if (removed || rewritten) {
        console.log(`[lanmark] 已剥掉 woff 回退：删除 ${removed} 个 .woff，改写 ${rewritten} 个 CSS`);
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [stripWoffFallback(), react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      // 4. `.cache` 同理：工具链/临时目录（TMP 也指向 .cache/tmp）文件高频变动，
      //    watcher 扫到会 EBUSY 直接崩掉 dev server（2026-09-26 实测）
      ignored: ["**/src-tauri/**", "**/.cache/**"],
    },
  },
}));
