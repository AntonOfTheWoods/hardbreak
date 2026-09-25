/**
 * Calendar pause, the Shell side (ADR 0001, architecture §5): the busy events
 * of the watched calendars, kept current in the scheduler.
 *
 * This module holds the lifecycle — which calendars are open, when they are
 * read, what is kept when something fails — and the pure rules that decide
 * which occurrences are busy events. Evolution Data Server itself is behind the
 * {@link CalendarBackend} port, implemented in `eds.ts`, so that everything
 * here can be tested without GObject introspection.
 *
 * There are deliberately no static imports of the EDS typelibs, here or in
 * `eds.ts`: they are an optional runtime dependency, and a static import of a
 * missing typelib would stop the whole extension from loading. `eds.ts` loads
 * them with dynamic `import()` instead; if that fails, the watcher is inert.
 * This module imports nothing from GI at all, so it also loads under bun and
 * in a standalone `gjs -m` probe.
 */

import { normalizeBusyIntervals, type BusyInterval } from '../core/calendar.js';
import type { Clock, Log, TimerHandle, Timers } from '../core/types.js';

/** How far ahead busy events are read: now → +48 h (spec §3). */
export const CALENDAR_WINDOW_MS = 48 * 3_600_000;

/** How often the window is moved on and every calendar read again. */
export const CALENDAR_REFRESH_MS = 3 * 3_600_000;

/**
 * One retry this long after a calendar failed to open or its backend died.
 * Also covers the login race: the source registry creates online-account
 * calendars shortly after it starts, possibly after the Shell asked for them.
 */
export const CALENDAR_RETRY_MS = 60_000;

// -- ports -------------------------------------------------------------------

/** `Gio.Cancellable` as far as the watcher is concerned. */
export interface Cancellable {
  cancel(): void;
}

/**
 * Everything the watcher needs from Evolution Data Server.
 *
 * There is no source registry here on purpose: the Shell never holds an
 * `EDataServer.SourceRegistry` (see `eds.ts`). A calendar is addressed by its
 * source uid alone, and an unknown, disabled or non-calendar uid is simply a
 * calendar that fails to open.
 */
export interface CalendarBackend {
  createCancellable(): Cancellable;
  /** The calendar with this EDS source uid. In memory; opening it may fail. */
  source(uid: string): CalendarSource;
}

export interface CalendarSource {
  readonly uid: string;
  connect(cancellable: Cancellable): Promise<CalendarConnection>;
}

export interface CalendarConnection {
  /** The busy intervals of this calendar that overlap `[startWall, endWall)`. */
  fetch(startWall: number, endWall: number, cancellable: Cancellable): Promise<BusyInterval[]>;
  /**
   * `changed` when the calendar's contents change, `died` when its backend
   * does. Returns a disconnect function.
   */
  watch(handlers: { changed(): void; died(): void }): () => void;
}

/** The part of the scheduler this adapter drives. */
export interface BusyTarget {
  setBusyIntervals(intervals: readonly BusyInterval[]): void;
}

// -- what counts as a busy event ----------------------------------------------

/** One occurrence of a calendar event, as expanded by EDS. */
export interface Occurrence {
  uid: string;
  /**
   * Epoch ms of the occurrence's original start — what a RECURRENCE-ID names.
   * For an occurrence generated from a recurrence rule this is its start.
   */
  recurrenceIdWall: number;
  startWall: number;
  endWall: number;
  /** A DATE-valued start: an all-day event, which is never a busy event. */
  allDay: boolean;
  /** `STATUS:CANCELLED`. */
  cancelled: boolean;
  /** `TRANSP:TRANSPARENT`, which is how Outlook's "free" arrives. */
  transparent: boolean;
}

/** `RANGE` of a RECURRENCE-ID; `'this'` when absent. */
export type OverrideRange = 'this' | 'thisandfuture' | 'thisandprior';

/** A detached instance: a component that changes one occurrence of a series. */
export interface Override {
  uid: string;
  recurrenceIdWall: number;
  range: OverrideRange;
  cancelled: boolean;
  transparent: boolean;
  /** Its own occurrence inside the window, or `null` when it lies outside. */
  occurrence: Occurrence | null;
}

