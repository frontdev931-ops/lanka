export interface SlotOption {
  label: string;
  date: string;
  time: string;
  doctor?: string;
}

// What a channel allows. Scenarios and replies consult this instead of knowing channel names.
export interface ChannelCaps {
  // may we write to a person who has not written first (after they subscribed)
  canInitiate: boolean;
  // we may answer only this long after the person's last message (null: no limit)
  replyWindowMs: number | null;
  // quick buttons with appointment times
  buttons: boolean;
  // messages outside the window need an approved template
  templates: boolean;
}

export class SendError extends Error {
  constructor(
    message: string,
    // the person blocked the bot / the reply window is closed: do not try again
    readonly blocked = false,
    readonly reason: 'not_connected' | 'window_closed' | 'failed' = 'failed',
  ) {
    super(message);
  }
}

export interface ChannelAdapter {
  readonly channel: string;
  readonly caps: ChannelCaps;
  // throws SendError
  send(clinicId: string, chatId: string, text: string, options: SlotOption[]): Promise<void>;
}

export const slotPayload = (o: SlotOption) => `slot|${o.date}|${o.time}${o.doctor ? `|${o.doctor.slice(0, 16)}` : ''}`;
