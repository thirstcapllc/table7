import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Account } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const START_CASH = 1000;
const COMP_CASH = 500;

// The money boundary. Games never write to accounts/transactions directly —
// they go through here, so identity, chips, comps, tiers, and audit history are
// owned by the platform and stay consistent across every game.
@Injectable()
export class CageService {
  constructor(private prisma: PrismaService) {}

  tier(points: number): 'Bronze' | 'Silver' | 'Gold' | 'Platinum' {
    if (points >= 5000) return 'Platinum';
    if (points >= 1500) return 'Gold';
    if (points >= 400) return 'Silver';
    return 'Bronze';
  }

  private newPlayerNo() { return String(Math.floor(100000 + Math.random() * 900000)); }
  private newPin() { return String(Math.floor(1000 + Math.random() * 9000)); }

  byToken(token: string) {
    return this.prisma.account.findUnique({ where: { token } });
  }
  byPlayerNo(playerNo: string) {
    return this.prisma.account.findUnique({ where: { playerNo } });
  }

  /** Load an account by token, or mint a fresh one. Bails out broke players. */
  async getOrCreate(token?: string): Promise<{ account: Account; created: boolean; comped: boolean }> {
    if (token) {
      const acc = await this.byToken(token);
      if (acc) {
        if (acc.cash < 50) {
          const updated = await this.prisma.account.update({
            where: { token }, data: { cash: acc.cash + COMP_CASH, comps: acc.comps + 1 },
          });
          await this.log(token, 'comp', COMP_CASH, updated.cash, { note: 'broke — cage comp' });
          return { account: updated, created: false, comped: true };
        }
        return { account: acc, created: false, comped: false };
      }
    }
    let playerNo = this.newPlayerNo();
    while (await this.byPlayerNo(playerNo)) playerNo = this.newPlayerNo();
    const account = await this.prisma.account.create({
      data: { token: randomBytes(12).toString('hex'), playerNo, pin: this.newPin(), cash: START_CASH },
    });
    return { account, created: true, comped: false };
  }

  setName(token: string, name: string) {
    const clean = String(name || '').replace(/[^A-Za-z0-9 _.'-]/g, '').trim().slice(0, 14);
    return this.prisma.account.update({ where: { token }, data: { name: clean } });
  }

  async log(token: string, type: string, amount: number, balanceAfter: number,
            opts: { game?: string; tableCode?: string; note?: string } = {}) {
    await this.prisma.transaction.create({
      data: { accountToken: token, type, amount, balanceAfter, game: opts.game ?? null, tableCode: opts.tableCode ?? null, note: opts.note ?? null },
    });
  }

  /** A game reports one settled round for a player: adjust chips, award comps, log it. */
  async settle(token: string, game: string, opts: { tableCode?: string; ref?: string; bet: number; result: string; payout: number }) {
    const acc = await this.byToken(token);
    if (!acc) return null;
    const cash = acc.cash + opts.payout;
    const compPoints = acc.compPoints + Math.max(0, opts.bet); // 1 pt per $ wagered
    const updated = await this.prisma.account.update({ where: { token }, data: { cash, compPoints } });
    await this.prisma.round.create({
      data: { accountToken: token, game, tableCode: opts.tableCode ?? null, ref: opts.ref ?? null, bet: opts.bet, result: opts.result, payout: opts.payout },
    });
    return updated;
  }

  async history(token: string, limit = 100) {
    const [transactions, rounds] = await Promise.all([
      this.prisma.transaction.findMany({ where: { accountToken: token }, orderBy: { createdAt: 'desc' }, take: limit }),
      this.prisma.round.findMany({ where: { accountToken: token }, orderBy: { createdAt: 'desc' }, take: limit }),
    ]);
    return { transactions, rounds };
  }

  /** Public shape of an account (never leaks nothing beyond what the player sees). */
  view(acc: Account) {
    return {
      token: acc.token, no: acc.playerNo, pin: acc.pin, name: acc.name,
      cash: acc.cash, compPoints: acc.compPoints, tier: this.tier(acc.compPoints), since: acc.createdAt,
    };
  }
}
