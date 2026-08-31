'use strict';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

class WgQrScanIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(extension) {
        super(0.5, 'WireGuard QR Scanner', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._scanning = false;

        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        this._icon = new St.Icon({
            icon_name: 'network-vpn-disconnected-symbolic',
            style_class: 'system-status-icon',
        });

        box.add_child(this._icon);
        this.add_child(box);

        this._buildMenu();

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) this._updateIcon();
        });
    }

    _buildMenu() {
        this._scanItem = new PopupMenu.PopupMenuItem(_('Escanear QR (WiFi/WireGuard)'));
        const scanIcon = new St.Icon({
            icon_name: 'scanner-symbolic',
            style_class: 'popup-menu-icon',
        });
        this._scanItem.insert_child_at_index(scanIcon, 0);
        this._scanItem.connect('activate', () => this._scanQR());
        this.menu.addMenuItem(this._scanItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._connectionsSection = new PopupMenu.PopupMenuSection(_('Conexiones'));
        this.menu.addMenuItem(this._connectionsSection);
        this._refreshConnections();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferencias...'));
        const prefsIcon = new St.Icon({
            icon_name: 'preferences-system-symbolic',
            style_class: 'popup-menu-icon',
        });
        prefsItem.insert_child_at_index(prefsIcon, 0);
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);

        const aboutItem = new PopupMenu.PopupMenuItem(_('Acerca de wgEasyConf'));
        const aboutIcon = new St.Icon({
            icon_name: 'help-about-symbolic',
            style_class: 'popup-menu-icon',
        });
        aboutItem.insert_child_at_index(aboutIcon, 0);
        aboutItem.connect('activate', () => this._showAboutDialog());
        this.menu.addMenuItem(aboutItem);
    }

    _refreshConnections() {
        this._connectionsSection.removeAll();

        try {
            const [ok, output] = GLib.spawn_command_line_sync(
                'nmcli -t -f NAME,TYPE,ACTIVE connection show'
            );

            if (ok) {
                const lines = output.toString().trim().split('\n');
                let wgFound = false;
                let wifiFound = false;

                for (const line of lines) {
                    const parts = line.split(':');
                    const name = parts[0];
                    const type = parts[1];
                    const active = parts[2];

                    if (type === 'wireguard') {
                        wgFound = true;
                        const statusIcon = active === 'yes' ? '✅ ' : '❌ ';
                        const subMenu = new PopupMenu.PopupSubMenuMenuItem(`${statusIcon}${name}`);

                        const toggleLabel = active === 'yes' ? _('Desconectar') : _('Conectar');
                        const toggleItem = new PopupMenu.PopupMenuItem(toggleLabel);
                        toggleItem.connect('activate', () => this._toggleConnection(name));
                        subMenu.menu.addMenuItem(toggleItem);

                        const deleteItem = new PopupMenu.PopupMenuItem(_('Eliminar...'));
                        deleteItem.connect('activate', () => this._deleteConnection(name));
                        subMenu.menu.addMenuItem(deleteItem);

                        this._connectionsSection.addMenuItem(subMenu);
                    }
                }

                if (!wgFound) {
                    const noConn = new PopupMenu.PopupMenuItem(_('No hay conexiones WireGuard'));
                    noConn.setSensitive(false);
                    this._connectionsSection.addMenuItem(noConn);
                }
            }
        } catch (e) {
            console.error(`wgEasyConf: Error listing connections: ${e.message}`);
            const errorItem = new PopupMenu.PopupMenuItem(_('Error al listar conexiones'));
            errorItem.setSensitive(false);
            this._connectionsSection.addMenuItem(errorItem);
        }
    }

    _updateIcon() {
        try {
            const [ok, output] = GLib.spawn_command_line_sync(
                'nmcli -t -f NAME,TYPE,ACTIVE connection show --active'
            );

            if (ok) {
                const lines = output.toString().trim().split('\n');
                const hasActiveWg = lines.some(line => {
                    const parts = line.split(':');
                    return parts[1] === 'wireguard' && parts[2] === 'yes';
                });

                this._icon.icon_name = hasActiveWg
                    ? 'network-vpn-symbolic'
                    : 'network-vpn-disconnected-symbolic';
            }
        } catch (e) {
            console.error(`wgEasyConf: Error updating icon: ${e.message}`);
        }
    }

    _scanQR() {
        if (this._scanning) {
            Main.notify('wgEasyConf', _('Ya hay un escaneo en curso...'));
            return;
        }

        const zbarcamPath = GLib.find_program_in_path('zbarcam');
        if (!zbarcamPath) {
            Main.notifyError('wgEasyConf', _('zbarcam no encontrado. Instala: sudo apt install zbar-tools'));
            return;
        }

        this._scanning = true;
        this._scanItem.label.set_text(_('Escaneando...'));

        const camera = this._settings.get_string('camera-device') || '/dev/video0';

        try {
            const proc = Gio.Subprocess.new(
                [zbarcamPath, '--raw', '-1', camera],
                Gio.SubprocessFlags.STDOUT_PIPE
            );

            const decoder = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
            let qrData = '';

            const readLine = () => {
                decoder.read_line_async(GLib.PRIORITY_DEFAULT, null, (_stream, result) => {
                    try {
                        const [line, length] = _stream.read_line_finish(result);
                        if (length > 0) {
                            qrData += line.toString() + '\n';
                            readLine();
                        } else {
                            if (this._scanning) {
                                this._scanning = false;
                                this._scanItem.label.set_text(_('Escanear QR (WiFi/WireGuard)'));
                                if (qrData.trim().length > 0) {
                                    this._processQR(qrData.trim());
                                } else {
                                    Main.notifyError('wgEasyConf', _('No se detectó código QR'));
                                }
                            }
                        }
                    } catch (e) {
                        if (this._scanning) {
                            this._scanning = false;
                            this._scanItem.label.set_text(_('Escanear QR (WiFi/WireGuard)'));
                            if (qrData.trim().length > 0) {
                                this._processQR(qrData.trim());
                            } else {
                                Main.notifyError('wgEasyConf', _('No se detectó código QR'));
                            }
                        }
                    }
                });
            };
            readLine();

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30000, () => {
                if (this._scanning) {
                    try { proc.force_exit(); } catch (_e) { /* process already exited */ }
                    this._scanning = false;
                    this._scanItem.label.set_text(_('Escanear QR (WiFi/WireGuard)'));
                    Main.notifyError('wgEasyConf', _('Timeout: no se detectó QR'));
                }
                return GLib.SOURCE_REMOVE;
            });

        } catch (e) {
            console.error(`wgEasyConf: Failed to start zbarcam: ${e.message}`);
            Main.notifyError('wgEasyConf', `Error al iniciar zbarcam: ${e.message}`);
            this._scanning = false;
            this._scanItem.label.set_text(_('Escanear QR (WiFi/WireGuard)'));
        }
    }

    _processQR(qrText) {
        if (!qrText || qrText.length === 0) {
            Main.notifyError('wgEasyConf', _('No se detectó código QR'));
            return;
        }

        if (qrText.toUpperCase().startsWith('WIFI:')) {
            this._processWifiQR(qrText);
            return;
        }

        if (!qrText.includes('[Interface')) {
            Main.notifyError('wgEasyConf', _('QR no reconocido. Soporta WiFi y WireGuard.'));
            return;
        }

        if (!qrText.includes('PrivateKey')) {
            Main.notifyError('wgEasyConf', _('Falta la clave privada en la configuración'));
            return;
        }

        const endpointMatch = qrText.match(/Endpoint\s*=\s*(.+)/);
        const defaultName = endpointMatch
            ? endpointMatch[1].split(':')[0].split('.')[0]
            : 'wg-qr';

        const [existsOk, existsOutput] = GLib.spawn_command_line_sync(
            `nmcli -t -f NAME connection show | grep -q "^${defaultName}$" && echo "yes" || echo "no"`
        );

        let conName = defaultName;
        if (existsOutput.toString().trim() === 'yes') {
            conName = `${defaultName}-${Math.floor(Date.now() / 1000)}`;
        }

        const tmpFile = Gio.File.new_for_path(`/tmp/wg-qr-${conName}.conf`);
        tmpFile.replace_contents(qrText, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        const [importOk, importOutput] = GLib.spawn_command_line_sync(
            `nmcli connection import type wireguard file ${tmpFile.get_path()}`
        );

        tmpFile.delete(null);

        if (!importOk) {
            Main.notifyError('wgEasyConf', _('Error al importar a NetworkManager'));
            return;
        }

        const importedName = importOutput.toString().match(/«(.+)»/)?.[1];
        if (importedName && importedName !== conName) {
            GLib.spawn_command_line_sync(`nmcli connection modify "${importedName}" connection.id "${conName}"`);
            GLib.spawn_command_line_sync(`nmcli connection modify "${conName}" connection.interface-name "${conName}"`);
        }

        GLib.spawn_command_line_async(`nmcli connection up "${conName}"`);

        Main.notify('wgEasyConf', `VPN conectada: ${conName}`);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._updateIcon();
            this._refreshConnections();
            return GLib.SOURCE_REMOVE;
        });
    }

    _processWifiQR(qrText) {
        // WIFI:T:<WPA|WEP|nopass>;S:<ssid>;P:<password>;H:<hidden>;;
        const params = {};
        const re = /([STPH]):([^;]*)/g;
        let m;
        while ((m = re.exec(qrText)) !== null) {
            params[m[1]] = m[2];
        }

        const ssid = params['S'] || '';
        if (!ssid) {
            Main.notifyError('wgEasyConf', _('El QR WiFi no tiene SSID válido'));
            return;
        }

        // Check if connection already exists
        const [existsOk, existsOutput] = GLib.spawn_command_line_sync(
            `nmcli -t -f NAME connection show | grep -qi "^${ssid}$" && echo "yes" || echo "no"`
        );

        if (existsOutput.toString().trim() === 'yes') {
            Main.notify('wgEasyConf', `La red "${ssid}" ya está configurada`);
            this._activateConnection(ssid);
            return;
        }

        const type = (params['T'] || 'WPA').toUpperCase();
        const isOpen = type === 'NOPASS';

        let cmd;
        if (isOpen) {
            cmd = `nmcli connection add type wifi con-name "${ssid}" ssid "${ssid}"`;
        } else {
            const keyMgmt = type === 'WEP' ? 'wep' : 'wpa-psk';
            const password = params['P'] || '';
            if (!password) {
                Main.notifyError('wgEasyConf', _('El QR WiFi no tiene contraseña'));
                return;
            }
            cmd = `nmcli connection add type wifi con-name "${ssid}" ssid "${ssid}" ` +
                  `wifi-sec.key-mgmt ${keyMgmt} wifi-sec.psk "${password}"`;
        }

        const [importOk, importOutput] = GLib.spawn_command_line_sync(cmd);

        if (!importOk) {
            Main.notifyError('wgEasyConf', `Error al agregar red WiFi: ${importOutput}`);
            return;
        }

        this._activateConnection(ssid);
    }

    _activateConnection(name) {
        GLib.spawn_command_line_async(`nmcli connection up "${name}"`);
        Main.notify('wgEasyConf', `Conectando: ${name}`);
    }

    _toggleConnection(name) {
        try {
            const [ok, output] = GLib.spawn_command_line_sync(
                'nmcli -t -f NAME,ACTIVE connection show --active'
            );

            if (ok) {
                const lines = output.toString().trim().split('\n');
                const isActive = lines.some(line => {
                    const [n] = line.split(':');
                    return n === name;
                });

                if (isActive) {
                    GLib.spawn_command_line_async(`nmcli connection down "${name}"`);
                    Main.notify('wgEasyConf', `Desconectado: ${name}`);
                } else {
                    GLib.spawn_command_line_async(`nmcli connection up "${name}"`);
                    Main.notify('wgEasyConf', `Conectado: ${name}`);
                }
            }
        } catch (e) {
            console.error(`wgEasyConf: Error toggling connection: ${e.message}`);
            Main.notifyError('wgEasyConf', `Error: ${e.message}`);
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._updateIcon();
            this._refreshConnections();
            return GLib.SOURCE_REMOVE;
        });
    }

    _deleteConnection(name) {
        const dialog = new ModalDialog.ModalDialog({
            styleClass: 'wg-easy-conf-dialog',
        });

        const contentBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style: 'padding: 24px;',
        });

        const warningLabel = new St.Label({
            text: _('¿Eliminar la conexión WireGuard?'),
            style: 'font-size: 18px; font-weight: bold; text-align: center;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(warningLabel);

        const nameLabel = new St.Label({
            text: name,
            style: 'font-size: 14px; text-align: center; margin-top: 8px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(nameLabel);

        const descLabel = new St.Label({
            text: _('Esta acción no se puede deshacer.\nLa configuración se eliminará permanentemente.'),
            style: 'font-size: 12px; text-align: center; margin-top: 16px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(descLabel);

        dialog.contentLayout.add_child(contentBox);

        dialog.setButtons([
            {
                label: _('Cancelar'),
                action: () => dialog.destroy(),
            },
            {
                label: _('Eliminar'),
                action: () => {
                    try {
                        GLib.spawn_command_line_sync(`nmcli connection delete "${name}"`);
                        Main.notify('wgEasyConf', `Conexión eliminada: ${name}`);
                    } catch (e) {
                        console.error(`wgEasyConf: Error deleting connection: ${e.message}`);
                        Main.notifyError('wgEasyConf', `Error al eliminar: ${e.message}`);
                    }
                    dialog.destroy();
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                        this._updateIcon();
                        this._refreshConnections();
                        return GLib.SOURCE_REMOVE;
                    });
                },
            },
        ]);

        dialog.open();
    }

    _showAboutDialog() {
        const dialog = new ModalDialog.ModalDialog({
            styleClass: 'wg-easy-conf-dialog',
        });

        const contentBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style: 'padding: 24px;',
        });

        const titleLabel = new St.Label({
            text: 'wgEasyConf',
            style: 'font-size: 24px; font-weight: bold; text-align: center;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(titleLabel);

        const versionLabel = new St.Label({
            text: 'v1.0',
            style: 'font-size: 14px; text-align: center; margin-top: 8px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(versionLabel);

        const descLabel = new St.Label({
            text: _('WireGuard QR Scanner para GNOME'),
            style: 'font-size: 14px; text-align: center; margin-top: 16px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(descLabel);

        const featuresLabel = new St.Label({
            text: _('• Escaneo de QR con cámara web\n• Importación directa a NetworkManager\n• Gestión de conexiones VPN'),
            style: 'font-size: 12px; text-align: center; margin-top: 16px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(featuresLabel);

        dialog.contentLayout.add_child(contentBox);

        dialog.setButtons([{label: _('Cerrar'), action: () => dialog.destroy()}]);

        dialog.open();
    }
}

export default class WgQrScanExtension extends Extension {
    enable() {
        this._indicator = new WgQrScanIndicator(this);
        Main.panel.addToStatusArea('wg-qr-scan', this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
