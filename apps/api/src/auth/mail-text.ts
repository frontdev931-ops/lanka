import type { Lang } from '../common/i18n';

const T = {
  reset: {
    uk: { subject: 'LANKA: скидання пароля', body: (url: string) => `Щоб задати новий пароль, відкрийте посилання (діє 1 годину):\n${url}\n\nЯкщо ви не просили скидання, просто проігноруйте цей лист.` },
    ru: { subject: 'LANKA: сброс пароля', body: (url: string) => `Чтобы задать новый пароль, откройте ссылку (действует 1 час):\n${url}\n\nЕсли вы не просили сброс, просто проигнорируйте это письмо.` },
    en: { subject: 'LANKA: reset your password', body: (url: string) => `Open this link to set a new password (valid for 1 hour):\n${url}\n\nIf you did not ask for a reset, ignore this email.` },
  },
  verify: {
    uk: { subject: 'LANKA: підтвердіть пошту', body: (url: string) => `Щоб підтвердити пошту, відкрийте посилання (діє 3 дні):\n${url}` },
    ru: { subject: 'LANKA: подтвердите почту', body: (url: string) => `Чтобы подтвердить почту, откройте ссылку (действует 3 дня):\n${url}` },
    en: { subject: 'LANKA: confirm your email', body: (url: string) => `Open this link to confirm your email (valid for 3 days):\n${url}` },
  },
  emailChange: {
    uk: { subject: 'LANKA: підтвердіть нову пошту', body: (url: string) => `Щоб змінити пошту для входу на цю адресу, відкрийте посилання (діє 3 дні):\n${url}\n\nЯкщо ви цього не просили, проігноруйте лист: пошта не зміниться.` },
    ru: { subject: 'LANKA: подтвердите новую почту', body: (url: string) => `Чтобы сменить почту для входа на этот адрес, откройте ссылку (действует 3 дня):\n${url}\n\nЕсли вы этого не просили, проигнорируйте письмо: почта не изменится.` },
    en: { subject: 'LANKA: confirm your new email', body: (url: string) => `Open this link to change your sign-in email to this address (valid for 3 days):\n${url}\n\nIf you did not ask for this, ignore the email: nothing will change.` },
  },
};

export const mailText = (kind: 'reset' | 'verify' | 'emailChange', lang: Lang, url: string) => ({ subject: T[kind][lang].subject, text: T[kind][lang].body(url) });
