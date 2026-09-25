/**
 * Calendar watcher lifecycle and the busy-event rules, with a fake EDS behind
 * the `CalendarBackend` port. `eds.ts` itself needs GObject introspection and a
 * running Evolution Data Server, so it is not exercised here.
 */

import { describe, expect, mock, test } from 'bun:test';

import type { BusyInterval } from '../core/calendar.js';
import { createFakeTimers, FakeClock } from '../core/testing.js';
import {
  applyOverrides,
  busyIntervalsOf,
  calendarChoices,
  CALENDAR_REFRESH_MS,
  CALENDAR_RETRY_MS,
  CALENDAR_WINDOW_MS,
  CalendarWatcher,
  isBusy,
  type CalendarBackend,
  type CalendarConnection,
  type CalendarSource,
  type Cancellable,
  type Occurrence,
  type Override,
  type SourceRecord,
} from './calendar.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// -- fakes ---------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every settled promise run its continuations. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

class FakeCancellable implements Cancellable {
  cancelled = 0;
  cancel(): void {
    this.cancelled++;
  }
}

class FakeConnection implements CalendarConnection {
  readonly fetches: { startWall: number; endWall: number; result: Deferred<BusyInterval[]> }[] = [];
  handlers: { changed(): void; died(): void } | null = null;
  unwatched = 0;

  fetch(startWall: number, endWall: number): Promise<BusyInterval[]> {
    const result = deferred<BusyInterval[]>();
    this.fetches.push({ startWall, endWall, result });
    return result.promise;
  }

  watch(handlers: { changed(): void; died(): void }): () => void {
    this.handlers = handlers;
    return () => {
      this.handlers = null;
      this.unwatched++;
    };
  }

  /** Answer the most recent read. */
  answer(intervals: BusyInterval[]): void {
    const last = this.fetches[this.fetches.length - 1];
    if (last === undefined) throw new Error('no read in flight');
    last.result.resolve(intervals);
  }
}

class FakeSource implements CalendarSource {
  readonly connects: Deferred<CalendarConnection>[] = [];
  constructor(readonly uid: string) {}

  connect(): Promise<CalendarConnection> {
    const result = deferred<CalendarConnection>();
    this.connects.push(result);
    return result.promise;
  }

  /** Complete the most recent connect with a fresh connection. */
  open(): FakeConnection {
    const connection = new FakeConnection();
    const last = this.connects[this.connects.length - 1];
    if (last === undefined) throw new Error('no connect in flight');
    last.resolve(connection);
    return connection;
  }
}

class FakeBackend implements CalendarBackend {
  readonly cancellables: FakeCancellable[] = [];
  readonly sources = new Map<string, FakeSource>();

  createCancellable(): Cancellable {
    const cancellable = new FakeCancellable();
    this.cancellables.push(cancellable);
    return cancellable;
  }

  source(uid: string): CalendarSource {
    return this.calendar(uid);
  }

  /** The fake calendar for `uid`, created on first use. */
  calendar(uid: string): FakeSource {
    let source = this.sources.get(uid);
    if (source === undefined) {
      source = new FakeSource(uid);
      this.sources.set(uid, source);
    }
    return source;
  }
}

function span(startMinutes: number, endMinutes: number, base: number): BusyInterval {
  return { startWall: base + startMinutes * MINUTE, endWall: base + endMinutes * MINUTE };
}

function mount(options: { failLoad?: boolean } = {}) {
  const clock = new FakeClock();
  const timers = createFakeTimers(clock);
  const published: BusyInterval[][] = [];
  const target = {
    setBusyIntervals: mock((intervals: readonly BusyInterval[]) => {
      published.push([...intervals]);
    }),
  };
  const log = mock((_msg: string, _err?: unknown) => {});
  const backend = new FakeBackend();
  const loadBackend = mock(() =>
    options.failLoad
      ? Promise.reject(new Error('Typelib file for namespace ECal not found'))
      : Promise.resolve<CalendarBackend>(backend),
  );
  const watcher = new CalendarWatcher(target, clock, timers, log, loadBackend);
  const base = clock.wallNow();

  /** Let the backend load. */
  async function ready(): Promise<void> {
    await flush();
  }

  return {
    clock,
    timers,
    published,
    target,
    log,
    backend,
    loadBackend,
    watcher,
    base,
    ready,
  };
}

