/**
 * 拖入/粘贴图片的**筛选**护栏。
 *
 * 这里钉住的是一个平台差异：Linux（WebKitGTK）从文件管理器拖过来的文件
 * `File.type` 常是**空串**（WebKit 不按扩展名猜 MIME）。历史上只看
 * `type.startsWith("image/")` 就会把正常 PNG 全滤掉，表现成「图片拖不进编辑器」
 * ——与硬约定 23 是同一类「拿 Chrome 的行为当所有平台的行为」的错。
 */
import { describe, it, expect } from "vitest";

import { fileExt, isImageFile, pickImageFiles } from "./image";

const file = (name: string, type = "") => new File([new Uint8Array([1])], name, { type });

describe("拖入文件的图片筛选（M8 走查修复）", () => {
  it("有 MIME 时按 MIME 认", () => {
    expect(isImageFile(file("a.bin", "image/png"))).toBe(true);
    expect(isImageFile(file("a.bin", "text/plain"))).toBe(false);
  });

  it("**MIME 为空时按扩展名认**（Linux 真机拖进来的就是这种）", () => {
    for (const name of ["照片.png", "photo.JPG", "x.jpeg", "a.gif", "b.webp", "c.svg", "d.bmp", "e.avif"]) {
      expect(isImageFile(file(name)), name).toBe(true);
    }
  });

  it("非图片不被接手（原样交给编辑器默认行为）", () => {
    for (const name of ["说明.txt", "data.json", "archive.zip", "noext"]) {
      expect(isImageFile(file(name)), name).toBe(false);
    }
  });

  it("pickImageFiles 只挑图片，且容忍 null/undefined", () => {
    const all = [file("照片.png"), file("说明.txt"), file("b.jpg", "")];
    expect(pickImageFiles(all).map((f) => f.name)).toEqual(["照片.png", "b.jpg"]);
    expect(pickImageFiles(null)).toEqual([]);
    expect(pickImageFiles(undefined)).toEqual([]);
  });

  it("fileExt 兜底：无扩展名时取 MIME 子类型", () => {
    expect(fileExt(file("照片.png"))).toBe("png");
    expect(fileExt(file("noext", "image/webp"))).toBe("webp");
    expect(fileExt(file("noext"))).toBe("bin");
  });
});
