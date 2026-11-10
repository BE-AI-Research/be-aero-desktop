// BE-Aero Dock helper - a GNOME Shell extension with no UI of its own.
//
// Wayland does not let an ordinary application see other applications'
// windows; the compositor does. This exports the window list and three
// verbs on the session bus so BE-Aero Desktop's dock can behave like a
// taskbar: org.gnome.Shell /org/beaero/Dock org.beaero.Dock.
//
// List() answers base64(JSON) so titles never meet gdbus's quoting rules.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `
<node>
  <interface name="org.beaero.Dock">
    <method name="List"><arg type="s" direction="out" name="b64json"/></method>
    <method name="Activate"><arg type="t" direction="in" name="id"/><arg type="b" direction="out" name="ok"/></method>
    <method name="Minimize"><arg type="t" direction="in" name="id"/><arg type="b" direction="out" name="ok"/></method>
    <method name="Close"><arg type="t" direction="in" name="id"/><arg type="b" direction="out" name="ok"/></method>
    <property name="Version" type="u" access="read"/>
  </interface>
</node>`;

const TASKBAR_TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY];

export default class BeAeroDock extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/beaero/Dock');
    }

    disable() {
        if (this._dbus) {
            this._dbus.flush();
            this._dbus.unexport();
            this._dbus = null;
        }
    }

    get Version() { return 1; }

    _windows() {
        return global.get_window_actors()
            .map(a => a.meta_window)
            .filter(w => w && !w.is_skip_taskbar() && TASKBAR_TYPES.includes(w.get_window_type()));
    }

    _find(id) {
        const n = Number(id);
        return this._windows().find(w => w.get_id() === n) || null;
    }

    List() {
        const tracker = Shell.WindowTracker.get_default();
        const focus = global.display.focus_window;
        const list = this._windows().map(w => {
            const app = tracker.get_window_app(w);
            const ws = w.get_workspace();
            return {
                id: w.get_id(),
                pid: w.get_pid(),
                title: w.get_title() || '',
                wmClass: w.get_wm_class() || '',
                app: app ? app.get_id() : '',
                appName: app ? app.get_name() : '',
                minimized: !!w.minimized,
                focused: w === focus,
                workspace: ws ? ws.index() : 0,
            };
        });
        return GLib.base64_encode(new TextEncoder().encode(JSON.stringify(list)));
    }

    Activate(id) {
        const w = this._find(id);
        if (!w) return false;
        const ws = w.get_workspace();
        if (ws && ws !== global.workspace_manager.get_active_workspace()) ws.activate_with_focus(w, global.get_current_time());
        else w.activate(global.get_current_time());
        return true;
    }

    Minimize(id) {
        const w = this._find(id);
        if (!w || !w.can_minimize()) return false;
        w.minimize();
        return true;
    }

    Close(id) {
        const w = this._find(id);
        if (!w) return false;
        w.delete(global.get_current_time());
        return true;
    }
}
