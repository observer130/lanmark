import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useVaultStore } from "../../stores/vault";

/**
 * 共享小控件：复制按钮与开关。
 *
 * 为什么单独抽出来：`CopyButton` 与 `Switch` 此前在同步面板和设置页各写一份，
 * 已经漂移——一份有 `aria-label`、另一份只有 `title`；复制失败一处静默吞掉、
 * 一处挂在 promise 的 reject 上。两份实现意味着「改一处、漏一处」。
 *
 * 约定：开关的点击**总是** `stopPropagation`（它常嵌在可点击行里，例如同步常驻条），
 * 复制失败统一走 Toast（`vault.error`）。
 */

/** 复制到剪贴板的小按钮：成功后 1.5s 打个勾 */
export function CopyButton({
  text,
  label = "复制",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`shrink-0 rounded-md p-1 text-ink-3 hover:bg-canvas hover:text-ink ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        void (async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch (err) {
            // 剪贴板权限被拒时用户什么都看不到，等于「点了没反应」
            useVaultStore.setState({ error: `复制失败：${String(err)}` });
          }
        })();
      }}
    >
      {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
    </button>
  );
}

/** 开关。`small` 用于同步常驻条（30×17），默认 38×22 */
export function Switch({
  on,
  onToggle,
  label,
  small = false,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  small?: boolean;
}) {
  const track = small ? "h-[17px] w-[30px]" : "h-[22px] w-[38px]";
  const knob = small ? "h-[13px] w-[13px]" : "h-4 w-4";
  const off = small ? "bg-ink-3/30" : "bg-ink/20";
  const shift = small ? "translateX(13px)" : "translateX(16px)";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={(e) => {
        // 常驻条整行可点，开关点一下不该顺带把面板开/关
        e.stopPropagation();
        onToggle();
      }}
      className={`relative shrink-0 rounded-full transition-colors ${track} ${
        on ? "bg-accent" : off
      }`}
    >
      <span
        className={`absolute rounded-full bg-white shadow-sm transition-transform ${knob} ${
          small ? "left-0.5 top-0.5" : "left-[3px] top-[3px]"
        }`}
        style={{ transform: on ? shift : "translateX(0)" }}
      />
    </button>
  );
}
