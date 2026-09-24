/**
 * M4f E3：诊断信息组装（纯函数）。
 *
 * 覆盖重点不是「字符串长什么样」，而是**该有的信息都在**——用户把这段贴出来
 * 求助时，缺一项就要多一轮来回追问（docs/08 §3.5 E3 的立意）。
 */
import { describe, expect, it } from "vitest";
import { buildDiagnostics, type DiagnosticsInput } from "../components/SettingsDialog";
import type { Settings } from "../lib/settings";

const SETTINGS: Settings = {
  appearance: {
    uiFont: "system",
    textFont: "sans",
    monoFont: "system",
    customFonts: { ui: "", text: "", mono: "" },
    textSize: "md",
    codeSize: "md",
    lineHeight: "normal",
    contentWidth: "auto",
    uiScalePct: 100,
  },
  editor: {
    defaultMode: "wysiwyg",
    autosaveMs: 700,
    sourceLineNumbers: true,
    newNoteLocation: "root",
  },
  storage: { trashRetentionDays: 30 },
};

function input(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    info: { version: "0.2.1", platform: "android", configDir: "/data/x", logDir: "/data/x/logs" },
    vaultPath: "/storage/notes",
    stats: { notes: 12, folders: 3, assets: 4, bytes: 2048, trashEntries: 1, trashBytes: 56 },
    pairing: null,
    servers: [],
    probeStates: {},
    syncAuto: true,
    conflictCount: null,
    settings: SETTINGS,
    ...over,
  };
}

describe("E3 诊断信息", () => {
  it("含版本、平台、库路径、规模、回收站、目录", () => {
    const t = buildDiagnostics(input());
    expect(t).toContain("Lanmark 0.2.1 (android)");
    expect(t).toContain("笔记库: /storage/notes");
    expect(t).toContain("12 篇 / 3 目录 / 4 附件");
    expect(t).toContain("回收站: 1 项");
    expect(t).toContain("配置目录: /data/x");
    expect(t).toContain("日志目录: /data/x/logs");
  });

  /** 最高频的求助是「同步没连上」——手机侧必须能看出服务器跑没跑、地址是多少 */
  it("手机侧：同步中心状态 + 本机地址 + 设备身份 + 待确认配对", () => {
    const t = buildDiagnostics(
      input({
        pairing: {
          running: true,
          port: 4180,
          deviceName: "Lanmark 手机",
          pairingCode: "12345678",
          lastRoundAt: null,
          lanIp: "http://192.168.131.34:4180",
          deviceId: "dee33e85d2bf59c9",
          pendingPairs: [
            { nonce: "n1", clientName: "pc", clientIp: "1.2.3.4", ageSecs: 3 },
          ],
        },
      }),
    );
    expect(t).toContain("同步中心: 运行中 · 端口 4180");
    expect(t).toContain("本机地址: http://192.168.131.34:4180");
    expect(t).toContain("设备身份: dee33e85d2bf59c9");
    expect(t).toContain("待确认配对: 1 条");
  });

  it("手机侧未运行 → 明确写「未运行」", () => {
    const t = buildDiagnostics(
      input({
        pairing: {
          running: false,
          port: null,
          deviceName: "x",
          pairingCode: "1",
          lastRoundAt: null,
          lanIp: null,
          deviceId: "",
          pendingPairs: [],
        },
      }),
    );
    expect(t).toContain("同步中心: 未运行");
    // 未运行且无已配对 → 明确「无」，而不是留空让人猜
    expect(t).toContain("已配对设备: 无");
  });

  it("桌面侧：列出每个已配对设备的在线状态与上次同步时间", () => {
    const t = buildDiagnostics(
      input({
        servers: [
          {
            id: "d1",
            name: "REDMI K90",
            url: "http://192.168.1.23:4180",
            token: "t",
            lastSuccessAt: 1_700_000_000_000,
            deviceId: "dev-1",
          },
          {
            id: "d2",
            name: "office-pad",
            url: "http://192.168.1.31:4180",
            token: "t",
            lastSuccessAt: null,
          },
        ],
        probeStates: { d1: { online: true }, d2: { online: false } },
      }),
    );
    expect(t).toContain("REDMI K90 (http://192.168.1.23:4180) · 在线");
    expect(t).toContain("office-pad (http://192.168.1.31:4180) · 离线");
    // 有 lastSuccessAt 才带时间；没有就不写（避免 "Invalid Date"）
    expect(t).not.toContain("Invalid Date");
  });

  it("未探测过的设备写「未探测」", () => {
    const t = buildDiagnostics(
      input({
        servers: [
          { id: "d1", name: "p", url: "http://a:4180", token: "t", lastSuccessAt: null },
        ],
      }),
    );
    expect(t).toContain("· 未探测");
  });

  it("冲突副本与自动同步开关", () => {
    const t = buildDiagnostics(input({ conflictCount: 3, syncAuto: false }));
    expect(t).toContain("冲突副本: 3 个");
    expect(t).toContain("自动同步: 关");
    // 0 个冲突不写这一行（噪声）
    expect(buildDiagnostics(input({ conflictCount: 0 }))).not.toContain("冲突副本");
  });

  it("未配置笔记库时写「未配置」且规模为未知（不崩）", () => {
    const t = buildDiagnostics(input({ vaultPath: null, stats: null }));
    expect(t).toContain("笔记库: 未配置");
    expect(t).toContain("规模: 未知");
    expect(t).toContain("回收站: 未知");
  });

  it("设置小节如实反映当前值", () => {
    const t = buildDiagnostics(
      input({
        settings: {
          ...SETTINGS,
          appearance: { ...SETTINGS.appearance, textFont: "serif", textSize: "xl" },
          editor: { ...SETTINGS.editor, defaultMode: "source", autosaveMs: 3000 },
        },
      }),
    );
    expect(t).toContain("正文=serif");
    expect(t).toContain("字号=xl/md");
    expect(t).toContain("默认模式=source 自动保存=3000ms");
  });
});