/**
 * Apply detached instances to the occurrences expanded from their series, the
 * way `e_cal_client_generate_instances()` does: an override replaces the
 * occurrence it names (and removes it when it was moved out of the window);
 * one that names nothing in the window stands on its own. A `THISANDFUTURE` or
 * `THISANDPRIOR` override also lends its status and transparency to the
 * occurrences on its side, whose times stay as generated.
 */
export function applyOverrides(
  occurrences: readonly Occurrence[],
  overrides: readonly Override[],
): Occurrence[] {
  const result: (Occurrence | null)[] = occurrences.map((occurrence) => ({ ...occurrence }));
  const standalone: Occurrence[] = [];
  const ordered = [...overrides].sort((a, b) => a.recurrenceIdWall - b.recurrenceIdWall);
  for (const override of ordered) {
    let matched = false;
    for (let i = 0; i < result.length; i++) {
      const occurrence = result[i];
      if (occurrence === null || occurrence === undefined || occurrence.uid !== override.uid) {
        continue;
      }
      if (occurrence.recurrenceIdWall === override.recurrenceIdWall) {
        result[i] = override.occurrence === null ? null : { ...override.occurrence };
        matched = true;
      } else if (
        (override.range === 'thisandfuture' &&
          occurrence.recurrenceIdWall > override.recurrenceIdWall) ||
        (override.range === 'thisandprior' &&
          occurrence.recurrenceIdWall < override.recurrenceIdWall)
      ) {
        occurrence.cancelled = override.cancelled;
        occurrence.transparent = override.transparent;
      }
    }
    if (!matched && override.occurrence !== null) standalone.push({ ...override.occurrence });
  }
  return [...result.filter((occurrence) => occurrence !== null), ...standalone];
}

/** Whether an occurrence is a busy event: timed, not cancelled, not free, not empty. */
export function isBusy(occurrence: Occurrence): boolean {
  return (
    !occurrence.allDay &&
    !occurrence.cancelled &&
    !occurrence.transparent &&
    Number.isFinite(occurrence.startWall) &&
    Number.isFinite(occurrence.endWall) &&
    occurrence.endWall > occurrence.startWall
  );
}

/**
 * The busy intervals among `occurrences` that overlap the window
 * `[startWall, endWall)`, merged. An event is kept whole, not cut at the window
 * edges: if EDS goes away, an event that runs past the window must still hold
 * until its real end.
 */
export function busyIntervalsOf(
  occurrences: readonly Occurrence[],
  startWall: number,
  endWall: number,
): BusyInterval[] {
  return normalizeBusyIntervals(
    occurrences
      .filter(
        (occurrence) =>
          isBusy(occurrence) && occurrence.startWall < endWall && occurrence.endWall > startWall,
      )
      .map((occurrence) => ({ startWall: occurrence.startWall, endWall: occurrence.endWall })),
  );
}

// -- the preferences' calendar list ---------------------------------------------

/** One EDS source as the preferences read it from the registry service. */
export interface SourceRecord {
  uid: string;
  displayName: string;
  /** Uid of the account (collection) or stub this source belongs to. */
  parentUid: string | null;
  enabled: boolean;
  /** Has a `[Calendar]` extension: it is a calendar. */
  hasCalendar: boolean;
  /** A collection's `CalendarEnabled`; `null` when the source is no collection. */
  collectionCalendarEnabled: boolean | null;
}

/** A row of the preferences' Calendar group. */
export interface CalendarChoice {
  uid: string;
  name: string;
  /** The account's display name, or "On this computer". */
  account: string;
}

/** Local calendars hang off this stub source, which is not an account. */
const LOCAL_STUB = 'local-stub';

/**
 * The calendars worth offering: enabled, under enabled ancestors, and not
 * below an account whose calendars are switched off — the same answer as
 * `e_source_registry_check_enabled()`. Sorted by account, then name.
 */
