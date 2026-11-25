// Push texts (2026-11-25): "<clinic> · <event>" and a short action. Shown on a lock screen, so never a patient's name, phone, message,
// medical detail or an amount of money; templates only.
import type { PushLang } from './push.service';

const REQUEST: Record<string, Record<PushLang, string>> = {
  BOOKING: { uk: 'Пацієнт просить запис', ru: 'Пациент просит запись', en: 'A patient asks for a booking' },
  RESCHEDULE: { uk: 'Пацієнт просить перенести візит', ru: 'Пациент просит перенести визит', en: 'A patient asks to reschedule' },
  CANCEL: { uk: 'Пацієнт просить скасувати візит', ru: 'Пациент просит отменить визит', en: 'A patient asks to cancel' },
  HANDOFF: { uk: 'Потрібна відповідь адміністратора', ru: 'Нужен ответ администратора', en: 'An administrator reply is needed' },
  REVIEW: { uk: 'Низька оцінка візиту', ru: 'Низкая оценка визита', en: 'A low visit rating' },
};
const W = {
  uk: { newRequest: 'Нова заявка', updRequest: 'Оновлення заявки', openRequests: 'Відкрийте заявки.', lead: 'Нове звернення', leadBody: 'З сайту або реклами. Відкрийте звернення.', signal: 'Сигнал', signalBody: 'Відкрийте, щоб переглянути подробиці.' },
  ru: { newRequest: 'Новая заявка', updRequest: 'Обновление заявки', openRequests: 'Откройте заявки.', lead: 'Новое обращение', leadBody: 'С сайта или рекламы. Откройте обращения.', signal: 'Сигнал', signalBody: 'Откройте, чтобы посмотреть подробности.' },
  en: { newRequest: 'New request', updRequest: 'Request updated', openRequests: 'Open the requests.', lead: 'New inquiry', leadBody: 'From the website or ads. Open the inquiries.', signal: 'Signal', signalBody: 'Open it to see the details.' },
};

export const requestPush = (kind: string, created: boolean) => (lang: PushLang, clinic: string) => ({
  title: `${clinic} · ${created ? W[lang].newRequest : W[lang].updRequest}`,
  body: `${REQUEST[kind]?.[lang] ?? ''}${REQUEST[kind] ? '. ' : ''}${W[lang].openRequests}`,
});
export const leadPush = () => (lang: PushLang, clinic: string) => ({ title: `${clinic} · ${W[lang].lead}`, body: W[lang].leadBody });
// eventName: the signal's name without numbers (signal-text pushTitle)
export const signalPush = (eventName: (lang: PushLang) => string) => (lang: PushLang, clinic: string) => ({ title: `${clinic} · ${W[lang].signal}`, body: `${eventName(lang)}. ${W[lang].signalBody}` });
