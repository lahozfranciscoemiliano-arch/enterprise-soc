# Deploy de Enterprise SOC en un VPS (Ubuntu/Debian, ej. Donweb)

Autor: Francisco E. Lahoz F.

Runbook paso a paso. Nada de esto se ejecuta solo — cada comando lo corres vos por SSH.

El stack central (Postgres + backend + frontend) corre completo con Docker Compose
(`docker-compose.yml` en la raíz del repo). El VPS **no necesita Node.js instalado**:
todo se construye y corre dentro de los contenedores. Nginx sí corre en el host, como
reverse proxy con TLS.

## 0. Antes de empezar

- El repo local (`enterprise-soc/`) hoy es **solo git local**, sin remoto. Subilo a un
  repositorio privado (GitHub/GitLab) antes de clonarlo en el VPS, o transferí la carpeta
  con `rsync`/`scp` si preferís no usar un remoto.
- Nunca reuses las credenciales de desarrollo en producción. Generá nuevas:
  ```bash
  openssl rand -hex 32
  ```

## 1. Provisionar el VPS (una sola vez)

```bash
scp deploy/setup-server.sh root@TU_IP:/root/
ssh root@TU_IP
sudo bash /root/setup-server.sh
```

Instala Docker, Nginx, Certbot, crea el usuario `socapp` sin privilegios, y configura
`ufw` para que **solo** 22 (SSH) y 80/443 (Nginx) queden expuestos — Postgres y los
puertos internos de la app (3000/3001) nunca son accesibles directo desde internet
(`docker-compose.yml` ya los liga a `127.0.0.1`, y `ufw` es la segunda capa).

## 2. Subir el código

```bash
su - socapp
git clone <url-de-tu-repo-privado> enterprise-soc
cd enterprise-soc
```

## 3. Configurar variables de entorno de producción

```bash
cp .env.example .env
nano .env
```

Como mínimo, completá con valores reales de producción (nunca los de desarrollo):

```bash
POSTGRES_USER=nocsoc_prod
POSTGRES_PASSWORD=<generado con openssl rand -hex 32>
JWT_SECRET=<generado con openssl rand -hex 32>
AGENT_ENROLLMENT_SECRET=<generado con openssl rand -hex 32>
CORS_ORIGIN=https://noc.tudominio.com
NEXT_PUBLIC_API_URL=https://noc.tudominio.com
NEXT_PUBLIC_WS_URL=wss://noc.tudominio.com/ws
```

El resto (SMTP/Slack/webhook, Fortinet, Gemini, umbrales, etc.) es opcional acá — se puede
completar después desde el panel, sin redeploy (ver sección 11).

## 4. Primer build y arranque

```bash
docker compose build
docker compose up -d
docker compose ps   # los 3 deberían quedar "Up" (postgres healthy)
```

Las migraciones de Prisma se aplican automáticamente al arrancar el contenedor del
backend (`prisma migrate deploy`, corre en cada arranque, es idempotente).

## 5. Crear el primer usuario ADMIN

```bash
docker exec enterprise-soc-backend node prisma/seed.js
```

Guardá el email/password que imprime — no se pueden recuperar después.

## 6. Nginx + TLS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/enterprise-soc
sudo nano /etc/nginx/sites-available/enterprise-soc   # reemplazar noc.tudominio.com
sudo ln -s /etc/nginx/sites-available/enterprise-soc /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d noc.tudominio.com
```

Certbot reescribe el archivo agregando el bloque HTTPS y el redirect automático desde
HTTP. Se renueva solo (revisa `systemctl status certbot.timer`).

A partir de acá, `https://noc.tudominio.com` debería servir el dashboard.

## 7. Deploys posteriores

```bash
./deploy/deploy.sh              # actualiza a lo último de la rama actual
./deploy/deploy.sh v1.2.0       # o a un tag/commit específico
```

Reconstruye las imágenes y reinicia los contenedores; las migraciones nuevas se aplican
solas al arrancar.

## 8. Rollback

```bash
./deploy/rollback.sh <commit-o-tag-anterior>
```

**Ojo:** esto revierte el código, no las migraciones de base de datos — ver el
comentario al principio de `rollback.sh`.

## 9. Notificaciones externas

Se configuran desde **Admin → Configuración → Notificaciones externas**, sin redeploy:

- **Email:** host/puerto/usuario/contraseña SMTP, remitente y destinatario(s)
- **Slack:** URL de un Incoming Webhook
- **Webhook genérico:** cualquier URL que acepte un POST con JSON (Teams, Discord, PagerDuty, etc.)

Solo se notifican alertas con severidad igual o mayor a la elegida (por defecto `HIGH`).
Alternativa: fijar los mismos valores como variables de entorno en el `.env` de la raíz
(ver `.env.example`) — sirven de default inicial, pero lo que se guarde desde el panel
tiene prioridad.

## 10. Segundo factor (2FA) y control de sesiones

