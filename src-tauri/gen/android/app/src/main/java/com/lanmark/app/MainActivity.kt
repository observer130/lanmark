package com.lanmark.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Android 15+（targetSdk 35+）系统强制 edge-to-edge：WebView 铺满到状态栏底下，
    // 固定定位的 UI（抽屉按钮）与状态栏重叠且点不到（真机验收发现，删
    // enableEdgeToEdge 无效——强制行为来自 targetSdk）。这里强制内容避开系统栏：
    window.decorView.fitsSystemWindows = true
    window.decorView.setOnApplyWindowInsetsListener { v, insets ->
      val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
      v.setPadding(v.paddingLeft, bars.top, v.paddingRight, bars.bottom)
      insets
    }
    // M4 真机反馈：系统深色模式下状态栏图标变白，而 App 只有浅色主题
    //（白图标落在白色背景上不可见）。主题已在 themes.xml 与 values-night 里钉死
    // 浅色，这里再**运行时兜底**一次：部分 ROM（MIUI 等）会在 Activity 重建或
    // 切换深色模式时重算系统栏外观，仅靠主题不可靠。
    applyLightSystemBars()

    // M2：通知运行时权限（Android 13+；不授予只影响常驻通知显示，不影响前台服务本身）
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
      != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
    }
    // 同步服务器前台服务保活（Rust 侧 axum 在 vault 打开后启动，见 commands.rs）
    SyncService.start(this)
  }

  /** 钉死浅色系统栏：浅色背景 + 深色图标，与「晨窗」浅色主题一致。 */
  private fun applyLightSystemBars() {
    window.statusBarColor = getColor(R.color.lanmark_status_bar)
    @Suppress("DEPRECATION")
    window.navigationBarColor = getColor(R.color.lanmark_status_bar)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      // API 30+：用 WindowInsetsController 统一设置（状态栏与导航栏都要）
      val c = window.insetsController ?: return
      val mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
        android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
      c.setSystemBarsAppearance(mask, mask)
    } else {
      @Suppress("DEPRECATION")
      window.decorView.systemUiVisibility =
        window.decorView.systemUiVisibility or
          android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or
          android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
    }
  }

  override fun onResume() {
    super.onResume()
    // 从系统设置的深色模式页返回 / Activity 重建后重算一次（ROM 行为差异兜底）
    applyLightSystemBars()
  }

  companion object {
    private const val REQUEST_NOTIFICATIONS = 4180
  }
}
