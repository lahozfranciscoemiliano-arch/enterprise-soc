package com.grupobistro.noc

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import okhttp3.Request
import kotlin.concurrent.thread

/** Primera pantalla: direccion del servidor NOC (se valida contra /api/auth/me). */
class SetupActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        SystemBars.apply(this, findViewById(R.id.root))

        val prefs = Prefs(this)
        val input = findViewById<EditText>(R.id.serverUrl)
        val error = findViewById<TextView>(R.id.setupError)
        val button = findViewById<Button>(R.id.connectButton)
        input.setText(prefs.serverUrl ?: BuildConfig.DEFAULT_SERVER_URL)

        button.setOnClickListener {
            val url = NocApi.normalizeUrl(input.text.toString())
            error.visibility = View.GONE
            button.isEnabled = false
            button.text = "Verificando…"
            thread {
                val result = try {
                    // /api/auth/me pasa por el proxy (Nginx) igual que el resto de la
                    // API: 200 = sesion ya iniciada, 401 = falta iniciar sesion.
                    // Cualquiera de los dos confirma que es el NOC.
                    NocApi.http.newCall(Request.Builder().url("$url/api/auth/me").build()).execute().use { res ->
                        if (res.code == 200 || res.code == 401) null
                        else "El servidor respondió HTTP ${res.code}. ¿Es la dirección del NOC?"
                    }
                } catch (e: Exception) {
                    "No se pudo conectar: ${e.message ?: "sin respuesta"}. Revisá la dirección y la conexión a internet."
                }
                runOnUiThread {
                    button.isEnabled = true
                    button.text = "Conectar"
                    if (result == null) {
                        prefs.serverUrl = url
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                        finish()
                    } else {
                        error.text = result
                        error.visibility = View.VISIBLE
                    }
                }
            }
        }
    }
}
