/**
 * The preferences' view of Evolution Data Server's sources, read from the
 * registry *service* over D-Bus (`org.gnome.evolution.dataserver.Sources5`)
 * with one async `GetManagedObjects` call.
 *
 * Deliberately not `EDataServer.SourceRegistry`: its dispose spins the main
 * context while GJS tears the process down, which crashes it (see `eds.ts`).
 * The key-file `Data` of each source is parsed with `GLib.KeyFile`, and
 * `calendarChoices()` in `calendar.ts` decides what to offer. Used by
 * `prefs.ts` only; the Shell never lists sources.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type { SourceRecord } from './calendar.js';

/** EDS's source registry service and its object manager. */
const SOURCES_BUS = 'org.gnome.evolution.dataserver.Sources5';
const SOURCES_PATH = '/org/gnome/evolution/dataserver/SourceManager';
const SOURCE_INTERFACE = 'org.gnome.evolution.dataserver.Source';

/** Every source the registry service knows: its uid and its key-file data. */
export function readSourceRecords(cancellable: Gio.Cancellable): Promise<SourceRecord[]> {
  return new Promise((resolve, reject) => {
    Gio.bus_get(Gio.BusType.SESSION, cancellable, (_source, busResult) => {
      let bus: Gio.DBusConnection;
      try {
        bus = Gio.bus_get_finish(busResult);
      } catch (err) {
        reject(err);
        return;
      }
      bus.call(
        SOURCES_BUS,
        SOURCES_PATH,
        'org.freedesktop.DBus.ObjectManager',
        'GetManagedObjects',
        null,
        new GLib.VariantType('(a{oa{sa{sv}}})'),
        Gio.DBusCallFlags.NONE,
        -1,
        cancellable,
        (_connection, result) => {
          try {
            const [objects] = bus.call_finish(result).recursiveUnpack() as [
              Record<string, Record<string, Record<string, unknown>>>,
            ];
            const records: SourceRecord[] = [];
            for (const interfaces of Object.values(objects)) {
              const properties = interfaces[SOURCE_INTERFACE];
              const uid = properties?.['UID'];
              const data = properties?.['Data'];
              if (typeof uid === 'string' && typeof data === 'string') {
                records.push(parseSourceData(uid, data));
              }
            }
            resolve(records);
          } catch (err) {
            reject(err);
          }
        },
      );
    });
  });
}

/** An EDS source's key file: `[Data Source]` plus one group per extension. */
function parseSourceData(uid: string, data: string): SourceRecord {
  const file = new GLib.KeyFile();
  // The length is in bytes (a gsize: -1 is rejected by GJS).
  file.load_from_data(data, new TextEncoder().encode(data).length, GLib.KeyFileFlags.NONE);
  const text = (group: string, key: string): string | null => {
    try {
      return file.get_locale_string(group, key, null);
    } catch {
      return null;
    }
  };
  const flag = (group: string, key: string): boolean | null => {
    try {
      return file.get_boolean(group, key);
    } catch {
      return null;
    }
  };
  const parent = text('Data Source', 'Parent');
  return {
    uid,
    displayName: text('Data Source', 'DisplayName') ?? '',
    parentUid: parent === null || parent === '' ? null : parent,
    enabled: flag('Data Source', 'Enabled') ?? true,
    hasCalendar: file.has_group('Calendar'),
    collectionCalendarEnabled: file.has_group('Collection')
      ? (flag('Collection', 'CalendarEnabled') ?? true)
      : null,
  };
}
