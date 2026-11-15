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

    local before after
    before=$(nmcli -t -f NAME connection show 2>/dev/null | sort || true)

    if ! nmcli connection import type wireguard file "$tmpfile" &>/dev/null; then
        rm -f "$tmpfile"
        error "Error al importar configuración a NetworkManager"
        return 1
    fi

    after=$(nmcli -t -f NAME connection show 2>/dev/null | sort || true)

    # Find the connection that appeared after the import instead of parsing
    # localized output (the «name» quoting changes with the locale).
    local imported_name
    imported_name=$(comm -13 <(echo "$before") <(echo "$after") | head -n1)
    imported_name=$(printf '%s' "$imported_name" | sed 's/\\\(.\)/\1/g')

    rm -f "$tmpfile"

    if [[ -z "$imported_name" ]]; then
        error "No se pudo determinar el nombre de la conexión importada"
        return 1
    fi

    if [[ "$imported_name" != "$con_name" ]]; then
        nmcli connection modify id "$imported_name" connection.id "$con_name" &>/dev/null
    fi

    log "Conexión '$con_name' creada exitosamente"
    return 0
}

test_connection() {
    local con_name="$1"
    info "Activando conexión..."
    if nmcli connection up id "$con_name" &>/dev/null; then
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
    [[ "${1^^}" == WIFI:* ]]
}

# Assign a parsed WIFI: field to the global variables.
_wifi_assign() {
    local key="${1^^}"
    local value="$2"

    case "$key" in
        S) SSID="$value" ;;
        P) PASSWORD="$value" ;;
        T) WIFI_TYPE="${value^^}" ;;
        H)
            if [[ "${value,,}" == "true" || "${value,,}" == "yes" || "$value" == "1" ]]; then
                WIFI_HIDDEN="yes"
            else
                WIFI_HIDDEN="no"
            fi
            ;;
    esac
}

# Parse a WIFI: QR payload honouring the standard \; \, \: \\ escapes.
# Sets SSID, PASSWORD, WIFI_TYPE and WIFI_HIDDEN.
parse_wifi_qr() {
    local payload="${1#*:}"
    local key="" value="" reading_key=1 escaped=0 i ch

    SSID="" PASSWORD="" WIFI_TYPE="WPA" WIFI_HIDDEN="no"

    for ((i = 0; i < ${#payload}; i++)); do
        ch="${payload:i:1}"
        if (( escaped )); then
            value+="$ch"
            escaped=0
        elif [[ "$ch" == '\' ]]; then
            escaped=1
        elif (( reading_key )); then
            case "$ch" in
                :) reading_key=0 ;;
                ';') key="" value="" ;;
                *) key+="$ch" ;;
            esac
        elif [[ "$ch" == ';' ]]; then
            [[ -n "$key" ]] && _wifi_assign "$key" "$value"
            key="" value="" reading_key=1
        else
            value+="$ch"
        fi
    done

    if [[ -n "$key" ]] && (( ! reading_key )); then
        _wifi_assign "$key" "$value"
    fi
}

import_wifi() {
    local qr_text="$1"

    parse_wifi_qr "$qr_text"

    if [[ -z "$SSID" ]]; then
        error "El QR WiFi no tiene SSID válido"
        return 1
    fi

    if nmcli connection show id "$SSID" &>/dev/null; then
        warn "Ya existe una conexión con el nombre '$SSID'"
        read -rp "¿Sobrescribir? (s/N): " overwrite
        if [[ "$overwrite" =~ ^[sS]$ ]]; then
            nmcli connection delete id "$SSID" &>/dev/null
            log "Conexión anterior eliminada"
        else
            info "Operación cancelada"
            return 1
        fi
    fi

    local add_args=(connection add type wifi con-name "$SSID" ssid "$SSID")

    [[ "$WIFI_HIDDEN" == "yes" ]] && add_args+=(wifi.hidden yes)

    if [[ "$WIFI_TYPE" != "NOPASS" ]]; then
        if [[ -z "$PASSWORD" ]]; then
            error "El QR WiFi no tiene contraseña"
            return 1
        fi

        if [[ "$WIFI_TYPE" == "WEP" ]]; then
            # WEP keys are 5/13 ASCII chars or 10/26 hex digits; anything
            # else is passed as a passphrase so NM can derive the key.
            local key_type=2
            if [[ "$PASSWORD" =~ ^([0-9a-fA-F]{10}|[0-9a-fA-F]{26}|[[:print:]]{5}|[[:print:]]{13})$ ]]; then
                key_type=1
            fi
            add_args+=(wifi-sec.key-mgmt wep
                wifi-sec.wep-key-type "$key_type"
                wifi-sec.wep-key0 "$PASSWORD")
        else
            add_args+=(wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PASSWORD")
        fi
    fi

    nmcli "${add_args[@]}" &>/dev/null || {
        error "Error al crear red '$SSID'"
        return 1
    }

    log "Red WiFi '$SSID' creada correctamente"

    if nmcli connection up id "$SSID" &>/dev/null; then
        log "Red WiFi '$SSID' activada"
    else
        warn "La red se creó, pero no se pudo activar (¿fuera de cobertura?)"
    fi

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

    if nmcli connection show id "$con_name" &>/dev/null; then
        warn "Ya existe una conexión con el nombre '$con_name'"
        read -rp "¿Sobrescribir? (s/N): " overwrite
        if [[ "$overwrite" =~ ^[sS]$ ]]; then
            nmcli connection delete id "$con_name" &>/dev/null
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
            nmcli connection down id "$con_name" &>/dev/null
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
