import { describe, expect, it } from "vitest";
import { useOutlineStore } from "./outline";

describe("outline store：跳转请求", () => {
  it("每次 jump 都递增 seq（连点同一标题也要能再次触发）", () => {
    useOutlineStore.setState({ request: null });
    const item = { level: 2 as const, text: "标题", line: 3, index: 0 };
    useOutlineStore.getState().jump("a.md", item);
    const first = useOutlineStore.getState().request;
    useOutlineStore.getState().jump("a.md", item);
    const second = useOutlineStore.getState().request;
    expect(first?.path).toBe("a.md");
    expect(second?.seq).toBe((first?.seq ?? 0) + 1);
    expect(second?.item).toEqual(item);
  });

  it("clear 清空请求", () => {
    useOutlineStore.getState().jump("a.md", { level: 1, text: "x", line: 1, index: 0 });
    useOutlineStore.getState().clear();
    expect(useOutlineStore.getState().request).toBeNull();
  });
});