// -- the watcher ---------------------------------------------------------------

describe('CalendarWatcher', () => {
  test('loads nothing while no calendar is watched', async () => {
    const m = mount();
    m.watcher.enable([]);
    await flush();
    expect(m.loadBackend).not.toHaveBeenCalled();
    expect(m.timers.pending).toBe(0);

    const work = m.backend.calendar('work');
    m.watcher.setWatched(['work']);
    await m.ready();
    expect(m.loadBackend).toHaveBeenCalledTimes(1);
    expect(work.connects).toHaveLength(1);
    m.watcher.disable();
  });

  test('publishes the merged busy intervals of every watched calendar for the next 48 h', async () => {
    const m = mount();
    const work = m.backend.calendar('work');
    const school = m.backend.calendar('school');
    m.watcher.enable(['work', 'school', 'work']);
    await m.ready();

    const workConnection = work.open();
    const schoolConnection = school.open();
    await flush();
    expect(workConnection.fetches).toEqual([
      expect.objectContaining({ startWall: m.base, endWall: m.base + CALENDAR_WINDOW_MS }),
    ]);

    workConnection.answer([span(60, 120, m.base)]);
    await flush();
    schoolConnection.answer([span(100, 180, m.base), span(300, 360, m.base)]);
    await flush();
    expect(m.published).toEqual([
      [span(60, 120, m.base)],
      [span(60, 180, m.base), span(300, 360, m.base)],
    ]);
    m.watcher.disable();
  });

  test('a change reads the calendar again, and changes during a read coalesce into one more', async () => {
    const m = mount();
    const work = m.backend.calendar('work');
    m.watcher.enable(['work']);
    await m.ready();
    const connection = work.open();
    await flush();
    expect(connection.fetches).toHaveLength(1);

    connection.handlers?.changed();
    connection.handlers?.changed();
    expect(connection.fetches).toHaveLength(1); // still one in flight
    connection.answer([span(10, 20, m.base)]);
    await flush();
    expect(connection.fetches).toHaveLength(2); // exactly one follow-up
    connection.answer([span(30, 40, m.base)]);
    await flush();
    expect(connection.fetches).toHaveLength(2);
    expect(m.published[m.published.length - 1]).toEqual([span(30, 40, m.base)]);
    m.watcher.disable();
  });

  test('identical results are not published twice', async () => {
    const m = mount();
    const work = m.backend.calendar('work');
    m.watcher.enable(['work']);
    await m.ready();
    const connection = work.open();
    await flush();
    connection.answer([span(10, 20, m.base)]);
    await flush();
    connection.handlers?.changed();
    connection.answer([span(10, 20, m.base)]);
    await flush();
    expect(m.target.setBusyIntervals).toHaveBeenCalledTimes(1);
    m.watcher.disable();
  });

  test('a failed read keeps the last known intervals', async () => {
    const m = mount();
    const work = m.backend.calendar('work');
    m.watcher.enable(['work']);
    await m.ready();
    const connection = work.open();
    await flush();
    connection.answer([span(10, 20, m.base)]);
    await flush();

    connection.handlers?.changed();
    connection.fetches[1]?.result.reject(new Error('backend error'));
    await flush();
    expect(m.published).toEqual([[span(10, 20, m.base)]]);
    expect(m.log).toHaveBeenCalledTimes(1);
    m.watcher.disable();
  });

  test('a dead backend keeps its intervals and is retried once, a minute later', async () => {
    const m = mount();
    const work = m.backend.calendar('work');
    m.watcher.enable(['work']);
    await m.ready();
    const first = work.open();
    await flush();
    first.answer([span(10, 20, m.base)]);
    await flush();

    first.handlers?.died();
    expect(first.unwatched).toBe(1);
    expect(m.published).toEqual([[span(10, 20, m.base)]]);

    m.timers.advance(CALENDAR_RETRY_MS);
    expect(work.connects).toHaveLength(2);
    work.connects[1]?.reject(new Error('still down'));
    await flush();
    // One retry per failure: the next attempt waits for the periodic refresh.
    m.timers.advance(CALENDAR_RETRY_MS * 10);
    expect(work.connects).toHaveLength(2);
    m.timers.advance(CALENDAR_REFRESH_MS);
    expect(work.connects).toHaveLength(3);
    const second = work.open();
    await flush();
    second.answer([span(40, 50, m.base)]);
    await flush();
    expect(m.published[m.published.length - 1]).toEqual([span(40, 50, m.base)]);
    m.watcher.disable();
  });

  test('missing bindings leave it inert: one journal line, the scheduler never called', async () => {
    const m = mount({ failLoad: true });
    m.watcher.enable(['work']);
    await flush();
    m.watcher.refresh();
    m.watcher.setWatched(['work', 'school']);
    await flush();
    expect(m.log).toHaveBeenCalledTimes(1);
    expect(String(m.log.mock.calls[0]?.[0])).toContain('gir1.2-ecal-2.0');
    expect(m.target.setBusyIntervals).not.toHaveBeenCalled();
    expect(m.timers.pending).toBe(0);
    m.watcher.disable();
  });

  test('a calendar that will not open is logged once, retried once, then on refresh', async () => {
    const m = mount();
    const stale = m.backend.calendar('stale');
    m.watcher.enable(['stale']);
    await m.ready();
    stale.connects[0]?.reject(new Error('No such source for UID "stale"'));
    await flush();
    expect(m.log).toHaveBeenCalledTimes(1);

    m.timers.advance(CALENDAR_RETRY_MS);
    expect(stale.connects).toHaveLength(2);
    stale.connects[1]?.reject(new Error('No such source for UID "stale"'));
    await flush();
    m.timers.advance(CALENDAR_REFRESH_MS - CALENDAR_RETRY_MS - 1);
    expect(stale.connects).toHaveLength(2);
    m.timers.advance(1);
    expect(stale.connects).toHaveLength(3);
    stale.connects[2]?.reject(new Error('No such source for UID "stale"'));
    await flush();
    // Still the one journal line, and the scheduler was never bothered.
    expect(m.log).toHaveBeenCalledTimes(1);
    expect(m.target.setBusyIntervals).not.toHaveBeenCalled();
    m.watcher.disable();
  });

  test('unwatching a calendar drops its intervals and disconnects it', async () => {
    const m = mount();
    const work = m.backend.calendar('work');
    const school = m.backend.calendar('school');
    m.watcher.enable(['work', 'school']);
    await m.ready();
    const workConnection = work.open();
    const schoolConnection = school.open();
    await flush();
    workConnection.answer([span(10, 20, m.base)]);
    schoolConnection.answer([span(30, 40, m.base)]);
    await flush();

    m.watcher.setWatched(['school']);
    expect(workConnection.unwatched).toBe(1);
    expect(m.published[m.published.length - 1]).toEqual([span(30, 40, m.base)]);

    m.watcher.setWatched([]);
    expect(m.published[m.published.length - 1]).toEqual([]);
    m.watcher.disable();
  });

  test('a calendar that appears later is opened on the next refresh', async () => {
    const m = mount();
    const later = m.backend.calendar('later');
    m.watcher.enable(['later']);
    await m.ready();
    later.connects[0]?.reject(new Error('No such source for UID "later"'));
    await flush();
    // The account shows up; the user comes back to the machine.
    m.watcher.refresh();
    expect(later.connects).toHaveLength(2);
    const connection = later.open();
    await flush();
    connection.answer([span(10, 20, m.base)]);
    await flush();
    expect(m.published).toEqual([[span(10, 20, m.base)]]);
    m.watcher.disable();
  });

  test('the window moves on every three hours and on refresh()', async () => {
    const m = mount();
    const work = m.backend.calendar('work');
    m.watcher.enable(['work']);
    await m.ready();
    const connection = work.open();
    await flush();
    connection.answer([]);
    await flush();

    m.timers.advance(CALENDAR_REFRESH_MS);
    expect(connection.fetches[1]?.startWall).toBe(m.base + CALENDAR_REFRESH_MS);
    connection.answer([]);
    await flush();

    m.clock.sleep(10 * HOUR); // a suspend: back from it, the extension calls refresh()
    m.watcher.refresh();
    expect(connection.fetches[2]?.startWall).toBe(m.base + CALENDAR_REFRESH_MS + 10 * HOUR);
    expect(connection.fetches[2]?.endWall).toBe(
      m.base + CALENDAR_REFRESH_MS + 10 * HOUR + CALENDAR_WINDOW_MS,
    );
    m.watcher.disable();
  });

  test('disable() cancels, disconnects, clears its timers and ignores late results', async () => {
    const m = mount();
    const work = m.backend.calendar('work');
    const school = m.backend.calendar('school');
    m.watcher.enable(['work', 'school']);
    await m.ready();
    const connection = work.open(); // school's connect stays in flight
    await flush();
    connection.handlers?.died(); // arms the retry timer
    connection.handlers = null;
    const fresh = new FakeConnection();
    m.timers.advance(CALENDAR_RETRY_MS);
    work.connects[1]?.resolve(fresh);
    await flush();
    expect(fresh.fetches).toHaveLength(1); // a read is in flight

    m.watcher.disable();
    expect(m.backend.cancellables[0]?.cancelled).toBe(1);
    expect(fresh.unwatched).toBe(1);
    expect(m.timers.pending).toBe(0);

    fresh.answer([span(10, 20, m.base)]);
    const late = school.open();
    await flush();
    expect(m.target.setBusyIntervals).not.toHaveBeenCalled();
    expect(late.handlers).toBeNull();
    expect(late.fetches).toHaveLength(0);

    // Disabling twice is harmless, and nothing runs afterwards.
    m.watcher.disable();
    m.watcher.refresh();
    m.watcher.setWatched(['work']);
    m.timers.advance(CALENDAR_REFRESH_MS * 2);
    expect(m.target.setBusyIntervals).not.toHaveBeenCalled();
  });

  test('disable() before the bindings have loaded leaves nothing behind', async () => {
    const m = mount();
    const work = m.backend.calendar('work');
    m.watcher.enable(['work']);
    m.watcher.disable();
    await flush();
    expect(m.backend.cancellables).toHaveLength(0);
    expect(work.connects).toHaveLength(0);
    expect(m.timers.pending).toBe(0);
  });

  test('a scheduler that throws does not escape into the main loop', async () => {
    const m = mount();
    m.target.setBusyIntervals.mockImplementation(() => {
      throw new Error('scheduler exploded');
    });
    const work = m.backend.calendar('work');
    m.watcher.enable(['work']);
    await m.ready();
    const connection = work.open();
    await flush();
    connection.answer([span(10, 20, m.base)]);
    await flush();
    expect(m.log).toHaveBeenCalledTimes(1);
    // The next change is still read.
    connection.handlers?.changed();
    expect(connection.fetches).toHaveLength(2);
    m.watcher.disable();
  });
});

