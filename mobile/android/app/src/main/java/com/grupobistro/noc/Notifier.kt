package com.grupobistro.noc

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

object Notifier {
    const val CHANNEL_CRITICAL = "alerts_critical"
    const val CHANNEL_ALERTS = "alerts"
    const val CHANNEL_SERVICE = "service"
    const val SERVICE_NOTIFICATION_ID = 1

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_CRITICAL, "Alertas críticas", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Alertas CRITICAL del NOC/SOC (servidor caído, malware, grupos privilegiados...)"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 400, 200, 400, 200, 600)
                enableLights(true)
                lightColor = Color.RED
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERTS, "Alertas", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Alertas del NOC/SOC y caídas de servicios"
                enableVibration(true)
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, "Conexión en segundo plano", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Aviso fijo mientras la app escucha alertas en tiempo real"
                setShowBadge(false)
            }
        )
    }

    private fun openAppIntent(context: Context, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_OPEN_ALERTS, true)
        }
        return PendingIntent.getActivity(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun canNotify(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private val SEVERITY_LABEL = mapOf("LOW" to "Baja", "MEDIUM" to "Media", "HIGH" to "Alta", "CRITICAL" to "CRÍTICA")

    fun showAlert(context: Context, id: String, severity: String, title: String, text: String) {
        if (!canNotify(context)) return
        val critical = severity.equals("CRITICAL", ignoreCase = true)
        val color = when (severity.uppercase()) {
            "CRITICAL" -> 0xFFDC2626.toInt()
            "HIGH" -> 0xFFEA580C.toInt()
            "MEDIUM" -> 0xFFF59E0B.toInt()
            else -> 0xFF64748B.toInt()
        }
        val notification = NotificationCompat.Builder(context, if (critical) CHANNEL_CRITICAL else CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setColor(color)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSubText("Severidad ${SEVERITY_LABEL[severity.uppercase()] ?: severity}")
            .setPriority(if (critical) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(context, id.hashCode()))
            .build()
        try {
            NotificationManagerCompat.from(context).notify(id.hashCode(), notification)
        } catch (_: SecurityException) {
        }
    }

    fun showInfo(context: Context, id: Int, title: String, text: String) {
        if (!canNotify(context)) return
        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setColor(0xFFB4532A.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(context, id))
            .build()
        try {
            NotificationManagerCompat.from(context).notify(id, notification)
        } catch (_: SecurityException) {
        }
    }

    fun serviceNotification(context: Context, status: String) =
        NotificationCompat.Builder(context, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setColor(0xFFB4532A.toInt())
            .setContentTitle("NOC Grupo Bistro")
            .setContentText(status)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(openAppIntent(context, 0))
            .build()
}
