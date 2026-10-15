import { vault } from "./vault";

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * 这次拖入的是不是图片。**判据必须同时看 MIME 与扩展名**：Linux 上从文件管理器拖过来的
 * 文件 `type` 常为空串（WebKitGTK 不按扩展名猜 MIME），只看 `type.startsWith("image/")`
 * 会把正常的 PNG 全滤掉。
 */
export function isImageFile(file: File): boolean {
  return (
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(file.name)
  );
}

/** 从一次拖放/粘贴里挑出图片文件（其余原样交给编辑器默认行为） */
export function pickImageFiles(files: ArrayLike<File> | null | undefined): File[] {
  return Array.from(files ?? []).filter(isImageFile);
}

export function fileExt(file: File): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(file.name);
  return m ? m[1] : file.type.split("/")[1] || "bin";
}

/** 图片（或任意文件）落盘到 vault assets/，返回相对路径（如 assets/a3f8….png） */
export async function uploadFile(file: File): Promise<string> {
  const b64 = await fileToBase64(file);
  return vault.saveAsset(b64, fileExt(file));
}
