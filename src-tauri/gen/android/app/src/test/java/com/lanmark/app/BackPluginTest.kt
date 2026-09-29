package com.lanmark.app

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * M4i 返回手势的**纯逻辑**单测（本地 JVM，无需 instrumentation）。
 *
 * 覆盖 [BackPlugin.resolve] —— 返回分发的决策表。之所以把决策抽成纯函数，
 * 就是为了让这段语义能被钉住：改了判定条件会在本地单测就红，不用上真机。
 *
 * 语义（半屏浮层 UI 下）：
 * - 有浮层（抽屉 / 设置页 / 新建对话框）→ 返回**关浮层**，不退出
 * - 没有浮层 → **不拦截**，交系统默认行为（退出）
 *
 * 曾有的「再划一次退出」两段式已废弃：那是把侧栏当一级菜单页的设计，
 * 半屏浮层下不成立（见 BackPlugin 类注释）。
 */
class BackPluginTest {

  @Test
  fun 抽屉开着时返回关浮层() {
    assertEquals(BackAction.CLOSE_OVERLAY, BackPlugin.resolve("drawer"))
  }

  @Test
  fun 设置页开着时返回关浮层() {
    assertEquals(BackAction.CLOSE_OVERLAY, BackPlugin.resolve("overlay"))
  }

  @Test
  fun 无浮层时不拦截() {
    assertEquals(BackAction.PASS_THROUGH, BackPlugin.resolve("none"))
  }

  @Test
  fun 未知处理器名按无浮层处理() {
    assertEquals(BackAction.PASS_THROUGH, BackPlugin.resolve(""))
    assertEquals(BackAction.PASS_THROUGH, BackPlugin.resolve("whatever"))
  }

  @Test
  fun 只有_drawer_和_overlay_会拦截() {
    // 拦截是**白名单**：任何新浮层类型都要显式加入，避免误拦退出
    val intercepting = listOf("drawer", "overlay")
    for (h in intercepting) {
      assertEquals("handler=$h", BackAction.CLOSE_OVERLAY, BackPlugin.resolve(h))
    }
    for (h in listOf("none", "", "editor", "search")) {
      assertEquals("handler=$h", BackAction.PASS_THROUGH, BackPlugin.resolve(h))
    }
  }
}
