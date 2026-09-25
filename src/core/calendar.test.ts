/**
 * The calendar gate's time arithmetic. Wall milliseconds throughout; the
 * scheduler tests cover how the gate drives breaks.
 */

import { describe, expect, test } from 'bun:test';
import {
  calendarGateAt,
  LEAD_SHADOW_MARGIN_MS,
  leadShadowMs,
  nextCalendarEdge,
  normalizeBusyIntervals,
  type BusyInterval,
} from './calendar.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** 2026-01-01T10:00:00Z, an arbitrary anchor. */
const TEN = Date.UTC(2026, 0, 1, 10, 0, 0);

function at(hours: number, minutes = 0, seconds = 0): number {
  return TEN + (hours - 10) * 60 * MINUTE + minutes * MINUTE + seconds * SECOND;
}

function busy(start: number, end: number): BusyInterval {
  return { startWall: start, endWall: end };
}

describe('leadShadowMs', () => {
  test('is warning + duration + the 60 s margin', () => {
    expect(LEAD_SHADOW_MARGIN_MS).toBe(60 * SECOND);
    // The defaults: a mini break warns 10 s and lasts 60 s, a long one 30 s and 3 min.
    expect(leadShadowMs(10 * SECOND, 60 * SECOND)).toBe(130 * SECOND);
    expect(leadShadowMs(30 * SECOND, 180 * SECOND)).toBe(270 * SECOND);
  });

  test('a zero warning leaves duration + margin', () => {
    expect(leadShadowMs(0, 60 * SECOND)).toBe(120 * SECOND);
  });

  test('negative inputs count as zero', () => {
    expect(leadShadowMs(-5, -5)).toBe(LEAD_SHADOW_MARGIN_MS);
  });
});

describe('normalizeBusyIntervals', () => {
  test('sorts and merges overlapping intervals', () => {
    expect(
      normalizeBusyIntervals([
        busy(at(11), at(12)),
        busy(at(10), at(11, 30)),
        busy(at(14), at(15)),
      ]),
    ).toEqual([busy(at(10), at(12)), busy(at(14), at(15))]);
  });

  test('merges touching intervals', () => {
    expect(normalizeBusyIntervals([busy(at(10), at(11)), busy(at(11), at(12))])).toEqual([
      busy(at(10), at(12)),
    ]);
  });

  test('keeps a contained interval inside its container', () => {
    expect(normalizeBusyIntervals([busy(at(10), at(13)), busy(at(11), at(12))])).toEqual([
      busy(at(10), at(13)),
    ]);
  });

  test('drops zero-length, inverted and non-finite intervals', () => {
    expect(
      normalizeBusyIntervals([
        busy(at(10), at(10)),
        busy(at(12), at(11)),
        busy(Number.NaN, at(11)),
        busy(at(9), Number.POSITIVE_INFINITY),
        busy(at(14), at(15)),
      ]),
    ).toEqual([busy(at(14), at(15))]);
  });

  test('does not mutate its input', () => {
    const input = [busy(at(11), at(12)), busy(at(10), at(11, 30))];
    const copy = input.map((interval) => ({ ...interval }));
    normalizeBusyIntervals(input);
    expect(input).toEqual(copy);
  });
});

