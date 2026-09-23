# Deploy de Enterprise SOC en un VPS (Ubuntu/Debian, ej. Donweb)

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

Las variables de notificaciones (SMTP/Slack/webhook) son opcionales — ver la sección 9.

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

## 9. Notificaciones externas (opcional)

En el `.env` de la raíz, completá cualquiera de estos antes de `docker compose up`
(o `docker compose up -d` de nuevo si ya estaba corriendo, para que tome los cambios):

- **Email:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `ALERT_EMAIL_TO`
- **Slack:** `SLACK_WEBHOOK_URL` (Incoming Webhook de Slack)
- **Webhook genérico:** `WEBHOOK_URL` (Teams, Discord, PagerDuty, tu propio sistema)

Solo se notifican alertas con severidad `HIGH` o `CRITICAL` (ajustable con
`NOTIFY_MIN_SEVERITY`).

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

## 11. Publicar el agente para descarga automática

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

## 12. Conectar servidores Windows al NOC

En cada servidor Windows a monitorear, como Administrador:

```powershell
.\install-agent.ps1 -BackendUrl "https://noc.tudominio.com" -EnrollmentSecret "<el AGENT_ENROLLMENT_SECRET del .env>"
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
      `python agent.py --debug --once` antes de darlo por confiable (ver sección 5, limitación
      de la detección de backups)
