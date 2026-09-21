# Deploy de Enterprise SOC en un VPS (Ubuntu/Debian, ej. Donweb)

Runbook paso a paso. Nada de esto se ejecuta solo — cada comando lo corres vos por SSH.

## 0. Antes de empezar

- El repo local (`enterprise-soc/`) hoy es **solo git local**, sin remoto. Subilo a un
  repositorio privado (GitHub/GitLab) antes de clonarlo en el VPS, o transferí la carpeta
  con `rsync`/`scp` si preferís no usar un remoto.
- Nunca reuses las credenciales de desarrollo (`.env` actuales) en producción. Generá
  nuevas con el mismo método que ya usamos localmente:
  ```bash
  # DATABASE_URL: cambiar el usuario/password de docker-compose.yml
  # JWT_SECRET / AGENT_ENROLLMENT_SECRET: generar con openssl
  openssl rand -hex 32
  ```

## 1. Provisionar el VPS (una sola vez)

```bash
scp deploy/setup-server.sh root@TU_IP:/root/
ssh root@TU_IP
sudo bash /root/setup-server.sh
```

Esto instala Node 20, Docker, Nginx, Certbot, crea el usuario `socapp` sin privilegios,
y configura `ufw` para que **solo** 22 (SSH) y 80/443 (Nginx) queden expuestos —
Postgres y los puertos 3000/3001 de la app nunca son accesibles directo desde internet.

## 2. Subir el código

```bash
su - socapp
git clone <url-de-tu-repo-privado> enterprise-soc
cd enterprise-soc
```

## 3. Configurar variables de entorno de producción

`backend/.env` (basado en `backend/.env.example`):
```bash
DATABASE_URL="postgresql://<usuario-fuerte>:<password-fuerte>@localhost:5432/nocsoc?schema=public"
JWT_SECRET="<generado con openssl rand -hex 32>"
JWT_EXPIRES_IN="8h"
CORS_ORIGIN="https://noc.tudominio.com"
PORT=3000
NODE_ENV=production
AGENT_ENROLLMENT_SECRET="<generado con openssl rand -hex 32>"
```

`fronted/.env.local` (basado en `fronted/.env.local.example`):
```bash
NEXT_PUBLIC_API_URL=https://noc.tudominio.com
NEXT_PUBLIC_WS_URL=wss://noc.tudominio.com/ws
```

## 4. Levantar PostgreSQL

```bash
cd backend
docker compose up -d
```

(Reusa el `docker-compose.yml` que ya tenés — solo asegurate de que las credenciales
del `.env` coincidan con las de ahí.)

## 5. Migraciones y seed inicial

```bash
npx prisma migrate deploy
npm run prisma:seed   # crea el primer usuario ADMIN
```

## 6. Servicios systemd

```bash
sudo cp deploy/enterprise-soc-backend.service /etc/systemd/system/
sudo cp deploy/enterprise-soc-frontend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable enterprise-soc-backend enterprise-soc-frontend
```

(El primer arranque real lo hace `deploy.sh` en el paso 8.)

## 7. Nginx + TLS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/enterprise-soc
sudo nano /etc/nginx/sites-available/enterprise-soc   # reemplazar noc.tudominio.com
sudo ln -s /etc/nginx/sites-available/enterprise-soc /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d noc.tudominio.com
```

Certbot reescribe el archivo agregando el bloque HTTPS y el redirect automático desde
HTTP. Se renueva solo (revisa `systemctl status certbot.timer`).

## 8. Primer deploy

```bash
cd ~/enterprise-soc
chmod +x deploy/*.sh
./deploy/deploy.sh
```

Esto instala dependencias, compila el frontend, aplica migraciones pendientes, y
arranca ambos servicios. A partir de acá, `https://noc.tudominio.com` debería servir
el dashboard.

## 9. Deploys posteriores

```bash
./deploy/deploy.sh              # actualiza a lo último de la rama actual
./deploy/deploy.sh v1.2.0       # o a un tag/commit específico
```

## 10. Rollback

```bash
./deploy/rollback.sh <commit-o-tag-anterior>
```

**Ojo:** esto revierte el código, no las migraciones de base de datos — ver el
comentario al principio de `rollback.sh`.

## 11. Conectar servidores Windows al NOC

Con el backend ya en producción, en cada servidor Windows:

```powershell
.\install-agent.ps1 -BackendUrl "https://noc.tudominio.com" -EnrollmentSecret "<el AGENT_ENROLLMENT_SECRET de arriba>"
```

Ver `agent/install-agent.ps1` — requiere PowerShell como Administrador (necesario para
que la tarea programada corra como SYSTEM, con permisos para leer el estado real de
backups).

## Checklist de seguridad antes de anunciar la URL

- [ ] `CORS_ORIGIN` apunta solo a tu dominio real, no a `*` ni a localhost
- [ ] `JWT_SECRET` y `AGENT_ENROLLMENT_SECRET` son nuevos, generados para producción
- [ ] Postgres, puerto 3000 y 3001 NO responden desde fuera del VPS (`ufw status`)
- [ ] TLS activo (`https://`, candado verde, `wss://` en la consola del navegador)
- [ ] Contraseña del usuario ADMIN inicial cambiada del valor del seed
- [ ] Ver la sección de gaps de seguridad conocidos de la conversación (RBAC ya
      aplicado a rutas admin; sigue faltando 2FA, rotación/revocación de JWT y audit log)
