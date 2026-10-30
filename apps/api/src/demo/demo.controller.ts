import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { setSessionCookie } from '../auth/auth.controller';
import { DemoService } from './demo.service';

// Public: starts a visitor's own demo clinic and signs them in to it. Limited by address and by the number of live copies.
@Controller('demo')
export class DemoController {
  constructor(private demo: DemoService) {}

  @Post('start')
  @HttpCode(200)
  async start(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.demo.start(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    setSessionCookie(res, r.accessToken);
    return { ok: true };
  }
}