describe('calendarGateAt', () => {
  const shadow = 130 * SECOND;
  const events = [busy(at(10), at(11))];

  test('is none well before the shadow', () => {
    expect(calendarGateAt(at(9), events, shadow)).toEqual({ state: 'none' });
  });

  test('the shadow starts inclusively, exactly shadowMs before the event', () => {
    expect(calendarGateAt(at(10) - shadow - 1, events, shadow)).toEqual({ state: 'none' });
    expect(calendarGateAt(at(10) - shadow, events, shadow)).toEqual({
      state: 'shadow',
      busyStartWall: at(10),
    });
    expect(calendarGateAt(at(10) - 1, events, shadow)).toEqual({
      state: 'shadow',
      busyStartWall: at(10),
    });
  });

  test('is busy from the start until, exclusively, the end', () => {
    expect(calendarGateAt(at(10), events, shadow)).toEqual({
      state: 'busy',
      busyUntilWall: at(11),
    });
    expect(calendarGateAt(at(11) - 1, events, shadow)).toEqual({
      state: 'busy',
      busyUntilWall: at(11),
    });
    expect(calendarGateAt(at(11), events, shadow)).toEqual({ state: 'none' });
  });

  test('the shadow length follows the kind of the next break', () => {
    const mini = leadShadowMs(10 * SECOND, 60 * SECOND);
    const long = leadShadowMs(30 * SECOND, 180 * SECOND);
    const fourMinutesBefore = at(9, 56);
    expect(calendarGateAt(fourMinutesBefore, events, mini)).toEqual({ state: 'none' });
    expect(calendarGateAt(fourMinutesBefore, events, long)).toEqual({
      state: 'shadow',
      busyStartWall: at(10),
    });
  });

  test('chained events and shadows are one continuous hold', () => {
    // 10:00–11:00, then 11:01–12:00: the second shadow starts before the
    // first event ends, so breaks resume only at 12:00.
    const chain = [busy(at(10), at(11)), busy(at(11, 1), at(12))];
    expect(calendarGateAt(at(10, 30), chain, shadow)).toEqual({
      state: 'busy',
      busyUntilWall: at(12),
    });
    // Between the two events: the shadow of the second one.
    expect(calendarGateAt(at(11, 0, 30), chain, shadow)).toEqual({
      state: 'shadow',
      busyStartWall: at(11, 1),
    });
    expect(calendarGateAt(at(11, 30), chain, shadow)).toEqual({
      state: 'busy',
      busyUntilWall: at(12),
    });
  });

  test('events further apart than a shadow are separate holds', () => {
    const apart = [busy(at(10), at(11)), busy(at(11, 10), at(12))];
    expect(calendarGateAt(at(10, 30), apart, shadow)).toEqual({
      state: 'busy',
      busyUntilWall: at(11),
    });
    expect(calendarGateAt(at(11, 3), apart, shadow)).toEqual({ state: 'none' });
    expect(calendarGateAt(at(11, 8), apart, shadow)).toEqual({
      state: 'shadow',
      busyStartWall: at(11, 10),
    });
  });

  test('accepts unsorted, overlapping and invalid input', () => {
    const messy = [busy(at(10, 30), at(11)), busy(at(10), at(10, 45)), busy(at(9), at(9))];
    expect(calendarGateAt(at(10, 50), messy, shadow)).toEqual({
      state: 'busy',
      busyUntilWall: at(11),
    });
    expect(calendarGateAt(at(9), messy, shadow)).toEqual({ state: 'none' });
  });

  test('no intervals, no gate', () => {
    expect(calendarGateAt(at(10), [], shadow)).toEqual({ state: 'none' });
  });
});

describe('nextCalendarEdge', () => {
  const shadow = 130 * SECOND;

  test('walks shadow start, event start and hold end in order', () => {
    const events = [busy(at(10), at(11))];
    const shadowStart = at(10) - shadow;
    expect(nextCalendarEdge(at(9), events, shadow)).toBe(shadowStart);
    expect(nextCalendarEdge(shadowStart, events, shadow)).toBe(at(10));
    expect(nextCalendarEdge(at(10), events, shadow)).toBe(at(11));
    expect(nextCalendarEdge(at(11), events, shadow)).toBeNull();
  });

  test('includes the step from an event into the next one’s shadow', () => {
    const chain = [busy(at(10), at(11)), busy(at(11, 1), at(12))];
    expect(nextCalendarEdge(at(10, 30), chain, shadow)).toBe(at(11));
    expect(nextCalendarEdge(at(11), chain, shadow)).toBe(at(11, 1));
    expect(nextCalendarEdge(at(11, 1), chain, shadow)).toBe(at(12));
  });

  test('every edge changes the gate, and nothing in between does', () => {
    const events = [busy(at(10), at(11)), busy(at(11, 1), at(12)), busy(at(15), at(15, 30))];
    let now = at(8);
    let gate = calendarGateAt(now, events, shadow);
    for (;;) {
      const edge = nextCalendarEdge(now, events, shadow);
      if (edge === null) break;
      // One millisecond before the edge the gate is still what it was.
      expect(calendarGateAt(edge - 1, events, shadow)).toEqual(gate);
      const next = calendarGateAt(edge, events, shadow);
      expect(next).not.toEqual(gate);
      gate = next;
      now = edge;
    }
    expect(gate).toEqual({ state: 'none' });
  });

  test('is null with no intervals', () => {
    expect(nextCalendarEdge(at(10), [], shadow)).toBeNull();
  });
});
