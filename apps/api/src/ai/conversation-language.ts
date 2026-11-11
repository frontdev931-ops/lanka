import { PrismaService } from '../prisma/prisma.service';
import { languageOfAgent } from './guardrails';

// The texts of the code's own buttons and their stored forms say nothing about the patient's language (they are fixed in Ukrainian or Russian by the code)
const BUTTON_TEXTS = ['Так, підтверджую', 'Ні, інший час', 'Да, подтверждаю', 'Нет, другое время', 'Так', 'Ні'];

// The language of ONE conversation, read from the patient's own messages (see languageOf): an explicit request for a language wins, a clear message sets it, a short or ambiguous one
// ("ок", a name, a phone number, a date, a button) keeps what the conversation already has. The same answer for the agent's texts and the booking steps, so the language does not
// change in the middle of a booking. Forty messages back, so an early explicit request still counts. No model call.
export async function conversationLanguage(prisma: PrismaService, clinicId: string, channel: string, chatId: string): Promise<'ru' | 'uk'> {
  const rows = await prisma.chatMessage.findMany({
    where: { clinicId, channel, chatId, direction: 'IN', NOT: [{ text: { startsWith: 'Обрав час:' } }, { text: { in: BUTTON_TEXTS } }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 40,
    select: { text: true },
  });
  // the clinic's own stored names (service titles, the address) are in the clinic's language whatever the patient speaks: they are not read as the patient's words
  const [services, clinic] = await Promise.all([
    prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE', active: true }, select: { title: true } }),
    prisma.clinic.findUnique({ where: { id: clinicId }, select: { publicAddress: true, publicDirections: true } }),
  ]);
  return languageOfAgent(rows.map((r) => r.text), [...services.map((s) => s.title), clinic?.publicAddress, clinic?.publicDirections]);
}
