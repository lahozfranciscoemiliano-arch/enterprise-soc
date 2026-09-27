package com.grupobistro.noc

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/**
 * El NOC completo (el mismo dashboard web, que ya es responsive) dentro de un
 * WebView, mas lo que un navegador no da: notificaciones de alertas con la
 * app cerrada, arranque automatico, descargas de reportes y deslizar para
 * recargar.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var webView: WebView
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var progress: ProgressBar
    private lateinit var errorView: LinearLayout
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var lastSessionToken: String? = null
    private var loadedServer: String? = null

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) {
            Toast.makeText(this, "Sin permiso de notificaciones no vas a recibir las alertas", Toast.LENGTH_LONG).show()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        if (prefs.serverUrl == null) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.activity_main)
        SystemBars.apply(this, findViewById(R.id.root))
        Notifier.createChannels(this)

        webView = findViewById(R.id.webview)
        swipe = findViewById(R.id.swipe)
        progress = findViewById(R.id.progress)
        errorView = findViewById(R.id.errorView)
        findViewById<Button>(R.id.retryButton).setOnClickListener { loadHome() }
        findViewById<Button>(R.id.settingsButton).setOnClickListener { showAppMenu() }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            mediaPlaybackRequiresUserGesture = true
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString NOCBistroApp/${BuildConfig.VERSION_NAME}"
        }

        // Puente para el boton "Ajustes de la app" del encabezado del NOC. Solo
        // se cargan paginas del propio NOC (lo externo va al navegador).
        webView.addJavascriptInterface(object {
            @JavascriptInterface
            fun openMenu() {
                runOnUiThread { showAppMenu() }
            }

            @JavascriptInterface
            fun version(): String = BuildConfig.VERSION_NAME
        }, "NocApp")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val home = Uri.parse(prefs.serverUrl)
                // Todo lo del NOC se abre adentro; links externos, en el navegador.
                if (url.host == home.host) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                } catch (_: ActivityNotFoundException) {
                }
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                errorView.visibility = View.GONE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                swipe.isRefreshing = false
                CookieManager.getInstance().flush()
                onSessionMaybeChanged()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    swipe.isRefreshing = false
                    findViewById<TextView>(R.id.errorDetail).text =
                        "${error.description}\n${prefs.serverUrl}"
                    errorView.visibility = View.VISIBLE
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress < 100) View.VISIBLE else View.GONE
                // El login y la navegacion del dashboard son de una sola pagina
                // (sin recargas): se revisa la cookie tambien aca.
                if (newProgress == 100) onSessionMaybeChanged()
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                return try {
                    fileChooser.launch(params.createIntent())
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }

        // Exportes CSV y reportes PDF: se bajan a "Descargas" con la sesion actual.
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            try {
                val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
                val request = DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    .addRequestHeader("User-Agent", userAgent)
                    .setMimeType(mimeType)
                    .setTitle(fileName)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                getSystemService(DownloadManager::class.java).enqueue(request)
                Toast.makeText(this, "Descargando $fileName…", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "No se pudo descargar: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }

        swipe.setColorSchemeColors(ContextCompat.getColor(this, R.color.brand))
        swipe.setOnRefreshListener { webView.reload() }
        // Solo recarga si la pagina esta arriba de todo (no al hacer scroll).
        swipe.setOnChildScrollUpCallback { _, _ -> webView.scrollY > 0 }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
            }
        })

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
            loadedServer = prefs.serverUrl
        } else {
            loadHome()
        }

        requestNotificationPermission()
        AlertCheckWorker.schedule(this)
        if (prefs.liveAlerts) AlertService.start(this)
    }

    private fun loadHome() {
        errorView.visibility = View.GONE
        loadedServer = prefs.serverUrl
        webView.loadUrl(prefs.serverUrl!!)
    }

    override fun onResume() {
        super.onResume()
        // Se cambio el servidor desde el menu: cargar el nuevo.
        if (loadedServer != null && prefs.serverUrl != loadedServer) {
            lastSessionToken = null
            loadHome()
            if (prefs.liveAlerts) AlertService.start(this, reconnect = true)
        }
    }

    /** Si cambio la sesion (login), el servicio de alertas se reconecta con ella. */
    private fun onSessionMaybeChanged() {
        val token = NocApi.sessionToken(prefs.serverUrl ?: return)
        if (token != null && token != lastSessionToken) {
            lastSessionToken = token
            CookieManager.getInstance().flush()
            if (prefs.liveAlerts) AlertService.start(this, reconnect = true)
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Al tocar una notificacion se vuelve al dashboard (las alertas estan arriba).
        if (intent.getBooleanExtra(EXTRA_OPEN_ALERTS, false)) webView.reload()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    /** Ajustes de la app (se abren desde el boton del encabezado del NOC). */
    private fun showAppMenu() {
        val liveLabel = if (prefs.liveAlerts) "Alertas en tiempo real: ACTIVADAS (tocar para apagar)" else "Alertas en tiempo real: apagadas (tocar para activar)"
        val levelLabel = "Nivel mínimo de alerta: " + mapOf("LOW" to "todas", "MEDIUM" to "media o más", "HIGH" to "alta o más", "CRITICAL" to "solo críticas")[prefs.minSeverity]
        val items = arrayOf(
            liveLabel,
            levelLabel,
            "Probar notificación",
            "Evitar que Android corte las alertas",
            "Recargar",
            "Cambiar servidor",
            "Acerca de",
        )
        AlertDialog.Builder(this)
            .setTitle("Ajustes de la app")
            .setItems(items) { _, which ->
                when (which) {
                    0 -> toggleLiveAlerts()
                    1 -> chooseMinSeverity()
                    2 -> {
                        requestNotificationPermission()
                        Notifier.showAlert(
                            this, "test-${System.currentTimeMillis()}", "CRITICAL",
                            "Prueba · NOC Grupo Bistro", "Si ves esta notificación, las alertas del NOC van a llegar a este celular."
                        )
                    }
                    3 -> openBatterySettings()
                    4 -> webView.reload()
                    5 -> startActivity(Intent(this, SetupActivity::class.java))
                    6 -> AlertDialog.Builder(this)
                        .setTitle("NOC / SOC Grupo Bistro")
                        .setMessage(
                            "Versión ${BuildConfig.VERSION_NAME}\nServidor: ${prefs.serverUrl}\n\n" +
                                "Acceso Restringido a cualquier Personal no autorizado de Grupo Bistro.\n\n" +
                                "Desarrollado por: Francisco E. Lahoz F."
                        )
                        .setPositiveButton("Cerrar", null)
                        .show()
                }
            }
            .setNegativeButton("Cerrar", null)
            .show()
    }

    private fun toggleLiveAlerts() {
        prefs.liveAlerts = !prefs.liveAlerts
        if (prefs.liveAlerts) AlertService.start(this, reconnect = true) else AlertService.stop(this)
        Toast.makeText(
            this,
            if (prefs.liveAlerts) "Alertas en tiempo real activadas" else "Alertas en tiempo real desactivadas (se revisa cada 15 min)",
            Toast.LENGTH_LONG
        ).show()
    }

    private fun chooseMinSeverity() {
        val options = arrayOf("Todas (baja o más)", "Media o más", "Alta o más (recomendado)", "Solo críticas")
        val values = arrayOf("LOW", "MEDIUM", "HIGH", "CRITICAL")
        AlertDialog.Builder(this)
            .setTitle("Notificarme alertas de nivel")
            .setSingleChoiceItems(options, values.indexOf(prefs.minSeverity)) { dialog, which ->
                prefs.minSeverity = values[which]
                dialog.dismiss()
            }
            .show()
    }

    @SuppressLint("BatteryLife")
    private fun openBatterySettings() {
        val pm = getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            Toast.makeText(this, "Listo: Android no restringe esta app en segundo plano", Toast.LENGTH_LONG).show()
            return
        }
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (_: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    companion object {
        const val EXTRA_OPEN_ALERTS = "open_alerts"
    }
}
