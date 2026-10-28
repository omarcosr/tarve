#!/usr/bin/env python3
"""Minimal org.kde.StatusNotifierWatcher for the Linux tray smoke.

Started after the app, it plays a tray host that appears later (a panel starting,
GNOME's AppIndicator extension being enabled): items register with it, as with
KDE's and GNOME's watchers, which always claim a host is registered.
"""
import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

DBusGMainLoop(set_as_default=True)
IFACE = "org.kde.StatusNotifierWatcher"


class Watcher(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, "/StatusNotifierWatcher")
        self.items = []

    @dbus.service.method(IFACE, in_signature="s", sender_keyword="sender")
    def RegisterStatusNotifierItem(self, service, sender=None):
        item = service if service.startswith(":") or "." in service else sender
        self.items.append(item)
        print(f"registered {item}", flush=True)
        self.StatusNotifierItemRegistered(item)

    @dbus.service.method(IFACE, in_signature="s")
    def RegisterStatusNotifierHost(self, service):
        pass

    @dbus.service.method(dbus.PROPERTIES_IFACE, in_signature="ss", out_signature="v")
    def Get(self, interface, prop):
        return self.GetAll(interface)[prop]

    @dbus.service.method(dbus.PROPERTIES_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return {
            "RegisteredStatusNotifierItems": dbus.Array(self.items, signature="s"),
            "IsStatusNotifierHostRegistered": True,
            "ProtocolVersion": dbus.Int32(0),
        }

    @dbus.service.signal(IFACE, signature="s")
    def StatusNotifierItemRegistered(self, service):
        pass


bus = dbus.SessionBus()
watcher = Watcher(bus)
name = dbus.service.BusName("org.kde.StatusNotifierWatcher", bus)
print("ready", flush=True)
GLib.MainLoop().run()