export function calendarChoices(records: readonly SourceRecord[]): CalendarChoice[] {
  const byUid = new Map(records.map((record) => [record.uid, record]));
  const usable = (record: SourceRecord): boolean => {
    const seen = new Set<string>();
    for (
      let current: SourceRecord | undefined = record;
      current !== undefined && !seen.has(current.uid);
      current = current.parentUid === null ? undefined : byUid.get(current.parentUid)
    ) {
      seen.add(current.uid);
      if (!current.enabled) return false;
      if (current !== record && current.collectionCalendarEnabled === false) return false;
    }
    return true;
  };
  const accountOf = (record: SourceRecord): string => {
    const parent = record.parentUid === null ? undefined : byUid.get(record.parentUid);
    if (parent === undefined || parent.uid === LOCAL_STUB || parent.displayName === '') {
      return 'On this computer';
    }
    return parent.displayName;
  };
  return records
    .filter((record) => record.hasCalendar && usable(record))
    .map((record) => ({
      uid: record.uid,
      name: record.displayName === '' ? record.uid : record.displayName,
      account: accountOf(record),
    }))
    .sort((a, b) => a.account.localeCompare(b.account) || a.name.localeCompare(b.name));
}

// -- the watcher ---------------------------------------------------------------

interface Entry {
  readonly uid: string;
  readonly source: CalendarSource;
  connection: CalendarConnection | null;
  unwatch: (() => void) | null;
  connecting: boolean;
  fetching: boolean;
  /** A change arrived while a fetch was in flight: fetch again after it. */
  again: boolean;
  /** The last intervals read successfully. Kept when anything fails later. */
  intervals: BusyInterval[];
  /** Bumped whenever the connection is dropped, so late results are ignored. */
  epoch: number;
  /** A retry was already spent on this failure; the next one waits for a refresh. */
  retried: boolean;
  /** Failing to open has been logged once; a stale uid must not fill the journal. */
  warned: boolean;
}

/**
 * Keeps the scheduler's busy intervals in step with the watched calendars.
 *
 * Nothing is loaded until at least one calendar is watched, so a user who never
 * ticks one never has EDS in the Shell. From then on:
 *
 * - each watched calendar is opened with `ECal.Client.connect` and read for
 *   the window now → +48 h;
 * - a change of the calendar's contents (its backend `revision`) reads it
 *   again, so a late edit from a phone reaches the scheduler within one read —
 *   mid-break included;
 * - the window moves on every {@link CALENDAR_REFRESH_MS}, on {@link refresh}
 *   (the extension calls it when the user comes back) and when the watched
 *   set changes; a calendar that failed to open is tried again then, and once
 *   {@link CALENDAR_RETRY_MS} after the failure.
 *
 * Failure keeps the last known intervals: they keep gating until they end,
 * and the journal gets a warning. If EDS or its bindings are missing, the
 * watcher is inert and never calls the scheduler (spec §3).
 */
export class CalendarWatcher {
  private watched: string[] = [];
  private active = false;
  private started = false;
  /** Bumped by `disable()`: every asynchronous continuation checks it. */
  private generation = 0;

  private cancellable: Cancellable | null = null;
  private backend: CalendarBackend | null = null;
  private readonly entries = new Map<string, Entry>();

  private refreshTimer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;
  private lastPublished: string | null = null;

  /**
   * `log` is for exceptions (bugs); `warn` for the failures this watcher
   * expects and survives — EDS missing, a calendar that will not open or
   * read, a backend that died — which are journal warnings and nothing more.
   */
  constructor(
    private readonly target: BusyTarget,
    private readonly clock: Clock,
    private readonly timers: Timers,
    private readonly log: Log,
    private readonly loadBackend: () => Promise<CalendarBackend>,
    private readonly warn: Log = log,
  ) {}

  enable(watched: readonly string[]): void {
    if (this.active) return;
    this.active = true;
    this.watched = unique(watched);
    if (this.watched.length > 0) this.start();
  }

  /** `watched-calendars` changed. Never throws. */
  setWatched(watched: readonly string[]): void {
    if (!this.active) return;
    this.watched = unique(watched);
    if (!this.started) {
      if (this.watched.length > 0) this.start();
      return;
    }
    this.safely('updating the watched calendars', () => this.sync());
  }

