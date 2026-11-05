// 安卓编辑器滚动探针（模拟器 / 真机通用）。
//
// 用法：node scripts/probe-android.mjs [--note long-note.md] [--port 9222]
// 前置：`scripts/android-emu.sh probe` 会先 adb forward；手工跑时按 AGENTS.md「真机调试」做。
//
// 验的是 v0.8.0 修的回归：窄屏下 <main> 必须带 min-h-0，否则整列被长笔记撑高，
// .editor-host 的 100% 高度等于内容高 → 滚动容器没有可滚范围，阅读/所见即所得只能显示一屏。
// 所以这里**只认真触摸**（Input.dispatchTouchEvent）产生的 scrollTop 位移，
// 并断言 main 高度不超过视口——前者证明「能滚」，后者守住「min-h-0 没被删」。
import { connect } from "./cdp-lib.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const NOTE = arg("--note", "long-note.md");
const PORT = Number(arg("--port", process.env.CDP_PORT || "9222"));

const c = await connect(PORT);
const sleep = c.sleep;

/** 打开侧栏里的目标笔记（树行是 <button>，innerText 含文件名）。 */
async function openNote() {
  if (await c.evalJs(`!!document.querySelector('.editor-host')`)) return true;
  const clicked = await c.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((e) => (e.innerText || '').includes(${JSON.stringify(NOTE)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) {
    console.error(`侧栏里找不到 ${NOTE}；当前页面文本：`, await c.text());
    return false;
  }
  return c.waitFor(`!!document.querySelector('.editor-host')`, 20000);
}

if (!(await openNote())) {
  console.error("打开笔记失败");
  process.exit(2);
}
await sleep(1200);

const metrics = async (tag) => {
  const raw = await c.evalJs(`JSON.stringify((() => {
    const h = document.querySelector('.editor-host');
    const main = document.querySelector('main');
    const card = h ? h.parentElement : null;
    return {
      mode: document.querySelector('.source-editor') ? 'source' : document.querySelector('.reading') ? 'read' : 'wysiwyg',
      innerH: innerHeight,
      vvH: Math.round(visualViewport.height),
      vvTop: Math.round(visualViewport.offsetTop),
      mainH: main ? Math.round(main.getBoundingClientRect().height) : null,
      host: h ? { c: h.clientHeight, s: h.scrollHeight, top: Math.round(h.scrollTop), oy: getComputedStyle(h).overflowY } : null,
      cardH: card ? card.clientHeight : null,
      cardBottom: card ? Math.round(card.getBoundingClientRect().bottom) : null,
    };
  })())`);
  console.log(tag, raw);
  return JSON.parse(raw);
};

const swipeUp = async (tag) => {
  const before = await metrics(`${tag} 前`);
  // 视口中部竖滑：x 取视口中心，y 从 80% 到 25%，14 步；真触摸，带视觉视口偏移换算。
  const x = Math.round((await c.j("innerWidth")) / 2);
  const y1 = Math.round(before.innerH * 0.8);
  const y2 = Math.round(before.innerH * 0.25);
  await c.swipe(x, y1, x, y2, 14);
  await sleep(700);
  const after = await metrics(`${tag} 后`);
  return { before, after, moved: (after.host?.top ?? 0) - (before.host?.top ?? 0) };
};

const pickMode = async (label) => {
  const opened = await c.evalJs(`(() => { const b = document.querySelector('button[aria-label="编辑模式"]'); b?.click(); return !!b; })()`);
  await sleep(500);
  const picked = await c.evalJs(`(() => {
    const el = [...document.querySelectorAll('[role=menuitem], button')].find((e) => (e.innerText || '').trim() === ${JSON.stringify(label)});
    el?.click();
    return !!el;
  })()`);
  await sleep(1200);
  console.log(`切换到 ${label}: opened=${opened} picked=${picked}`);
  return opened && picked;
};

const results = {};
results.wysiwyg = await swipeUp("WYSIWYG");
await c.shot("emu-probe-wysiwyg.png");

if (!(await pickMode("阅读模式"))) {
  console.error("切不到阅读模式");
  process.exit(3);
}
results.read = await swipeUp("阅读模式");
await c.shot("emu-probe-read.png");

await pickMode("所见即所得");

const checks = {
  // 承重断言：main 不得被内容撑高（v0.7.0 的 mainH≈2116 会在这里挂）
  wysiwygMainFitsViewport: results.wysiwyg.before.mainH <= results.wysiwyg.before.innerH + 2,
  wysiwygHasRange: (results.wysiwyg.before.host?.s ?? 0) > (results.wysiwyg.before.host?.c ?? 0) + 100,
  wysiwygSwipeMoved: results.wysiwyg.moved > 100,
  readMainFitsViewport: results.read.before.mainH <= results.read.before.innerH + 2,
  readHasRange: (results.read.before.host?.s ?? 0) > (results.read.before.host?.c ?? 0) + 100,
  readSwipeMoved: results.read.moved > 100,
  // 页面本身不应被滚动（滚动应发生在编辑区内部）
  pageDidNotScroll: (results.wysiwyg.after.vvTop ?? 0) === 0 && (results.read.after.vvTop ?? 0) === 0,
};

console.log("结论:", JSON.stringify(checks));
console.log("页面错误:", c.errors.length ? c.errors.slice(0, 5) : "无");
c.close();

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
if (failed.length) {
  console.error("FAIL:", failed.join(", "));
  process.exit(1);
}
console.log("PASS");
