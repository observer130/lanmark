package com.lanmark.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * M4i 移动端返回手势：**只管「返回时该不该先关浮层」**。
 *
 * 设计前提（用户反馈后定型）：侧栏在窄屏是**半屏浮层**（Gmail / Obsidian
 * Mobile 式），不是「一级菜单页」。因此返回就是标准语义 —— 有浮层先关浮层，
 * 没有就直接退出；**不做「再划一次退出」的两段式**（那是把侧栏当一级页面
 * 时的设计，半屏浮层下不成立）。
 *
 * 为什么单独一个插件：MainActivity 拿不到 WebView，而「关浮层」要通知前端。
 * 事件走 `webView.evaluateJavascript` 派发 DOM CustomEvent —— 不用插件事件
 * 通道（`addPluginListener`）是实测结论：真机 2510DRK44C / Android 16 上
 * 注册后 `hasListener=false`，事件收不到（原因未究，直接派发更可靠）。
 *
 * 可测性：分发决策 [resolve] 是**纯函数**，不碰 Android 运行时 ——
 * 见 BackPluginTest（本地单测，无需 instrumentation）。
 */
@TauriPlugin
class BackPlugin(private val activity: Activity) : Plugin(activity) {

  /** 插件被装载时拿到 WebView：后续派发事件要用（存实例字段，不能放 companion） */
  override fun load(webView: WebView) {
    instance = this
    this.webView = webView
  }

  private var webView: WebView? = null

  /**
   * 前端上报「当前返回该做什么」：`drawer` / `overlay` / 其它=无浮层。
   * 前端在浮层开关时下发（不是每次返回都问 —— 返回由系统直接派发给原生）。
   */
  @Command
  fun setUiBackHandler(invoke: Invoke) {
    // Invoke 没有 getString：参数走 JSObject。
    // 用双参版（单参版在 key 缺失时抛 JSONException，不是返回 null）
    val handler = invoke.getArgs().getString("handler", null) ?: "none"
    currentHandler = handler
    invoke.resolve()
  }

  /** 通知前端「返回被按下，请关掉你当前的浮层」。 */
  fun dispatchBackToWeb() {
    val wv = webView ?: return
    // evaluateJavascript 必须在主线程
    Handler(Looper.getMainLooper()).post {
      wv.evaluateJavascript(DISPATCH_JS, null)
    }
  }

  companion object {
    /** 前端监听的 DOM 事件名（见 src/stores/back.ts） */
    const val EVENT_BACK = "lanmark:back"

    /** 派发脚本：与前端 `window.addEventListener("lanmark:back")` 配对 */
    private const val DISPATCH_JS =
      "window.dispatchEvent(new CustomEvent('$EVENT_BACK'))"

    @Volatile
    var currentHandler: String = "none"
      private set

    @Volatile
    private var instance: BackPlugin? = null

    /** 供 MainActivity 调用：让前端关掉当前浮层。 */
    fun triggerBack() {
      instance?.dispatchBackToWeb()
    }

    /**
     * 纯决策：这次返回该做什么。**不碰 Android 运行时，可本地单测。**
     *
     * @param handler 前端上报的处理器名
     */
    fun resolve(handler: String): BackAction {
      return if (handler == "drawer" || handler == "overlay") {
        BackAction.CLOSE_OVERLAY
      } else {
        BackAction.PASS_THROUGH
      }
    }

    /** 单测用：重置状态 */
    fun resetForTest() {
      currentHandler = "none"
      instance = null
    }
  }
}

/**
 * 返回动作。
 * - [CLOSE_OVERLAY] 关掉当前浮层（抽屉 / 设置页 / 新建对话框），**不退出**
 * - [PASS_THROUGH] 没有浮层：不拦截，交给系统默认行为（退出）
 */
enum class BackAction { CLOSE_OVERLAY, PASS_THROUGH }
