import { Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FacebookApi } from './meta-graph.api';
import { MetaAdapter } from './meta.adapter';

@Injectable()
export class FacebookAdapter extends MetaAdapter {
  readonly channel = 'MESSENGER';
  protected readonly provider = Provider.MESSENGER;

  constructor(prisma: PrismaService, api: FacebookApi) {
    super(prisma, api);
  }
}
