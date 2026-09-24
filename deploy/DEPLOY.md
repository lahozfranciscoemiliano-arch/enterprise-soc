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

El resto (SMTP/Slack/webhook, Fortinet, Claude, umbrales, etc.) es opcional acá — se puede
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
  key propia del dispositivo. Un script propio (corriendo en la misma red que el FortiGate,
  ya que su interfaz de management normalmente no es accesible desde internet) hace polling
  contra la API del FortiGate y reenvía los eventos relevantes con:
  ```bash
  curl -X POST https://noc.tudominio.com/api/forti/events \
    -H "X-Device-Id: <id del dispositivo>" -H "X-Api-Key: <api key>" \
    -H "Content-Type: application/json" \
    -d '{"type":"IPS_ATTACK","severity":"HIGH","description":"...","sourceIp":"1.2.3.4"}'
  ```
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

## 15. Asistente (Claude)

Botón flotante 🤖 en el dashboard, disponible para cualquier usuario logueado. Para
activarlo:

1. Creá una cuenta y una API key en [console.anthropic.com](https://console.anthropic.com)
   — **distinta de una suscripción Claude Pro de claude.ai**, que no da acceso a la API y
   no sirve para esto. Se factura por uso.
2. Cargala en Admin → Configuración → Asistente (Claude).

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
