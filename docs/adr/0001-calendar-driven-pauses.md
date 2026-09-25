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
- Failure mode is fail-toward-enforcing. Busy events already fetched (a rolling 48-hour
  window) keep gating until they end, but a dead EDS means new or edited events are
  missed. The warning goes to the journal only. Do Not Disturb stays the manual backstop.
- A calendar event covering "now" ends a running break and silences hardbreak, including
  in strict mode. This bypass is accepted on purpose: a synced calendar gives a
  remote kill switch from a phone.