Cada usuario activa su propio 2FA desde el dashboard (botón **Mi cuenta**, arriba a la
derecha) — no requiere nada en el servidor más allá de tener el stack corriendo:

1. **Mi cuenta → Activar 2FA**: muestra un código QR para escanear con Google Authenticator,
   Authy, o cualquier app TOTP. También se puede cargar el secreto a mano.
2. Confirmar con un código de 6 dígitos activa el 2FA y muestra 8 códigos de respaldo de un
   solo uso — guardarlos ahora, no se vuelven a mostrar.
3. A partir de ahí, cada login pide el código además de la contraseña.

Recomendado activarlo en la cuenta ADMIN inicial antes de anunciar la URL al resto del
equipo (ver el checklist más abajo).

**Si alguien pierde el dispositivo con el 2FA:** un ADMIN puede restablecerlo desde
Admin → Usuarios → **Restablecer 2FA** (lo desactiva y de paso cierra las sesiones activas de
esa cuenta, por si el dispositivo perdido también tenía una sesión abierta).

**Revocar sesiones:** las sesiones ya no son un JWT stateless que dura hasta que expira solo
— quedan registradas en la base y se pueden cerrar en cualquier momento:

- Cada usuario: **Mi cuenta → Cerrar sesión en todos los dispositivos**.
- Un ADMIN sobre cualquier usuario: Admin → Usuarios → **Cerrar sesiones** (útil ante una
  cuenta comprometida o la baja de un empleado).

## 11. Configuración editable desde el panel

**Admin → Configuración** centraliza casi todo lo que antes solo se podía tocar editando el
`.env` y reiniciando: notificaciones (sección 9), umbrales globales de alerta por defecto,
duración de la sesión, el secreto de auto-enrolamiento de agentes, la versión publicada del
agente (sección 16), Fortinet (sección 13) y la API key del asistente (sección 15).

Un valor guardado ahí **tiene prioridad sobre la variable de entorno** correspondiente, y
aplica en caliente (hasta 10 segundos de caché interno, sin reiniciar nada) — con una sola
excepción: el receptor de syslog de Fortinet abre un socket UDP al arrancar el proceso, así
que activarlo/cambiar su puerto sí requiere `docker compose restart backend`.

Los campos sensibles (contraseña SMTP, webhooks, secretos, API keys) nunca se muestran en
texto plano después de guardados — solo confirman que están configurados y los últimos 4
caracteres, como con las API keys de servidores y dispositivos.

## 12. Etiquetas de servidores

Admin → Servidores → **Configurar** permite asignarle etiquetas libres a cada servidor
(sucursal, ambiente, rol de la app, etc.), separadas por coma. Sirven para organizar
visualmente servidores cuando son muchos — no afectan alertas ni permisos.

## 13. Monitor Fortinet

Nueva pestaña **Fortinet** en el dashboard, con dos formas de alimentarla (elegís una o las
dos, se configuran en Admin → Configuración → Fortinet y Admin → Fortinet):

- **Ingesta por API (recomendado):** Admin → Fortinet → "+ Nuevo dispositivo" genera una API
  key propia del dispositivo. `fortinet-poller/` (en la raíz del repo) es el script listo
  para usar: corre en la misma red que el FortiGate (su interfaz de management normalmente
  no es accesible desde internet), hace polling contra la API REST del FortiGate, clasifica
  cada log con la misma lógica que usa el backend para syslog (ver más abajo), y lo manda a:
  ```bash
  curl -X POST https://noc.tudominio.com/api/forti/events \
    -H "X-Device-Id: <id del dispositivo>" -H "X-Api-Key: <api key>" \
    -H "Content-Type: application/json" \
    -d '{"type":"IPS_ATTACK","severity":"HIGH","description":"...","sourceIp":"1.2.3.4"}'
  ```
  Instrucciones completas (configuración del token en el FortiGate, Linux/systemd y
  Windows) en `fortinet-poller/README.md`.
- **Syslog UDP:** si el FortiGate puede mandar syslog pero no se puede escribir un script,
  activá el receptor en Admin → Configuración → Fortinet (requiere reiniciar el backend) y
  configurá el FortiGate para mandar sus logs a la IP del VPS. El backend matchea el evento
  contra el dispositivo registrado por su IP de origen — eventos de IPs no registradas se
  descartan. **Importante:** este puerto UDP tiene que quedar expuesto a internet (o a la
  red donde esté el FortiGate) para que sirva de algo, a diferencia de todos los demás
  puertos de este sistema. Docker administra sus propias reglas de firewall y por defecto
  **ignora `ufw`** para los puertos que publica explícitamente — antes de descomentar la
  línea del puerto UDP en `docker-compose.yml`, restringí el origen permitido (por IP del
  FortiGate específico, o mejor, mandando el syslog por una VPN/túnel en vez de exponerlo a
  toda la internet).

