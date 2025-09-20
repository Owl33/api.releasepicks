import { Module } from '@nestjs/common';
import { YouTubeService } from './youtube.service';
import { YouTubeController } from './youtube.controller';

@Module({
  providers: [YouTubeService],
  controllers: [YouTubeController],
  exports: [YouTubeService],
})
export class YouTubeModule {}