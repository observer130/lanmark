package com.lanmark.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * M2 vault 目录选择插件（Rust 侧桥见 src-tauri/src/mobile.rs）。
 *
 * 策略（docs/research/android-vault-dir.md）：Android 11+ 的 scoped storage 下，
 * SAF tree URI 直接映射回文件路径后 std::fs 并不可写——必须 MANAGE_EXTERNAL_STORAGE。
 * 因此：hasAllFilesAccess / requestAllFilesAccess 管授权；appDir 返回框架创建的
 * 应用私有外部目录（Android/data/<pkg> 系统懒创建，std::fs mkdir 包目录必被拒，
 * 不能在前端硬编码整链路径后自行 mkdir）；pickFolder 的 SAF 选择器
 * 仅作目录选择 UI，把 primary 卷的 tree URI 确定性映射回真实路径字符串，
 * 交给既有的 vault_set_path（std::fs 路径语义）零改动复用。
 */
@TauriPlugin
class VaultPickerPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun hasAllFilesAccess(invoke: Invoke) {
    val granted = if (Build.VERSION.SDK_INT >= 30) {
      Environment.isExternalStorageManager()
    } else {
      // Android 10-：scoped storage 之前，WRITE_EXTERNAL_STORAGE 即共享存储写权限
      activity.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
        android.content.pm.PackageManager.PERMISSION_GRANTED
    }
    val ret = JSObject()
    ret.put("granted", granted)
    invoke.resolve(ret)
  }

  @Command
  fun requestAllFilesAccess(invoke: Invoke) {
    try {
      if (Build.VERSION.SDK_INT >= 30) {
        // 直达本 App 的「所有文件访问」开关页
        val intent = Intent(
          android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
          Uri.parse("package:${activity.packageName}"),
        )
        activity.startActivity(intent)
        invoke.resolve()
      } else {
        // 旧版无需此授权流程
        val ret = JSObject()
        ret.put("granted", true)
        invoke.resolve(ret)
      }
    } catch (e: Exception) {
      invoke.reject("无法打开授权设置页: ${e.message}")
    }
  }

  @Command
  fun appDir(invoke: Invoke) {
    try {
      // 应用私有外部目录必须经框架获取：Android/data/<pkg> 由系统懒创建，
      // std::fs 直接 mkdir 包目录会被 FUSE 拒绝（os error 13，全新安装必现，
      // 2026-09-23 真机复现）。getExternalFilesDir 由框架保证创建与属主。
      val dir = activity.getExternalFilesDir(null)
      val ret = JSObject()
      ret.put("path", dir?.absolutePath)
      invoke.resolve(ret)
    } catch (e: Exception) {
      invoke.reject("获取应用目录失败: ${e.message}")
    }
  }

  @Command
  fun pickFolder(invoke: Invoke) {
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
      startActivityForResult(invoke, intent, "onFolderPicked")
    } catch (e: Exception) {
      invoke.reject("无法打开目录选择器: ${e.message}")
    }
  }

  @ActivityCallback
  fun onFolderPicked(invoke: Invoke, result: ActivityResult) {
    val uri: Uri = result.data?.data ?: run {
      invoke.resolve() // 用户取消 → null
      return
    }
    try {
      // 授权持久化（重启后仍有效；映射失败时留作证据/后手）
      runCatching {
        activity.contentResolver.takePersistableUriPermission(
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
      }
      val path = treeUriToPrimaryPath(uri)
        ?: throw IllegalArgumentException("仅支持内部存储（primary 卷）目录")
      val ret = JSObject()
      ret.put("path", path)
      invoke.resolve(ret)
    } catch (e: Exception) {
      invoke.reject("解析所选目录失败: ${e.message}")
    }
  }

  /**
   * content://com.android.externalstorage.documents/tree/primary%3ANotes/vault
   * → /storage/emulated/0/Notes/vault
   *
   * 只承诺 primary 卷（内部存储）；SD 卡/"Downloads" 抽屉项等无可靠路径映射。
   */
  private fun treeUriToPrimaryPath(uri: Uri): String? {
    val docId = DocumentsContract.getTreeDocumentId(uri) ?: return null
    val parts = docId.split(":", limit = 2)
    if (parts.size != 2 || parts[0] != "primary") return null
    val rel = parts[1].trim('/')
    @Suppress("DEPRECATION")
    val root = Environment.getExternalStorageDirectory()?.absolutePath ?: return null
    return if (rel.isEmpty()) root else "$root/$rel"
  }
}
