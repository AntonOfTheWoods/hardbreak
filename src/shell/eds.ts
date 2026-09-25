/**
 * Evolution Data Server behind the calendar watcher's port (ADR 0001,
 * architecture §5). Everything here runs in the Shell process, so:
 *
 * - **No `EDataServer.SourceRegistry`.** Its dispose spins the main context it
 *   was created on (`source_registry_dispose()` iterates it until nothing is
 *   pending), and GJS drops the last reference while it tears the JavaScript
 *   context down — so with a registry held, every Shell exit dispatched Shell
 *   sources into a dying context and segfaulted (reproduced under a headless
 *   Shell 50.1 and in plain gjs). A calendar is opened from a scratch
 *   `ESource` carrying only its uid (`EDataServer.Source.new_with_uid`, no
 *   D-Bus): the calendar factory resolves the uid in its own registry, and a
 *   uid that is unknown, disabled or not a calendar just fails to open.
 * - **Async only.** Every calendar connection, every query and every
 *   time-zone lookup that can reach D-Bus uses the GAsyncReadyCallback
 *   form. libecal runs those in a GTask worker (or its private D-Bus thread)
 *   and delivers the callback on the thread-default main context of the
 *   caller, i.e. the Shell's main loop. There are no `*_sync` D-Bus calls, and
 *   no `ECal.ClientView`: its `start()`/`stop()` are synchronous D-Bus calls
 *   with no async variant in libecal 3.56. Live updates come from the client's
 *   `backend-property-changed` signal for `revision`, which the file backend
 *   and every `ECalMetaBackend` (Microsoft 365, EWS, CalDAV, Google) bump on
 *   each change, and which libecal emits from an idle source on the client's
 *   main context.
 * - **Main thread only.** Recurrences are expanded with
 *   `ECal.recur_generate_instances_sync()`: plain CPU work over components
 *   already fetched, with both callbacks invoked synchronously on this thread
 *   (`scope call`). Its time-zone callback never does D-Bus: it answers from
 *   the client's own cache and libical's built-in zones, and anything missing
 *   is fetched beforehand with the async `ECal.Client.get_timezone()`.
 *   `ECal.Client.generate_instances()` is not used: it resolves time zones with
 *   `e_cal_client_tzlookup_cb()`, which falls back to a synchronous D-Bus call
 *   on a cache miss, and it offers no completion signal to JavaScript.
 *
 * The typelibs are optional at runtime, so they are loaded with dynamic
 * `import()`; a missing one rejects {@link loadEdsBackend} and leaves the
 * watcher inert instead of stopping the extension from loading.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type ECalNamespace from 'gi://ECal?version=2.0';
import type EDataServerNamespace from 'gi://EDataServer?version=1.2';
import type ICalGLibNamespace from 'gi://ICalGLib?version=3.0';

import type { BusyInterval } from '../core/calendar.js';
import type { Log } from '../core/types.js';
import {
  applyOverrides,
  busyIntervalsOf,
  type CalendarBackend,
  type CalendarConnection,
  type CalendarSource,
  type Cancellable,
  type Occurrence,
  type Override,
  type OverrideRange,
} from './calendar.js';

type ECalModule = typeof ECalNamespace;
type EDataServerModule = typeof EDataServerNamespace;
type ICalGLibModule = typeof ICalGLibNamespace;
type ICalComponent = ICalGLibNamespace.Component;
type ICalProperty = ICalGLibNamespace.Property;
type ICalTime = ICalGLibNamespace.Time;
type ICalTimezone = ICalGLibNamespace.Timezone;
type ECalClient = ECalNamespace.Client;

/** The three optional typelibs (`gir1.2-ecal-2.0`, `-edataserver-1.2`, `-ical-3.0`). */
export interface EdsBindings {
  readonly ECal: ECalModule;
  readonly EDataServer: EDataServerModule;
  readonly ICalGLib: ICalGLibModule;
}

/** Rejects when any of the typelibs is missing. */
export async function loadEdsBindings(): Promise<EdsBindings> {
  const [ecal, edataserver, icalglib] = await Promise.all([
    import('gi://ECal?version=2.0'),
    import('gi://EDataServer?version=1.2'),
    import('gi://ICalGLib?version=3.0'),
  ]);
  return { ECal: ecal.default, EDataServer: edataserver.default, ICalGLib: icalglib.default };
}

/** The watcher's backend, or a rejection when EDS cannot be used at all. */
export async function loadEdsBackend(log: Log): Promise<CalendarBackend> {
  return new EdsBackend(await loadEdsBindings(), log);
}

