package com.grupobistro.noc

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.content.ContextCompat
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * Conexion permanente al WebSocket del NOC (/ws, el mismo feed que usa el
 * dashboard) para notificar alertas al instante aunque la app este cerrada.
 * Corre como servicio en primer plano (Android lo exige para una conexion
 * permanente) con una notificacion fija de prioridad minima.
 */
class AlertService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var attempt = 0
    private var stopped = false
    private var failedCookie: String? = null
    private val serviceStatus = mutableMapOf<String, String>() // monitor de servicio -> ultimo estado

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        val notification = Notifier.serviceNotification(this, "Conectando al NOC…")
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(Notifier.SERVICE_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(Notifier.SERVICE_NOTIFICATION_ID, notification)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_RECONNECT) {
            // La app avisa que puede haber una sesion nueva (login): reconectar ya.
            failedCookie = null
            attempt = 0
            socket?.cancel()
            socket = null
        }
        if (socket == null) connect()
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, "Servicio detenido")
        socket = null
        super.onDestroy()
    }

    private fun updateStatus(text: String) {
        getSystemService(NotificationManager::class.java)
            .notify(Notifier.SERVICE_NOTIFICATION_ID, Notifier.serviceNotification(this, text))
    }

    private fun connect() {
        if (stopped) return
        val prefs = Prefs(this)
        val base = prefs.serverUrl ?: return stopSelf()
        val cookie = NocApi.cookieHeader(base)

        if (NocApi.sessionToken(base) == null || (cookie != null && cookie == failedCookie)) {
            // Sin sesion (o con la misma que ya fue rechazada): esperar a que
            // el usuario inicie sesion en la app.
            updateStatus("Iniciá sesión en la app para recibir alertas")
            scheduleReconnect(60_000)
            return
        }

        val request = Request.Builder()
            .url(NocApi.wsUrl(base))
            .header("Cookie", cookie!!)
            .header("User-Agent", "NOCBistroApp/${BuildConfig.VERSION_NAME}")
            .build()

        socket = NocApi.http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempt = 0
                handler.post { updateStatus("Conectado · recibiendo alertas en tiempo real") }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    handleMessage(JSONObject(text))
                } catch (_: Exception) {
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handler.post { onDisconnected(code, cookie) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                handler.post { onDisconnected(response?.code ?: -1, cookie) }
            }
        })
    }

    private fun onDisconnected(code: Int, cookie: String) {
        socket = null
        if (stopped) return
        if (code == 4001 || code == 4002 || code == 401) {
            // Sesion vencida o cerrada: avisar una sola vez por sesion.
            failedCookie = cookie
            val prefs = Prefs(this)
            if (prefs.expiredCookieNotified != cookie) {
                prefs.expiredCookieNotified = cookie
                Notifier.showInfo(
                    this, 9001, "Sesión del NOC vencida",
                    "Abrí la app e iniciá sesión de nuevo para seguir recibiendo alertas."
                )
            }
            updateStatus("Sesión vencida · iniciá sesión en la app")
            scheduleReconnect(60_000)
            return
        }
        attempt++
        val delay = (5_000L * (1 shl minOf(attempt, 5))).coerceAtMost(120_000L)
        updateStatus("Sin conexión con el NOC · reintentando…")
        scheduleReconnect(delay)
    }

    private fun scheduleReconnect(delayMs: Long) {
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed({ if (socket == null) connect() }, delayMs)
    }

    private fun handleMessage(msg: JSONObject) {
        val prefs = Prefs(this)
        when (msg.optString("type")) {
            "SECURITY_ALERT", "SECURITY_ALERT_UPDATE" -> {
                val ev = msg.optJSONObject("event") ?: return
                val id = ev.optString("id").ifEmpty { return }
                val severity = ev.optString("severity", "LOW")
                val status = ev.optString("status", "OPEN")
                if (status == "RESOLVED" || !prefs.severityAllowed(severity)) return
                // Silenciada desde el NOC: no molestar hasta que venza.
                val snoozed = ev.optString("snoozedUntil", "")
                if (snoozed.isNotEmpty() && snoozed != "null" &&
                    runCatching { java.time.Instant.parse(snoozed).isAfter(java.time.Instant.now()) }.getOrDefault(false)
                ) return
                // Una actualizacion solo notifica si la alerta empeoro; una nueva, siempre.
                val isNew = msg.optString("type") == "SECURITY_ALERT"
                if (!isNew && Prefs.rank(severity) < 2) return
                if (!prefs.shouldNotify(id, Prefs.rank(severity))) return
                val server = ev.optString("serverName", "")
                val title = (if (isNew) "" else "Empeoró: ") + humanType(ev.optString("type")) + if (server.isNotEmpty()) " · $server" else ""
                Notifier.showAlert(this, id, severity, title, ev.optString("description"))
            }
            "SERVICE_CHECK" -> {
                val c = msg.optJSONObject("check") ?: return
                val id = c.optString("id")
                val status = c.optString("status")
                val previous = serviceStatus.put(id, status)
                if (previous == null || previous == status) return
                val name = c.optString("name", "Servicio")
                if (status == "down" && prefs.severityAllowed("HIGH")) {
                    Notifier.showAlert(this, "svc-$id-${System.currentTimeMillis() / 60000}", "HIGH", "Servicio caído: $name", c.optString("lastError", "No responde"))
                } else if (status == "up" && previous == "down") {
                    Notifier.showInfo(this, ("svc-up-$id").hashCode(), "Servicio restablecido: $name", "Volvió a responder.")
                }
            }
        }
    }

    companion object {
        const val ACTION_RECONNECT = "com.grupobistro.noc.RECONNECT"

        private val TYPE_LABEL = mapOf(
            "AGENT_OFFLINE" to "Servidor sin reportar",
            "CPU_THRESHOLD" to "CPU alta",
            "MEMORY_THRESHOLD" to "Memoria alta",
            "DISK_THRESHOLD" to "Disco lleno",
            "BACKUP_FAILED" to "Backup fallido",
            "BACKUP_WARNING" to "Backup con advertencias",
            "NETWORK_UNREACHABLE" to "Sin conexión",
            "INTERNET_OUTAGE" to "Corte de internet",
            "ISP_FAILOVER" to "Enlace de respaldo",
            "NETWORK_DEGRADED" to "Internet degradado",
            "DISK_FORECAST" to "Disco se está llenando",
            "DISK_FAILURE_PREDICTED" to "Disco con fallas",
            "SERVICE_DOWN" to "Servicio detenido",
            "LOGIN_FAILURE" to "Intentos de acceso fallidos",
            "MALWARE_DETECTED" to "Malware detectado",
            "AD_ACCOUNT_LOCKOUT" to "Cuenta bloqueada",
            "PRIVILEGED_GROUP_CHANGE" to "Cambio en grupo privilegiado",
            "DHCP_SCOPE_EXHAUSTED" to "DHCP sin IPs libres",
            "IP_CONFLICT" to "Conflicto de IP",
            "PRINTER_ISSUE" to "Impresora",
            "ANOMALY_DETECTED" to "Anomalía",
        )

        fun humanType(type: String): String = TYPE_LABEL[type] ?: type.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }

        fun start(context: Context, reconnect: Boolean = false) {
            val intent = Intent(context, AlertService::class.java)
            if (reconnect) intent.action = ACTION_RECONNECT
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (_: Exception) {
                // Android puede negarse a iniciarlo desde segundo plano; el
                // chequeo periodico (AlertCheckWorker) cubre ese caso.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AlertService::class.java))
        }
    }
}
