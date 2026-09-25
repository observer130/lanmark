/**
 * 应用品牌标（「行与句点」）：与 src-tauri/icons/icon.svg 同一设计的矢量版。
 * 旧版是「蓝底白 L」文字占位块（gen-icon.py 时代），应用图标换新后（a6a5a13）
 * 这里也要跟着换——不要再手写 bg-accent + 白字的方块当 logo。
 *
 * 为什么内联 SVG 而不是 <img src>：容器只给 h-7 w-7 一类尺寸约束，
 * 内联可以随 Tailwind 类缩放、无需额外请求；设计源改了只需同步改这里的几何参数。
 *
 * 投影走 .lanmark-appmark 的 filter: drop-shadow（见 index.css），不用 Tailwind 的
 * shadow-*：那是 box-shadow，会按 svg 的矩形边界投影，圆角外的透明四角会露出直角阴影。
 */
export function AppMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={`lanmark-appmark${className ? ` ${className}` : ""}`}
      role="img"
      aria-label="Lanmark"
    >
      <defs>
        <linearGradient id="lanmark-appmark-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F9FAFB" />
          <stop offset="1" stopColor="#F5F6F8" />
        </linearGradient>
      </defs>
      {/* 底：浅灰渐变圆角方块（同一渐变 id 全局只渲染一份，多实例无冲突） */}
      <rect width="512" height="512" rx="118" fill="url(#lanmark-appmark-bg)" />
      {/* 行与句点：蓝 #3061D8，第二行是弱化衬行，句点琥珀 #F0C781 */}
      <rect x="102" y="119" width="224" height="52" rx="26" fill="#3061D8" />
      <rect x="102" y="217" width="308" height="34" rx="17" fill="#3061D8" opacity=".14" />
      <rect x="102" y="285" width="224" height="34" rx="17" fill="#3061D8" />
      <rect x="102" y="353" width="152" height="34" rx="17" fill="#3061D8" />
      <circle cx="308" cy="370" r="23" fill="#F0C781" />
      {/* 发丝描边：小尺寸下不可见但保留与 icon.svg 一致 */}
      <rect
        x="1.5"
        y="1.5"
        width="509"
        height="509"
        rx="116.5"
        fill="none"
        stroke="#E3E5E7"
        strokeWidth="2.5"
      />
    </svg>
  );
}