  /**
   * Move the window on and read every calendar again; reopen any that failed.
   * Called on return from an absence (a suspend may have outlasted the window)
   * and by the periodic timer. Never throws: the caller goes on to tell the
   * scheduler the user is back.
   */
  refresh(): void {
    if (!this.active || this.backend === null) return;
    this.safely('refreshing the watched calendars', () => {
      this.sync();
      for (const entry of this.entries.values()) {
        if (entry.connection !== null) this.fetch(entry);
        else if (!entry.connecting) this.connect(entry);
      }
    });
  }

  /**
   * Cancel everything in flight, disconnect every signal, clear every timer.
   * Nothing reaches the scheduler afterwards.
   */
  disable(): void {
    if (!this.active) return;
    this.active = false;
    this.started = false;
    this.generation++;

    this.clearTimer('refreshTimer');
    this.clearTimer('retryTimer');

    const cancellable = this.cancellable;
    this.cancellable = null;
    cancellable?.cancel();

    for (const entry of this.entries.values()) this.disconnect(entry);
    this.entries.clear();

    this.backend = null;
    this.lastPublished = null;
  }

  // -- start-up ----------------------------------------------------------------

  private start(): void {
    this.started = true;
    const generation = this.generation;
    let loading: Promise<CalendarBackend>;
    try {
      loading = this.loadBackend();
    } catch (err) {
      this.unavailable(generation, err);
      return;
    }
    loading.then(
      (backend) =>
        this.safely('opening the watched calendars', () => this.ready(generation, backend)),
      (err: unknown) => this.unavailable(generation, err),
    );
  }

  private ready(generation: number, backend: CalendarBackend): void {
    if (generation !== this.generation) return;
    this.backend = backend;
    this.cancellable = backend.createCancellable();
    this.sync();
    this.armRefresh();
  }

  /** One journal line; the gate stays inert and breaks carry on (spec §3). */
  private unavailable(generation: number, err: unknown): void {
    if (generation !== this.generation) return;
    this.warn(
      'hardbreak: calendar pause is unavailable — the introspection data for Evolution Data ' +
        'Server (gir1.2-ecal-2.0, gir1.2-edataserver-1.2, gir1.2-ical-3.0) could not be ' +
        'loaded; breaks are not affected',
      err,
    );
  }

  // -- calendars ---------------------------------------------------------------

  /** Open what is watched, drop what no longer is. */
  private sync(): void {
    const backend = this.backend;
    if (backend === null) return;
    let dropped = false;
    for (const [uid, entry] of this.entries) {
      if (this.watched.includes(uid)) continue;
      this.disconnect(entry);
      this.entries.delete(uid);
      dropped = true;
    }
    for (const uid of this.watched) {
      if (this.entries.has(uid)) continue;
      const entry: Entry = {
        uid,
        source: backend.source(uid),
        connection: null,
        unwatch: null,
        connecting: false,
        fetching: false,
        again: false,
        intervals: [],
        epoch: 0,
        retried: false,
        warned: false,
      };
      this.entries.set(uid, entry);
      this.connect(entry);
    }
    if (dropped) this.publish();
  }

  private connect(entry: Entry): void {
    const cancellable = this.cancellable;
    if (cancellable === null) return;
    const generation = this.generation;
    const epoch = ++entry.epoch;
    entry.connecting = true;
    entry.source.connect(cancellable).then(
      (connection) =>
        this.safely(`opening calendar ${entry.uid}`, () => {
          if (!this.current(generation, entry, epoch)) return;
          entry.connecting = false;
          entry.warned = false;
          entry.connection = connection;
          entry.unwatch = connection.watch({
            changed: () =>
              this.safely(`a change to calendar ${entry.uid}`, () => this.fetch(entry)),
            died: () => this.safely(`calendar ${entry.uid} going away`, () => this.died(entry)),
          });
          this.fetch(entry);
        }),
      (err: unknown) => {
        if (!this.current(generation, entry, epoch)) return;
        entry.connecting = false;
        if (!entry.warned) {
          entry.warned = true;
          this.warn(
            `hardbreak: could not open calendar ${entry.uid} (unknown, disabled or not a ` +
              'calendar?); keeping what was known and trying again later',
            err,
          );
        }
        this.retryOnce(entry);
      },
    );
  }

