#!/bin/bash
# wg-qr-import.sh - Scan WireGuard QR code and import to NetworkManager
# Part of wgEasyConf project

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[✓]${NC} $1" >&2; }
warn() { echo -e "${YELLOW}[!]${NC} $1" >&2; }
error() { echo -e "${RED}[✗]${NC} $1" >&2; }
info() { echo -e "${CYAN}[i]${NC} $1" >&2; }

check_deps() {
    local missing=()
    local packages=()

    if ! command -v zbarcam &>/dev/null; then
        missing+=("zbarcam")
        packages+=("zbar-tools")
    fi

    if ! command -v nmcli &>/dev/null; then
        missing+=("nmcli")
        packages+=("network-manager")
    fi

    if ! command -v wg &>/dev/null; then
        missing+=("wg")
        packages+=("wireguard-tools")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        error "Dependencias faltantes: ${missing[*]}"
        info "Instalando: ${packages[*]}..."
        sudo apt install -y "${packages[@]}" || {
            error "No se pudo instalar. Instala manualmente: sudo apt install ${packages[*]}"
            exit 1
        }
    fi
}

list_cameras() {
    local cameras=()
    for dev in /dev/video*; do
        [[ -e "$dev" ]] && cameras+=("$dev")
    done
    if [[ ${#cameras[@]} -eq 0 ]]; then
        error "No se encontraron cámaras web"
        exit 1
    fi
    echo "${cameras[@]}"
}

select_camera() {
    local cameras
    read -ra cameras <<< "$(list_cameras)"

    if [[ ${#cameras[@]} -eq 1 ]]; then
        echo "${cameras[0]}"
        return
    fi

    info "Cámaras disponibles:"
    for i in "${!cameras[@]}"; do
        echo "  $((i+1))) ${cameras[$i]}" >&2
    done

    local choice
    while true; do
        read -rp "Selecciona una cámara [1-${#cameras[@]}]: " choice
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#cameras[@]} )); then
            echo "${cameras[$((choice-1))]}"
            return
        fi
        error "Opción inválida"
    done
}

capture_qr() {
    local camera="$1"
    info "Escaneando QR desde $camera..."
    info "Apunta la cámara al código QR y mantén estable"

    local qr_text
    qr_text=$(timeout 30 zbarcam --raw -1 "$camera" 2>/dev/null) || {
        error "No se detectó QR o timeout alcanzado"
        return 1
    }

    if [[ -z "$qr_text" ]]; then
        error "Código QR vacío o inválido"
        return 1
    fi

    echo "$qr_text"
}

validate_wg_config() {
    local config="$1"
    echo "$config" | grep -q '\[Interface\]' || { error "Falta [Interface]"; return 1; }
    echo "$config" | grep -q 'PrivateKey' || { error "Falta PrivateKey"; return 1; }
    echo "$config" | grep -q '\[Peer\]' || { error "Falta [Peer]"; return 1; }
    echo "$config" | grep -q 'PublicKey' || { error "Falta PublicKey"; return 1; }
    return 0
}

parse_wg_config() {
    local config="$1"
    local current_section=""

    while IFS= read -r line; do
        line=$(echo "$line" | sed 's/#.*//' | xargs)
        [[ -z "$line" ]] && continue

        if [[ "$line" == "[Interface]" ]]; then current_section="interface"; continue; fi
        if [[ "$line" == "[Peer]" ]]; then current_section="peer"; continue; fi

        local key="${line%%=*}"
        local value="${line#*=}"

        case "$current_section.$key" in
            interface.PrivateKey) WG_PRIVATE_KEY="$value" ;;
            interface.Address)    WG_ADDRESS="$value" ;;
            interface.DNS)        WG_DNS="$value" ;;
            interface.ListenPort) WG_LISTEN_PORT="$value" ;;
            peer.PublicKey)       WG_PEER_PUBLIC_KEY="$value" ;;
            peer.Endpoint)        WG_ENDPOINT="$value" ;;
            peer.AllowedIPs)      WG_ALLOWED_IPS="$value" ;;
            peer.PresharedKey)    WG_PSK="$value" ;;
        esac
    done <<< "$config"
}