// -- busy-event rules ------------------------------------------------------------

describe('busy events', () => {
  const base = Date.UTC(2026, 0, 5, 8, 0, 0);

  function occurrence(overrides: Partial<Occurrence> = {}): Occurrence {
    return {
      uid: 'class',
      recurrenceIdWall: base,
      startWall: base,
      endWall: base + HOUR,
      allDay: false,
      cancelled: false,
      transparent: false,
      ...overrides,
    };
  }

  test('only timed, opaque, confirmed, non-empty occurrences are busy', () => {
    expect(isBusy(occurrence())).toBe(true);
    expect(isBusy(occurrence({ allDay: true }))).toBe(false);
    expect(isBusy(occurrence({ cancelled: true }))).toBe(false);
    expect(isBusy(occurrence({ transparent: true }))).toBe(false);
    expect(isBusy(occurrence({ endWall: base }))).toBe(false);
    expect(isBusy(occurrence({ endWall: base - 1 }))).toBe(false);
    expect(isBusy(occurrence({ endWall: Number.NaN }))).toBe(false);
  });

  test('busyIntervalsOf keeps what overlaps the window, whole, and merges it', () => {
    const windowStart = base + 30 * MINUTE;
    const windowEnd = base + 5 * HOUR;
    expect(
      busyIntervalsOf(
        [
          occurrence(), // started before the window: kept, not cut
          occurrence({ startWall: base + HOUR, endWall: base + 2 * HOUR }), // touches: merged
          occurrence({ startWall: base + 3 * HOUR, endWall: base + 3 * HOUR, uid: 'empty' }),
          occurrence({ startWall: base + 4 * HOUR, endWall: base + 6 * HOUR }), // runs past: kept
          occurrence({ startWall: base - 2 * HOUR, endWall: base - HOUR }), // before
          occurrence({ startWall: base + 5 * HOUR, endWall: base + 6 * HOUR }), // at the end: out
          occurrence({ startWall: base + 2 * HOUR, endWall: base + 3 * HOUR, allDay: true }),
        ],
        windowStart,
        windowEnd,
      ),
    ).toEqual([
      { startWall: base, endWall: base + 2 * HOUR },
      { startWall: base + 4 * HOUR, endWall: base + 6 * HOUR },
    ]);
  });

  describe('applyOverrides', () => {
    const daily = [0, 1, 2].map((day) =>
      occurrence({
        recurrenceIdWall: base + day * 24 * HOUR,
        startWall: base + day * 24 * HOUR,
        endWall: base + day * 24 * HOUR + HOUR,
      }),
    );

    function override(values: Partial<Override>): Override {
      return {
        uid: 'class',
        recurrenceIdWall: base + 24 * HOUR,
        range: 'this',
        cancelled: false,
        transparent: false,
        occurrence: null,
        ...values,
      };
    }

    test('a moved occurrence replaces the one it names', () => {
      const moved = occurrence({
        recurrenceIdWall: base + 24 * HOUR,
        startWall: base + 26 * HOUR,
        endWall: base + 27 * HOUR,
      });
      const result = applyOverrides(daily, [override({ occurrence: moved })]);
      expect(result.map((o) => o.startWall)).toEqual([base, base + 26 * HOUR, base + 48 * HOUR]);
    });

    test('an occurrence moved out of the window disappears from it', () => {
      const result = applyOverrides(daily, [override({ occurrence: null })]);
      expect(result.map((o) => o.startWall)).toEqual([base, base + 48 * HOUR]);
    });

    test('an occurrence moved into the window from outside stands on its own', () => {
      const moved = occurrence({
        recurrenceIdWall: base - 7 * 24 * HOUR,
        startWall: base + 5 * HOUR,
        endWall: base + 6 * HOUR,
      });
      const result = applyOverrides(daily, [
        override({ recurrenceIdWall: base - 7 * 24 * HOUR, occurrence: moved }),
      ]);
      expect(result.map((o) => o.startWall)).toEqual([
        base,
        base + 24 * HOUR,
        base + 48 * HOUR,
        base + 5 * HOUR,
      ]);
    });

    test('a cancelled detached occurrence is kept, cancelled, so it is not busy', () => {
      const cancelled = occurrence({
        recurrenceIdWall: base + 24 * HOUR,
        startWall: base + 24 * HOUR,
        endWall: base + 25 * HOUR,
        cancelled: true,
      });
      const result = applyOverrides(daily, [override({ cancelled: true, occurrence: cancelled })]);
      expect(result.filter(isBusy).map((o) => o.startWall)).toEqual([base, base + 48 * HOUR]);
    });

    test('THISANDFUTURE lends its status to later occurrences, times unchanged', () => {
      const result = applyOverrides(daily, [
        override({ range: 'thisandfuture', transparent: true, occurrence: null }),
      ]);
      expect(result.map((o) => [o.startWall, o.transparent])).toEqual([
        [base, false],
        [base + 48 * HOUR, true],
      ]);
    });

    test('THISANDPRIOR lends its status to earlier occurrences', () => {
      const result = applyOverrides(daily, [
        override({ range: 'thisandprior', cancelled: true, occurrence: null }),
      ]);
      expect(result.map((o) => [o.startWall, o.cancelled])).toEqual([
        [base, true],
        [base + 48 * HOUR, false],
      ]);
    });

    test('overrides of another series change nothing', () => {
      const result = applyOverrides(daily, [override({ uid: 'other', occurrence: null })]);
      expect(result).toEqual(daily);
    });

    test('the input is not mutated', () => {
      const copy = daily.map((o) => ({ ...o }));
      applyOverrides(daily, [override({ range: 'thisandfuture', cancelled: true })]);
      expect(daily).toEqual(copy);
    });
  });
});

