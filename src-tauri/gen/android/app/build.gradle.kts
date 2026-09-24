import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// M4g：固定 release 签名（docs/08 §12.1）。
//
// 背景：此前 release 资产是 CI 用 `--debug` 构建的，debug keystore 由 AGP 在每台
// CI runner 首次构建时**随机生成**（runner 每次全新）→ 每个版本的 APK 签名都不同
// → 手机覆盖安装失败（INSTALL_FAILED_UPDATE_INCOMPATIBLE）。对「应用目录」用户
// （vault 在应用私有存储）卸载重装 = 本地笔记库整体丢失。
//
// **keystore 永不入库**（私有密钥材料，与硬约定 9 的 patches/ 性质相反）。
// 四个值从环境变量读；**任一缺失即回退 debug 签名** —— 本地开发与 CI 以外的
// 构建流程完全不受影响。
val releaseStoreFile: String? = System.getenv("LANMARK_KEYSTORE_PATH")
val releaseStorePassword: String? = System.getenv("LANMARK_KEYSTORE_PASSWORD")
val releaseKeyAlias: String? = System.getenv("LANMARK_KEY_ALIAS")
val releaseKeyPassword: String? = System.getenv("LANMARK_KEY_PASSWORD")
val hasReleaseSigning: Boolean = listOf(
    releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword
).all { !it.isNullOrBlank() } && file(releaseStoreFile!!).exists()

android {
    compileSdk = 36
    // 钉在 SDK 里已装的 build-tools 34.0.0：AGP 8.11 默认要 35.0.0，本网络下拖不下来。
    // 换版本前必须先手工装好对应 build-tools，否则写在纸上也没用
    buildToolsVersion = "34.0.0"
    namespace = "com.lanmark.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.lanmark.app"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        // 只在四个环境变量齐全且 keystore 文件确实存在时创建；否则整个块不注册，
        // release build type 回退到 debug 签名（AGP 默认行为）。
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                // 与 v0.1 起的 debug 构建一致的算法与有效期，避免多余的迁移变数
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            // M4g：有固定 keystore 就用它；没有则显式回退 debug 签名
            // （此前 release build type 无 signingConfig，AGP 会给未签名产物，
            //  本地跑 `pnpm tauri android build` 会产出装不上的 APK）
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")