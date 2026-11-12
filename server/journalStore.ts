// Stockage persistant du journal (signaux proposés par l'app + annotations des trades), partagé par tous tes appareils.
// Le serveur AI Studio (Cloud Run) n'a pas de disque durable : on garde un petit fichier JSON épinglé dans ta
// conversation Telegram avec le bot (déjà configuré). Il sert aussi de sauvegarde. Sans Telegram : mémoire seule.
import { telegramConfig, type FetchLike } from './telegram';

export interface SignalRec {
  id: string;
  pair: string;
  kind: 'protocole' | 'test';
  direction: 'acheter' | 'vendre';
  entry: number;
  sl: number;
  tp1: number | null;
  tp2: number | null;
  at: number;
  validUntil: number | null;
  zone: string | null;
}
export type TradeKind = 'protocole' | 'test' | 'hors';
export interface Annotation {
  kind?: TradeKind;
  note?: string;
  /** stop saisi à la main quand ni le plan ni l'ordre ne le donnent (pour calculer le R) */
  sl?: number | null;
}
export interface StoreData {
  v: 1;
  signals: SignalRec[];
  annotations: Record<string, Annotation>;
  /** alertes de risque déjà envoyées (clé → heure), pour ne pas les répéter */
  riskAlerts?: Record<string, number>;
}

const FILE_NAME = 'ora-journal.json';
const MAX_SIGNALS = 1500;
const empty = (): StoreData => ({ v: 1, signals: [], annotations: {} });

export class JournalStore {
  private data: StoreData | null = null;
  private loading: Promise<StoreData> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pinnedId: number | null = null;
  lastError: string | null = null;

  constructor(
    private env: Record<string, string | undefined> = process.env,
    private fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    private saveDelayMs = 3_000
  ) {}

  get persistent() {
    return !!telegramConfig(this.env);
  }

  async get(): Promise<StoreData> {
    if (this.data) return this.data;
    if (!this.loading) {
      this.loading = this.load()
        .catch(e => {
          this.lastError = `Lecture de la sauvegarde Telegram impossible : ${String(e?.message || e).slice(0, 160)}`;
          return empty();
        })
        .then(d => (this.data = d));
    }
    return this.loading;
  }

  /** Enregistre un signal proposé (protocole ou TEST) ; ignoré s'il est déjà connu (même actif, sens et zone). */
  async addSignal(s: SignalRec): Promise<boolean> {
    const d = await this.get();
    if (d.signals.some(x => x.id === s.id)) return false;
    d.signals.push(s);
    if (d.signals.length > MAX_SIGNALS) d.signals.splice(0, d.signals.length - MAX_SIGNALS);
    this.scheduleSave();
    return true;
  }

  async annotate(positionId: string, a: Annotation): Promise<Annotation> {
    const d = await this.get();
    const cur = { ...(d.annotations[positionId] ?? {}) };
    if (a.kind !== undefined) cur.kind = a.kind;
    if (a.note !== undefined) cur.note = a.note.slice(0, 500);
    if (a.sl !== undefined) cur.sl = a.sl === null || !Number.isFinite(Number(a.sl)) || Number(a.sl) <= 0 ? null : Number(a.sl);
    d.annotations[positionId] = cur;
    this.scheduleSave();
    return cur;
  }

  /** Marque une alerte de risque comme envoyée ; false si elle l'était déjà. */
  async markRiskAlert(key: string, now = Date.now()): Promise<boolean> {
    const d = await this.get();
    d.riskAlerts ??= {};
    if (d.riskAlerts[key]) return false;
    d.riskAlerts[key] = now;
    for (const [k, t] of Object.entries(d.riskAlerts)) if (now - t > 7 * 86_400_000) delete d.riskAlerts[k];
    this.scheduleSave();
    return true;
  }

  /** Écrit tout de suite (tests, ou avant arrêt). */
  async flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.save();
  }

  private scheduleSave() {
    if (!this.persistent) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch(() => undefined);
    }, this.saveDelayMs);
  }

  private api(method: string) {
    return `https://api.telegram.org/bot${telegramConfig(this.env)!.token}/${method}`;
  }

  private async call(method: string, body: any) {
    const res = await this.fetchImpl(this.api(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!json?.ok) throw new Error(json?.description || `erreur ${res.status}`);
    return json.result;
  }

  private async load(): Promise<StoreData> {
    const cfg = telegramConfig(this.env);
    if (!cfg) return empty();
    const chat = await this.call('getChat', { chat_id: cfg.chatId });
    const pinned = chat?.pinned_message;
    const doc = pinned?.document;
    if (!doc || doc.file_name !== FILE_NAME) return empty();
    this.pinnedId = pinned.message_id;
    const file = await this.call('getFile', { file_id: doc.file_id });
    const res = await this.fetchImpl(`https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`, { signal: AbortSignal.timeout(10_000) });
    const json: any = await res.json();
    if (json?.v !== 1 || !Array.isArray(json.signals)) return empty();
    return { v: 1, signals: json.signals, annotations: json.annotations ?? {}, riskAlerts: json.riskAlerts ?? {} };
  }

  private async save() {
    const cfg = telegramConfig(this.env);
    if (!cfg || !this.data) return;
    try {
      const form = new FormData();
      form.append('chat_id', cfg.chatId);
      form.append('disable_notification', 'true');
      form.append('caption', 'Sauvegarde du journal ORA Trader (mise à jour automatique) — ne pas désépingler ni supprimer.');
      form.append('document', new Blob([JSON.stringify(this.data)], { type: 'application/json' }), FILE_NAME);
      const res = await this.fetchImpl(this.api('sendDocument'), { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) });
      const json = await res.json().catch(() => ({}));
      if (!json?.ok) throw new Error(json?.description || `erreur ${res.status}`);
      const newId = json.result.message_id;
      await this.call('pinChatMessage', { chat_id: cfg.chatId, message_id: newId, disable_notification: true });
      const old = this.pinnedId;
      this.pinnedId = newId;
      if (old) {
        await this.call('unpinChatMessage', { chat_id: cfg.chatId, message_id: old }).catch(() => undefined);
        await this.call('deleteMessage', { chat_id: cfg.chatId, message_id: old }).catch(() => undefined);
      }
      this.lastError = null;
    } catch (e: any) {
      this.lastError = `Sauvegarde Telegram impossible : ${String(e?.message || e).slice(0, 160)}`;
    }
  }
}

let shared: JournalStore | null = null;
export function getJournalStore(): JournalStore {
  if (!shared) shared = new JournalStore();
  return shared;
}
