import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { assertConfig } from './common/config';

async function bootstrap() {
  assertConfig(); // in production weak secrets and http addresses mean a refusal to start
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true }) // the raw body is needed to check the Instagram webhook signature;
  // The server stands behind the hosting proxy: we take the real client address (needed for the attempt limits)
  app.set('trust proxy', 1);
  app.use(helmet());
  // The site's own address for the app; the public chat widget (/webchat) answers CORS itself, per clinic, from the sites the clinic listed
  app.enableCors((req: { url?: string }, cb: (err: Error | null, opts: { origin: string | boolean; preflightContinue?: boolean }) => void) =>
    cb(null, req.url?.startsWith('/webchat') || req.url?.startsWith('/leads') ? { origin: false, preflightContinue: true } : { origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' }),
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
