import { Logger } from '@nestjs/common';
import { MailService } from '../src/auth/mail.service';
import { configProblems } from '../src/common/config';

const KEY = 're_test_key_do_not_leak_0123456789';
const good = { NODE_ENV: 'production', BILLING_ENFORCED: 'false', JWT_SECRET: 'a'.repeat(40), ENCRYPTION_KEY: 'b'.repeat(40) + 'x', DATABASE_URL: 'postgresql://x', WEB_ORIGIN: 'https://lankaclinic.app' };

describe('пошта через Resend', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  it('лист іде у Resend з ключем у заголовку і відправником EMAIL_FROM; без ключа лист не відправляється нікуди', async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = 'LANKA <notifications@lankaclinic.app>';
    const f = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"id":"1"}', { status: 200 }));
    const via = await new MailService().deliver({ to: 'a@example.com', subject: 'Тема', text: 'Текст' });
    expect(via).toBe('resend');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({ from: 'LANKA <notifications@lankaclinic.app>', to: ['a@example.com'], subject: 'Тема', text: 'Текст' });
    expect(init.body as string).not.toContain(KEY);
  });

  it('помилка Resend не ламає запит і не потрапляє в журнал разом із ключем', async () => {
    process.env.RESEND_API_KEY = KEY;
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void logged.push(String(m)));
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"message":"The domain is not verified"}', { status: 403 }));
    const mail = new MailService();
    await expect(mail.send({ to: 'a@example.com', subject: 's', text: 't' })).resolves.toBeUndefined();
    expect(logged.join('\n')).toContain('403');
    expect(logged.join('\n')).not.toContain(KEY);
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error(`network down ${KEY}`));
    await mail.send({ to: 'a@example.com', subject: 's', text: 't' });
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it('старе ім’я MAIL_FROM працює, якщо EMAIL_FROM не задано', async () => {
    process.env.RESEND_API_KEY = KEY;
    delete process.env.EMAIL_FROM;
    process.env.MAIL_FROM = 'Old <old@lankaclinic.app>';
    const f = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await new MailService().deliver({ to: 'a@example.com', subject: 's', text: 't' });
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string).from).toBe('Old <old@lankaclinic.app>');
  });

  it('у продакшені потрібні ключ пошти і відправник', () => {
    expect(configProblems(good).join()).toContain('RESEND_API_KEY');
    expect(configProblems({ ...good, RESEND_API_KEY: KEY }).join()).toContain('EMAIL_FROM');
    expect(configProblems({ ...good, RESEND_API_KEY: KEY, EMAIL_FROM: 'LANKA <notifications@lankaclinic.app>' })).toEqual([]);
    expect(configProblems({ ...good, SMTP_URL: 'smtps://u:p@h:465' })).toEqual([]);
  });
});

describe('пошта з вкладенням', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });
  it('вкладення йде в Resend як base64; в журналі тестів файл не зберігається', async () => {
    process.env.RESEND_API_KEY = 're_test_key_do_not_leak_0123456789';
    process.env.EMAIL_FROM = 'LANKA <notifications@lankaclinic.app>';
    const f = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const m = new MailService();
    await m.send({ to: 'a@example.com', subject: 's', text: 't', attachments: [{ filename: 'r.xlsx', content: Buffer.from('hello') }] });
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string).attachments).toEqual([{ filename: 'r.xlsx', content: Buffer.from('hello').toString('base64') }]);
    expect(m.outbox[0].attachments![0].content.length).toBe(0);
  });
});
