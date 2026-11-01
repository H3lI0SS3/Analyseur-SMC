// Calendrier économique : annonces à fort impact (USD, EUR).
// Source gratuite : flux hebdomadaire ForexFactory (faireconomy.media), mis en cache 1 heure.

export interface NewsEvent {
  t: number;
  currency: string;
  title: string;
  /** horaire non confirmé (« tentative » / toute la journée) : pas d'heure exacte à bloquer */
  tentative?: boolean;
}

/** Une vraie annonce tombe à l'heure, au quart d'heure ou à 5 minutes près ; sinon l'horaire est un marqueur « à confirmer ». */
export const isTentativeTime = (t: number) => new Date(t).getUTCMinutes() % 5 !== 0 || new Date(t).getUTCSeconds() !== 0;

export interface NewsState {
  available: boolean;
  events: NewsEvent[];
  fetchedAt: number;
  error?: string;
}

const FEED = process.env.NEWS_FEED_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
let cache: NewsState | null = null;
let inflight: Promise<NewsState> | null = null;

export async function getNews(): Promise<NewsState> {
  if (cache && cache.available && Date.now() - cache.fetchedAt < 3_600_000) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(FEED, { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingAnalyzer/3.0)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = await res.json();
      if (!Array.isArray(json)) throw new Error('format inattendu');
      const events: NewsEvent[] = json
        .filter((e: any) => String(e.impact).toLowerCase() === 'high' && ['USD', 'EUR'].includes(String(e.country).toUpperCase()))
        .map((e: any) => {
          const t = Date.parse(e.date);
          return { t, currency: String(e.country).toUpperCase(), title: String(e.title || 'Annonce'), tentative: isTentativeTime(t) || /tentative|all day/i.test(String(e.time || '')) };
        })
        .filter((e: NewsEvent) => Number.isFinite(e.t))
        .sort((a: NewsEvent, b: NewsEvent) => a.t - b.t);
      cache = { available: true, events, fetchedAt: Date.now() };
    } catch (err: any) {
      // Une liste récente (< 6 h) reste exploitable ; sinon calendrier indisponible.
      if (cache && Date.now() - cache.fetchedAt < 6 * 3_600_000) cache = { ...cache };
      else cache = { available: false, events: [], fetchedAt: Date.now(), error: String(err?.message || err) };
    } finally {
      inflight = null;
    }
    return cache!;
  })();
  return inflight;
}

/** Devises qui comptent pour chaque actif. */
export const NEWS_CURRENCIES: Record<string, string[]> = { 'EUR/USD': ['USD', 'EUR'], 'XAU/USD': ['USD'] };
