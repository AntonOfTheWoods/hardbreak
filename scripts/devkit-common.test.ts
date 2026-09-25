import { expect, test } from 'bun:test';
import {
  BLOCKED_BUS_NAMES,
  busConfig,
  EDS_XDG,
  edsStubService,
  execArg,
  parseServiceFile,
  standardSessionServiceDirs,
  stubService,
  SYSTEM_SESSION_CONF,
} from './devkit-common.js';

test('the stub service dir is listed before the stock session config, so it wins', () => {
  const xml = busConfig('/repo/tmp/devkit/dbus/services');
  const servicedir = xml.indexOf('<servicedir>/repo/tmp/devkit/dbus/services</servicedir>');
  const include = xml.indexOf(`<include>${SYSTEM_SESSION_CONF}</include>`);
  expect(servicedir).toBeGreaterThan(-1);
  expect(include).toBeGreaterThan(servicedir);
});

test('paths are escaped as XML text', () => {
  expect(busConfig('/a&b/<c>')).toContain('<servicedir>/a&amp;b/&lt;c&gt;</servicedir>');
});

test('each blocked name fails to spawn rather than being unknown (EDS deletes GOA sources on ServiceUnknown)', () => {
  for (const name of BLOCKED_BUS_NAMES) {
    const lines = stubService(name).split('\n');
    expect(lines).toContain('[D-BUS Service]');
    expect(lines).toContain(`Name=${name}`);
    expect(lines).toContain('Exec=/bin/false');
  }
});

test('session service dirs follow dbus-daemon precedence, without duplicates', () => {
  expect(
    standardSessionServiceDirs({
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_DATA_HOME: '/home/u/.local/share',
      XDG_DATA_DIRS: '/usr/share/ubuntu:/usr/local/share/:/usr/share/',
    }),
  ).toEqual([
    '/run/user/1000/dbus-1/services',
    '/home/u/.local/share/dbus-1/services',
    '/usr/share/ubuntu/dbus-1/services',
    '/usr/local/share/dbus-1/services',
    '/usr/share/dbus-1/services',
  ]);
});

test('service files yield Name and the raw Exec of the [D-BUS Service] group only', () => {
  const text = [
    '# comment',
    '[D-BUS Service]',
    'Name=org.gnome.evolution.dataserver.Sources5',
    'Exec=/usr/libexec/evolution-source-registry --flag\\sx',
    'SystemdService=evolution-source-registry.service',
    '[Other]',
    'Exec=/bin/nope',
  ].join('\n');
  expect(parseServiceFile(text)).toEqual({
    name: 'org.gnome.evolution.dataserver.Sources5',
    exec: '/usr/libexec/evolution-source-registry --flag\\sx',
  });
});

test('Exec arguments are single-quoted, and unquotable paths are refused', () => {
  expect(execArg('XDG_DATA_HOME=/a b/c')).toBe("'XDG_DATA_HOME=/a b/c'");
  for (const bad of ["/it's", '/back\\slash', '/new\nline']) {
    expect(() => execArg(bad)).toThrow(/cannot pass/);
  }
});

test('an EDS stub runs the original Exec with every XDG base dir moved', () => {
  const text = edsStubService({
    name: 'org.gnome.evolution.dataserver.Calendar8',
    exec: '/usr/libexec/evolution-calendar-factory',
    file: '/usr/share/dbus-1/services/org.gnome.evolution.dataserver.Calendar8.service',
  });
  const service = parseServiceFile(text);
  expect(service.name).toBe('org.gnome.evolution.dataserver.Calendar8');
  expect(service.exec).toStartWith('/usr/bin/env ');
  expect(service.exec).toEndWith(
    ' GSETTINGS_BACKEND=memory /usr/libexec/evolution-calendar-factory',
  );
  for (const [variable, dir] of EDS_XDG) expect(service.exec).toContain(`'${variable}=${dir}'`);
});
