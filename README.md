# wgEasyConf

Herramienta para escanear códigos QR de redes **WiFi** y configuraciones **WireGuard**, e importarlas a NetworkManager en GNOME.

## Componentes

- **Extensión GNOME Shell** (`wgqr-scan@wgEasyConf/`) — Panel con botón para escanear QR, gestionar conexiones VPN y configurar la cámara
- **Script CLI** (`wg-qr-import.sh`) — Alternativa desde terminal con interfaz interactiva

## Requisitos

- GNOME Shell 45+
- NetworkManager con soporte WireGuard
- `zbar-tools` (`sudo apt install zbar-tools`)
- Cámara web compatible con V4L2

## Instalación

```bash
./install.sh
```

Reiniciar la sesión GNOME después de instalar.

## Uso

### Desde GNOME
Clic en el ícono del panel → **Escanear QR (WiFi/WireGuard)** → Apuntar cámara al código QR.

El escáner detecta automáticamente el tipo de QR:

- **Redes WiFi** (`WIFI:T:...;S:...;P:...;;`) — Crea y activa la conexión WiFi (WPA, WEP, abierta)
- **WireGuard** (`[Interface]`/`[Peer]`) — Importa la VPN y la activa

### Desde terminal
```bash
wg-qr-import.sh [--camera /dev/video0]
```

El script detecta y procesa ambos tipos de QR.

## Configuración

```bash
gnome-extensions prefs wgqr-scan@wgEasyConf
```

Permite seleccionar el dispositivo de cámara a utilizar.
