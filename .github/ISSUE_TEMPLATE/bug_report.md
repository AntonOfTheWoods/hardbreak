---
name: Bug report
about: Something hardbreak did, or failed to do
title: ''
labels: bug
assignees: ''
---

## What happened

<!-- What you saw, and what you expected instead. -->

## Environment

- GNOME Shell version (`gnome-shell --version`):
- Distribution and version:
- Session type (`echo $XDG_SESSION_TYPE`): Wayland / X11
- hardbreak version (`gnome-extensions info hardbreak@melser.org`):
- Installed from: extensions.gnome.org / release zip / source

## Steps to reproduce

1.
2.
3.

## Did the overlay come down?

<!-- If the screen was stuck: did it clear on its own (the watchdog releases the
overlay 30 s after the break should have ended, and on any internal error), or
did you have to switch to a TTY and disable the extension? -->

- [ ] The overlay cleared on its own
- [ ] I had to disable the extension from a TTY
- [ ] Not applicable

## Logs

```
journalctl -b -o cat /usr/bin/gnome-shell | grep -i hardbreak
```

<!-- Paste the output, or the lines around the failure. -->
