import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { randomBytes } from 'crypto';
import { hashToken } from '../auth/tokens';
import { decrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramApi } from './telegram.api';

const CODE_TTL = 15 * 60_000;
type Cfg = { staffChat?: { id: string; title: string }; staffCode?: { hash: string; expiresAt: number } } & Record<string, unknown>;

// The clinic's staff chat in Telegram: the bot writes to the staff there (new requests). The chat is linked with a command carrying a one-time code:
// the bot has no way to find a chat by number or link, it learns the chat id only when it receives a message in it.
@Injectable()
export class StaffNotifierService {
  private readonly log = new Logger(StaffNotifierService.name);

  constructor(
    private prisma: PrismaService,
    private telegram: TelegramApi,
  ) {}

  private async integration(clinicId: string) {
    return this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.TELEGRAM } } });
  }

  // A config change reads a fresh record: Telegram polling also updates this record (offset)
  private async patch(clinicId: string, fn: (cfg: Cfg) => Cfg) {
    const i = await this.integration(clinicId);
    if (!i?.apiKeyEnc) throw new BadRequestException('bot_not_connected');
    await this.prisma.integration.update({ where: { id: i.id }, data: { config: fn({ ...(i.config as Cfg) }) as object } });
  }

  async chat(clinicId: string): Promise<{ id: string; title: string } | null> {
    return ((await this.integration(clinicId))?.config as Cfg | undefined)?.staffChat ?? null;
  }

  async begin(clinicId: string) {
    const code = randomBytes(4).toString('hex').toUpperCase();
    await this.patch(clinicId, (c) => ({ ...c, staffCode: { hash: hashToken(code), expiresAt: Date.now() + CODE_TTL } }));
    return { code, command: `/chat ${code}`, expiresAt: new Date(Date.now() + CODE_TTL) };
  }

  async clear(clinicId: string) {
    await this.patch(clinicId, ({ staffChat: _a, staffCode: _b, ...rest }) => rest);
  }

  // The command "/chat CODE" in a chat: if the code is right and not expired, the chat becomes the staff chat
  async bind(clinicId: string, code: string, chat: { id: string; title: string }): Promise<boolean> {
    const cfg = (await this.integration(clinicId))?.config as Cfg | undefined;
    const c = cfg?.staffCode;
    if (!c || c.expiresAt < Date.now() || c.hash !== hashToken(code.trim().toUpperCase())) return false;
    await this.patch(clinicId, ({ staffCode: _x, ...rest }) => ({ ...rest, staffChat: chat }));
    return true;
  }

  // A message to the staff. A sending failure must not break the main work, so errors go only to the log.
  async notify(clinicId: string, text: string): Promise<boolean> {
    try {
      const i = await this.integration(clinicId);
      const chat = (i?.config as Cfg | undefined)?.staffChat;
      if (!i?.apiKeyEnc || !chat) return false;
      await this.telegram.sendMessage(decrypt(i.apiKeyEnc), chat.id, text);
      return true;
    } catch (e) {
      this.log.warn(`Служебный чат: ${(e as Error).message}`);
      return false;
    }
  }
}
