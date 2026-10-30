import { decrypt } from '../common/crypto';

// The clinic's stored credentials (encrypted JSON), or null
export function viberCredentials(i: { apiKeyEnc: string | null }): Record<string, string> | null {
  return i.apiKeyEnc ? (JSON.parse(decrypt(i.apiKeyEnc)) as Record<string, string>) : null;
}

// Viber Business Messages go through a partner (TurboSMS or Infobip: the choice is open). The rest of the system talks to this
// interface only, so choosing the partner means writing one class that implements it and binding it to `ViberProvider`.
export abstract class ViberProvider {
  // Whether a real partner is bound; false means Viber cannot be connected yet
  abstract readonly available: boolean;
  // Checks the clinic's credentials; returns a display name of the sender
  abstract verify(credentials: Record<string, string>): Promise<{ senderName: string }>;
  abstract send(credentials: Record<string, string>, to: string, text: string, buttons: { title: string; payload: string }[]): Promise<void>;
}

// Until a partner is chosen: nothing can be connected or sent
export class NoViberProvider extends ViberProvider {
  readonly available = false;
  async verify(): Promise<{ senderName: string }> {
    throw new Error('viber_provider_not_chosen');
  }
  async send(): Promise<void> {
    throw new Error('viber_provider_not_chosen');
  }
}
