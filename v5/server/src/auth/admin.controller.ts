import { Body, Controller, HttpCode, HttpException, Post } from '@nestjs/common';
import { AuthService, AdminSession } from './auth.service';
import { CageService } from '../cage/cage.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('admin')
export class AdminController {
  constructor(private auth: AuthService, private cage: CageService, private prisma: PrismaService) {}

  private require(body: any): AdminSession {
    const s = this.auth.auth(body);
    if (!s) throw new HttpException({ error: 'Not signed in as an admin.' }, 403);
    return s;
  }
  private requireOwner(body: any): AdminSession {
    const s = this.require(body);
    if (!s.isOwner) throw new HttpException({ error: 'Owner only.' }, 403);
    return s;
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { username?: string; password?: string; key?: string }) {
    const res = await this.auth.adminLogin(body);
    if (!res) { await new Promise((r) => setTimeout(r, 400)); throw new HttpException({ error: 'Wrong credentials.' }, 403); }
    return res;
  }

  @Post('overview')
  @HttpCode(200)
  async overview(@Body() body: any) {
    const s = this.require(body);
    const accounts = await this.prisma.account.findMany({ orderBy: { cash: 'desc' }, take: 500 });
    return {
      accounts: accounts.map((a) => ({
        token: a.token, no: a.playerNo, name: a.name || '(unnamed)', cash: a.cash,
        comps: a.comps, compPoints: a.compPoints, tier: this.cage.tier(a.compPoints), since: a.createdAt,
      })),
      you: s.who, isOwner: s.isOwner,
    };
  }

  @Post('credit')
  @HttpCode(200)
  async credit(@Body() body: { token?: string; amount?: number }) {
    this.require(body);
    const amount = Math.round(Number(body.amount) || 0);
    if (!amount || Math.abs(amount) > 100000) throw new HttpException({ error: 'Amount must be ±$1–$100,000.' }, 400);
    const cash = await this.cage.adjustCash(String(body.token || ''), amount);
    if (cash === null) throw new HttpException({ error: 'No such account.' }, 400);
    return { ok: true, cash };
  }

  @Post('resetpin')
  @HttpCode(200)
  async resetpin(@Body() body: { token?: string }) {
    this.require(body);
    const acc = await this.cage.byToken(String(body.token || ''));
    if (!acc) throw new HttpException({ error: 'No such account.' }, 400);
    const pin = await this.cage.resetPin(acc.token);
    return { ok: true, no: acc.playerNo, pin };
  }

  @Post('delete')
  @HttpCode(200)
  async remove(@Body() body: { token?: string }) {
    this.require(body);
    const acc = await this.cage.byToken(String(body.token || ''));
    if (!acc) throw new HttpException({ error: 'No such account.' }, 400);
    await this.prisma.account.delete({ where: { token: acc.token } });
    return { ok: true };
  }

  @Post('history')
  @HttpCode(200)
  async history(@Body() body: { token?: string }) {
    this.require(body);
    const acc = await this.cage.byToken(String(body.token || ''));
    if (!acc) throw new HttpException({ error: 'No such account.' }, 400);
    return this.cage.history(acc.token);
  }

  @Post('staff')
  @HttpCode(200)
  async staff(@Body() body: any) {
    const s = this.requireOwner(body);
    const admins = await this.auth.listStaff();
    return { admins: admins.map((a) => a.username), you: s.who, isOwner: s.isOwner };
  }

  @Post('add-staff')
  @HttpCode(200)
  async addStaff(@Body() body: { username?: string; password?: string }) {
    this.requireOwner(body);
    const username = String(body.username || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24);
    const password = String(body.password || '');
    if (username.length < 3) throw new HttpException({ error: 'Username needs 3+ characters.' }, 400);
    if (password.length < 6) throw new HttpException({ error: 'Password needs 6+ characters.' }, 400);
    if (username === 'owner') throw new HttpException({ error: '"owner" is reserved.' }, 400);
    await this.auth.addStaff(username, password);
    return { ok: true };
  }

  @Post('remove-staff')
  @HttpCode(200)
  async removeStaff(@Body() body: { username?: string }) {
    this.requireOwner(body);
    await this.auth.removeStaff(String(body.username || ''));
    return { ok: true };
  }
}
