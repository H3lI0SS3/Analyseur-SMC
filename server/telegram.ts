// Alertes Telegram (envoi seul). Variables : TELEGRAM_BOT_TOKEN (créé avec @BotFather) et TELEGRAM_CHAT_ID.
export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export function telegramConfig(env: Record<string, string | undefined> = process.env): { token: string; chatId: string } | null {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (env.TELEGRAM_CHAT_ID || '').trim();
  return token && chatId ? { token, chatId } : null;
}

/** Échappe le texte pour le mode HTML de Telegram. */
export const esc = (s: string | number) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Envoie un message ; ne lève jamais d'exception (l'alerte ne doit pas casser la surveillance). */
export async function sendTelegram(html: string, opts: { fetchImpl?: FetchLike; env?: Record<string, string | undefined> } = {}): Promise<{ ok: boolean; error?: string }> {
  const cfg = telegramConfig(opts.env);
  if (!cfg) return { ok: false, error: 'Telegram non configuré (TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID).' };
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const res = await f(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) return { ok: false, error: `Telegram : ${json?.description || `erreur ${res.status}`}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `Telegram injoignable : ${String(e?.message || e).slice(0, 120)}` };
  }
}

/** Conversations récentes du bot (pour trouver TELEGRAM_CHAT_ID après avoir écrit au bot). */
export async function telegramChats(opts: { fetchImpl?: FetchLike; env?: Record<string, string | undefined> } = {}): Promise<{ id: string; name: string }[]> {
  const token = ((opts.env ?? process.env).TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN manquant.');
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await f(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
  const json = await res.json();
  if (!json?.ok) throw new Error(`Telegram : ${json?.description || 'erreur'}`);
  const chats = new Map<string, string>();
  for (const u of json.result ?? []) {
    const c = u.message?.chat ?? u.channel_post?.chat;
    if (c?.id !== undefined) chats.set(String(c.id), [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || c.username || '');
  }
  return [...chats].map(([id, name]) => ({ id, name }));
}
