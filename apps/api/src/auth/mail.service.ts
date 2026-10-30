import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

export interface MailAttachment {
  filename: string;
  content: Buffer;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}

// Sending mail. Order: Resend (RESEND_API_KEY, over its HTTPS API), then SMTP (SMTP_URL), then, outside production only,
// the server log (the log shows the link). The sender is EMAIL_FROM (MAIL_FROM is the older name and still works).
// The key is read only here and is never written to a log or an error message.
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
  // Mails sent while running (tests read it; in production it does not grow: a ring of 50)
  readonly outbox: Mail[] = [];

  private from() {
    return process.env.EMAIL_FROM ?? process.env.MAIL_FROM ?? 'LANKA <no-reply@localhost>';
  }

  // Throws on failure; used by send() (which swallows it) and by the test-send script
  async deliver(mail: Mail): Promise<'resend' | 'smtp' | 'log'> {
    if (mail.to.endsWith('@demo.lankaclinic.app')) return 'log'; // made-up demo users have no mailbox
    const key = process.env.RESEND_API_KEY;
    if (key) {
      let res: Response;
      try {
        res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: this.from(), to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.attachments?.length ? { attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })) } : {}) }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        // only the error code (for example ENOTFOUND, UND_ERR_CONNECT_TIMEOUT), never the request
        const code = ((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name).toString().slice(0, 40);
        throw new Error(`Resend недоступний (${code})`);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(`Resend ${res.status}: ${(body?.message ?? '').slice(0, 200)}`);
      }
      return 'resend';
    }
    if (this.transport) {
      await this.transport.sendMail({ from: this.from(), ...mail });
      return 'smtp';
    }
    if (process.env.NODE_ENV !== 'production') this.log.log(`Письмо для ${mail.to}: ${mail.subject}\n${mail.text}`);
    else this.log.error('Ни RESEND_API_KEY, ни SMTP_URL не заданы: письмо не отправлено');
    return 'log';
  }

  async send(mail: Mail) {
    // the ring for tests keeps no file contents
    this.outbox.push({ ...mail, attachments: mail.attachments?.map((a) => ({ filename: a.filename, content: Buffer.alloc(0) })) });
    if (this.outbox.length > 50) this.outbox.shift();
    try {
      await this.deliver(mail);
    } catch (e) {
      // The mail server's error is not shown to the user: the answer must not reveal whether such an email exists
      this.log.error(`Письмо не отправлено: ${(e as Error).message}`);
    }
  }
}
