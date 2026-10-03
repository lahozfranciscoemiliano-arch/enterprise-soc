package com.grupobistro.noc

import android.webkit.CookieManager
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Utilidades compartidas para hablar con el backend del NOC. */
object NocApi {
    const val SESSION_COOKIE = "soc_session"

    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS) // mantiene viva la conexion WebSocket (NAT de datos moviles)
            .build()
    }

    fun normalizeUrl(raw: String): String {
        var url = raw.trim().trimEnd('/')
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            // Un dominio va por HTTPS; una IP sola (sin certificado), por http.
            val isIp = Regex("""^\d{1,3}(\.\d{1,3}){3}(:\d+)?$""").matches(url)
            url = (if (isIp) "http://" else "https://") + url
        }
        return url
    }

    fun wsUrl(baseUrl: String): String =
        baseUrl.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/ws"

    /** Cookies de la sesion iniciada en el WebView (incluye la httpOnly de sesion). */
    fun cookieHeader(baseUrl: String): String? = try {
        CookieManager.getInstance().getCookie(baseUrl)
    } catch (e: Exception) {
        null
    }

    fun sessionToken(baseUrl: String): String? =
        cookieHeader(baseUrl)
            ?.split(";")
            ?.map { it.trim() }
            ?.firstOrNull { it.startsWith("$SESSION_COOKIE=") }
            ?.substringAfter("=")
            ?.takeIf { it.isNotBlank() }
}
