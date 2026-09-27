package com.grupobistro.noc

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Al encender el celular (o al actualizar la app) vuelve a escuchar alertas. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = Prefs(context)
        if (prefs.serverUrl == null) return
        AlertCheckWorker.schedule(context)
        if (prefs.liveAlerts) AlertService.start(context)
    }
}
