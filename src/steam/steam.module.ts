import { Module } from '@nestjs/common';
import { StreamlinedSteamService } from './steam.service';
import { SteamController } from './steam.controller';
import { SteamIdResolver } from './steam-id.resolver';
import { SteamDetailLoader } from './steam-detail.loader';
import { SteamReviewAggregator } from './steam-review.aggregator';
import { SteamBridge } from './steam-bridge.service';

@Module({
  providers: [
    SteamIdResolver,
    SteamDetailLoader,
    SteamReviewAggregator,
    SteamBridge,
    StreamlinedSteamService,
  ],
  controllers: [SteamController],
  exports: [
    SteamIdResolver,
    SteamDetailLoader,
    SteamReviewAggregator,
    SteamBridge,
    StreamlinedSteamService,
  ], // 다른 모듈에서 사용할 수 있도록 export
})
export class SteamModule {}
