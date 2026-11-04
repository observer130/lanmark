import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.ts"],
    // 全量并行时 jsdom + Milkdown 的单用例耗时会明显高于单文件运行：
    // 长文档往返用例自设 15s 性能护栏，runner 超时必须宽于它，
    // 否则默认 5s 会先杀掉用例，护栏永远走不到。
    testTimeout: 30_000,
    // Milkdown 是 ESM 包，需要内联处理
    server: {
      deps: {
        inline: [/@milkdown/, /unified/, /remark/, /unist/, /mdast/, /hast/, /micromark/],
      },
    },
  },
});