  private fetch(entry: Entry): void {
    const connection = entry.connection;
    const cancellable = this.cancellable;
    if (connection === null || cancellable === null) return;
    if (entry.fetching) {
      entry.again = true;
      return;
    }
    entry.fetching = true;
    entry.again = false;
    const generation = this.generation;
    const epoch = entry.epoch;
    const startWall = this.clock.wallNow();
    const settle = (): void => {
      entry.fetching = false;
      if (entry.again) this.fetch(entry);
    };
    connection.fetch(startWall, startWall + CALENDAR_WINDOW_MS, cancellable).then(
      (intervals) => {
        if (!this.current(generation, entry, epoch)) return;
        entry.intervals = intervals;
        entry.retried = false;
        // Settled whatever publishing does, or the next change would wait on
        // a read that has already finished.
        this.safely(`publishing calendar ${entry.uid}`, () => this.publish());
        this.safely(`reading calendar ${entry.uid} again`, settle);
      },
      (err: unknown) => {
        if (!this.current(generation, entry, epoch)) return;
        this.warn(`hardbreak: could not read calendar ${entry.uid}; keeping what was known`, err);
        this.safely(`reading calendar ${entry.uid} again`, settle);
      },
    );
  }

  /** The backend died: keep its intervals, reconnect later. */
  private died(entry: Entry): void {
    this.warn(`hardbreak: the backend of calendar ${entry.uid} died; keeping what was known`);
    this.disconnect(entry);
    this.retryOnce(entry);
  }

  /** Drop the connection and its signals; keep the last known intervals. */
  private disconnect(entry: Entry): void {
    entry.epoch++;
    const unwatch = entry.unwatch;
    entry.unwatch = null;
    entry.connection = null;
    entry.connecting = false;
    entry.fetching = false;
    entry.again = false;
    unwatch?.();
  }

  private current(generation: number, entry: Entry, epoch: number): boolean {
    return (
      generation === this.generation &&
      this.entries.get(entry.uid) === entry &&
      entry.epoch === epoch
    );
  }

  /** Merge every calendar's intervals and hand them over, unless unchanged. */
  private publish(): void {
    if (!this.active) return;
    const intervals = normalizeBusyIntervals(
      [...this.entries.values()].flatMap((entry) => entry.intervals),
    );
    const key = JSON.stringify(intervals);
    if (key === this.lastPublished) return;
    this.target.setBusyIntervals(intervals);
    // Only once it was taken: a scheduler that threw gets the list again.
    this.lastPublished = key;
  }

  // -- timers ------------------------------------------------------------------

  private armRefresh(): void {
    this.clearTimer('refreshTimer');
    this.refreshTimer = this.timers.set(CALENDAR_REFRESH_MS, () => {
      this.refreshTimer = null;
      this.refresh();
      if (this.active) this.armRefresh();
    });
  }

  /**
   * One quick retry per failure: EDS restarts a dead backend on the next
   * connection. If that fails as well, the calendar waits for the next refresh
   * rather than hammering a backend that is down.
   */
  private retryOnce(entry: Entry): void {
    if (entry.retried) return;
    entry.retried = true;
    this.armRetry();
  }

  private armRetry(): void {
    if (!this.active || this.retryTimer !== null) return;
    this.retryTimer = this.timers.set(CALENDAR_RETRY_MS, () => {
      this.retryTimer = null;
      this.refresh();
    });
  }

  private clearTimer(slot: 'refreshTimer' | 'retryTimer'): void {
    const handle = this[slot];
    this[slot] = null;
    if (handle === null) return;
    try {
      this.timers.clear(handle);
    } catch (err) {
      this.log(`hardbreak: failed to clear the calendar ${slot}`, err);
    }
  }

  /** Nothing thrown from an EDS callback may escape into the main loop. */
  private safely(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log(`hardbreak: ${label} failed`, err);
    }
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
