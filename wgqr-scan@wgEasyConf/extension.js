'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const SCAN_TIMEOUT_SECONDS = 30;
const REFRESH_DELAY_MS = 2000;

Gio._promisify(Gio.Subprocess.prototype,
    'communicate_utf8_async', 'communicate_utf8_finish');

/**
 * Run a command without a shell, so data coming from a QR code can never be
 * interpreted as shell syntax.
 *
 * @param {string[]} argv - command and arguments
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
async function runCommand(argv) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, null);

    return {
        ok: proc.get_successful(),
        stdout: stdout ?? '',
        stderr: (stderr ?? '').trim(),
    };
}

/**
 * Split a terse nmcli line, honouring the backslash escapes used for ':'
 * and '\' inside values.
 *
 * @param {string} line - a line produced by nmcli -t
 * @returns {string[]}
 */
function splitTerse(line) {
    const parts = [];
    let current = '';
    let escaped = false;

    for (const char of line) {
        if (escaped) {
            current += char;
            escaped = false;
        } else if (char === '\\') {
            escaped = true;
        } else if (char === ':') {
            parts.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    parts.push(current);

    return parts;
}

/**
 * Parse the WIFI: URI format used in QR codes.
 * Supports the standard \; \, \: \\ escapes.
 *
 * @param {string} text - QR contents
 * @returns {Object<string, string>}
 */
function parseWifiQR(text) {
    const params = {};
    const payload = text.replace(/^WIFI:/i, '');
    let key = '';
    let value = '';
    let readingKey = true;
    let escaped = false;

    for (const char of payload) {
        if (escaped) {
            value += char;
            escaped = false;
        } else if (char === '\\') {
            escaped = true;
        } else if (readingKey) {
            if (char === ':') {
                readingKey = false;
            } else if (char === ';') {
                key = '';
                value = '';
            } else {
                key += char;
            }
        } else if (char === ';') {
            if (key)
                params[key.toUpperCase()] = value;
            key = '';
            value = '';
            readingKey = true;
        } else {
            value += char;
        }
    }

    if (key && !readingKey)
        params[key.toUpperCase()] = value;

    return params;
}

function isTruthy(value) {
    return /^(true|yes|1)$/i.test(value ?? '');
}

function sanitizeConnectionName(value) {
    return value
        .replace(/[^A-Za-z0-9._-]/g, '')
        .replace(/^[^A-Za-z0-9]+/, '')
        .slice(0, 32);
}

function isValidInterfaceName(name) {
    return name.length > 0 &&
        name.length <= 15 &&
        /^[A-Za-z0-9_.-]+$/.test(name) &&
        !/^[.-]/.test(name);
}

class WgQrScanIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(extension) {
        super(0.5, 'WireGuard QR Scanner', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._scanLabel = _('Escanear QR (WiFi/WireGuard)');
        this._destroyed = false;
        this._scanning = false;
        this._scanProc = null;
        this._scanTimeoutId = 0;
        this._scanGeneration = 0;
        this._refreshTimeoutIds = new Set();
        this._connectionsToken = 0;
        this._iconToken = 0;

        this.add_style_class_name('wg-qr-scan-indicator');

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
        this._updateIcon();

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen)
                return;
            this._updateIcon();
            this._refreshConnections();
        });
    }

    _buildMenu() {
        this._scanItem = new PopupMenu.PopupImageMenuItem(
            this._scanLabel, 'scanner-symbolic');
        this._scanItem.connect('activate', () => {
            this._scanQR().catch(e => {
                console.error(`wgEasyConf: Error scanning: ${e.message}`);
                Main.notifyError('wgEasyConf', `${_('Error al escanear')}: ${e.message}`);
            });
        });
        this.menu.addMenuItem(this._scanItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._connectionsSection = new PopupMenu.PopupMenuSection();
        this._connectionsHeader = new St.Label({
            text: _('Conexiones WireGuard'),
            style_class: 'wg-qr-scan-section-header',
        });
        this._connectionsSection.box.add_child(this._connectionsHeader);
        this.menu.addMenuItem(this._connectionsSection);
        this._refreshConnections().catch(e => {
            console.error(`wgEasyConf: Error refreshing connections: ${e.message}`);
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupImageMenuItem(
            _('Preferencias...'), 'preferences-system-symbolic');
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);

        const aboutItem = new PopupMenu.PopupImageMenuItem(
            _('Acerca de wgEasyConf'), 'help-about-symbolic');
        aboutItem.connect('activate', () => this._showAboutDialog());
        this.menu.addMenuItem(aboutItem);
    }

    async _getConnectionNames() {
        const result = await runCommand(
            ['nmcli', '-t', '-f', 'NAME', 'connection', 'show']);

        if (!result.ok)
            throw new Error(result.stderr || _('Error al listar conexiones'));

        return result.stdout
            .split('\n')
            .filter(line => line.length > 0)
            .map(line => splitTerse(line)[0]);
    }

    _addDisabledItem(section, text) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.setSensitive(false);
        section.addMenuItem(item);
    }

    async _refreshConnections() {
        if (this._destroyed)
            return;

        const token = ++this._connectionsToken;
        this._connectionsSection.removeAll();

        let result;
        try {
            result = await runCommand(['nmcli', '-t', '-f', 'NAME,TYPE,ACTIVE',
                'connection', 'show']);
        } catch (e) {
            if (token === this._connectionsToken && !this._destroyed)
                this._addDisabledItem(this._connectionsSection,
                    _('Error al listar conexiones'));
            console.error(`wgEasyConf: Error listing connections: ${e.message}`);
            return;
        }

        if (this._destroyed || token !== this._connectionsToken)
            return;

        if (!result.ok) {
            this._addDisabledItem(this._connectionsSection,
                _('Error al listar conexiones'));
            return;
        }

        let wgFound = false;

        for (const line of result.stdout.split('\n')) {
            if (line.length === 0)
                continue;

            const [name, type, active] = splitTerse(line);
            if (type !== 'wireguard')
                continue;

            wgFound = true;
            const statusIcon = active === 'yes' ? '✅ ' : '❌ ';
            const subMenu = new PopupMenu.PopupSubMenuMenuItem(
                `${statusIcon}${name}`);

            const toggleLabel = active === 'yes' ? _('Desconectar') : _('Conectar');
            const toggleItem = new PopupMenu.PopupMenuItem(toggleLabel);
            toggleItem.connect('activate', () => this._toggleConnection(name));
            subMenu.menu.addMenuItem(toggleItem);

            const deleteItem = new PopupMenu.PopupMenuItem(_('Eliminar...'));
            deleteItem.connect('activate', () => this._deleteConnection(name));
            subMenu.menu.addMenuItem(deleteItem);

            this._connectionsSection.addMenuItem(subMenu);
        }

        if (!wgFound) {
            this._addDisabledItem(this._connectionsSection,
                _('No hay conexiones WireGuard'));
        }
    }

    async _updateIcon() {
        const token = ++this._iconToken;

        try {
            const result = await runCommand(['nmcli', '-t', '-f', 'NAME,TYPE,ACTIVE',
                'connection', 'show', '--active']);

            if (this._destroyed || token !== this._iconToken || !result.ok)
                return;

            const hasActiveWg = result.stdout.split('\n').some(line => {
                const [, type, active] = splitTerse(line);
                return type === 'wireguard' && active === 'yes';
            });

            this._icon.icon_name = hasActiveWg
                ? 'network-vpn-symbolic'
                : 'network-vpn-disconnected-symbolic';
        } catch (e) {
            console.error(`wgEasyConf: Error updating icon: ${e.message}`);
        }
    }

    async _scanQR() {
        if (this._scanning) {
            Main.notify('wgEasyConf', _('Ya hay un escaneo en curso...'));
            return;
        }

        const zbarcamPath = GLib.find_program_in_path('zbarcam');
        if (!zbarcamPath) {
            Main.notifyError('wgEasyConf',
                _('zbarcam no encontrado. Instala: sudo apt install zbar-tools'));
            return;
        }

        const camera = this._settings.get_string('camera-device') || '/dev/video0';

        let proc;
        try {
            proc = Gio.Subprocess.new(
                [zbarcamPath, '--raw', '-1', camera],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            console.error(`wgEasyConf: Failed to start zbarcam: ${e.message}`);
            Main.notifyError('wgEasyConf',
                `${_('Error al iniciar zbarcam')}: ${e.message}`);
            return;
        }

        const generation = ++this._scanGeneration;
        this._scanning = true;
        this._scanProc = proc;
        this._scanItem.label.set_text(_('Escaneando...'));

        this._scanTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SCAN_TIMEOUT_SECONDS * 1000, () => {
                this._scanTimeoutId = 0;
                if (generation === this._scanGeneration)
                    this._finishScan(null, _('Timeout: no se detectó QR'));
                return GLib.SOURCE_REMOVE;
            });

        let stdout = '';
        let stderr = '';

        try {
            [stdout, stderr] = await proc.communicate_utf8_async(null, null);
        } catch (e) {
            if (!this._destroyed && generation === this._scanGeneration)
                this._finishScan(null, `${_('Error al escanear')}: ${e.message}`);
            return;
        }

        if (this._destroyed || generation !== this._scanGeneration)
            return;

        const text = (stdout ?? '').trim();
        if (text.length > 0) {
            this._finishScan(text);
            return;
        }

        const detail = (stderr ?? '').trim();
        if (detail.length > 0)
            this._finishScan(null, `${_('Error al escanear')}: ${detail}`);
        else
            this._finishScan(null, _('No se detectó código QR'));
    }

    _finishScan(text, errorMessage = null) {
        if (!this._scanning)
            return;

        this._scanning = false;
        this._scanGeneration++;

        if (this._scanTimeoutId !== 0) {
            GLib.source_remove(this._scanTimeoutId);
            this._scanTimeoutId = 0;
        }

        if (this._scanProc) {
            try {
                this._scanProc.force_exit();
            } catch (_e) {
                // Process already exited
            }
            this._scanProc = null;
        }

        if (this._destroyed)
            return;

        this._scanItem.label.set_text(this._scanLabel);

        if (errorMessage) {
            Main.notifyError('wgEasyConf', errorMessage);
            return;
        }

        if (text && text.length > 0) {
            this._processQR(text).catch(e => {
                console.error(`wgEasyConf: Error processing QR: ${e.message}`);
                Main.notifyError('wgEasyConf',
                    `${_('Error al procesar el QR')}: ${e.message}`);
            });
        } else {
            Main.notifyError('wgEasyConf', _('No se detectó código QR'));
        }
    }

    _cancelScan() {
        this._scanGeneration++;

        if (this._scanTimeoutId !== 0) {
            GLib.source_remove(this._scanTimeoutId);
            this._scanTimeoutId = 0;
        }

        for (const id of this._refreshTimeoutIds)
            GLib.source_remove(id);
        this._refreshTimeoutIds.clear();

        if (this._scanProc) {
            try {
                this._scanProc.force_exit();
            } catch (_e) {
                // Process already exited
            }
            this._scanProc = null;
        }

        this._scanning = false;
    }

    _scheduleRefresh(delay = REFRESH_DELAY_MS) {
        if (this._destroyed)
            return;

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._refreshTimeoutIds.delete(id);
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;

            this._updateIcon();
            this._refreshConnections().catch(e => {
                console.error(`wgEasyConf: Error refreshing connections: ${e.message}`);
            });
            return GLib.SOURCE_REMOVE;
        });

        this._refreshTimeoutIds.add(id);
    }

    async _processQR(qrText) {
        if (!qrText || qrText.length === 0) {
            Main.notifyError('wgEasyConf', _('No se detectó código QR'));
            return;
        }

        if (qrText.toUpperCase().startsWith('WIFI:')) {
            await this._processWifiQR(qrText);
            return;
        }

        if (!qrText.includes('[Interface]')) {
            Main.notifyError('wgEasyConf',
                _('QR no reconocido. Soporta WiFi y WireGuard.'));
            return;
        }

        if (!qrText.includes('PrivateKey')) {
            Main.notifyError('wgEasyConf',
                _('Falta la clave privada en la configuración'));
            return;
        }

        const endpointMatch = qrText.match(/^\s*Endpoint\s*=\s*(.+)$/mi);
        const endpointHost = endpointMatch
            ? endpointMatch[1].trim().split(':')[0]
            : '';
        // Use the first label of a DNS name; for IP addresses fall back to a
        // generic name instead of a meaningless numeric one.
        const hostLabel = sanitizeConnectionName(endpointHost.split('.')[0]);
        const baseName = hostLabel && !/^\d+$/.test(hostLabel) ? hostLabel : 'wg-qr';

        let existing = [];
        try {
            existing = await this._getConnectionNames();
        } catch (e) {
            console.error(`wgEasyConf: Error listing connections: ${e.message}`);
        }

        let conName = baseName;
        if (existing.includes(conName))
            conName = `${baseName}-${Math.floor(Date.now() / 1000)}`;

        let tmpPath;
        try {
            tmpPath = this._writeTempConfig(qrText);
        } catch (e) {
            console.error(`wgEasyConf: Error writing temp config: ${e.message}`);
            Main.notifyError('wgEasyConf',
                `${_('Error al preparar la configuración')}: ${e.message}`);
            return;
        }

        const before = new Set(existing);
        let importResult;

        try {
            importResult = await runCommand(
                ['nmcli', 'connection', 'import', 'type', 'wireguard', 'file', tmpPath]);
        } catch (e) {
            importResult = {ok: false, stderr: e.message};
        } finally {
            try {
                GLib.unlink(tmpPath);
            } catch (_e) {
                // Ignore cleanup errors
            }
        }

        if (!importResult.ok) {
            Main.notifyError('wgEasyConf',
                `${_('Error al importar a NetworkManager')}: ${importResult.stderr}`);
            return;
        }

        let importedName = conName;
        try {
            const after = await this._getConnectionNames();
            importedName = after.find(name => !before.has(name)) ?? conName;
        } catch (e) {
            console.error(`wgEasyConf: Error detecting imported name: ${e.message}`);
        }

        if (importedName !== conName) {
            const rename = await runCommand(
                ['nmcli', 'connection', 'modify', 'id', importedName,
                    'connection.id', conName]);
            if (!rename.ok) {
                Main.notifyError('wgEasyConf',
                    `${_('Error al renombrar la conexión')}: ${rename.stderr}`);
                return;
            }
        }

        if (isValidInterfaceName(conName)) {
            await runCommand(['nmcli', 'connection', 'modify', 'id', conName,
                'connection.interface-name', conName]);
        }

        const up = await runCommand(['nmcli', 'connection', 'up', 'id', conName]);
        if (!up.ok) {
            Main.notifyError('wgEasyConf',
                `${_('VPN importada, pero no se pudo activar')}: ${up.stderr}`);
            return;
        }

        Main.notify('wgEasyConf', `${_('VPN conectada')}: ${conName}`);
        this._scheduleRefresh();
    }

    _writeTempConfig(contents) {
        const [fd, path] = GLib.file_open_tmp('wg-qr-XXXXXX.conf');
        GLib.close(fd);

        const file = Gio.File.new_for_path(path);
        file.replace_contents(contents, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        return path;
    }

    async _processWifiQR(qrText) {
        // WIFI:T:<WPA|WEP|nopass>;S:<ssid>;P:<password>;H:<hidden>;;
        const params = parseWifiQR(qrText);
        const ssid = params.S || '';

        if (!ssid) {
            Main.notifyError('wgEasyConf', _('El QR WiFi no tiene SSID válido'));
            return;
        }

        let existing = [];
        try {
            existing = await this._getConnectionNames();
        } catch (e) {
            console.error(`wgEasyConf: Error listing connections: ${e.message}`);
        }

        if (existing.includes(ssid)) {
            Main.notify('wgEasyConf', `${_('La red ya está configurada')}: ${ssid}`);
            await this._activateConnection(ssid);
            return;
        }

        const type = (params.T || 'WPA').toUpperCase();
        const isOpen = type === 'NOPASS';
        const argv = ['nmcli', 'connection', 'add', 'type', 'wifi',
            'con-name', ssid, 'ssid', ssid];

        if (!isOpen) {
            const password = params.P || '';
            if (!password) {
                Main.notifyError('wgEasyConf',
                    _('El QR WiFi no tiene contraseña'));
                return;
            }

            if (type === 'WEP') {
                // WEP keys are 5/13 ASCII chars or 10/26 hex digits; anything
                // else is passed as a passphrase so NM can derive the key.
                const isKey = /^([0-9a-fA-F]{10}|[0-9a-fA-F]{26}|[\x20-\x7e]{5}|[\x20-\x7e]{13})$/.test(password);
                argv.push('wifi-sec.key-mgmt', 'wep',
                    'wifi-sec.wep-key-type', isKey ? '1' : '2',
                    'wifi-sec.wep-key0', password);
            } else {
                argv.push('wifi-sec.key-mgmt', 'wpa-psk',
                    'wifi-sec.psk', password);
            }
        }

        if (isTruthy(params.H))
            argv.push('wifi.hidden', 'yes');

        const result = await runCommand(argv);
        if (!result.ok) {
            Main.notifyError('wgEasyConf',
                `${_('Error al agregar red WiFi')}: ${result.stderr}`);
            return;
        }

        await this._activateConnection(ssid);
    }

    async _activateConnection(name) {
        const result = await runCommand(['nmcli', 'connection', 'up', 'id', name]);
        if (!result.ok) {
            Main.notifyError('wgEasyConf',
                `${_('Error al conectar')}: ${result.stderr}`);
            return;
        }

        Main.notify('wgEasyConf', `${_('Conectando')}: ${name}`);
        this._scheduleRefresh();
    }

    async _toggleConnection(name) {
        try {
            const result = await runCommand(['nmcli', '-t', '-f', 'NAME',
                'connection', 'show', '--active']);

            if (!result.ok) {
                Main.notifyError('wgEasyConf',
                    `${_('Error al consultar conexiones')}: ${result.stderr}`);
                return;
            }

            const activeNames = result.stdout
                .split('\n')
                .filter(line => line.length > 0)
                .map(line => splitTerse(line)[0]);
            const isActive = activeNames.includes(name);

            const toggle = await runCommand(['nmcli', 'connection',
                isActive ? 'down' : 'up', 'id', name]);

            if (!toggle.ok) {
                Main.notifyError('wgEasyConf',
                    `${_('Error al cambiar el estado')}: ${toggle.stderr}`);
                return;
            }

            Main.notify('wgEasyConf', isActive
                ? `${_('Desconectado')}: ${name}`
                : `${_('Conectado')}: ${name}`);
        } catch (e) {
            console.error(`wgEasyConf: Error toggling connection: ${e.message}`);
            Main.notifyError('wgEasyConf', `${_('Error')}: ${e.message}`);
        }

        this._scheduleRefresh();
    }

    _deleteConnection(name) {
        const dialog = new ModalDialog.ModalDialog({
            styleClass: 'wg-qr-scan-dialog',
        });

        const contentBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            style: 'padding: 24px;',
        });

        const warningLabel = new St.Label({
            text: _('¿Eliminar la conexión WireGuard?'),
            style: 'font-size: 18px; font-weight: bold;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(warningLabel);

        const nameLabel = new St.Label({
            text: name,
            style: 'font-size: 14px; margin-top: 8px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(nameLabel);

        const descLabel = new St.Label({
            text: _('Esta acción no se puede deshacer.\nLa configuración se eliminará permanentemente.'),
            style: 'font-size: 12px; margin-top: 16px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(descLabel);

        dialog.contentLayout.add_child(contentBox);

        dialog.setButtons([
            {
                label: _('Cancelar'),
                action: () => dialog.close(),
            },
            {
                label: _('Eliminar'),
                action: async () => {
                    dialog.close();

                    try {
                        const result = await runCommand(
                            ['nmcli', 'connection', 'delete', 'id', name]);

                        if (result.ok) {
                            Main.notify('wgEasyConf',
                                `${_('Conexión eliminada')}: ${name}`);
                        } else {
                            Main.notifyError('wgEasyConf',
                                `${_('Error al eliminar')}: ${result.stderr}`);
                        }
                    } catch (e) {
                        console.error(`wgEasyConf: Error deleting connection: ${e.message}`);
                        Main.notifyError('wgEasyConf',
                            `${_('Error al eliminar')}: ${e.message}`);
                    }

                    this._scheduleRefresh();
                },
            },
        ]);

        dialog.open();
    }

    _showAboutDialog() {
        const dialog = new ModalDialog.ModalDialog({
            styleClass: 'wg-qr-scan-dialog',
        });

        const contentBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            style: 'padding: 24px;',
        });

        const titleLabel = new St.Label({
            text: 'wgEasyConf',
            style: 'font-size: 24px; font-weight: bold;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(titleLabel);

        const versionLabel = new St.Label({
            text: 'v1.1',
            style: 'font-size: 14px; margin-top: 8px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(versionLabel);

        const descLabel = new St.Label({
            text: _('WireGuard QR Scanner para GNOME'),
            style: 'font-size: 14px; margin-top: 16px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(descLabel);

        const featuresLabel = new St.Label({
            text: _('• Escaneo de QR con cámara web\n• Importación directa a NetworkManager\n• Gestión de conexiones VPN'),
            style: 'font-size: 12px; margin-top: 16px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        contentBox.add_child(featuresLabel);

        dialog.contentLayout.add_child(contentBox);

        dialog.setButtons([{
            label: _('Cerrar'),
            action: () => dialog.close(),
        }]);

        dialog.open();
    }

    destroy() {
        this._destroyed = true;
        this._cancelScan();
        this._connectionsToken++;
        this._iconToken++;
        this._settings = null;
        this._extension = null;

        super.destroy();
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