import_to_nm() {
    local con_name="$1"
    local config="$2"

    local tmpfile
    tmpfile=$(mktemp /tmp/wg-qr-XXXXXX.conf)
    echo "$config" > "$tmpfile"

    local import_output
    import_output=$(nmcli connection import type wireguard file "$tmpfile" 2>&1) || {
        rm -f "$tmpfile"
        error "Error al importar configuración a NetworkManager"
        return 1
    }

    local imported_name
    imported_name=$(echo "$import_output" | grep -oP '(?<=«)[^»]+')

    rm -f "$tmpfile"

    if [[ -z "$imported_name" ]]; then
        error "No se pudo determinar el nombre de la conexión importada"
        return 1
    fi

    if [[ "$imported_name" != "$con_name" ]]; then
        nmcli connection modify "$imported_name" connection.id "$con_name" &>/dev/null
        nmcli connection modify "$con_name" connection.interface-name "$con_name" &>/dev/null
    fi

    log "Conexión '$con_name' creada exitosamente"
    return 0
}

test_connection() {
    local con_name="$1"
    info "Activando conexión..."
    if nmcli connection up "$con_name" &>/dev/null; then
        log "Conexión activada"
        local first_ip
        first_ip=$(echo "$WG_ALLOWED_IPS" | cut -d',' -f1 | cut -d'/' -f1)
        if [[ -n "$first_ip" ]]; then
            info "Probando conectividad a $first_ip..."
            if ping -c 3 -W 5 "$first_ip" &>/dev/null; then
                log "Conexión verificada: $first_ip responde"
            else
                warn "No se pudo verificar conectividad (puede ser normal)"
            fi
        fi
    else
        error "Error al activar la conexión"
        return 1
    fi
}

show_status() {
    local con_name="$1"
    echo "" >&2
    info "Estado de la conexión:"
    { wg show "$con_name" 2>/dev/null || warn "No se pudo mostrar estado"; } >&2
    echo "" >&2
}

is_wifi_qr() {
    [[ "$1" =~ ^[Ww][Ii][Ff][Ii]: ]]
}

import_wifi() {
    local qr_text="$1"
    local ssid="" password="" type="WPA" hidden="no"
    local field key value

    IFS=';' read -ra fields <<< "$qr_text"
    for field in "${fields[@]}"; do
        [[ "$field" == *:* ]] || continue
        key="${field%%:*}"
        value="${field#*:}"
        case "${key^^}" in
            S) ssid="$value" ;;
            P) password="$value" ;;
            T) type="${value^^}" ;;
            H) hidden="${value,,}" ;;
        esac
    done

    if [[ -z "$ssid" ]]; then
        error "El QR WiFi no tiene SSID válido"
        return 1
    fi

    if nmcli connection show "$ssid" &>/dev/null; then
        warn "Ya existe una conexión con el nombre '$ssid'"
        read -rp "¿Sobrescribir? (s/N): " overwrite
        if [[ "$overwrite" =~ ^[sS]$ ]]; then
            nmcli connection delete "$ssid" &>/dev/null
            log "Conexión anterior eliminada"
        else
            info "Operación cancelada"
            return 1
        fi
    fi

    if [[ "$type" == "NOPASS" ]]; then
        nmcli connection add type wifi con-name "$ssid" ssid "$ssid" &>/dev/null || {
            error "Error al crear red abierta '$ssid'"
            return 1
        }
    else
        if [[ -z "$password" ]]; then
            error "El QR WiFi no tiene contraseña"
            return 1
        fi
        local keymgmt="wpa-psk"
        [[ "$type" == "WEP" ]] && keymgmt="wep"
        nmcli connection add type wifi con-name "$ssid" ssid "$ssid" \
            wifi-sec.key-mgmt "$keymgmt" wifi-sec.psk "$password" &>/dev/null || {
            error "Error al crear red '$ssid'"
            return 1
        }
    fi

    log "Red WiFi '$ssid' creada correctamente"
    return 0
}

