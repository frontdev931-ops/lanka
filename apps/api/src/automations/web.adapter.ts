import { Injectable } from '@nestjs/common';
import { ChannelAdapter } from './channels';

// The widget on the clinic's site: the visitor's browser asks for new messages itself, so "sending" is only that the message is
// stored (the caller stores it). Nothing leaves the server, so nothing can fail here.
@Injectable()
export class WebAdapter implements ChannelAdapter {
  readonly channel = 'WEB';
  readonly caps = { canInitiate: false, replyWindowMs: null, buttons: true, templates: false };

  async send() {
    return;
  }
}
