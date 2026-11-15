'use strict';

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
    ngettext,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WgQrScanPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Preferencias'),
            icon_name: 'network-vpn-symbolic',
        });
        window.add(page);

        const cameraGroup = new Adw.PreferencesGroup({
            title: _('Cámara'),
            description: _('Selecciona la cámara para escanear códigos QR'),
        });
        page.add(cameraGroup);

        const cameras = this._detectCameras();

        const cameraRow = new Adw.ComboRow({
            title: _('Dispositivo de cámara'),
            subtitle: ngettext('%d cámara detectada', '%d cámaras detectadas',
                cameras.length).replace('%d', cameras.length),
        });

        const cameraStore = new Gtk.StringList();
        cameraStore.append(_('Auto-detectar'));
        for (const camera of cameras)
            cameraStore.append(camera);
        cameraRow.set_model(cameraStore);

        const currentCamera = settings.get_string('camera-device');
        if (currentCamera === '') {
            cameraRow.set_selected(0);
        } else {
            const index = cameras.indexOf(currentCamera);
            cameraRow.set_selected(index >= 0 ? index + 1 : 0);
        }

        cameraRow.connect('notify::selected', () => {
            const selected = cameraRow.get_selected();
            settings.set_string('camera-device',
                selected === 0 ? '' : cameras[selected - 1]);
        });

        cameraGroup.add(cameraRow);

        const infoGroup = new Adw.PreferencesGroup({
            title: _('Información'),
        });
        page.add(infoGroup);

        const versionRow = new Adw.ActionRow({
            title: _('Versión'),
            subtitle: '1.1',
        });
        infoGroup.add(versionRow);

        const scriptRow = new Adw.ActionRow({
            title: _('Script backend'),
            subtitle: '/usr/local/bin/wg-qr-import.sh',
        });
        infoGroup.add(scriptRow);

        window.set_default_size(480, 360);
        window.set_search_enabled(false);
    }

    _detectCameras() {
        const cameras = new Set();

        try {
            const enumerator = Gio.File.new_for_path('/sys/class/video4linux')
                .enumerate_children('standard::name',
                    Gio.FileQueryInfoFlags.NONE, null);

            let info;
            while ((info = enumerator.next_file(null))) {
                const name = info.get_name();
                if (name.startsWith('video') && this._isCaptureNode(name))
                    cameras.add(`/dev/${name}`);
            }
            enumerator.close(null);
        } catch (_e) {
            // sysfs is not available; fall back to /dev below
        }

        if (cameras.size === 0) {
            try {
                const enumerator = Gio.File.new_for_path('/dev')
                    .enumerate_children('standard::name',
                        Gio.FileQueryInfoFlags.NONE, null);

                let info;
                while ((info = enumerator.next_file(null))) {
                    const name = info.get_name();
                    if (name.startsWith('video'))
                        cameras.add(`/dev/${name}`);
                }
                enumerator.close(null);
            } catch (e) {
                console.error(`wgEasyConf: Error detecting cameras: ${e.message}`);
            }
        }

        return [...cameras].sort((a, b) =>
            a.localeCompare(b, undefined, {numeric: true}));
    }

    _isCaptureNode(name) {
        try {
            const file = Gio.File.new_for_path(
                `/sys/class/video4linux/${name}/index`);
            const [, contents] = file.load_contents(null);
            const index = Number.parseInt(
                new TextDecoder().decode(contents).trim(), 10);

            return Number.isNaN(index) || index === 0;
        } catch (_e) {
            return true;
        }
    }
}
