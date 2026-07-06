import { Body, Controller, Get, Post } from '@nestjs/common';
import { CageService } from './cage.service';

@Controller()
export class CageController {
  constructor(private cage: CageService) {}

  @Get('health')
  health() {
    return { ok: true, service: 'table-seven-v5', ts: Date.now() };
  }

  /** Load or create the caller's account; optionally set the name. */
  @Post('account')
  async account(@Body() body: { token?: string; name?: string }) {
    let { account, created, comped } = await this.cage.getOrCreate(body.token);
    if (body.name) account = await this.cage.setName(account.token, body.name);
    return { ...this.cage.view(account), created, comped };
  }

  /** A player's own card summary + credits/debits + round history (token-authed). */
  @Post('my-history')
  async myHistory(@Body() body: { token: string }) {
    const acc = await this.cage.byToken(String(body.token || ''));
    if (!acc) return { error: 'Unknown account.' };
    const hist = await this.cage.history(acc.token);
    return { account: this.cage.view(acc), ...hist };
  }
}
