// Client cTrader Open API (FxPro) en LECTURE SEULE : bougies M5 / M15 / H1 au prix du broker.
// Protocole JSON sur WebSocket (port 5036), messages { clientMsgId, payloadType, payload } — help.ctrader.com/open-api.
// Aucun message de trading n'est implémenté : l'app ne peut pas passer d'ordre.
//
// Variables d'environnement (panneau Secrets d'AI Studio, ou .env en local) :
//   CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET   application créée sur openapi.ctrader.com
//   CTRADER_ACCESS_TOKEN                        jeton du compte (autorisation « accounts » = lecture seule recommandée)
//   CTRADER_REFRESH_TOKEN                       facultatif : renouvelle le jeton s'il expire
//   CTRADER_ACCOUNT_ID                          facultatif : ctidTraderAccountId (sinon premier compte de l'environnement)
//   CTRADER_ENV                                 demo (défaut) ou live
//   CTRADER_SYMBOL_XAU, CTRADER_SYMBOL_EUR      facultatifs : nom du symbole chez le broker (défaut XAUUSD / EURUSD)
import type { Candle } from './marketData';

export const PT = {
  HEARTBEAT: 51,
  COMMON_ERROR: 50,
  APP_AUTH_REQ: 2100,
  APP_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  GET_TRENDBARS_REQ: 2137,
  GET_TRENDBARS_RES: 2138,
  ERROR_RES: 2142,
  TOKEN_INVALIDATED_EVENT: 2147,
  CLIENT_DISCONNECT_EVENT: 2148,
  ACCOUNTS_BY_TOKEN_REQ: 2149,
  ACCOUNTS_BY_TOKEN_RES: 2150,
  REFRESH_TOKEN_REQ: 2173,
  REFRESH_TOKEN_RES: 2174,
} as const;

/** ProtoOATrendbarPeriod */
export const PERIOD = { M5: 5, M15: 7, H1: 9 } as const;
export type CtTf = keyof typeof PERIOD;
const TF_MS: Record<CtTf, number> = { M5: 300_000, M15: 900_000, H1: 3_600_000 };
/** Taille d'une requête d'historique (on découpe en tranches pour rester sous les limites de l'API). */
const CHUNK_MS: Record<CtTf, number> = { M5: 7 * 86_400_000, M15: 21 * 86_400_000, H1: 90 * 86_400_000 };
/** Les prix des barres sont des entiers au 1/100 000 (indépendant du nombre de décimales du symbole). */
const PRICE_SCALE = 100_000;

export interface CTraderConfig {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string | null;
  accountId: number | null;
  env: 'demo' | 'live';
  symbols: Record<string, string>;
}

/** Configuration lue dans l'environnement ; null si cTrader n'est pas configuré (l'app reste sur Twelve Data). */
export function ctraderConfig(env: Record<string, string | undefined> = process.env): CTraderConfig | null {
  const clientId = (env.CTRADER_CLIENT_ID || '').trim();
  const clientSecret = (env.CTRADER_CLIENT_SECRET || '').trim();
  const accessToken = (env.CTRADER_ACCESS_TOKEN || '').trim();
  if (!clientId || !clientSecret || !accessToken) return null;
  const acc = Number((env.CTRADER_ACCOUNT_ID || '').trim());
  return {
    clientId,
    clientSecret,
    accessToken,
    refreshToken: (env.CTRADER_REFRESH_TOKEN || '').trim() || null,
    accountId: Number.isFinite(acc) && acc > 0 ? acc : null,
    env: (env.CTRADER_ENV || 'demo').trim().toLowerCase() === 'live' ? 'live' : 'demo',
    symbols: {
      'XAU/USD': (env.CTRADER_SYMBOL_XAU || 'XAUUSD').trim(),
      'EUR/USD': (env.CTRADER_SYMBOL_EUR || 'EURUSD').trim(),
    },
  };
}

/** Sous-ensemble de l'API WebSocket du navigateur / de Node 22 (remplaçable en test). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev?: any) => void) | null;
  onerror: ((ev?: any) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;
const defaultFactory: SocketFactory = url => {
  const WS = (globalThis as any).WebSocket;
  if (!WS) throw new Error('WebSocket indisponible dans ce Node.js (version 22 ou plus requise).');
  return new WS(url) as SocketLike;
};

export class CTraderError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Barre cTrader → bougie de l'app (prix bid du broker). */
export function toCandle(bar: any): Candle | null {
  const t = Number(bar?.utcTimestampInMinutes) * 60_000;
  const low = Number(bar?.low);
  if (!Number.isFinite(t) || !Number.isFinite(low) || t <= 0) return null;
  const d = (k: string) => Number(bar?.[k] ?? 0); // les champs à 0 sont absents du JSON
  return { t, o: (low + d('deltaOpen')) / PRICE_SCALE, h: (low + d('deltaHigh')) / PRICE_SCALE, l: low / PRICE_SCALE, c: (low + d('deltaClose')) / PRICE_SCALE };
}

const norm = (s: string) => s.replace(/[^A-Z0-9]/gi, '').toUpperCase();

