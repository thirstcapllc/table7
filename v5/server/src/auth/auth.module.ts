import { Module } from '@nestjs/common';
import { CageModule } from '../cage/cage.module';
import { AuthService } from './auth.service';
import { PlayerAuthController } from './player-auth.controller';
import { AdminController } from './admin.controller';

@Module({
  imports: [CageModule],
  providers: [AuthService],
  controllers: [PlayerAuthController, AdminController],
  exports: [AuthService],
})
export class AuthModule {}