Eventos IPS, virus, HA failover e interfaces caídas, o cualquiera marcado `CRITICAL`,
disparan notificación por los mismos canales de la sección 9.

**Sin probar contra un FortiGate real:** el parseo de syslog (`src/services/fortinet.js`)
está escrito según el formato de log estándar de FortiOS documentado públicamente, pero no
se validó contra logs reales de un FortiGate de Grupo Bistro. Revisá los primeros eventos
que lleguen antes de confiar ciegamente en la clasificación de tipo/severidad.

## 14. Acceso remoto (RDP/VNC) sin abrir puertos en el servidor

Admin → Servidores → **Conectar** (solo visible si activaste
"Mostrar el botón Conectar" en Admin → Configuración → Acceso remoto) abre un túnel
inverso: el agente ya instalado en el servidor se conecta hacia el backend cuando se le
pide, así que **no hace falta abrir ningún puerto entrante en el servidor ni tocarlo a
mano**. Requiere que ese servidor tenga el agente corriendo (versión 1.1.0 o superior).

Pasos para el operador (vos, desde tu propia máquina):

```bash
cd tools
npm install          # una sola vez
```

El botón "Conectar" te da el comando exacto con la sesión y el token ya completados:

```bash
node remote-relay.js --backend wss://noc.tudominio.com --session <id> --token <token>
mstsc /v:localhost:13389        # o tu cliente VNC, según el servicio elegido
```

Detalles de seguridad de esta función:

- El token es de un solo uso (una segunda conexión con el mismo token se rechaza) y expira
  a los 2 minutos si no se usa.
- El túnel completo se corta solo a los 30 minutos, se haya usado o no.
- El backend nunca interpreta el contenido del túnel (es un relay de bytes puro) — la
  autenticación/autorización de la sesión RDP/VNC en sí la sigue haciendo Windows.
- Solo ADMIN puede iniciar una sesión; queda registrado en Auditoría quién, cuándo y sobre
  qué servidor (`REMOTE_SESSION_CREATE`/`REMOTE_SESSION_CLOSE`).
- Es la función de mayor privilegio de todo el sistema (acceso interactivo directo a un
  servidor) — si no la vas a usar por ahora, dejala apagada en Configuración.

## 15. Asistente (Gemini)

Botón flotante 🤖 en el dashboard, disponible para cualquier usuario logueado. Para
activarlo:

