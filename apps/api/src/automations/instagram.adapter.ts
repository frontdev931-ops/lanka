import { Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InstagramApi } from './instagram.api';
import { FacebookApi } from './meta-graph.api';
import { MetaAdapter, META_WINDOW_MS } from './meta.adapter';

// Kept under the old name for imports
export const IG_WINDOW_MS = META_WINDOW_MS;

@Injectable()
export class InstagramAdapter extends MetaAdapter {
  readonly channel = 'INSTAGRAM';
  protected readonly provider = Provider.INSTAGRAM;

  constructor(prisma: PrismaService, api: InstagramApi, private fbApi: FacebookApi) {
    super(prisma, api);
  }

  protected apiFor(config?: Record<string, unknown>) {
    return config?.mode === 'FACEBOOK_LOGIN' ? this.fbApi : this.api;
  }
}
