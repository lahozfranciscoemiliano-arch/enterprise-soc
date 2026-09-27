package com.grupobistro.noc

import android.app.Activity
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Android 15 dibuja las apps "de borde a borde": sin esto el contenido queda
 * debajo de la barra de estado (hora, bateria) y de la barra de navegacion.
 * Se deja espacio para ambas (y para el teclado) y se usan iconos oscuros
 * sobre fondo blanco, igual que el encabezado del NOC.
 */
object SystemBars {
    fun apply(activity: Activity, root: View) {
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        WindowCompat.getInsetsController(activity.window, root).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
    }
}
