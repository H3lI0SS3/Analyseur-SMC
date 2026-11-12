// Garde-fous de risque sur le compte réel, vérifiés à chaque passage de la surveillance (toutes les 5 min) :
// position trop grosse par rapport au lot conseillé, perte du jour au-delà de la limite. Alerte Telegram, une seule fois.
import type { FxJournal } from './fxJournal';
import { esc } from './telegram';

/** Limite de perte du jour (même valeur par défaut que l'app). */
export const DAILY_LOSS_LIMIT_PCT = 3;

export interface RiskStore {
  markRiskAlert(key: string, now?: number): Promise<boolean>;
}

export async function checkRisk(
  j: FxJournal,
  store: RiskStore,
  notify: (html: string) => Promise<{ ok: boolean }>,
  now = Date.now()
): Promise<string[]> {
  const sent: string[] = [];
  if (!j.available) return sent;
  for (const t of j.trades.filter(x => x.closedAt === null && x.oversize)) {
    if (!(await store.markRiskAlert(`oversize|${t.positionId}`, now))) continue;
    const lines = [
      `<b>⚠️ ORA Trader — position trop grosse</b>`,
      `${t.direction === 'acheter' ? 'Achat' : 'Vente'} ${esc(t.pair)} : <b>${t.lots} lot</b>${t.recommendedLots !== null ? ` au lieu de ${t.recommendedLots} lot conseillé` : ''}.`,
      t.riskPct !== null ? `Risque réel : <b>${t.riskPct} %</b> du compte${t.plannedRiskPct !== null ? ` (prévu : ${t.plannedRiskPct} %)` : ''}.` : 'Aucun stop connu sur cette position : risque non mesuré.',
      `Réduis la position sur cTrader si ce n’était pas voulu. L’app ne touche jamais à tes ordres.`,
    ];
    await notify(lines.join('\n'));
    sent.push(`oversize|${t.positionId}`);
  }
  if (j.desk.balance && j.desk.lossTodayPct >= DAILY_LOSS_LIMIT_PCT) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (await store.markRiskAlert(`dailyloss|${day}`, now)) {
      await notify(
        `<b>🛑 ORA Trader — limite de perte du jour atteinte</b>\nPerte du jour : <b>${j.desk.lossTodayPct} %</b> (limite ${DAILY_LOSS_LIMIT_PCT} %), positions ouvertes comprises.\nStop pour aujourd’hui : plus de nouveau trade.`
      );
      sent.push(`dailyloss|${day}`);
    }
  }
  return sent;
}
