import { Module } from '@nestjs/common';
import { MetaLoginApi } from '../automations/meta-login.api';
import { MetaAdsApi } from './meta-ads.api';
import { MetaAdsController, MetaAdsPublicController } from './meta-ads.controller';
import { MetaAdsService } from './meta-ads.service';

// Meta ad analytics (read only); its own login and API client, independent of the messaging module
@Module({ controllers: [MetaAdsController, MetaAdsPublicController], providers: [MetaAdsService, MetaAdsApi, MetaLoginApi] })
export class AdsModule {}