/** `e_cal_client_connect()`'s "do not wait for the backend to be online": `(guint32) -1`. */
const DONT_WAIT_FOR_CONNECTED = 0xffff_ffff;

/** Series fetched per `(uid? …)` query in the second pass. */
const UIDS_PER_QUERY = 50;

class EdsBackend implements CalendarBackend {
  constructor(
    private readonly gi: EdsBindings,
    private readonly log: Log,
  ) {}

  createCancellable(): Cancellable {
    return new Gio.Cancellable();
  }

  source(uid: string): CalendarSource {
    return new EdsSource(this.gi, uid, this.log);
  }
}

class EdsSource implements CalendarSource {
  constructor(
    private readonly gi: EdsBindings,
    readonly uid: string,
    private readonly log: Log,
  ) {}

  connect(cancellable: Cancellable): Promise<CalendarConnection> {
    const { ECal, EDataServer } = this.gi;
    return new Promise((resolve, reject) => {
      let source: EDataServerNamespace.Source;
      try {
        // A scratch source: the uid and nothing else. No D-Bus, no registry.
        source = EDataServer.Source.new_with_uid(this.uid, null);
      } catch (err) {
        reject(err);
        return;
      }
      // Not waiting for the backend to be online: its cache answers at once,
      // and the revision bump after the backend's own sync reads it again.
      ECal.Client.connect(
        source,
        ECal.ClientSourceType.EVENTS,
        DONT_WAIT_FOR_CONNECTED,
        asGio(cancellable),
        (_source, result) => {
          try {
            const client = ECal.Client.connect_finish(result) as ECalClient | null;
            if (client === null) throw new Error(`no client for calendar ${this.uid}`);
            resolve(new EdsConnection(this.gi, client, this.uid, this.log));
          } catch (err) {
            reject(err);
          }
        },
      );
    });
  }
}

class EdsConnection implements CalendarConnection {
  /** TZIDs neither cached, built in nor known to the backend: floating from now on. */
  private readonly unresolvable = new Set<string>();

  constructor(
    private readonly gi: EdsBindings,
    private readonly client: ECalClient,
    private readonly uid: string,
    private readonly log: Log,
  ) {}

  watch(handlers: { changed(): void; died(): void }): () => void {
    const client = this.client;
    let revision: string | null = null;
    const ids = [
      client.connect('backend-property-changed', (_client, name: string, value: string) => {
        // The backend bumps `revision` on every change of its contents.
        if (name !== 'revision' || value === revision) return;
        revision = value;
        handlers.changed();
      }),
      client.connect('backend-died', () => handlers.died()),
    ];
    return () => {
      for (const id of ids) client.disconnect(id);
    };
  }

  async fetch(
    startWall: number,
    endWall: number,
    cancellable: Cancellable,
  ): Promise<BusyInterval[]> {
    const inWindow = await this.objects(occurInTimeRange(startWall, endWall), cancellable);

    // Second pass: every component of each recurring series in the window. A
    // detached occurrence moved *out* of the window is not returned by the
    // first query, yet it has to cancel the occurrence its series generates
    // inside the window.
    const seriesUids = [
      ...new Set(inWindow.filter((component) => this.isRecurringMaster(component)).map(uidOf)),
    ];
    const series: ICalComponent[] = [];
    for (let i = 0; i < seriesUids.length; i += UIDS_PER_QUERY) {
      series.push(
        ...(await this.objects(anyUid(seriesUids.slice(i, i + UIDS_PER_QUERY)), cancellable)),
      );
    }

    const components = new Map<string, ICalComponent>();
    for (const component of [...inWindow, ...series]) {
      components.set(this.keyOf(component), component);
    }
    await this.prefetchTimezones([...components.values()], cancellable);
    return this.expand([...components.values()], startWall, endWall, cancellable);
  }

  // -- queries -----------------------------------------------------------------

