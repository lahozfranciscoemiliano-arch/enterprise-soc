plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Version: se sube con cada build de GitHub Actions (APP_VERSION_CODE) para
// que Android acepte la actualizacion encima de la instalada.
val appVersionCode = (System.getenv("APP_VERSION_CODE") ?: "1").toInt()
val appVersionName = System.getenv("APP_VERSION_NAME") ?: "1.0.0"

android {
    namespace = "com.grupobistro.noc"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.grupobistro.noc"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        // Servidor por defecto (se puede cambiar desde la app).
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"${System.getenv("NOC_DEFAULT_URL") ?: "https://bistro.enterprisesoc.lat"}\"")
    }

    signingConfigs {
        create("release") {
            // Keystore fija (secreto del repo en GitHub Actions): todas las
            // versiones se firman con la misma clave, asi se actualizan sin
            // desinstalar.
            val ks = System.getenv("ANDROID_KEYSTORE_PATH")
            if (ks != null) {
                storeFile = file(ks)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (System.getenv("ANDROID_KEYSTORE_PATH") != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
