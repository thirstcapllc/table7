import { Injectable, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CageService } from '../cage/cage.service';

// Owner master key (env) always unlocks and manages staff. Staff are
// username+password rows in the DB with in-memory session tokens.
const ADMIN_KEY = process.env.TABLE_ADMIN_KEY || randomBytes(6).toString('hex');
const SESSION_MS = 8 * 60 * 60 * 1000;
const START_CASH = 1000;

export interface AdminSession { who: string; isOwner: boolean; expiresAt: number; }

@Injectable()
export class AuthService implements OnModuleInit {
  private sessions = new Map<string, AdminSession>();

  constructor(private prisma: PrismaService, private cage: CageService) {}

  onModuleInit() {
    if (!process.env.TABLE_ADMIN_KEY) {
      // eslint-disable-next-line no-console
      console.log('  [auth] owner key (dev, random this boot): ' + ADMIN_KEY);
    }
    setInterval(() => {
      const now = Date.now();
      for (const [t, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(t);
    }, 10 * 60000).unref();
  }

  // ---- credentials ----
  private pinEqual(a: string, b: string) {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
  }
  hashPassword(password: string, salt?: string) {
    salt = salt || randomBytes(16).toString('hex');
    return { hash: scryptSync(String(password), salt, 32).toString('hex'), salt };
  }
  private verifyPassword(password: string, rec: { hash: string; salt: string }) {
    if (!rec || !rec.salt || !rec.hash) return false;
    const a = Buffer.from(scryptSync(String(password), rec.salt, 32).toString('hex'));
    const b = Buffer.from(rec.hash);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  private isMasterKey(key: string) {
    const a = createHash('sha256').update(String(key || '')).digest();
    const b = createHash('sha256').update(ADMIN_KEY).digest();
    return timingSafeEqual(a, b);
  }

  // ---- player login (returning Player# + PIN) ----
  async playerLogin(number: string, pin: string, discard?: string) {
    const no = String(number || '').replace(/\D/g, '').slice(0, 8);
    const p = String(pin || '').replace(/\D/g, '').slice(0, 8);
    const acc = no ? await this.cage.byPlayerNo(no) : null;
    if (!acc || !this.pinEqual(acc.pin, p)) return null;
    if (discard && discard !== acc.token) {
      const guest = await this.cage.byToken(discard);
      if (guest && guest.cash === START_CASH && !guest.name) {
        try { await this.prisma.account.delete({ where: { token: discard } }); } catch (e) { /* ignore */ }
      }
    }
    return acc;
  }

  // ---- admin sessions ----
  private newSession(who: string, isOwner: boolean) {
    const t = randomBytes(24).toString('hex');
    this.sessions.set(t, { who, isOwner, expiresAt: Date.now() + SESSION_MS });
    return t;
  }
  async adminLogin(body: { username?: string; password?: string; key?: string }) {
    const username = String(body.username || '').trim();
    if (username) {
      const rec = await this.prisma.admin.findUnique({ where: { username } });
      if (rec && this.verifyPassword(body.password || '', rec)) {
        return { session: this.newSession(username, false), who: username, isOwner: false };
      }
      return null;
    }
    if (this.isMasterKey(body.key || '')) return { session: this.newSession('owner', true), who: 'owner', isOwner: true };
    return null;
  }
  auth(body: { session?: string; key?: string }): AdminSession | null {
    if (body && body.session) {
      const s = this.sessions.get(String(body.session));
      if (s && s.expiresAt > Date.now()) return s;
    }
    if (body && body.key && this.isMasterKey(body.key)) return { who: 'owner', isOwner: true, expiresAt: Infinity };
    return null;
  }

  // ---- staff management (owner) ----
  listStaff() { return this.prisma.admin.findMany({ select: { username: true }, orderBy: { username: 'asc' } }); }
  async addStaff(username: string, password: string) {
    const rec = this.hashPassword(password);
    await this.prisma.admin.upsert({ where: { username }, create: { username, ...rec }, update: rec });
  }
  async removeStaff(username: string) {
    for (const [t, s] of this.sessions) if (s.who === username) this.sessions.delete(t);
    return this.prisma.admin.delete({ where: { username } }).catch(() => null);
  }
}
