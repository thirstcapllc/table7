import { Body, Controller, HttpCode, HttpException, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CageService } from '../cage/cage.service';

@Controller()
export class PlayerAuthController {
  constructor(private auth: AuthService, private cage: CageService) {}

  /** Returning player logs in with their Player # + PIN. */
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { number?: string; pin?: string; discard?: string }) {
    const acc = await this.auth.playerLogin(body.number || '', body.pin || '', body.discard);
    if (!acc) {
      await new Promise((r) => setTimeout(r, 400)); // slow brute force
      throw new HttpException({ error: 'Player number or PIN is wrong.' }, 403);
    }
    return this.cage.view(acc);
  }
}
