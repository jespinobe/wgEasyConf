#!/bin/bash
# install.sh - Install wgEasyConf (WireGuard QR Scanner)
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo -e "${CYAN}  wgEasyConf - Instalador${NC}"
echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo ""

# 1. Install dependencies
info "Instalando dependencias..."
if command -v zbarcam &>/dev/null; then
    log "zbar-tools ya instalado"
else
    sudo apt install -y zbar-tools && log "zbar-tools instalado" || {
        error "Error al instalar zbar-tools"
        exit 1
    }
fi

# 2. Install backend script
info "Instalando script backend..."
sudo install -m 755 "$SCRIPT_DIR/wg-qr-import.sh" /usr/local/bin/wg-qr-import.sh
log "Script instalado en /usr/local/bin/wg-qr-import.sh"

# 3. Install GNOME Shell extension
info "Instalando extensión GNOME..."
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/wgqr-scan@wgEasyConf"
mkdir -p "$EXT_DIR"
cp "$SCRIPT_DIR/wgqr-scan@wgEasyConf/metadata.json" "$EXT_DIR/"
cp "$SCRIPT_DIR/wgqr-scan@wgEasyConf/extension.js" "$EXT_DIR/"
cp "$SCRIPT_DIR/wgqr-scan@wgEasyConf/prefs.js" "$EXT_DIR/"
cp "$SCRIPT_DIR/wgqr-scan@wgEasyConf/stylesheet.css" "$EXT_DIR/"

# Create and compile schemas
info "Compilando schemas..."
mkdir -p "$EXT_DIR/schemas"
cp "$SCRIPT_DIR/wgqr-scan@wgEasyConf/schemas/"*.xml "$EXT_DIR/schemas/"
glib-compile-schemas "$EXT_DIR/schemas/" && log "Schemas compilados" || {
    warn "Error al compilar schemas (las preferencias pueden no funcionar)"
}

# Create icons directory (optional, for custom icon)
mkdir -p "$EXT_DIR/icons"

log "Extensión instalada en $EXT_DIR"

# 4. Enable extension
info "Habilitando extensión..."
gnome-extensions enable wgqr-scan@wgEasyConf 2>/dev/null || true
log "Extensión habilitada"

# 5. Done
echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Instalación completada${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
info "Reinicia tu sesión GNOME para activar la extensión"
info "O ejecuta: gnome-extensions enable wgqr-scan@wgEasyConf"
echo ""
info "Uso desde terminal:"
info "  wg-qr-import.sh [--camera /dev/video0]"
echo ""
info "Uso desde GNOME:"
info "  Haz clic en el ícono del panel → Escanear QR WireGuard"
echo ""
info "Configuración:"
info "  gnome-extensions prefs wgqr-scan@wgEasyConf"
echo ""
