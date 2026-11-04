import { ForbiddenException, Injectable } from '@nestjs/common';

// The state of the restriction for the settings page (no dialog ids)
export function autoBookingTestStatus(): { restricted: boolean; dialogs: number } {
  const on = process.env.AUTOBOOKING_TEST_ONLY === 'true';
  return { restricted: on, dialogs: on ? new Set((process.env.AUTOBOOKING_TEST_DIALOGS ?? '').split(/[\s,;]+/).filter(Boolean)).size : 0 };
}

export interface DialogOrigin {
  channel: string;
  chatId: string;
}

// A TEMPORARY server-side restriction for the first live test of automatic booking: only the dialogs listed here may create a patient card and a
// visit in the clinic's system by themselves; every other dialog of the clinic keeps working as a request for the administrator.
//   AUTOBOOKING_TEST_ONLY=true      turns the restriction on (anything else, or no variable: off, nothing changes for anybody)
//   AUTOBOOKING_TEST_DIALOGS=...    the allowed dialogs, separated by commas or spaces, each as  <clinicId>|<CHANNEL>|<chatId>
// With the restriction on and an empty list NO automatic booking is allowed. A dialog is identified by the clinic, the channel and the
// internal id of the chat (never by a name or an Instagram username). The variables are read at every check, so the check is made right before
// every write to the clinic's system, retries included. A write made by a staff member (userId set) is not restricted.
@Injectable()
export class AutoBookingGate {
  restricted(): boolean {
    return process.env.AUTOBOOKING_TEST_ONLY === 'true';
  }

  key(clinicId: string, channel: string, chatId: string): string {
    return `${clinicId}|${channel}|${chatId}`;
  }

  private list(): Set<string> {
    return new Set((process.env.AUTOBOOKING_TEST_DIALOGS ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean));
  }

  status() {
    return { restricted: this.restricted(), dialogs: this.restricted() ? this.list().size : 0 };
  }

  allowed(clinicId: string, origin: DialogOrigin | undefined): boolean {
    if (!this.restricted()) return true;
    return !!origin && this.list().has(this.key(clinicId, origin.channel, origin.chatId));
  }

  // Throws for an automatic write of a dialog that is not allowed (a staff write, userId set, is never restricted)
  assert(clinicId: string, userId: string | null, origin: DialogOrigin | undefined): void {
    if (userId) return;
    if (!this.allowed(clinicId, origin)) throw new ForbiddenException('auto_booking_not_allowed_for_dialog');
  }
}
