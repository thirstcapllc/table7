import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { CageModule } from './cage/cage.module';
import { AuthModule } from './auth/auth.module';

// The platform root. Each game becomes another module imported here, all
// sharing the one CageModule.
@Module({
  imports: [PrismaModule, CageModule, AuthModule],
})
export class AppModule {}
