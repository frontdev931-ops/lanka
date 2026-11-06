import { PrismaService } from '../prisma/prisma.service';

// Cleaning of a COPY of the text that goes to the AI provider (the stored chat and the data needed for the booking are never changed). It is done by code here: no text
// is sent to another model to clean it.
//
// What it covers: (1) every recognisable phone number in the system prompt and in every message of the history, always; (2) the contact data KNOWN to the application for
// this chat (the name and the surname of the booking request, the name and the phone of the linked card, the name the channel gave): the names in the dialogue messages, also in
// another case ending ("Ірино"), the phones also in the system text; (3) the messages that only collect the contacts (the system's question about them, the patient's short answer) are replaced by a neutral note.
// What it does NOT cover: a name or any other personal detail that the patient writes in free text and that the application does not know as a contact (for example
// "мене звати Олена" before the data question, a street, a diagnosis told in words), a number written in words, a phone broken into pieces by other words. It is NOT
// anonymisation; it removes the contacts the booking collects.
export interface Contacts {
  names: string[];
  phones: string[];
}

export const NO_CONTACTS: Contacts = { names: [], phones: [] };

const PHONE_MASK = '[телефон]';
const NAME_MASK = '[ім’я]';
export const DATA_QUESTION_NOTE = '[запит даних для запису]';
export const DATA_ANSWER_NOTE = '[дані для запису надіслано]';
// a phone: 9 to 14 digits with the usual separators (+380 97 123-45-67, (097) 123 45 67, 0971234567)
const PHONE_RE = /(?<![\d])\+?\d(?:[\s\-().]*\d){8,13}(?![\d])/g;
// the system's own questions that collect the contacts (uk and ru)
const DATA_QUESTION = /(?:Щоб оформити запис, напишіть|Чтобы оформить запись, напишите|прізвище \(одним словом\)|ім’я \(одним словом\)|фамилию \(одним словом\)|имя \(одним словом\)|номер телефону для зв’язку|номер телефона для связи|прізвище та ім’я|фамилию и имя|що з цього прізвище|что из этого фамилия|Дані для запису|Данные для записи)/i;
const LABELS = /(?<![\p{L}])(?:прізвище|ім['’ʼ`]?я|фамилия|имя|телефон|тел|номер|мене|меня|звати|зовут|мій|мой|моє|мое|я|це|это|мобільний|мобильный)(?![\p{L}])/giu;
const STOP = new Set(['так', 'ні', 'да', 'нет', 'ок', 'добре', 'дякую', 'спасибо', 'будь', 'ласка', 'привіт', 'привет']);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// the known name as a pattern: the stem (the ending may change) for a long name, the whole word for a short one
function nameRe(name: string): RegExp | null {
  const n = name.trim();
  if (n.length < 2) return null;
  const stem = n.length >= 5 ? n.slice(0, n.length - 2) : n;
  return new RegExp(`(?<![\\p{L}])${esc(stem)}${n.length >= 5 ? "[\\p{L}'’ʼ-]*" : ''}(?![\\p{L}])`, 'giu');
}

// the known phone as a pattern that tolerates any separators between its last 7 to 9 digits
function phoneRe(phone: string): RegExp | null {
  const d = phone.replace(/\D/g, '');
  if (d.length < 7) return null;
  const tail = d.slice(-Math.min(9, d.length));
  return new RegExp(`(?<![\\d])(?:\\+?\\d[\\s\\-().]*){0,5}${tail.split('').join('[\\s\\-().]*')}(?![\\d])`, 'g');
}

// `generic`: also every recognisable phone (used for the patient's dialogue). The system prompt holds the CLINIC's own numbers (its approved facts), so there only the known
// contacts of the patient are masked.
export function maskText(text: string, c: Contacts = NO_CONTACTS, generic = true): string {
  let out = text;
  for (const p of c.phones) {
    const re = phoneRe(p);
    if (re) out = out.replace(re, PHONE_MASK);
  }
  if (generic) out = out.replace(PHONE_RE, PHONE_MASK);
  for (const n of c.names) {
    const re = nameRe(n);
    if (re) out = out.replace(re, NAME_MASK);
  }
  return out;
}

// What remains of a patient's message when the contact data are taken out: nothing but name-like words means it only carried contacts
function carriesOnlyContacts(text: string): boolean {
  if (text.includes('?')) return false;
  const rest = text.replace(PHONE_RE, ' ').replace(LABELS, ' ').replace(/[,.;:!()\-–—]/g, ' ').trim();
  if (/\d/.test(rest)) return false;
  const tokens = rest.split(/\s+/).filter(Boolean);
  return tokens.length <= 3 && tokens.every((t) => /^[\p{L}'’ʼ-]{2,}$/u.test(t) && !STOP.has(t.toLowerCase()));
}

// The messages of a dialogue as the model gets them: the contacts' questions and answers are replaced by a neutral note, every other message keeps its meaning
// with the phones and the known names masked
export function scrubMessages(msgs: { role: 'user' | 'assistant'; content: string }[], c: Contacts = NO_CONTACTS): { role: 'user' | 'assistant'; content: string }[] {
  let afterQuestion = false;
  return msgs.map((m) => {
    if (m.role === 'assistant' && DATA_QUESTION.test(m.content)) {
      afterQuestion = true;
      return { role: m.role, content: DATA_QUESTION_NOTE };
    }
    if (m.role === 'user') {
      const hasPhone = PHONE_RE.test(m.content);
      PHONE_RE.lastIndex = 0;
      if ((hasPhone || afterQuestion) && carriesOnlyContacts(m.content)) return { role: m.role, content: DATA_ANSWER_NOTE };
      afterQuestion = false;
    } else afterQuestion = false;
    return { role: m.role, content: maskText(m.content, c) };
  });
}

// The contacts the application knows for this chat (the booking request, the linked card, the name the channel gave): they are masked wherever they appear
export async function contactsOf(prisma: PrismaService, clinicId: string, channel: string, chatId: string): Promise<Contacts> {
  const [reqs, link, named] = await Promise.all([
    prisma.bookingRequest.findMany({ where: { clinicId, channel, chatId }, orderBy: { createdAt: 'desc' }, take: 5, select: { lastName: true, firstName: true, fullName: true, phone: true, contactName: true } }),
    prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { patient: { select: { fullName: true, phone: true } } } }),
    prisma.chatMessage.findMany({ where: { clinicId, channel, chatId, contactName: { not: null } }, orderBy: { createdAt: 'desc' }, take: 1, select: { contactName: true } }),
  ]);
  const words = (s?: string | null) => (s ?? '').split(/[\s,;]+/).map((x) => x.replace(/[^\p{L}'’ʼ-]/gu, '')).filter((x) => x.length >= 2);
  const names = new Set<string>();
  for (const r of reqs) for (const w of [...words(r.lastName), ...words(r.firstName), ...words(r.fullName), ...words(r.contactName)]) names.add(w);
  for (const w of words(link?.patient?.fullName)) names.add(w);
  for (const m of named) for (const w of words(m.contactName)) names.add(w);
  const phones = new Set<string>();
  for (const r of reqs) if (r.phone) phones.add(r.phone);
  if (link?.patient?.phone) phones.add(link.patient.phone);
  return { names: [...names], phones: [...phones] };
}
