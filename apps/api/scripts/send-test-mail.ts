// Sends one test mail with the configured provider: npx ts-node scripts/send-test-mail.ts you@example.com
// Prints only the provider name or the error text, never the key.
import 'dotenv/config';
import { MailService } from '../src/auth/mail.service';

async function main() {
  const to = process.argv[2];
  if (!to || !to.includes('@')) throw new Error('Usage: ts-node scripts/send-test-mail.ts <email>');
  const via = await new MailService().deliver({ to, subject: 'LANKA: тестовий лист', text: 'Це тестовий лист від LANKA. Якщо ви його бачите, пошта налаштована правильно.' });
  console.log(`Sent via: ${via}`);
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