main() {
    local CAMERA_OVERRIDE=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --camera)
                CAMERA_OVERRIDE="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    echo -e "${CYAN}═══════════════════════════════════════════${NC}" >&2
    echo -e "${CYAN}  WireGuard QR Scanner - wgEasyConf${NC}" >&2
    echo -e "${CYAN}═══════════════════════════════════════════${NC}" >&2
    echo "" >&2

    check_deps

    local camera
    if [[ -n "$CAMERA_OVERRIDE" ]]; then
        if [[ -e "$CAMERA_OVERRIDE" ]]; then
            camera="$CAMERA_OVERRIDE"
            log "Cámara configurada: $camera"
        else
            error "Cámara no encontrada: $CAMERA_OVERRIDE"
            exit 1
        fi
    else
        camera=$(select_camera)
        log "Cámara seleccionada: $camera"
    fi

    local qr_text
    qr_text=$(capture_qr "$camera") || exit 1
    log "QR capturado correctamente"

    if is_wifi_qr "$qr_text"; then
        log "QR de red WiFi detectado"
        import_wifi "$qr_text" || exit 1
        log "Proceso completado"
        info "La red WiFi está disponible en GNOME Settings → Red → Wi-Fi"
        exit 0
    fi

    validate_wg_config "$qr_text" || exit 1
    log "Configuración WireGuard válida"

    parse_wg_config "$qr_text"
    log "Configuración parseada"

    echo "" >&2
    info "Configuración detectada:"
    [[ -n "${WG_ADDRESS:-}" ]] && echo "  Address: $WG_ADDRESS" >&2
    [[ -n "${WG_DNS:-}" ]] && echo "  DNS: $WG_DNS" >&2
    [[ -n "${WG_ENDPOINT:-}" ]] && echo "  Endpoint: $WG_ENDPOINT" >&2
    [[ -n "${WG_ALLOWED_IPS:-}" ]] && echo "  Allowed IPs: $WG_ALLOWED_IPS" >&2
    echo "" >&2

    local con_name
    while true; do
        read -rp "Nombre de la conexión: " con_name
        con_name=$(echo "$con_name" | xargs)
        [[ -n "$con_name" ]] && break
        error "El nombre no puede estar vacío"
    done

    if nmcli connection show "$con_name" &>/dev/null; then
        warn "Ya existe una conexión con el nombre '$con_name'"
        read -rp "¿Sobrescribir? (s/N): " overwrite
        if [[ "$overwrite" =~ ^[sS]$ ]]; then
            nmcli connection delete "$con_name" &>/dev/null
            log "Conexión anterior eliminada"
        else
            info "Operación cancelada"
            exit 0
        fi
    fi

    import_to_nm "$con_name" "$qr_text" || exit 1
    test_connection "$con_name" || exit 1
    show_status "$con_name"

    echo "" >&2
    info "¿Qué deseas hacer?"
    echo "  1) Mantener conexión activa" >&2
    echo "  2) Desconectar" >&2
    echo "  3) Mantener y habilitar al inicio" >&2

    local choice
    read -rp "Selecciona [1-3]: " choice

    case "$choice" in
        1) log "Conexión '$con_name' mantenida activa" ;;
        2)
            nmcli connection down "$con_name" &>/dev/null
            log "Conexión '$con_name' desconectada"
            ;;
        3)
            sudo systemctl enable "wg-quick@${con_name}" 2>/dev/null || true
            log "Conexión '$con_name' habilitada al inicio"
            ;;
        *) warn "Opción inválida, manteniendo conexión activa" ;;
    esac

    echo "" >&2
    log "Proceso completado"
    info "La conexión '$con_name' está disponible en GNOME Settings → Network → VPN"
}

main "$@"
