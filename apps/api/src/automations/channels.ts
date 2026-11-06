export interface SlotOption {
  label: string;
  date: string;
  time: string;
  doctor?: string;
  // The doctor of the time as an id in Cliniccards (carried in the button, so a name is never parsed back)
  doctorId?: string;
  // A button that is not an appointment time (for example "yes, confirm"): its own payload
  payload?: string;
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
    // The request may have reached the provider although no clear answer came (no response at all, a server error): a caller that must not send twice
    // treats the result as UNKNOWN and never repeats it blindly. A clear refusal of the provider is not ambiguous.
    readonly ambiguous = false,
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

export const slotPayload = (o: SlotOption) => o.payload ?? `slot|${o.date}|${o.time}${o.doctorId ? `|#${o.doctorId}` : o.doctor ? `|${o.doctor.slice(0, 16)}` : ''}`;