// -- the preferences' calendar list ---------------------------------------------

describe('calendarChoices', () => {
  function record(values: Partial<SourceRecord> & { uid: string }): SourceRecord {
    return {
      displayName: values.uid,
      parentUid: null,
      enabled: true,
      hasCalendar: false,
      collectionCalendarEnabled: null,
      ...values,
    };
  }

  const registry: SourceRecord[] = [
    record({ uid: 'local-stub', displayName: 'On This Computer' }),
    record({
      uid: 'system-calendar',
      displayName: 'Personal',
      parentUid: 'local-stub',
      hasCalendar: true,
    }),
    record({ uid: 'account', displayName: 'me@example.org', collectionCalendarEnabled: true }),
    record({ uid: 'work', displayName: 'Calendrier', parentUid: 'account', hasCalendar: true }),
    record({ uid: 'classes', displayName: 'Classes', parentUid: 'account', hasCalendar: true }),
    record({ uid: 'book', displayName: 'Contacts', parentUid: 'account' }),
    record({
      uid: 'off',
      displayName: 'Off',
      parentUid: 'account',
      hasCalendar: true,
      enabled: false,
    }),
    record({ uid: 'gone', displayName: 'Orphan', parentUid: 'no-such-parent', hasCalendar: true }),
  ];

  test('lists enabled calendars with their account, sorted by account then name', () => {
    expect(calendarChoices(registry)).toEqual([
      { uid: 'work', name: 'Calendrier', account: 'me@example.org' },
      { uid: 'classes', name: 'Classes', account: 'me@example.org' },
      { uid: 'gone', name: 'Orphan', account: 'On this computer' },
      { uid: 'system-calendar', name: 'Personal', account: 'On this computer' },
    ]);
  });

  test('an account that is disabled, or has its calendars switched off, hides them', () => {
    const disabled = registry.map((r) => (r.uid === 'account' ? { ...r, enabled: false } : r));
    expect(calendarChoices(disabled).map((c) => c.uid)).toEqual(['gone', 'system-calendar']);
    const noCalendars = registry.map((r) =>
      r.uid === 'account' ? { ...r, collectionCalendarEnabled: false } : r,
    );
    expect(calendarChoices(noCalendars).map((c) => c.uid)).toEqual(['gone', 'system-calendar']);
  });

  test('a nameless calendar is shown by its uid, and a parent cycle does not hang', () => {
    expect(
      calendarChoices([
        record({ uid: 'a', displayName: '', parentUid: 'b', hasCalendar: true }),
        record({ uid: 'b', displayName: 'B', parentUid: 'a' }),
      ]),
    ).toEqual([{ uid: 'a', name: 'a', account: 'B' }]);
  });
});
