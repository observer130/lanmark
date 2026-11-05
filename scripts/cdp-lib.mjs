// CDP helper（真机 / 模拟器通用）：所有交互默认走**真触摸事件**。
// 用法：import { connect } from "./cdp-lib.mjs"; const c = await connect();
//
// 路径全部相对仓库根解析，不写死 /home/xxx；ADB 依次取
// $ADB → $ANDROID_SDK_ROOT/platform-tools/adb → $ANDROID_HOME/... → .cache/android-sdk/... → PATH 里的 adb。
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WS = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(WS, ".cache", "screenshots");
mkdirSync(OUT, { recursive: true });

function resolveAdb() {
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb"),
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, "platform-tools", "adb"),
    join(WS, ".cache", "android-sdk", "platform-tools", "adb"),
    "adb",
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      execFileSync(p, ["version"], { stdio: "ignore" });
      return p;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error("找不到可用的 adb（设 ADB=/path/to/adb 或 ANDROID_SDK_ROOT）");
}
const ADB = resolveAdb();

export async function connect(port = 9222) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("没有可连的 WebView target（检查 adb forward 是否还活着）");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown")
      errors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  };
  const j = async (expr) => JSON.parse(await evalJs(`JSON.stringify(${expr})`));
  /** 轮询直到表达式为真；超时返回 false。 */
  const waitFor = async (expr, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (await evalJs(expr)) return true;
      } catch {
        /* 页面还没就绪 */
      }
      await sleep(300);
    }
    return false;
  };
  /**
   * 截图走 `adb exec-out screencap` 而**不是** `Page.captureScreenshot`：
   * 真机 WebView 上后者会常年挂住（不返回、也不报错，探针就卡死在这里，
   * 2026-10-16 反复踩——表现为「脚本无输出地卡住」，极难定位）。
   * AGENTS.md 的真机调试本来推荐的就是 screencap。
   */
  const shot = async (name) => {
    const buf = execFileSync(ADB, ["exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(OUT, name), buf);
    return name;
  };
  /**
   * 触摸坐标换算：调用方一律传**布局坐标**（getBoundingClientRect 的那套），
   * 这里减去 `visualViewport.offsetTop/Left` 再发给 CDP。
   *
   * 为什么必须做：软键盘弹出时页面被上推（真机实测 offsetTop=51），而 CDP 的
   * 触摸坐标是相对**视觉视口**的——不做这步，键盘一弹出所有合成点击都落空，
   * 表现成「键盘弹出后头部按钮全失灵」，其实是**探针的假象**（真用户点屏幕正常）。
   * 2026-10-16 踩过一次，别再让调用方各自换算。
   */
  const toVisual = async (x, y) => {
    const off = await j(`({ x: Math.round(visualViewport?.offsetLeft ?? 0), y: Math.round(visualViewport?.offsetTop ?? 0) })`);
    return { x: Math.max(1, x - off.x), y: Math.max(1, y - off.y) };
  };
  const tap = async (x, y) => {
    const p = await toVisual(x, y);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
    await sleep(55);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(120);
  };
  const longPress = async (x, y, ms = 800) => {
    const p = await toVisual(x, y);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
    await sleep(ms);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(250);
  };
  const swipe = async (x1, y1, x2, y2, steps = 10) => {
    const a = await toVisual(x1, y1);
    const b = await toVisual(x2, y2);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [a] });
    for (let i = 1; i <= steps; i += 1) {
      await send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }],
      });
      await sleep(22);
    }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(200);
  };
  /** 元素矩形（CSS 像素；CDP 触摸坐标也是 CSS 像素） */
  const rect = async (sel) => {
    const r = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return "null";
      const b = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), cx: Math.round(b.left + b.width / 2), cy: Math.round(b.top + b.height / 2) });
    })()`);
    return r === "null" ? null : JSON.parse(r);
  };
  /** 按可见文字点按钮（React 的 .click() 对按钮有效，但对触屏专属路径不算证据——只用于配置类操作） */
  const clickText = async (text) =>
    evalJs(`(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim().startsWith(${JSON.stringify(text)}));
      if (!b) return "NOT_FOUND";
      b.click(); return "CLICKED";
    })()`);
  const text = async () => evalJs(`document.body.innerText.replace(/\\n+/g, " | ").slice(0, 400)`);
  const close = () => ws.close();
  return { send, evalJs, j, waitFor, shot, tap, longPress, swipe, rect, clickText, text, sleep, errors, close };
}
