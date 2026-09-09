/**
 * The warning notification shown shortly before a break (architecture §5), plus
 * the one-off first-run notice. Both are owned until dismissed or destroyed.
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
  private notice: MessageTray.Notification | null = null;

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
      // The tray can destroy notifications independently of the extension.
      notification.connect('destroy', () => {
        if (this.notification === notification) this.notification = null;
      });
      this.notification = notification;
      source.addNotification(notification);
    } catch (err) {
      this.log('hardbreak: could not post the warning notification', err);
      this.dismiss();
    }
  }

  /** Idempotent: safe when nothing was posted or the tray already dropped it. */
  dismiss(): void {
    const notification = this.notification;
    this.notification = null;
    notification?.destroy();
  }

  /** Remains visible until acknowledged or the extension is disabled. */
  postNotice(title: string, body: string): boolean {
    this.dismissNotice();
    try {
      const source = MessageTray.getSystemSource();
      const notice = new MessageTray.Notification({
        source,
        title,
        body,
        isTransient: false,
        // Keep the enforcement and recovery instructions visible until acknowledged.
        urgency: MessageTray.Urgency.CRITICAL,
      });
      notice.connect('destroy', () => {
        if (this.notice === notice) this.notice = null;
      });
      this.notice = notice;
      source.addNotification(notice);
      return true;
    } catch (err) {
      this.log('hardbreak: could not post the first-run notice', err);
      this.dismissNotice();
      return false;
    }
  }

  destroy(): void {
    this.dismiss();
    this.dismissNotice();
  }

  private dismissNotice(): void {
    const notice = this.notice;
    this.notice = null;
    notice?.destroy();
  }
}
