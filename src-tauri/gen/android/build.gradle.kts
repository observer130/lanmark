buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

// 真机走查用：debug 包加 `.debug` 后缀，装成**独立应用**，与已装的 release 版共存。
//
// 为什么写在根文件而不是 app/build.gradle.kts：`pnpm tauri android build` 会**重写**
// app/build.gradle.kts——往里加的语句会被抹掉（注释却留下，极易误判成「改成功了」，
// 2026-10-16 实测），而根文件不会被重写，所以标准构建命令就能生效，不需要两步构建。
//
// 为什么需要共存：release 资产是固定 keystore 签名，本地只能出 debug 签名，二者
// **无法互相覆盖**（INSTALL_FAILED_UPDATE_INCOMPATIBLE）；而卸载 App 会删掉
// 「应用目录」用户的笔记库（`getExternalFilesDir`，按 applicationId 解析）。见硬约定 27。
// 配套：`app/src/debug/res/values/strings.xml` 把 debug 版应用名改成 "Lanmark Debug"。
subprojects {
    plugins.withId("com.android.application") {
        extensions.configure<com.android.build.api.dsl.ApplicationExtension> {
            buildTypes.getByName("debug").applicationIdSuffix = ".debug"
        }
    }
}
