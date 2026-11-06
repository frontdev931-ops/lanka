import type request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { MOCK_KEY } from '../mock/cliniccards-mock';

// The synthetic clinic "LANKA Agent Test" for the agent's drafts and its evaluation: made-up services, prices, texts and schedule, in the language of the
// dialogue, on the mock Cliniccards. Nothing here is real and nothing is created outside the test database.
export const TITLES = {
  uk: { consult: 'Тестова консультація', hygiene: 'Тестова гігієна', filling: 'Тестове лікування', free: 'Тестова безкоштовна перевірка' },
  ru: { consult: 'Тестовая консультация', hygiene: 'Тестовая гигиена', filling: 'Тестовое лечение', free: 'Тестовая бесплатная проверка' },
};
const TEXTS = {
  uk: {
    consult: 'Склад (тестові дані): огляд, консультація лікаря, план лікування. Триває близько 30 хвилин.',
    faqFear: ['Чи можна сказати лікарю, що я боюся?', 'Так. Лікар пояснює кожен крок і зупиняється за вашим сигналом (тестова відповідь клініки).'],
    faqLong: ['Скільки триває консультація?', 'Приблизно 30 хвилин (тестова відповідь клініки).'],
    address: 'м. Тестове, вул. Вигадана, 1 (тестова адреса)',
  },
  ru: {
    consult: 'Состав (тестовые данные): осмотр, консультация врача, план лечения. Длится около 30 минут.',
    faqFear: ['Можно ли сказать врачу, что я боюсь?', 'Да. Врач объясняет каждый шаг и останавливается по вашему сигналу (тестовый ответ клиники).'],
    faqLong: ['Сколько длится консультация?', 'Примерно 30 минут (тестовый ответ клиники).'],
    address: 'г. Тестовое, ул. Выдуманная, 1 (тестовый адрес)',
  },
};
const WEEK = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), { from: '09:00', to: '18:00' }]));
const rnd = () => Math.random().toString(36).slice(2, 9);
const PASSWORD = 'correct-horse-battery';

export interface AgentClinicOpts {
  name?: string;
  agent?: boolean;
  autoReply?: boolean;
  events?: boolean;
  lang?: 'uk' | 'ru';
}

export async function createAgentClinic(deps: { http: () => ReturnType<typeof request>; prisma: PrismaService }, opts: AgentClinicOpts = {}) {
  const { http, prisma } = deps;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const lang = opts.lang ?? 'uk';
  const email = `c${rnd()}@example.com`;
  const res = await http().post('/auth/register').send({ acceptTerms: true, clinicName: opts.name ?? 'LANKA Agent Test', name: 'Тест', email, password: PASSWORD }).expect(201);
  const token = res.body.accessToken as string;
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const clinicId = user.memberships[0].clinicId;
  await http().get('/integrations/cliniccards').set(auth(token)).expect(200);
  await http().put('/integrations/cliniccards/key').set(auth(token)).send({ apiKey: MOCK_KEY }).expect(200);
  await http().post('/integrations/cliniccards/sync').set(auth(token)).expect(201);
  await prisma.clinic.update({
    where: { id: clinicId },
    // the sync of the mock overwrites the clinic name with the mock's own: the name of the synthetic clinic is set again after it
    data: { name: opts.name ?? 'LANKA Agent Test', plan: 'PRO', aiEnabled: true, aiAutoReply: !!opts.autoReply, sendingEnabled: true, aiAgentMode: opts.agent !== false, funnelEventsEnabled: !!opts.events, publicAddress: TEXTS[lang].address },
  });
  // The sync of the mock imports ITS price list into the knowledge base: the synthetic clinic keeps only its own made-up services (found by the first live probe)
  await prisma.kbItem.updateMany({ where: { clinicId, source: 'CLINICCARDS' }, data: { active: false } });
  const now = new Date();
  const t = TITLES[lang];
  const x = TEXTS[lang];
  const svc = (title: string, priceUah: number | null, text = '') => prisma.kbItem.create({ data: { clinicId, kind: 'SERVICE', title, text, priceUah, durationMin: 30, active: true, approvedAt: now, reviewedAt: now } });
  const consult = await svc(t.consult, 100, x.consult); // an explicitly test price
  const hygiene = await svc(t.hygiene, null); // the price is not known
  const filling = await svc(t.filling, 300);
  const free = await svc(t.free, 0); // explicitly free
  for (const [title, text] of [x.faqFear, x.faqLong]) await prisma.kbItem.create({ data: { clinicId, kind: 'FAQ', title, text, active: true, approvedAt: now, reviewedAt: now } });
  await http().get('/booking-settings').set(auth(token)).expect(200);
  await http().put('/booking-settings/shared-account').set(auth(token)).send({ doctorId: '503' }).expect(200);
  await http().put('/booking-settings/cabinets').set(auth(token)).send({ cabinets: [{ externalId: '801', onlineBooking: true, acceptsUrgent: false }, { externalId: '802', onlineBooking: true, acceptsUrgent: false }] }).expect(200);
  await http().put('/booking-settings/services').set(auth(token)).send({ services: [{ id: consult.id, onlineBooking: true, cabinetIds: [] }] }).expect(200);
  await http().put('/clinic/work-hours').set(auth(token)).send(WEEK).expect(200);
  await http().put('/booking-settings/mode').set(auth(token)).send({ mode: 'CABINETS' }).expect(200);
  return { token, clinicId, userId: user.id, chat: `ig${rnd()}`, consult, hygiene, filling, free };
}
export type AgentClinic = Awaited<ReturnType<typeof createAgentClinic>>;
