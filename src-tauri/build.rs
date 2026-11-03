fn main() {
    // Android 15+ 的 16KB 页设备要求 ELF 的 LOAD 段按 16KB 对齐：
    // 不对齐时安装会弹「此应用不符合 16KB 对齐要求」，这类设备上原生库也可能加载失败。
    // 本机 NDK r27 的 lld 默认只按 4KB 对齐（r28 起才默认 16KB），必须显式要求。
    // 只作用于本 crate 的可链接目标（Android 侧就是 liblanmark_lib.so），桌面端不受影响；
    // 16KB 对齐对 4KB 页设备同样合法（max-page-size 是上限，不是强制页大小）。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
