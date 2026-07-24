'use strict';

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WgQrScanPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Camera detection page
        const page = new Adw.PreferencesPage({
            title: _('Preferencias'),
            icon_name: 'network-vpn-symbolic',
        });
        window.add(page);

        // Camera group
        const cameraGroup = new Adw.PreferencesGroup({
            title: _('Cámara'),
            description: _('Selecciona la cámara para escanear códigos QR'),
        });
        page.add(cameraGroup);

        // Detect cameras
        const cameras = this._detectCameras();

        // Camera selector
        const cameraRow = new Adw.ComboRow({
            title: _('Dispositivo de cámara'),
            subtitle: _(['Cámara detectada', 'Cámaras detectadas'][cameras.length > 1 ? 1 : 0]),
        });

        // Build camera list
        const cameraStore = new Gtk.StringList();
        cameraStore.append(_('Auto-detectar'));
        for (const cam of cameras) {
            cameraStore.append(cam);
        }
        cameraRow.set_model(cameraStore);

        // Set current selection
        const currentCamera = settings.get_string('camera-device');
        if (currentCamera === '') {
            cameraRow.set_selected(0);
        } else {
            const idx = cameras.indexOf(currentCamera);
            cameraRow.set_selected(idx >= 0 ? idx + 1 : 0);
        }

        // Save on change
        cameraRow.connect('notify::selected', () => {
            const selected = cameraRow.get_selected();
            if (selected === 0) {
                settings.set_string('camera-device', '');
            } else {
                settings.set_string('camera-device', cameras[selected - 1]);
            }
        });

        cameraGroup.add(cameraRow);

        // Info group
        const infoGroup = new Adw.PreferencesGroup({
            title: _('Información'),
        });
        page.add(infoGroup);

        const versionRow = new Adw.ActionRow({
            title: _('Versión'),
            subtitle: _('1.0'),
        });
        infoGroup.add(versionRow);

        const scriptRow = new Adw.ActionRow({
            title: _('Script backend'),
            subtitle: '/usr/local/bin/wg-qr-import.sh',
        });
        infoGroup.add(scriptRow);

        window.set_default_size(400, 300);
        window.set_search_enabled(false);
    }

    _detectCameras() {
        const cameras = [];
        try {
            const dir = Gio.File.new_for_path('/dev');
            const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);

            let info;
            while ((info = enumerator.next_file(null))) {
                const name = info.get_name();
                if (name.startsWith('video')) {
                    cameras.push(`/dev/${name}`);
                }
            }
        } catch (e) {
            console.error(`wgEasyConf: Error detecting cameras: ${e.message}`);
        }

        return cameras.sort();
    }
}
