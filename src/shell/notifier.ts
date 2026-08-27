/**
 * The warning notification shown shortly before a break (architecture §5), plus
 * {@link postNotice} for the one-off first-run notice.
 *
 * The warning is the only notice the user gets before the wall, so it says how
 * long the wall will be up; it is transient and is torn down the moment the
 * break starts, because a banner surviving behind the modal would be unreadable
 * and unclosable.
 */

import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { formatCountdown } from '../core/format.js';
import type { BreakKind, Log } from '../core/types.js';

export class Notifier {
  private notification: MessageTray.Notification | null = null;

  constructor(private readonly log: Log) {}

  /**
   * `secondsUntil` comes from the scheduler; `durationMs` is how long the break
   * that is coming will last.
   */
  warn(kind: BreakKind, secondsUntil: number, durationMs: number): void {
    this.dismiss();
    try {
      const source = MessageTray.getSystemSource();
      const notification = new MessageTray.Notification({
        source,
        title: `${kind === 'mini' ? 'Mini' : 'Long'} break in ${Math.max(0, Math.round(secondsUntil))} s`,
        body: `Save your work — the screen will lock for ${formatCountdown(durationMs)}.`,
        isTransient: true,
      });
      // The tray can drop it on its own (timeout, "Clear"), so never hold on to
      // a dead reference: `dismiss()` would then throw inside the break path.
      notification.connect('destroy', () => {
        if (this.notification === notification) this.notification = null;
      });
      this.notification = notification;
      source.addNotification(notification);
    } catch (err) {
      this.log('hardbreak: could not post the warning notification', err);
      this.notification = null;
    }
  }

  /** Idempotent: safe when nothing was posted or the tray already dropped it. */
  dismiss(): void {
    const notification = this.notification;
    this.notification = null;
    if (!notification) return;
    try {
      notification.destroy();
    } catch (err) {
      this.log('hardbreak: could not destroy the warning notification', err);
    }
  }

  destroy(): void {
    this.dismiss();
  }
}

/**
 * A one-off, non-transient notification: it stays in the message list until the
 * user dismisses it, because it is how someone who has just enabled hardbreak
 * finds out that breaks cannot be skipped and how to get out of a wedged
 * session. Nothing keeps a reference — it is not ours to take down again.
 *
 * Never throws: a failure here must not take the caller down with it.
 */
export function postNotice(title: string, body: string, log: Log): void {
  try {
    const source = MessageTray.getSystemSource();
    source.addNotification(
      new MessageTray.Notification({
        source,
        title,
        body,
        isTransient: false,
        // CRITICAL keeps the banner up until it is acknowledged. A three-line
        // warning about an extension that takes the whole screen is not
        // something to flash for four seconds and file away.
        urgency: MessageTray.Urgency.CRITICAL,
      }),
    );
  } catch (err) {
    log('hardbreak: could not post the first-run notice', err);
  }
}