  private objects(sexp: string, cancellable: Cancellable): Promise<ICalComponent[]> {
    return new Promise((resolve, reject) => {
      this.client.get_object_list(sexp, asGio(cancellable), (_client, result) => {
        try {
          // An empty result is `[false, []]` without an error (libecal returns
          // FALSE for an empty GSList), so the flag is not an error indicator.
          const [, components] = this.client.get_object_list_finish(result);
          resolve(components ?? []);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * Make every TZID resolvable without D-Bus before expanding: whatever the
   * client cache and libical's built-in zones do not know is asked of the
   * backend asynchronously, which also stores it in the client's cache.
   */
  private async prefetchTimezones(
    components: readonly ICalComponent[],
    cancellable: Cancellable,
  ): Promise<void> {
    const missing = new Set<string>();
    for (const component of components) {
      try {
        component.foreach_tzid((param) => {
          const tzid = param.get_tzid();
          if (tzid && !this.unresolvable.has(tzid) && this.zone(tzid) === null) missing.add(tzid);
        });
      } catch (err) {
        this.log(`hardbreak: could not list the time zones of an event in ${this.uid}`, err);
      }
    }
    await Promise.all([...missing].map((tzid) => this.fetchTimezone(tzid, cancellable)));
  }

  private fetchTimezone(tzid: string, cancellable: Cancellable): Promise<void> {
    return new Promise((resolve) => {
      this.client.get_timezone(tzid, asGio(cancellable), (_client, result) => {
        try {
          this.client.get_timezone_finish(result);
        } catch (err) {
          if (!isCancelled(err)) {
            this.unresolvable.add(tzid);
            this.log(
              `hardbreak: time zone ${JSON.stringify(tzid)} of calendar ${this.uid} is unknown; ` +
                'its events are read as local time',
              err,
            );
          }
        }
        resolve();
      });
    });
  }

  /**
   * TZID → zone, without any D-Bus: the client's cache (which also maps
   * libical's and Evolution's aliases onto built-in zones), then libical's
   * built-in zones by TZID and by location. `null` makes the recurrence code
   * fall back to the default (local) zone.
   */
  private zone(tzid: string): ICalTimezone | null {
    const { ECal, ICalGLib } = this.gi;
    if (tzid === 'UTC') return ICalGLib.Timezone.get_utc_timezone();
    try {
      const cached = ECal.TimezoneCache.prototype.get_timezone.call(this.client, tzid);
      if (cached) return cached;
    } catch {
      // Fall through to the built-in zones.
    }
    return (
      (ICalGLib.Timezone.get_builtin_timezone_from_tzid(tzid) as ICalTimezone | null) ??
      ICalGLib.Timezone.get_builtin_timezone(tzid)
    );
  }

  // -- expansion ---------------------------------------------------------------

  private expand(
    components: readonly ICalComponent[],
    startWall: number,
    endWall: number,
    cancellable: Cancellable,
  ): BusyInterval[] {
    const { ECal, ICalGLib } = this.gi;
    const utc = ICalGLib.Timezone.get_utc_timezone();
    const localZone = this.localZone();
    const intervalStart = ICalGLib.Time.new_from_timet_with_zone(
      Math.floor(startWall / 1000),
      0,
      utc,
    );
    const intervalEnd = ICalGLib.Time.new_from_timet_with_zone(Math.ceil(endWall / 1000), 0, utc);

    const occurrences: Occurrence[] = [];
    const overrides: Override[] = [];
    let unreadable = 0;
    for (const component of components) {
      try {
        const uid = uidOf(component);
        const cancelled = this.isCancelled(component);
        const transparent = this.isTransparent(component);
        const found: Occurrence[] = [];
        ECal.recur_generate_instances_sync(
          component,
          intervalStart,
          intervalEnd,
          (_component, instanceStart, instanceEnd) => {
            const startOf = toWall(instanceStart);
            found.push({
              uid,
              recurrenceIdWall: startOf,
              startWall: startOf,
              endWall: toWall(instanceEnd),
              allDay: instanceStart.is_date(),
              cancelled,
              transparent,
            });
            return true;
          },
          (tzid) => (this.unresolvable.has(tzid) ? null : this.zone(tzid)),
          localZone,
          asGio(cancellable),
        );

        const recurrenceId = component.get_first_property(
          ICalGLib.PropertyKind.RECURRENCEID_PROPERTY,
        );
        if (recurrenceId === null) {
          occurrences.push(...found);
          continue;
        }
        const recurrenceIdWall = this.recurrenceIdWall(recurrenceId, localZone);
        const own = found[0];
        overrides.push({
          uid,
          recurrenceIdWall,
          range: this.rangeOf(recurrenceId),
          cancelled,
          transparent,
          occurrence: own === undefined ? null : { ...own, recurrenceIdWall },
        });
      } catch (err) {
        if (isCancelled(err)) throw err;
        unreadable++;
      }
    }
    if (unreadable > 0) {
      this.log(`hardbreak: skipped ${unreadable} unreadable event(s) in calendar ${this.uid}`);
    }
    return busyIntervalsOf(applyOverrides(occurrences, overrides), startWall, endWall);
  }

  /** Floating times and unknown zones are local time, as in any calendar app. */
  private localZone(): ICalTimezone {
    const { ICalGLib } = this.gi;
    try {
      const zone = ICalGLib.Timezone.get_builtin_timezone(
        GLib.TimeZone.new_local().get_identifier(),
      );
      if (zone) return zone;
    } catch {
      // UTC below.
    }
    return ICalGLib.Timezone.get_utc_timezone();
  }

  private recurrenceIdWall(property: ICalProperty, localZone: ICalTimezone): number {
    const { ICalGLib } = this.gi;
    const time = property.get_recurrenceid();
    if (time.is_utc()) return time.as_timet_with_zone(ICalGLib.Timezone.get_utc_timezone()) * 1000;
    const param = property.get_first_parameter(
      ICalGLib.ParameterKind.TZID_PARAMETER,
    ) as ICalGLibNamespace.Parameter | null;
    const tzid = param?.get_tzid() ?? null;
    const zone = tzid === null || this.unresolvable.has(tzid) ? null : this.zone(tzid);
    return time.as_timet_with_zone(zone ?? localZone) * 1000;
  }

  private rangeOf(property: ICalProperty): OverrideRange {
    const { ICalGLib } = this.gi;
    const param = property.get_first_parameter(
      ICalGLib.ParameterKind.RANGE_PARAMETER,
    ) as ICalGLibNamespace.Parameter | null;
    if (param === null) return 'this';
    switch (param.get_range()) {
      case ICalGLib.ParameterRange.THISANDFUTURE:
        return 'thisandfuture';
      case ICalGLib.ParameterRange.THISANDPRIOR:
        return 'thisandprior';
      default:
        return 'this';
    }
  }

  private isRecurringMaster(component: ICalComponent): boolean {
    const { PropertyKind } = this.gi.ICalGLib;
    return (
      component.get_first_property(PropertyKind.RECURRENCEID_PROPERTY) === null &&
      (component.get_first_property(PropertyKind.RRULE_PROPERTY) !== null ||
        component.get_first_property(PropertyKind.RDATE_PROPERTY) !== null)
    );
  }

  /** `STATUS:CANCELLED`. (`Component.get_status()` throws when STATUS is absent.) */
  private isCancelled(component: ICalComponent): boolean {
    const { ICalGLib } = this.gi;
    try {
      const status = component.get_first_property(ICalGLib.PropertyKind.STATUS_PROPERTY);
      return status !== null && status.get_status() === ICalGLib.PropertyStatus.CANCELLED;
    } catch {
      return false;
    }
  }

  /** `TRANSP:TRANSPARENT`: free time. Absent or unreadable means opaque (RFC 5545). */
  private isTransparent(component: ICalComponent): boolean {
    const { ICalGLib } = this.gi;
    try {
      const transp = component
        .get_first_property(ICalGLib.PropertyKind.TRANSP_PROPERTY)
        ?.get_transp();
      return (
        transp === ICalGLib.PropertyTransp.TRANSPARENT ||
        transp === ICalGLib.PropertyTransp.TRANSPARENTNOCONFLICT
      );
    } catch {
      return false;
    }
  }

  /** uid + RECURRENCE-ID: one master or one detached instance. */
  private keyOf(component: ICalComponent): string {
    const recurrenceId = component.get_first_property(
      this.gi.ICalGLib.PropertyKind.RECURRENCEID_PROPERTY,
    );
    return `${uidOf(component)}\n${recurrenceId?.as_ical_string() ?? ''}`;
  }
}

function uidOf(component: ICalComponent): string {
  return component.get_uid() ?? '';
}

/** Epoch ms of an instance boundary; e-cal-recur sets the zone on every time it hands out. */
function toWall(time: ICalTime): number {
  return time.as_timet_with_zone(time.get_timezone()) * 1000;
}

/** EDS's `YYYYMMDDTHHMMSSZ`. */
function isoUtc(wallMs: number): string {
  return new Date(wallMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function occurInTimeRange(startWall: number, endWall: number): string {
  return `(occur-in-time-range? (make-time "${isoUtc(startWall)}") (make-time "${isoUtc(endWall)}"))`;
}

function anyUid(uids: readonly string[]): string {
  const terms = uids.map((uid) => `(uid? ${sexpString(uid)})`);
  return terms.length === 1 ? (terms[0] ?? '') : `(or ${terms.join(' ')})`;
}

/** An S-expression string literal: backslash and double quote escaped. */
function sexpString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function asGio(cancellable: Cancellable): Gio.Cancellable {
  return cancellable as Gio.Cancellable;
}

function isCancelled(err: unknown): boolean {
  return err instanceof GLib.Error && err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}