1. Creá una API key gratis en [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   con tu cuenta de Google — el nivel gratuito alcanza para uso normal del asistente (tiene
   límite de requests por minuto); para uso más intensivo se asocia un proyecto de Google
   Cloud con facturación habilitada.
2. Cargala en Admin → Configuración → Asistente (Gemini).

El modelo por defecto es `gemini-3.8-flash`. Si lo cambiás, usá otro modelo de la familia
Gemini 3.x: el backend manda el nivel de razonamiento como `thinkingLevel` (low/medium),
que es el parámetro de los modelos 3.x — los 2.5 usan otro (`thinkingBudget`) y pueden
rechazar la request. Ojo: en estos modelos `maxOutputTokens` incluye los tokens de
razonamiento, por eso cada llamada fija su nivel explícitamente (`low` para triage, digest,
resúmenes y búsqueda; `medium` para el chat, el análisis de logs y la visión) y suma un
margen al tope de respuesta (ver `src/services/gemini.js`).

Cada consulta se manda con un resumen en vivo de las alertas abiertas, servidores y
eventos Fortinet recientes, para que pueda responder sobre el estado real sin que tengas
que copiar y pegar nada. Queda un log de auditoría (prompt + respuesta + quién preguntó) en
Admin → Configuración, tabla `assistant_logs` — no hay un endpoint en el panel para verlo
todavía, se consulta directo en la base si hace falta revisar el uso.

## 16. Publicar el agente y actualizaciones automáticas

Compilá el agente una vez (en cualquier Windows con Python) y subilo al VPS:

```powershell
# En la máquina de desarrollo Windows:
pyinstaller --onefile --name enterprise-soc-agent --hidden-import=win32timezone --hidden-import=win32api agent.py
```

```bash
# Subida al VPS:
scp dist/enterprise-soc-agent.exe socapp@TU_IP:~/enterprise-soc/backend/downloads/
docker cp ~/enterprise-soc/backend/downloads/enterprise-soc-agent.exe enterprise-soc-backend:/app/downloads/
```

A partir de acá, `install-agent.ps1` lo descarga solo si no lo encuentra local.

**Para actualizar los agentes ya instalados sin tocarlos uno por uno:** subí el nuevo .exe
de la misma forma, y completá **Admin → Configuración → Sesión y agentes → Última versión de
agente publicada** con el mismo número que tiene `AGENT_VERSION` al principio de
`agent/agent.py`. En su próximo ciclo, cada agente con una versión anterior se descarga el
.exe nuevo, se reemplaza a sí mismo, y se reinicia solo (la Tarea Programada lo relanza
automáticamente). No hace falta volver a correr `install-agent.ps1`.

## 17. Conectar servidores Windows al NOC

En cada servidor Windows a monitorear, como Administrador:

```powershell
.\install-agent.ps1 -BackendUrl "https://noc.tudominio.com" -EnrollmentSecret "<el AGENT_ENROLLMENT_SECRET del .env o de Admin -> Configuracion>"
```

Con eso alcanza: descarga el agente si hace falta, se auto-registra en el NOC, y queda
corriendo como tarea programada — sin tocar la base de datos ni el dashboard a mano. Ver
`agent/install-agent.ps1` para los detalles.

## 18. Retención de datos (housekeeping)

Con 30GB de disco en el VPS y 21 servidores reportando telemetría cada minuto, sin límite
esa tabla sola llenaría el disco en meses. Un job interno corre automáticamente **una vez
por día** (empieza 2 minutos después de arrancar el backend) y purga:

- Telemetría más vieja que `TELEMETRY_RETENTION_DAYS` (default: 30 días)
- Backups reportados más viejos que `BACKUP_STATUS_RETENTION_DAYS` (default: 180 días)
- Alertas **ya resueltas** más viejas que `SECURITY_EVENT_RETENTION_DAYS` (default: 365
  días) — una alerta abierta o reconocida nunca se borra por antigüedad, solo por antigüedad
  *después de* resolverse
- Eventos Fortinet más viejos que `FORTI_EVENT_RETENTION_DAYS` (default: 180 días)
- Auditoría más vieja que `AUDIT_LOG_RETENTION_DAYS` (default: 365 días)
- Sesiones vencidas/revocadas y sesiones de acceso remoto cerradas de más de 30 días
  (no configurable, es pura limpieza operativa)

Los días se ajustan en **Admin → Configuración → Retención de datos**; poner `0` en
cualquiera desactiva la purga de esa tabla (no recomendado con este disco). Después de
purgar, corre `VACUUM (ANALYZE)` sobre las tablas afectadas para que Postgres devuelva el
espacio libre al sistema de archivos antes de esperar al autovacuum.

**Admin → Reportes** muestra el resultado de la última corrida y tiene un botón para forzar
una corrida manual (útil recién configurado, para no esperar hasta el otro día).

## 19. Auto-monitoreo del VPS anfitrión

Hoy nadie vigila el CPU/RAM/disco del propio Ubuntu del VPS ni el estado de sus contenedores
Docker — si el disco se llena o un contenedor se cae, te enterás cuando el NOC ya dejó de
funcionar. `deploy/host-monitor.sh` resuelve esto reusando el mismo mecanismo que un agente
Windows: corre **en el host** (no dentro de Docker), se auto-registra como un servidor más
via `/api/servers/enroll`, y manda telemetría real por `/api/telemetry` — así aparece en el
dashboard, dispara alertas por los mismos umbrales, y no necesitó ningún endpoint nuevo del
lado del backend.

Primera corrida (registra el host y guarda las credenciales en `/etc/enterprise-soc/`):

```bash
sudo mkdir -p /opt/enterprise-soc/deploy
sudo cp deploy/host-monitor.sh /opt/enterprise-soc/deploy/
sudo bash /opt/enterprise-soc/deploy/host-monitor.sh \
  --backend http://localhost:3000 \
  --enrollment-secret "<el AGENT_ENROLLMENT_SECRET del .env o de Admin -> Configuracion>"
```

Queda registrado con el tag `infra-vps` y con nombre `<hostname>-vps`. Para que corra solo
cada minuto, instalar el timer de systemd:

```bash
sudo cp deploy/host-monitor.service deploy/host-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now host-monitor.timer
sudo systemctl status host-monitor.timer
```

Si Docker está instalado, además reporta qué contenedores del stack (`enterprise-soc-*`) no
están corriendo o su healthcheck los marca `unhealthy` — eso dispara automáticamente una
alerta `CUSTOM` de severidad HIGH (ver `alertEngine.js`, campo `metadata.unhealthyContainers`
de la telemetría). Sin Docker instalado, simplemente omite esa parte y sigue reportando
CPU/RAM/disco con normalidad.

## 20. Reportes ejecutivos automáticos

**Admin → Reportes** genera un PDF con SLA, incidentes del período, tiempo promedio de
resolución, estado de backups y detalle por servidor — pensado para mandarle a gerencia sin
que entren al panel. Se puede generar a demanda (elegís el período en días) o programar el
envío automático:

**Admin → Configuración → Reportes ejecutivos**: activar, elegir frecuencia (diaria o
semanal, los lunes), hora UTC de envío, y el/los destinatario(s). Requiere SMTP configurado
(sección 9) — reusa la misma configuración de las notificaciones de alertas.

Los últimos 60 reportes generados quedan disponibles para descarga en el propio panel
(persisten en el volumen `report_files`, sobreviven a un rebuild).

## 21. Playbooks de resolución

**Admin → Playbooks** tiene un procedimiento sugerido por cada tipo de alerta (interno:
`CPU_THRESHOLD`, `BACKUP_FAILED`, etc.; y de Fortinet: `IPS_ATTACK`, `HA_FAILOVER`, etc.),
precargado con contenido por defecto al correr el seed y editable en cualquier momento.
Se muestra directamente junto a cada alerta en **Logs Regex** (botón "📘 Playbook"), así el
equipo no depende de acordarse el procedimiento de memoria. Volver a correr
`node prisma/seed.js` nunca pisa un playbook que ya fue editado — solo crea los que falten.

## 22. Watchdog de agente caído (heartbeat)

El campo de estado (ONLINE/OFFLINE) de cada servidor ahora se mantiene solo: si un agente
deja de reportar telemetría por más del umbral configurado (default 240s, ~4 ciclos de
60s), se marca OFFLINE automáticamente y dispara una alerta `CRITICAL`. Se ajusta en
**Admin → Configuración → Sesión y agentes**; el resultado de la última corrida (corre cada
minuto solo) se ve en **Admin → Reportes**.

## 23. Triage automático y resumen de reportes con IA

Con `GEMINI_API_KEY` configurada (sección 15), cada alerta nueva recibe automáticamente
un triage corto de Gemini (causa probable + primera acción, usando el playbook del tipo
como contexto) que aparece junto a la alerta en **Logs Regex**. Los reportes ejecutivos
también incluyen un resumen en lenguaje natural para gerencia. Sin la API key configurada,
todo funciona igual pero sin estas dos cosas — nunca bloquea ni demora la alerta en sí.

## 24. Análisis de logs de Windows y búsqueda en lenguaje natural

Desde el detalle de cada servidor (Monitoreo → clic en un nodo), el botón **🤖 Analizar con
IA** resume los errores recientes del Visor de Eventos que el agente ya manda. En **Logs
Regex**, el campo "🤖 Buscar con IA" permite preguntar en lenguaje natural sobre las alertas
cargadas (ej. "problemas de backup de Kansas este mes") en vez de armar una regex. Ambos
requieren la API key de Gemini.

## 25. Detección de anomalías estadística

Corre sola, sin configuración: cada hora recalcula un baseline (media + desvío estándar)
por servidor, métrica y hora del día sobre los últimos 14 días, y compara la telemetría
nueva contra ESE patrón — detecta picos raros para un servidor puntual aunque no crucen
ningún umbral fijo (ej. un pico de red a las 3am en un sitio que normalmente no tiene
tráfico a esa hora). Necesita al menos ~20 muestras por hora antes de generar su primer
baseline (unos días de historial real). Estado visible en **Admin → Reportes**.

## 26. Synthetic monitoring (chequeo de red activo)

Opt-in por servidor: en **Admin → Servidores → Configurar → Info del sitio**, definí un
puerto TCP (ej. 3389 para RDP) y el backend intenta conectarse cada 2 minutos. Distingue
"el agente se colgó pero la red está bien" de "el sitio entero perdió conectividad" —
relevante con 2 conexiones de internet dedicadas por sitio. Dos fallos seguidos disparan
una alerta `NETWORK_UNREACHABLE` (CRITICAL si el heartbeat también lo tiene OFFLINE).

## 27. Digest proactivo

Corre cada 6 horas: si un mismo servidor acumula 3 o más alertas en las últimas 24hs, manda
una notificación por los canales configurados (sección 9) señalando el patrón — con una nota
redactada por Gemini si está configurado, o un texto genérico si no. No hace falta abrir el
dashboard para enterarse de un problema recurrente.

## 28. Lectura de capturas de Fortinet por visión (Gemini)

Para los sitios sin API key ni syslog de Fortinet configurado todavía: en **Admin →
Fortinet → Analizar captura de pantalla**, subí un screenshot del panel del FortiGate y
Gemini extrae los eventos visibles (tipo, severidad, descripción, IPs). Nunca se ingesta
nada automáticamente — se revisan y confirman los eventos antes de cargarlos.

## 29. Notificaciones por Telegram

Canal adicional en **Admin → Configuración → Notificaciones externas**: creá un bot gratis
con [@BotFather](https://t.me/BotFather) (sin proceso de aprobación, a diferencia de
WhatsApp Business que requiere cuenta Meta verificada), agregalo al grupo/chat a notificar,
y cargá el token + chat ID.

## 30. Mapa geográfico y mini-CMDB por sitio

Nueva pestaña **Mapa**: muestra cada sucursal en un mapa real (OpenStreetMap) con un
marcador coloreado según su salud. Requiere cargar latitud/longitud por servidor en
**Admin → Servidores → Configurar → Info del sitio**, junto con datos operativos opcionales
(ISP primario/secundario y su contacto, contacto del sitio, si tiene Fortinet propio,
notas) — información que hoy solo vive en la cabeza de alguien.

## 31. Modo Guardia y exportar reportes a CSV

Nueva pestaña **Guardia**: vista simplificada pensada para el celular de quien está de
guardia a la noche — solo alertas CRITICAL/HIGH abiertas, servidores caídos y backups
fallidos, en texto grande. Además, **Admin → Reportes** ahora tiene un botón "Exportar CSV"
junto al PDF, para quien prefiera abrir los números en Excel.

## 32. Pestaña Backups (tamaño y detalle real por servidor)

Nueva pestaña **Backups**: vista dedicada con el estado de backup de los 21 servidores en
un solo lugar — tamaño total respaldado en la flota, tasa de éxito, resultado/método/última
corrida/antigüedad/tamaño/estado de VSS por servidor, filtrable por resultado, y con un
historial expandible (últimas 15 corridas) por servidor con un clic.

El tamaño real (`sizeBytes`) y la ruta de destino (`targetPath`) del backup son nuevos:
antes el agente nunca los completaba (siempre quedaban `null`). El agente (a partir de
`AGENT_VERSION = "1.2.0"`) ahora:

- Lee `LastBackupTargetPath` del WMI de Windows Server Backup cuando ese método está
  disponible, o extrae la ruta con una expresión regular agnóstica al idioma de la salida
  de `wbadmin get versions` (busca un patrón de ruta UNC o de unidad, no el texto de la
  etiqueta que sí está localizado).
- Con esa ruta, suma el tamaño de los archivos del backup (`os.walk` + `os.path.getsize`)
  como aproximación honesta al tamaño real — best-effort, con límite de 20.000 archivos y
  25 segundos para no colgarse en un recurso de red lento, y solo cuando el último
  resultado fue `SUCCESS`.

**Nota honesta:** ni `wbadmin` ni el WMI de Windows Server Backup exponen la *duración* de
la corrida del backup (solo la hora de finalización) — no es algo que Windows guarde de
forma nativa, así que no se inventó ese dato. El historial expandible de cada servidor
(hora, resultado, tamaño, método de cada corrida reciente) es la señal más honesta
disponible para ver la frecuencia y consistencia de los backups sin fabricar un número.

Para que el tamaño/ruta empiecen a aparecer hace falta republicar el agente (sección 16) y
que cada servidor lo actualice solo en su próximo ciclo (no hace falta reinstalar con
`install-agent.ps1` a mano, siempre que `AGENT_LATEST_VERSION` esté seteado en Admin →
Configuración).

## 33. Actualizar la VPS de producción (un solo comando)

`deploy/vps-update.sh` aplica todo lo pendiente en la VPS y se puede correr las veces que
haga falta (cada paso detecta si ya está hecho, y si uno falla sigue con los demás):

```bash
cd /home/socapp/enterprise-soc && git pull && bash deploy/vps-update.sh
```

1. Reconstruye y reinicia backend + frontend, y espera a que el backend responda.
2. Agrega `location /downloads/` al Nginx si falta (con backup y rollback automático si
   `nginx -t` falla). Sin eso, la descarga del `.exe` — que usan `install-agent.ps1` y la
   auto-actualización de los agentes — cae en el frontend y da 404.
3. Baja el `.exe` de la Release `agent-latest`, verifica que sea la misma versión que
   `AGENT_VERSION` de `agent/agent.py`, lo publica en el backend, comprueba la descarga
   de punta a punta vía Nginx, y recién ahí marca `AGENT_LATEST_VERSION` para que los
   agentes se actualicen solos. Necesita el repo **público** en ese momento; si está
   privado, este paso se saltea con un aviso.
4. Instala el auto-monitoreo del VPS (sección 19) si todavía no estaba.

Al final muestra un resumen OK / FALLO / SALTEADO por paso.

## 34. Alertas sin duplicados, monitoreo preventivo, red/internet y UniFi

**Alertas deduplicadas.** Una misma condición (mismo servidor + mismo motivo)
genera UNA alerta: mientras siga activa se actualiza (contador `×N` y "última
vez"), sin volver a notificar salvo que empeore la severidad. Cuando se
normaliza se cierra sola ("Auto-resuelta"); si reaparece en menos de 30 min
se reabre la misma. La migración de esta versión consolida las alertas
repetidas que ya existían (se conserva una por condición, con el total de
repeticiones) y borra las filas repetidas del historial de backups.

**Historial de backups.** Una fila por corrida real, no por chequeo. Con el
agente 1.3.0 se lee además el Visor de Eventos (Microsoft-Windows-Backup):
duración de cada backup, corridas fallidas y la lista de copias restaurables.
En la pestaña Backups el historial muestra por defecto solo los exitosos.

**Agente 1.3.0 (se actualiza solo).** Cada 5 min manda: todas las unidades,
salud física de discos (SMART/Storage), reinicio pendiente, fecha del último
parche y actualizaciones pendientes, servicios automáticos detenidos,
Microsoft Defender, señales del Visor de Eventos de las últimas 24 h (errores
de disco, apagados inesperados, pantallazos azules, memoria agotada, logins
fallidos, malware) y top de procesos. Cada minuto mide internet desde el
sitio (latencia/pérdida a 1.1.1.1 y 8.8.8.8, DNS, gateway, IP pública) y, si
el sitio se queda sin internet, registra el corte y lo informa con su
duración al volver. El backend además pronostica cuándo se llena C:.

**Configurar (Admin):**
1. *Servidores → Configurar*: cargar la **IP pública del ISP primario y del
   secundario** de cada sitio. Con eso se detecta automáticamente cuándo una
   sucursal está saliendo por el enlace de respaldo (alerta `ISP_FAILOVER`).
2. *Configuración → Ubiquiti UniFi*: modo **Nube (Site Manager)** + API key
   creada en https://unifi.ui.com → API. "Probar conexión" confirma cuántos
   dispositivos ve. Modo **Local** solo si la VPS llega a la consola.
3. *Configuración → Monitoreo preventivo* (opcional): lista de servicios
   críticos (por defecto SQL Server, IIS, VSS, etc.) y días máximos sin parches.
4. Opcional en `.env`: `APP_TIMEZONE=America/Asuncion` (o la que corresponda)
   para las fechas dentro de los textos de alertas.

## 35. Inventario de red (PCs, usuarios del AD, impresoras, IPs) y monitores de servicios

**Quién recolecta.** El agente 1.4.0 detecta solo si el servidor tiene los
roles de Active Directory (servicio NTDS) o DHCP (servicio DHCPServer) —en
Grupo Bistro, **BSFS2**— y ahí corre cada 5 minutos, en un hilo aparte:

- **DHCP:** ámbitos, concesiones, reservas y exclusiones (`Get-DhcpServerv4*`).
- **Barrido de IPs:** la subred completa de cada ámbito (ping + puertos 445,
  135, 3389, 9100, 80, 443 y 22; un "conexión rechazada" también cuenta como
  equipo presente). Con eso arma el mapa: concedida / reservada / IP fija en
  uso / conflicto / **libre en el rango DHCP** / **libre para IP fija**.
- **Equipos del AD** (`Get-ADComputer`), cruzados con el DHCP para tener
  IP, MAC y si están encendidos.
- **Usuario de cada PC:** el DC registra un evento 4768 (ticket de Kerberos)
  cada vez que alguien inicia sesión en un equipo, con usuario e IP. Se
  muestra como "último usuario que inició sesión" (con historial).
- **Usuarios del AD:** bloqueados, vencimiento de contraseña, último logon.
- **Auditoría del AD:** bloqueos (4740), altas/bajas de usuarios, reseteos
  de contraseña y cambios de grupos. Además cuenta los fallos de contraseña
  (4771/4625) para detectar ataques de fuerza bruta.
- **Impresoras:** por SNMP (Printer-MIB estándar) en todas las IPs activas y
  en las colas del servidor de impresión: estado, errores (atasco, sin
  papel, tapa abierta…), nivel de tóner/consumibles, contador y serie.

**Alertas nuevas:** ámbito DHCP ≥ 85 % (crítica ≥ 95 %), conflicto de IP,
impresora con problemas (tóner ≤ 10 % como aviso bajo), cuenta bloqueada
(se cierra sola al desbloquearse), fuerza bruta (≥ 15 fallos de un usuario
en 5 min) y **alta en un grupo privilegiado** (Domain Admins, etc.: crítica).

**Opcional en BSFS2**: agregar al final de
`C:\Program Files\EnterpriseSOC\Agent\.env` y reiniciar la tarea:

```
# Subredes sin DHCP que también se quieren barrer (servidores, cámaras…)
INVENTORY_EXTRA_SUBNETS=192.168.110.0/24
# Si las impresoras usan otra comunidad SNMP de solo lectura
SNMP_COMMUNITY=public
```

Probar a mano (PowerShell como administrador, en la carpeta del agente):
`.\enterprise-soc-agent.exe --inventory` muestra el resumen y lo envía.

**Monitores de servicios** (pestaña Red e Internet): chequeos HTTP(S) o
TCP desde la VPS a los sistemas del negocio (punto de venta en la nube,
facturación, web, VPN). Uptime 24 h / 7 d / 30 d, latencia, historial, aviso
de caída (confirmada con 2 fallos) y de vencimiento del certificado SSL
(30, 14 y 3 días antes).

## 36. Instalar el agente en un servidor nuevo con un solo comando

`vps-update.sh` publica el instalador en `/downloads/install-agent.ps1`. En el
servidor Windows, en **PowerShell como Administrador**:

```powershell
$noc='http://203.161.39.123'; $s="$env:TEMP\install-agent.ps1"; Invoke-WebRequest "$noc/downloads/install-agent.ps1" -OutFile $s -UseBasicParsing; Unblock-File $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s -BackendUrl $noc -EnrollmentSecret 'EL_SECRETO'
```

Descarga el instalador y la última versión del agente desde el NOC, registra
el servidor (auto-enrolamiento), escribe la configuración y deja el agente
corriendo como SYSTEM con arranque automático. Repetirlo en el mismo servidor
lo reinstala/actualiza sin duplicarlo.

## 37. Backups por tipo de servidor, falsos positivos de disco y VPS 24/7

**Backups.** Solo en los servidores cuyo nombre empieza con `ALOHA` / `ALLOHA`
se leen todos los métodos (scripts en tareas programadas, SQL, Historial de
archivos, software de terceros). En el resto solo cuenta Windows Server Backup /
Copias de seguridad de Windows. La VPS (`grupo-bistro-noc-soc-2026-vps`, y todo
equipo con etiqueta `infra-vps`) no se tiene en cuenta para backups; solo se
monitorean su estado, sus recursos y su seguridad. Los prefijos y las
exclusiones se cambian en Admin → Configuración → Monitoreo preventivo.

**VSS.** El servicio de instantáneas es de inicio manual y Windows lo detiene
solo cuando no lo usa. Ya no cuenta como problema; solo si está
**deshabilitado**.

**Disco.** La alerta del Visor de Eventos ahora cuenta únicamente sectores
defectuosos, fallas predichas por el propio disco y corrupción NTFS en discos
**internos** (agente 1.6.0). Se descartan los discos USB y los
reintentos/timeouts de E/S, que eran la causa de los falsos positivos. Para
alertar hacen falta al menos 3 eventos, vistos en 2 diagnósticos seguidos. Las
alertas viejas se cierran solas en el siguiente diagnóstico de cada servidor.

**VPS.** `vps-update.sh` ejecuta primero `deploy/tune-vps.sh`, que:
- mide los núcleos y la RAM y genera `docker-compose.override.yml`:
  - Postgres: shared_buffers, cache, workers paralelos y /dev/shm;
  - Node: heap del backend y del frontend;
  - pool de conexiones.
- ajusta el kernel (sysctl);
- crea una swap de emergencia si falta;
- limita journald a 500 MB;
- ajusta Nginx (gzip, 4096 conexiones por worker);
- activa `soc-autoheal.timer`, que cada 2 minutos reinicia cualquier
  contenedor *unhealthy* y limpia imágenes viejas si el disco pasa del 85 %.

Además:
- los contenedores tienen healthchecks y logs con tope;
- el backend cachea la validación de las API keys de los agentes (antes
  ejecutaba bcrypt en cada latido);
- `/health` informa la demora del event loop y la memoria.

Comprobación:

    docker compose ps                  # todos "healthy"
    curl -s http://127.0.0.1:3000/health
    systemctl list-timers soc-autoheal.timer

## Checklist de seguridad antes de anunciar la URL

- [ ] `CORS_ORIGIN`, `NEXT_PUBLIC_API_URL` y `NEXT_PUBLIC_WS_URL` apuntan a tu dominio real
- [ ] `POSTGRES_PASSWORD`, `JWT_SECRET` y `AGENT_ENROLLMENT_SECRET` son nuevos, generados para producción
- [ ] Postgres, puerto 3000 y 3001 NO responden desde fuera del VPS (`ufw status`, y confirmá
      que `docker compose ps` muestra los puertos ligados a `127.0.0.1`, no a `0.0.0.0`)
- [ ] TLS activo (`https://`, candado verde, `wss://` en la consola del navegador)
- [ ] Contraseña del usuario ADMIN inicial guardada en un lugar seguro (no se puede recuperar)
- [ ] `NODE_ENV=production` en el backend (ya viene fijo en `docker-compose.yml`) — sin esto,
      la cookie de sesión no se marca `Secure` y el navegador la rechazaría igual bajo HTTPS
- [ ] Activaste el 2FA en la cuenta ADMIN inicial (Mi cuenta → Activar 2FA) y guardaste los
      códigos de respaldo en un lugar seguro
- [ ] Verificaste el estado de backup real de al menos un servidor Windows con
      `python agent.py --debug --once` antes de darlo por confiable (ver el manual, limitación
      de la detección de backups)
- [ ] Si vas a usar el receptor de syslog de Fortinet, revisaste la nota de `ufw`
      vs. Docker de la sección 13 antes de exponer el puerto UDP
- [ ] Si vas a usar el acceso remoto (sección 14), el equipo entiende que es la función de
      mayor privilegio del sistema y quién puede usarla (solo ADMIN)
- [ ] Instalaste `host-monitor.sh` + su timer de systemd (sección 19) — con 30GB de disco,
      es la única forma de enterarte si el propio VPS se está quedando sin espacio
- [ ] Revisaste que los valores de retención (sección 18) tengan sentido para tu disco; el
      default (30 días de telemetría) ya está pensado para 30GB pero conviene confirmarlo
      después de la primera semana real con los 21 servidores reportando
