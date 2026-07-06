import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();
  const port = process.env.PORT || 7800;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log('\n  ♠ ♥  TABLE SEVEN v5  ♦ ♣  API on http://localhost:' + port + '/api\n');
}
bootstrap();