export class CTraderClient {
  private ws: SocketLike | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (p: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private accountId: number | null;
  private symbolIds = new Map<string, number>();
  /** dernier problème rencontré (affiché dans le statut de l'app) */
  lastError: string | null = null;
  /** périmètre du jeton : SCOPE_VIEW (lecture) ou SCOPE_TRADE */
  scope: string | null = null;
  tokenRefreshedAt: number | null = null;

  constructor(
    private cfg: CTraderConfig,
    private factory: SocketFactory = defaultFactory,
    private opts: { timeoutMs?: number; idleMs?: number; heartbeatMs?: number } = {}
  ) {
    this.accountId = cfg.accountId;
  }

  get url() {
    return `wss://${this.cfg.env}.ctraderapi.com:5036`;
  }

  /** Bougies d'un actif, de la plus ancienne à la plus récente (la dernière peut être en cours). */
  async trendbars(pairId: string, tf: CtTf, count: number, now = Date.now()): Promise<Candle[]> {
    await this.connect();
    const symbolId = this.symbolIds.get(pairId);
    if (!symbolId) throw new CTraderError('SYMBOL_NOT_FOUND', `Symbole ${this.cfg.symbols[pairId] ?? pairId} introuvable chez le broker (renseigne CTRADER_SYMBOL_XAU / CTRADER_SYMBOL_EUR).`);
    const byT = new Map<number, Candle>();
    let to = now + TF_MS[tf];
    const maxChunks = Math.ceil((count * TF_MS[tf]) / CHUNK_MS[tf]) + 4; // marge pour les week-ends
    for (let k = 0; k < maxChunks && byT.size < count; k++) {
      const from = to - CHUNK_MS[tf];
      const res = await this.request(PT.GET_TRENDBARS_REQ, { ctidTraderAccountId: this.accountId, symbolId, period: PERIOD[tf], fromTimestamp: from, toTimestamp: to }, PT.GET_TRENDBARS_RES);
      for (const bar of res?.trendbar ?? []) {
        const c = toCandle(bar);
        if (c) byT.set(c.t, c);
      }
      to = from;
    }
    this.touch();
    return [...byT.values()].sort((a, b) => a.t - b.t).slice(-count);
  }

  /** Connexion + authentification application et compte + liste des symboles (une seule fois par connexion). */
  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await this.open();
      await this.request(PT.APP_AUTH_REQ, { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret }, PT.APP_AUTH_RES);
      await this.resolveAccount();
      await this.authAccount();
      const list = await this.request(PT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: this.accountId, includeArchivedSymbols: false }, PT.SYMBOLS_LIST_RES);
      const symbols: any[] = list?.symbol ?? [];
      for (const [pairId, name] of Object.entries(this.cfg.symbols)) {
        const s = symbols.find(x => norm(String(x.symbolName ?? '')) === norm(name)) ?? symbols.find(x => norm(String(x.symbolName ?? '')).startsWith(norm(name)));
        if (s) this.symbolIds.set(pairId, Number(s.symbolId));
      }
      this.lastError = null;
    })().catch(err => {
      this.lastError = String(err?.message || err);
      this.reset();
      throw err;
    });
    return this.ready;
  }

  private async resolveAccount() {
    const res = await this.request(PT.ACCOUNTS_BY_TOKEN_REQ, { accessToken: this.cfg.accessToken }, PT.ACCOUNTS_BY_TOKEN_RES);
    // énumération en texte ou en nombre selon l'encodage JSON (SCOPE_VIEW = 0, SCOPE_TRADE = 1) ; absente = valeur par défaut 0
    const sc = res?.permissionScope;
    this.scope = sc === 1 || sc === '1' || sc === 'SCOPE_TRADE' ? 'SCOPE_TRADE' : 'SCOPE_VIEW';
    if (this.scope === 'SCOPE_TRADE') console.warn('[cTrader] Jeton avec droit de trading : l’app ne l’utilise qu’en lecture, mais un jeton « accounts » (lecture seule) est plus sûr.');
    if (this.accountId) return;
    const accounts: any[] = res?.ctidTraderAccount ?? [];
    const wantLive = this.cfg.env === 'live';
    const acc = accounts.find(a => !!a.isLive === wantLive);
    if (!acc) throw new CTraderError('NO_ACCOUNT', `Aucun compte ${wantLive ? 'réel' : 'démo'} autorisé pour ce jeton cTrader (vérifie CTRADER_ENV).`);
    this.accountId = Number(acc.ctidTraderAccountId);
  }

  private async authAccount() {
    try {
      await this.request(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: this.accountId, accessToken: this.cfg.accessToken }, PT.ACCOUNT_AUTH_RES);
    } catch (e: any) {
      // jeton expiré : on le renouvelle une fois avec le refresh token (en mémoire, jamais affiché ni journalisé)
      if (!(e instanceof CTraderError) || !/TOKEN|ACCESS_DENIED|INVALID/i.test(e.code) || !this.cfg.refreshToken) throw e;
      const r = await this.request(PT.REFRESH_TOKEN_REQ, { refreshToken: this.cfg.refreshToken }, PT.REFRESH_TOKEN_RES);
      if (!r?.accessToken) throw e;
      this.cfg = { ...this.cfg, accessToken: r.accessToken, refreshToken: r.refreshToken || this.cfg.refreshToken };
      this.tokenRefreshedAt = Date.now();
      console.warn('[cTrader] Jeton renouvelé automatiquement. Génère un nouveau jeton et mets à jour CTRADER_ACCESS_TOKEN / CTRADER_REFRESH_TOKEN.');
      await this.request(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: this.accountId, accessToken: this.cfg.accessToken }, PT.ACCOUNT_AUTH_RES);
    }
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = this.factory(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new CTraderError('TIMEOUT', 'Connexion cTrader : pas de réponse en 15 s.'));
          try { ws.close(); } catch { /* déjà fermé */ }
        }
      }, this.opts.timeoutMs ?? 15_000);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.heartbeat = setInterval(() => this.send(PT.HEARTBEAT, {}), this.opts.heartbeatMs ?? 10_000);
        resolve();
      };
      ws.onmessage = ev => this.onMessage(ev.data);
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new CTraderError('CONNECTION', `Connexion à ${this.url} impossible.`));
        }
      };
      ws.onclose = () => this.reset(new CTraderError('CLOSED', 'Connexion cTrader fermée.'));
    });
  }

  private onMessage(raw: any) {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    const type = Number(msg?.payloadType);
    if (type === PT.HEARTBEAT) return;
    if (type === PT.TOKEN_INVALIDATED_EVENT || type === PT.CLIENT_DISCONNECT_EVENT) {
      this.lastError = type === PT.TOKEN_INVALIDATED_EVENT ? 'Jeton cTrader invalidé : régénère-le.' : 'Déconnecté par le serveur cTrader.';
      this.reset(new CTraderError('DISCONNECTED', this.lastError));
      return;
    }
    const p = msg?.clientMsgId ? this.pending.get(msg.clientMsgId) : undefined;
    if (!p) return;
    this.pending.delete(msg.clientMsgId);
    clearTimeout(p.timer);
    if (type === PT.ERROR_RES || type === PT.COMMON_ERROR) {
      const code = String(msg.payload?.errorCode ?? 'ERROR');
      const desc = String(msg.payload?.description ?? '');
      p.reject(new CTraderError(code, `cTrader : ${code}${desc ? ` (${desc})` : ''}`));
    } else p.resolve({ __type: type, ...(msg.payload ?? {}) });
  }

  private send(payloadType: number, payload: any, clientMsgId?: string) {
    this.ws?.send(JSON.stringify(clientMsgId ? { clientMsgId, payloadType, payload } : { payloadType, payload }));
  }

  private request(payloadType: number, payload: any, expect: number): Promise<any> {
    if (!this.ws) return Promise.reject(new CTraderError('CLOSED', 'Connexion cTrader fermée.'));
    const id = `ora_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CTraderError('TIMEOUT', `cTrader : pas de réponse (message ${payloadType}).`));
      }, this.opts.timeoutMs ?? 15_000);
      this.pending.set(id, {
        resolve: (res: any) => (res.__type === expect ? resolve(res) : reject(new CTraderError('UNEXPECTED', `cTrader : réponse ${res.__type} au lieu de ${expect}.`))),
        reject,
        timer,
      });
      this.send(payloadType, payload, id);
    });
  }

  /** Ferme la connexion après une période sans activité (instance Cloud Run économe). */
  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.opts.idleMs ?? 5 * 60_000);
  }

  close() {
    const ws = this.ws;
    this.reset(new CTraderError('CLOSED', 'Connexion cTrader fermée.'));
    try { ws?.close(); } catch { /* déjà fermé */ }
  }

  private reset(err?: Error) {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.idle) clearTimeout(this.idle);
    this.heartbeat = null;
    this.idle = null;
    this.ws = null;
    this.ready = null;
    this.symbolIds.clear();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err ?? new CTraderError('CLOSED', 'Connexion cTrader fermée.'));
    }
    this.pending.clear();
  }
}

// ---------- Instance partagée par le serveur ----------
let shared: CTraderClient | null = null;
let sharedKey = '';

/** Client cTrader configuré par l'environnement (null sans configuration). */
export function getCTrader(): CTraderClient | null {
  const cfg = ctraderConfig();
  if (!cfg) return null;
  const key = `${cfg.clientId}|${cfg.accessToken.slice(-6)}|${cfg.env}|${cfg.accountId ?? ''}`;
  if (!shared || key !== sharedKey) {
    shared?.close();
    shared = new CTraderClient(cfg);
    sharedKey = key;
  }
  return shared;
}

/** Statut affiché dans l'app (aucun secret). */
export function ctraderStatus() {
  const cfg = ctraderConfig();
  if (!cfg) return { configured: false as const };
  const c = getCTrader()!;
  return {
    configured: true as const,
    env: cfg.env,
    lastError: c.lastError,
    readOnly: c.scope ? c.scope === 'SCOPE_VIEW' : null,
    tokenRefreshed: c.tokenRefreshedAt !== null,
  };
}
