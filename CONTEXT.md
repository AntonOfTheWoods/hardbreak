# hardbreak

Enforced screen breaks for GNOME Shell: an undismissable full-screen overlay on a schedule.
This glossary is the ubiquitous language; `docs/spec.md` holds the decisions.

## Language

### Breaks

**Mini break**:
The short, frequent break (default 60 s every 30 min).
_Avoid_: microbreak (Stretchly's word)

**Long break**:
The longer break that replaces a mini after `minis-per-long` minis (default 3 min, alternating).

**Wall**:
The modal overlay that covers every monitor during a break and refuses all input and keybindings.
_Avoid_: popup, dialog, screen lock

**Strict mode**:
The wall with no Skip button and no Escape; the countdown or the watchdog are the only ways out.
_Avoid_: hard mode (in code/UI; "Hard" survives only as spec history)

**Watchdog**:
The independent deadline (break duration + 30 s) and exception guard that releases the wall when anything goes wrong. Not user-configurable.

**Postpone window**:
The initial fraction of a break (default 30 %) during which the once-per-break postpone is offered.

**Fresh cycle**:
Restarting the schedule as if just enabled: counters cleared, next break a full interval away.

**Owed break**:
A break interrupted by lock or suspend; a short absence brings the same break back (warning first) instead of skipping it.

### Gates

A gate is a condition that suppresses breaks while it holds: disabled, DND, away, manual pause, calendar pause.

**Away**:
Not at the machine — idle past the natural break threshold, screen locked, or suspended.

**Natural break threshold**:
Time away (`idle-reset`, default 5 min) that counts as having taken a break; a shorter absence resumes the frozen countdown.

**Manual pause**:
A pause chosen from the panel menu (1 h, 2 h, until the morning hour).

**Calendar pause**:
The gate that holds while inside a busy event or its lead shadow. Ends with a fresh cycle, like DND.
_Avoid_: class mode, quiet hours

### Calendar

**Watched calendar**:
A calendar the user has ticked in preferences; its timed events suppress breaks.
_Avoid_: class calendar

**Busy event**:
One concrete, timed instance from a watched calendar, as expanded by Evolution Data Server (recurrences and exceptions already applied). All-day events are never busy events.
_Avoid_: class, appointment

**Lead shadow**:
The silence immediately before a busy event: no break may start whose warning + duration would not finish 60 s before the event begins.
_Avoid_: pre-window guard, margin
