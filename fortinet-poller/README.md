# Poller de eventos FortiGate (Opción 1: API)

Consulta los logs del FortiGate por su API REST cada cierto intervalo y los manda al SOC
(`POST /api/forti/events`). Corre **en la misma red que el FortiGate** (o con VPN hacia
ella) — su interfaz de management normalmente no es accesible desde internet.

Ver `fortinet_poller.py` (encabezado del archivo) para el detalle de qué hace y por qué.

## 1. En el FortiGate (una sola vez)

1. **System → Administrators → Create New → REST API Admin**.
2. Nombre (ej. `soc-poller`) y un perfil de **solo lectura** si tu FortiOS lo permite —
   el poller nunca escribe nada, solo lee logs.
3. Si la máquina donde vas a correr esto tiene IP fija, restringila en "Trusted Hosts".
4. Confirmá: FortiOS te muestra el **API Token una sola vez**. Copialo ahora.

## 2. En el SOC (una sola vez, por cada FortiGate)

**Admin → Fortinet → "+ Nuevo dispositivo"** → te da un `Device ID` y una `API Key`
(también se muestra una sola vez).

## 3. Correrlo

### Linux / mini-PC en la sucursal

```bash
sudo apt-get install -y python3-pip
git clone https://github.com/lahozfranciscoemiliano-arch/enterprise-soc.git
cd enterprise-soc/fortinet-poller
pip3 install -r requirements.txt
cp .env.example .env
nano .env   # completá FORTIGATE_HOST, FORTIGATE_API_TOKEN, FORTI_DEVICE_ID, FORTI_API_KEY
python3 fortinet_poller.py   # probalo en primer plano, Ctrl+C para cortar
```

Si arrancó bien vas a ver en la consola algo como:

```
fortinet_poller arrancando: FortiGate=192.168.10.1 vdom=root -> SOC=http://203.161.39.123
Endpoints a consultar: event/vpn, event/system, event/admin, event/ha, ips, virus, anomaly
Primer poll de event/vpn: 40 filas, arranco el watermark sin reenviar historico
...
```

Para dejarlo corriendo solo (systemd):

```bash
sudo mkdir -p /opt/fortinet-poller
sudo cp -r . /opt/fortinet-poller/
sudo cp fortinet-poller.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fortinet-poller
sudo systemctl status fortinet-poller
journalctl -u fortinet-poller -f   # logs en vivo
```

### Windows (una de las máquinas de esa sucursal)

```powershell
# 1. Instalar Python 3 (python.org) si no está.
# 2. Clonar o copiar esta carpeta, después:
pip install -r requirements.txt
copy .env.example .env
notepad .env   # completar los valores

# 3. Probar en primer plano:
python fortinet_poller.py

# 4. Para que quede corriendo solo, registralo como Tarea Programada
#    (mismo patron que agent/install-agent.ps1): disparador "al iniciar
#    el sistema", accion "python.exe" con argumento la ruta completa a
#    fortinet_poller.py, "Ejecutar tanto si el usuario inicio sesion como
#    si no". O usá NSSM para correrlo como servicio de Windows.
```

## 4. Verificar que llega

**Fortinet** en el dashboard debería empezar a mostrar eventos a los pocos minutos
(depende de que haya actividad real en el equipo — logins VPN, intentos de ataque, etc.).
Si no aparece nada:

- Revisá los logs del poller (`journalctl -u fortinet-poller -f` en Linux, o la consola en
  Windows) — cualquier error de conexión o 401 queda ahí.
- `FORTIGATE_VERIFY_TLS=false` es el default porque la mayoría de los FortiGate usan un
  certificado autofirmado en la interfaz de management. Si tenés un certificado real,
  poné `true`.
- El primer poll de cada endpoint nunca reenvía nada (solo establece el punto de partida)
  — es esperado, los eventos van a empezar a llegar desde el segundo ciclo en adelante.
- Si un endpoint da error 404/400 seguido, es que ese subtipo de log no existe en tu
  versión/modelo de FortiOS — sacalo de `FORTIGATE_LOG_ENDPOINTS` en el `.env` (separados
  por coma) y listo, el resto sigue funcionando igual.

## 5. Actualizar

Mismo comando que el resto del stack: `git pull` en esta carpeta y reiniciar el servicio
(`systemctl restart fortinet-poller` o relanzar la tarea programada en Windows).
