import { Module } from '@nestjs/common';
import { CageService } from './cage.service';
import { CageController } from './cage.controller';

// Exported so every game module can inject CageService.
@Module({
  providers: [CageService],
  controllers: [CageController],
  exports: [CageService],
})
export class CageModule {}
