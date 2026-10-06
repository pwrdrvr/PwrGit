#!/usr/bin/env python3
"""Resolve the installed launcher icon through GTK's standard hicolor theme."""
import pathlib
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

Gtk.init([])
theme = Gtk.IconTheme.new()
theme.set_custom_theme("hicolor")
for size in (32, 128, 512):
    info = theme.lookup_icon("pwrgit", size, Gtk.IconLookupFlags.FORCE_SIZE)
    assert info is not None, f"hicolor cannot resolve pwrgit at {size}px"
    expected = f"/usr/share/icons/hicolor/{size}x{size}/apps/pwrgit.png"
    assert info.get_filename() == expected, info.get_filename()
    icon = info.load_icon()
    assert (icon.get_width(), icon.get_height()) == (size, size)
    print(f"GTK resolved and decoded {expected}")

# Entirely contrived fixture: show the actual theme-resolved icon and app name.
# This is a GTK preview, not a screenshot of the Ubuntu applications menu.
window = Gtk.OffscreenWindow()
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
box.set_border_width(24)
box.pack_start(Gtk.Image.new_from_pixbuf(theme.load_icon("pwrgit", 128, 0)), False, False, 0)
box.pack_start(Gtk.Label(label="PwrGit"), False, False, 0)
window.add(box)
window.show_all()
while Gtk.events_pending():
    Gtk.main_iteration()
output = pathlib.Path(sys.argv[1])
output.parent.mkdir(parents=True, exist_ok=True)
window.get_pixbuf().savev(str(output), "png", [], [])
window.destroy()
