package com.grupobistro.noc

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import okhttp3.Request
import org.json.JSONArray
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Respaldo del servicio en tiempo real: cada 15 minutos (el minimo que
 * permite Android) consulta las alertas abiertas y notifica las nuevas.
 * Cubre los casos en que el sistema corta el servicio en segundo plano.
 */
class AlertCheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        val base = prefs.serverUrl ?: return Result.success()
        val cookie = NocApi.cookieHeader(base) ?: return Result.success()
        if (NocApi.sessionToken(base) == null) return Result.success()

        val since = prefs.lastPollAt
        val now = System.currentTimeMillis()
        return try {
            val request = Request.Builder().url("$base/api/events?limit=50").header("Cookie", cookie).build()
            NocApi.http.newCall(request).execute().use { res ->
                if (!res.isSuccessful) return Result.success()
                val events = JSONArray(res.body?.string() ?: "[]")
                // Primera corrida: solo marca el punto de partida (no avisa de alertas viejas).
                if (since > 0) {
                    for (i in 0 until events.length()) {
                        val ev = events.getJSONObject(i)
                        if (ev.optString("status") == "RESOLVED") continue
                        val severity = ev.optString("severity", "LOW")
                        if (!prefs.severityAllowed(severity)) continue
                        if (ev.optBoolean("silent", false)) continue
                        val created = try { Instant.parse(ev.optString("createdAt")).toEpochMilli() } catch (_: Exception) { 0L }
                        if (created < since) continue
                        val id = ev.optString("id")
                        if (!prefs.shouldNotify(id, Prefs.rank(severity))) continue
                        val server = ev.optString("serverName", "")
                        Notifier.showAlert(
                            applicationContext, id, severity,
                            AlertService.humanType(ev.optString("type")) + if (server.isNotEmpty()) " · $server" else "",
                            ev.optString("description")
                        )
                    }
                }
                prefs.lastPollAt = now
            }
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }

    companion object {
        private const val NAME = "noc-alert-check"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<AlertCheckWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
