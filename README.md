# wgEasyConf

Herramienta para escanear códigos QR de WireGuard e importar configuraciones VPN a NetworkManager en GNOME.

## Componentes

- **Extensión GNOME Shell** (`wgqr-scan@wgEasyConf/`) — Panel con botón para escanear QR, gestionar conexiones y configurar la cámara
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
Clic en el ícono del panel → **Escanear QR WireGuard** → Apuntar cámara al código QR.

### Desde terminal
```bash
wg-qr-import.sh [--camera /dev/video0]
```

## Configuración

```bash
gnome-extensions prefs wgqr-scan@wgEasyConf
```

Permite seleccionar el dispositivo de cámara a utilizar.
