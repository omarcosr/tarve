#!/usr/bin/env python3
"""Minimal org.freedesktop.Notifications server for the Linux tray smoke.

Records each notification and clicks its default action, like a user would.
"""
import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

DBusGMainLoop(set_as_default=True)


class Server(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, "/org/freedesktop/Notifications")
        self.next_id = 0

    @dbus.service.method("org.freedesktop.Notifications", in_signature="susssasa{sv}i", out_signature="u")
    def Notify(self, app, replaces, icon, summary, body, actions, hints, timeout):
        self.next_id += 1
        nid = self.next_id
        print(f"notify {summary!r} {body!r} actions={list(actions)}", flush=True)
        if "default" in actions:
            GLib.timeout_add(150, self.click, nid)
        return nid

    def click(self, nid):
        self.ActionInvoked(nid, "default")
        self.NotificationClosed(nid, 2)
        return False

    @dbus.service.method("org.freedesktop.Notifications", out_signature="as")
    def GetCapabilities(self):
        return ["actions", "body"]

    @dbus.service.method("org.freedesktop.Notifications", out_signature="ssss")
    def GetServerInformation(self):
        return ("tarve-smoke", "tarve", "1", "1.2")

    @dbus.service.method("org.freedesktop.Notifications", in_signature="u")
    def CloseNotification(self, nid):
        self.NotificationClosed(nid, 3)

    @dbus.service.signal("org.freedesktop.Notifications", signature="us")
    def ActionInvoked(self, nid, action):
        pass

    @dbus.service.signal("org.freedesktop.Notifications", signature="uu")
    def NotificationClosed(self, nid, reason):
        pass


bus = dbus.SessionBus()
name = dbus.service.BusName("org.freedesktop.Notifications", bus)
server = Server(bus)
print("ready", flush=True)
GLib.MainLoop().run()
