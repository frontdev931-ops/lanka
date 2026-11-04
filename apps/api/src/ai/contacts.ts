// The questions every patient asks first: where are you, what is your phone, when do you work. The answers come from what the clinic
// itself entered (address, phone, directions, working hours), are written by the code and need neither the model nor a person.
export interface Contacts {
  address: string | null;
  phone: string | null;
  directions: string | null;
  // already formatted in the language of the answer, null when the clinic did not set its working hours
  hours: string | null;
  // The clinic keeps its address or contacts in the knowledge base (the model answers from there): then "unknown" is not said by the code
  inKnowledgeBase?: boolean;
}

const ADDRESS = /(адрес|де\s+ви\s+(знаходит|розташов)|де\s+знаходит|де\s+розташов|де\s+вас\s+знайти|куди\s+(їхати|йти|під)|як\s+(дістатися|добратися|доїхати)|де\s+паркув|парков|паркув|где\s+вы|где\s+находит|где\s+расположен|где\s+вас\s+найти|куда\s+(ехать|идти|подъезжать)|как\s+(добраться|доехать))/i;
const PHONE = /(телефон|номер\s+(телефону|адміністратор|администратор)|зателефон|подзвон|набрати|позвон|контакти|контакты|зв['’]?язатися|связаться)/i;
const HOURS = /(графік|график|режим\s+робот|режим\s+работ|години\s+робот|часы\s+работ|до\s+котр|до\s+скольк|працюєте|работаете|відкриті|открыты|коли\s+ви\s+працюєте|когда\s+вы\s+работаете)/i;
// A message that also asks for a booking or a change goes to the model, which sees the contacts too
const BOOKING = /(запис|записат|запиш|окн|вікн|вікон|хочу|перенес|скас|відмін|отмен)/i;

export function wantsContacts(text: string): { address: boolean; phone: boolean; hours: boolean } | null {
  if (text.length > 120 || BOOKING.test(text)) return null;
  const w = { address: ADDRESS.test(text), phone: PHONE.test(text), hours: HOURS.test(text) };
  return w.address || w.phone || w.hours ? w : null;
}

// null when nothing that was asked is known: the model (or a person) takes the question
export function contactReply(text: string, lang: 'ru' | 'uk', c: Contacts): string | null {
  const w = wantsContacts(text);
  if (!w) return null;
  const ru = lang === 'ru';
  const parts: string[] = [];
  if (w.address && c.address) parts.push(`${ru ? 'Наш адрес' : 'Наша адреса'}: ${c.address}.${c.directions ? ` ${c.directions}` : ''}`);
  else if (w.address && c.directions) parts.push(c.directions);
  if (w.phone && c.phone) parts.push(`${ru ? 'Телефон администратора' : 'Телефон адміністратора'}: ${c.phone}.`);
  if (w.hours && c.hours) parts.push(`${ru ? 'График работы' : 'Графік роботи'}: ${c.hours}.`);
  // Asked, but the clinic has not entered it: said plainly, with no invented ban ("we cannot name it in this chat") and no promise of a call
  const unknown: string[] = [];
  if (w.address && !c.address && !c.directions) unknown.push(ru ? 'адрес клиники' : 'адреса клініки');
  if (w.phone && !c.phone) unknown.push(ru ? 'телефон администратора' : 'телефон адміністратора');
  if (w.hours && !c.hours) unknown.push(ru ? 'график работы' : 'графік роботи');
  if (unknown.length && !c.inKnowledgeBase) parts.push(ru ? `Данных о том, что вы спросили (${unknown.join(', ')}), у нас сейчас нет, это нужно уточнить у администратора клиники.` : `Даних про те, що ви запитали (${unknown.join(', ')}), у нас зараз немає, це потрібно уточнити в адміністратора клініки.`);
  if (!parts.length) return null;
  parts.push(ru ? 'Если хотите записаться, напишите нам.' : 'Якщо хочете записатися, напишіть нам.');
  return parts.join('\n\n');
}

const DAY_UK = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];
const DAY_RU = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

// "пн–пт 09:00–20:00, сб 10:00–15:00, нд вихідний": neighbouring days with the same hours are joined (days are '1' Monday … '7' Sunday)
export function formatHours(week: Record<string, { from: string; to: string } | null>, lang: 'ru' | 'uk'): string {
  const names = lang === 'ru' ? DAY_RU : DAY_UK;
  const label = (h: { from: string; to: string } | null) => (h ? `${h.from}–${h.to}` : lang === 'ru' ? 'выходной' : 'вихідний');
  const groups: { from: number; to: number; text: string }[] = [];
  for (let d = 1; d <= 7; d++) {
    const text = label(week[String(d)] ?? null);
    const last = groups[groups.length - 1];
    if (last && last.text === text && last.to === d - 1) last.to = d;
    else groups.push({ from: d, to: d, text });
  }
  return groups.map((g) => `${g.from === g.to ? names[g.from - 1] : `${names[g.from - 1]}–${names[g.to - 1]}`} ${g.text}`).join(', ');
}
