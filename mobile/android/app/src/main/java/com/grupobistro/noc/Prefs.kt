package com.grupobistro.noc

import android.content.Context
import org.json.JSONObject

/** Configuracion local de la app (servidor, alertas) y memoria de alertas ya notificadas. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("noc_prefs", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() {
            val stored = sp.getString("server_url", null)
            // El NOC paso de la IP de la VPS a su dominio con HTTPS: las
            // instalaciones viejas se actualizan solas (hay que iniciar sesion
            // de nuevo, la sesion es por direccion).
            if (stored != null && stored.trimEnd('/') in LEGACY_SERVER_URLS) {
                sp.edit().putString("server_url", BuildConfig.DEFAULT_SERVER_URL).apply()
                return BuildConfig.DEFAULT_SERVER_URL
            }
            return stored
        }
        set(value) = sp.edit().putString("server_url", value).apply()

    /** Conexion permanente (servicio en primer plano) para alertas al instante. */
    var liveAlerts: Boolean
        get() = sp.getBoolean("live_alerts", true)
        set(value) = sp.edit().putBoolean("live_alerts", value).apply()

    /** Severidad minima a notificar: LOW, MEDIUM, HIGH o CRITICAL. */
    var minSeverity: String
        get() = sp.getString("min_severity", "HIGH") ?: "HIGH"
        set(value) = sp.edit().putString("min_severity", value).apply()

    /** Ultimo chequeo por encuesta (WorkManager), en ms. 0 = nunca. */
    var lastPollAt: Long
        get() = sp.getLong("last_poll_at", 0L)
        set(value) = sp.edit().putLong("last_poll_at", value).apply()

    /** Cookie de sesion con la que ya se aviso "sesion vencida" (para no repetir). */
    var expiredCookieNotified: String?
        get() = sp.getString("expired_cookie", null)
        set(value) = sp.edit().putString("expired_cookie", value).apply()

    /**
     * Alertas ya notificadas: id -> rango de severidad notificado. Una alerta
     * que empeora (HIGH -> CRITICAL) se vuelve a notificar; una que solo se
     * repite, no.
     */
    @Synchronized
    fun shouldNotify(alertId: String, severityRank: Int): Boolean {
        val map = JSONObject(sp.getString("notified", "{}") ?: "{}")
        val previous = map.optInt(alertId, -1)
        if (previous >= severityRank) return false
        map.put(alertId, severityRank)
        // Se conservan solo las ultimas ~300.
        while (map.length() > 300) {
            val first = map.keys().next()
            map.remove(first)
        }
        sp.edit().putString("notified", map.toString()).apply()
        return true
    }

    fun severityAllowed(severity: String): Boolean = rank(severity) >= rank(minSeverity)

    companion object {
        private val LEGACY_SERVER_URLS = setOf("http://203.161.39.123", "http://203.161.39.123:80")

        fun rank(severity: String?): Int = when (severity?.uppercase()) {
            "LOW" -> 0
            "MEDIUM" -> 1
            "HIGH" -> 2
            "CRITICAL" -> 3
            else -> 0
        }
    }
}
