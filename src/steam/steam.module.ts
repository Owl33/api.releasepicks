import { Module } from '@nestjs/common';
import { StreamlinedSteamService } from './steam.service';
import { SteamController } from './steam.controller';

@Module({
  providers: [StreamlinedSteamService],
  controllers: [SteamController],
  exports: [StreamlinedSteamService], // 다른 모듈에서 사용할 수 있도록 export
})
export class SteamModule {}
