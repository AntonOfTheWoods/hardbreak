---
status: accepted
date: 2026-09-25
---

# Calendar pauses come from Evolution Data Server, not a recurrence engine of our own

Breaks must stay silent while Anton teaches, and his classes follow irregular patterns
("every Monday for 14 weeks except the 3rd and 10th"). We do not store schedules or expand
recurrences in hardbreak. Instead, the user ticks **watched calendars** in preferences, and
every timed event in them is a **busy event** that holds the **calendar pause** gate (see
`CONTEXT.md`). Recurrence rules and their exceptions are expanded by Evolution Data Server
(EDS), and classes are edited in a real calendar (Microsoft 365, Google or a local one).

## Considered options

- **Own rules in preferences** (weekly/monthly rules plus explicit date lists and
  exceptions). Rejected: a rule editor without exceptions is useless for real term
  timetables, and one with exceptions would be a bigger libadwaita UI than everything else
  in hardbreak, reimplementing what calendar apps already do.
- **The Shell's own `org.gnome.Shell.CalendarServer`** (the service behind the clock
  menu). Rejected on two facts from GNOME Shell 50 (checked 2026-09-25). First,
  `SetTimeRange` stores a single range for the whole server (`app->since`/`app->until`),
  so our "next 48 hours" query and the clock menu's month view would overwrite each other.
  Second, it only loads calendars marked *selected* for display
  (`e_source_selectable_get_selected`), so a calendar hidden in the calendar app would
  silently stop pausing breaks.
- **Direct EDS access from the extension through GObject introspection** (ECal,
  EDataServer, ICalGLib), using the async API only. **Chosen.**

## Consequences

- A runtime dependency outside GNOME Shell: `gir1.2-ecal-2.0`, `gir1.2-edataserver-1.2`
  and `gir1.2-ical-3.0` on Debian/Ubuntu. When they are missing, the gate is inert and
  preferences say why. Breaks are never affected.
- EDS runs inside the compositor process. Only async calls are allowed; a synchronous EDS
  call could freeze the desktop.
- Two obvious EDS APIs are deliberately not used; checked against the EDS 3.56.2 source
  during implementation. Don't "fix" these back.
  - `ECalClientView`: its `start()`, `stop()` and `set_flags()` are synchronous D-Bus calls
    (`e_dbus_calendar_view_call_*_sync`) with no async variant. Live updates come from the
    client's `backend-property-changed` signal for `revision`, which the file backend and
    every meta backend (Microsoft 365, EWS, CalDAV, Google) bump on change. It is emitted
    from an idle source on the main context.
  - `ESourceRegistry`: its dispose iterates the creator's main context. When GJS drops the
    last reference during context teardown, gnome-shell segfaults on exit. The Shell opens
    clients from scratch `ESource`s (`new_with_uid`, no D-Bus). Prefs lists calendars over
    the registry's D-Bus interface (`org.gnome.evolution.dataserver.Sources5`).
    `ECal.Client.generate_instances` is avoided too: its time-zone lookup falls back to a
    synchronous `GetTimezone` call. Recurrences are expanded in-process with
    `ECal.recur_generate_instances_sync`, which is CPU-only, with a local time-zone resolver.
- Failure mode is fail-toward-enforcing. Busy events already fetched (a rolling 48-hour
  window) keep gating until they end, but a dead EDS means new or edited events are
  missed. The warning goes to the journal only. Do Not Disturb stays the manual backstop.
- A calendar event covering "now" ends a running break and silences hardbreak, including
  in strict mode. This bypass is accepted on purpose: a synced calendar gives a
  remote kill switch from a phone.
