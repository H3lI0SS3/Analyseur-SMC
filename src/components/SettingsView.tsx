import { useEffect, useState } from 'react';
import type { RiskSettings, Status } from '../types';
import { cx } from '../lib/utils';

interface Props {
  settings: RiskSettings;
  setSettings: (s: RiskSettings) => void;
  status: Status | null;
}

export function SettingsView({ settings, setSettings, status }: Props) {
  const set = (patch: Partial<RiskSettings>) => setSettings({ ...settings, ...patch });
  const providers = status?.providers || [];
  const options: { key: RiskSettings['aiProvider']; label: string; enabled: boolean }[] = [
    { key: 'auto', label: 'Auto', enabled: providers.length > 0 },
    { key: 'claude', label: 'Claude', enabled: providers.includes('claude') },
    { key: 'gemini', label: 'Gemini', enabled: providers.includes('gemini') },
    { key: 'none', label: 'Sans IA', enabled: true },
  ];

  return (
    <div className="space-y-3">
      <section className="card space-y-4 p-4">
        <div className="label">Gestion du risque</div>
        <Field label="Capital du compte ($)" value={settings.capital} step={10} min={10} onChange={v => set({ capital: v })} hint="Remplacé automatiquement par le solde réel quand cTrader est connecté." />
        <Field label="Risque par trade (%)" value={settings.riskPct} step={0.25} min={0.1} max={2} onChange={v => set({ riskPct: Math.min(2, v) })} hint="Recommandé : 0,5 à 1 %. Plafonné à 2 %. Avec cTrader : 0,5 % au maximum tant que l’app n’a pas 30 trades réels." />
        <Field label="Perte max par jour (%)" value={settings.dailyLossPct} step={0.5} min={0.5} max={10} onChange={v => set({ dailyLossPct: v })} hint="Compte les pertes du jour + le risque des trades encore ouverts. Au-delà, plus de nouveau trade au journal." />
      </section>

      <section className="card space-y-4 p-4">
        <div className="label">Broker</div>
        <button
          onClick={() => set({ broker: 'mt5', commissionPerLot: 7, spreadEurPips: 0.2, spreadGold: 0.2 })}
          className={cx(
            'w-full rounded-lg border py-2 text-sm font-semibold',
            settings.broker === 'mt5' && settings.commissionPerLot === 7 && settings.spreadEurPips === 0.2 && settings.spreadGold === 0.2 ? 'border-gold bg-gold/10 text-gold' : 'border-line text-ink'
          )}
        >
          Préréglage FxPro cTrader : commission 7 $/lot, spreads 0,2
        </button>
        <div className="grid grid-cols-3 gap-2">
          {([['mt5', 'cTrader / lots'], ['cent', 'Compte cent'], ['etoro', 'eToro']] as const).map(([k, l]) => (
            <button
              key={k}
              onClick={() => set(k === 'mt5' ? { broker: k } : { broker: k, commissionPerLot: 0 })}
              className={cx('rounded-lg border py-2 text-sm', (settings.broker ?? 'mt5') === k ? 'border-gold bg-gold/10 text-gold' : 'border-line text-mute')}
            >
              {l}
            </button>
          ))}
        </div>
        {settings.broker === 'cent' && (
          <p className="text-xs leading-snug text-mute">
            Compte cent : saisis ton capital en dollars (5 000 USC = 50 $). Les tailles sont données en lots cent (1 lot cent = 1/100 de lot standard). Vérifie dans la « Spécification » du symbole que c’est bien le cas chez ton broker.
          </p>
        )}
        {settings.broker === 'etoro' && (
          <>
            <Field label="Levier eToro EUR/USD (1:x)" value={settings.leverageEur ?? 30} step={1} min={1} max={400} onChange={v => set({ leverageEur: v })} hint="1 = sans levier. Le levier ne change pas ton risque (fixé par le stop et ton % de risque) : il change seulement le montant à bloquer." />
            <Field label="Levier eToro or (1:x)" value={settings.leverageGold ?? 20} step={1} min={1} max={400} onChange={v => set({ leverageGold: v })} />
          </>
        )}
        <div className="label pt-2">Coûts de ton broker</div>
        <Field label="Spread EUR/USD (pips)" value={settings.spreadEurPips} step={0.1} min={0} max={10} onChange={v => set({ spreadEurPips: v })} />
        <Field label="Spread or ($)" value={settings.spreadGold} step={0.05} min={0} max={5} onChange={v => set({ spreadGold: v })} />
        <Field label="Commission aller-retour par lot ($)" value={settings.commissionPerLot} step={0.5} min={0} max={50} onChange={v => set({ commissionPerLot: v })} hint={settings.broker === 'etoro' ? 'eToro se rémunère en général par le spread : 0 sauf frais affichés sur ton compte.' : 'Pris en compte dans le stop, les objectifs, le R:R net et la taille de lot.'} allowZero />
      </section>

      <section className="card space-y-3 p-4">
        <div className="label">Intelligence artificielle</div>
        <div className="grid grid-cols-4 gap-1 rounded-lg bg-card2 p-1">
          {options.map(o => (
            <button
              key={o.key}
              disabled={!o.enabled}
              onClick={() => set({ aiProvider: o.key })}
              className={cx('rounded-md py-2 text-xs font-semibold disabled:opacity-30', settings.aiProvider === o.key ? 'bg-gold text-bg' : 'text-mute')}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-xs leading-relaxed text-mute">
          L’IA relit les calculs du moteur, peut rejeter un plan ou affiner les niveaux, mais ne peut jamais forcer un trade ni inventer un prix.
        </p>
        <ul className="space-y-1 text-xs">
          <KeyRow name="ANTHROPIC_API_KEY" ok={providers.includes('claude')} desc={`Claude (${status?.models.claude || '—'})`} />
          <KeyRow name="GEMINI_API_KEY" ok={providers.includes('gemini')} desc={`Gemini (${status?.models.gemini || '—'})`} />
        </ul>
      </section>

      <section className="card space-y-2 p-4">
        <div className="label">Données de marché</div>
        <p className="text-sm">
          Source actuelle : <span className="font-semibold text-gold">{status?.dataSource || '—'}</span>
        </p>
        <ul className="space-y-1 text-xs">
          <KeyRow
            name="CTRADER_CLIENT_ID · CTRADER_CLIENT_SECRET · CTRADER_ACCESS_TOKEN"
            ok={!!status?.ctrader?.configured && !(status.ctrader as any).lastError}
            desc={`Bougies au prix FxPro via cTrader Open API, en lecture seule${status?.ctrader?.configured ? ` (compte ${(status.ctrader as any).env === 'live' ? 'réel' : 'démo'}${(status.ctrader as any).account?.login ? ` n° ${(status.ctrader as any).account.login}` : ''})` : ''}. Facultatifs : CTRADER_REFRESH_TOKEN, CTRADER_ENV (demo / live), CTRADER_ACCOUNT_ID`}
            optional
          />
          <KeyRow name="TWELVE_DATA_API_KEY" ok={status?.dataSource === 'Twelve Data' || (!!status?.ctrader?.configured && status?.dataSource !== 'Yahoo Finance')} desc="Cotations spot EUR/USD et XAU/USD (gratuit sur twelvedata.com) ; en secours si cTrader est configuré" optional />
        </ul>
        {status?.ctrader?.configured && (status.ctrader as any).lastError && (
          <p className="text-xs text-warn">cTrader : {(status.ctrader as any).lastError} — l’app bascule sur Twelve Data en attendant.</p>
        )}
        {status?.ctrader?.configured && (status.ctrader as any).readOnly === false && (
          <p className="text-xs text-warn">Ton jeton cTrader a le droit de trading. L’app ne l’utilise qu’en lecture, mais un jeton « accounts » (lecture seule) est plus sûr.</p>
        )}
        {status?.ctrader?.configured && (status.ctrader as any).tokenRefreshed && (
          <p className="text-xs text-warn">Le jeton cTrader a expiré et a été renouvelé pour cette session : génère-en un nouveau et mets à jour CTRADER_ACCESS_TOKEN et CTRADER_REFRESH_TOKEN.</p>
        )}
        <p className="text-xs leading-relaxed text-mute">
          Sans clé Twelve Data, l’app utilise Yahoo Finance (gratuit) : l’or y est coté via les futures COMEX, avec quelques dollars d’écart possible avec ton broker.
          Les clés se règlent dans AI Studio, panneau « Secrets ». Elles restent côté serveur et ne sont jamais envoyées au navigateur.
        </p>
      </section>
      <section className="card space-y-2 p-4">
        <div className="label">Surveillance automatique et alertes</div>
        <ul className="space-y-1 text-xs">
          <KeyRow name="WATCH_SECRET" ok={!!status?.watchConfigured} desc="Clé de la vérification toutes les 5 min (16 caractères minimum)" optional />
          <KeyRow name="TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID" ok={!!status?.telegram} desc="Bot Telegram qui t’envoie les setups et les ordres prêts" optional />
        </ul>
        <p className="text-xs leading-relaxed text-mute">
          Adresse à appeler toutes les 5 minutes (cron-job.org, gratuit) :
          <span className="num block break-all text-ink">{typeof window !== 'undefined' ? window.location.origin : ''}/api/watch/tick</span>
          <span className="mt-1 block">
            Plus sûr : dans cron-job.org (onglet « Avancé » → « En-têtes »), ajoute l’en-tête <span className="num text-ink">X-Watch-Key</span> avec ton WATCH_SECRET,
            au lieu de mettre <span className="num">?key=…</span> dans l’adresse (l’adresse apparaît dans les journaux d’appels).
          </span>
          La surveillance ne travaille que pendant les kill zones et n’envoie que deux types d’alertes : « setup en préparation » et « ordre prêt ». Aucun ordre n’est passé.
        </p>
      </section>
      <section className="card space-y-2 p-4">
        <div className="label">Connecteur Claude (MCP)</div>
        <ul className="space-y-1 text-xs">
          <KeyRow name="MCP_TOKEN" ok={!!status?.mcpEnabled} desc="Secret d’accès au connecteur (16 caractères minimum)" optional />
          <KeyRow name="APP_ACCESS_CODE" ok={!!status?.accessRequired} desc="Code pour ouvrir l’app et protéger tes crédits IA (recommandé)" optional />
        </ul>
        <p className="text-xs leading-relaxed text-mute">
          Une fois l’app publiée, ajoute dans Claude un connecteur personnalisé avec l’adresse
          <span className="num text-ink"> {typeof window !== 'undefined' ? window.location.origin : ''}/mcp</span>.
          Claude pourra alors lire les cotations, les bougies et lancer l’analyse. Aucun ordre ne peut être passé.
        </p>
      </section>
    </div>
  );
}

function Field({ label, value, onChange, step, min, max, hint, allowZero }: { label: string; value: number; onChange: (v: number) => void; step: number; min?: number; max?: number; hint?: string; allowZero?: boolean }) {
  // texte libre pendant la saisie (on peut vider le champ, taper « 0, » ou « 0.3 ») ; la valeur n'est enregistrée que si elle est valide
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  const parse = (t: string) => Number(t.replace(',', '.'));
  const valid = (v: number) => Number.isFinite(v) && (v > 0 || (allowZero && v === 0)) && (max === undefined || v <= max);
  const bad = text.trim() !== '' && !valid(parse(text));
  return (
    <label className="block">
      <span className="text-sm">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setText(String(value)); // valeur invalide ou vide : on revient à la dernière valeur enregistrée
        }}
        onChange={e => {
          setText(e.target.value);
          const v = parse(e.target.value);
          if (e.target.value.trim() !== '' && valid(v)) onChange(v);
        }}
        className={cx('num mt-1 w-full rounded-lg border bg-card2 px-3 py-2.5 text-base text-ink focus:outline-none', bad ? 'border-down' : 'border-line focus:border-gold')}
      />
      {bad && <span className="mt-1 block text-xs text-down">Valeur non valide{max !== undefined ? ` (max ${max})` : ''} : non enregistrée.</span>}
      {hint && <span className="mt-1 block text-xs text-mute">{hint}</span>}
    </label>
  );
}

function KeyRow({ name, ok, desc, optional }: { name: string; ok: boolean; desc: string; optional?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md bg-card2 px-2.5 py-1.5">
      <span className="min-w-0">
        <span className="num text-xs">{name}</span>
        <span className="block text-xs text-mute">{desc}</span>
      </span>
      <span className={cx('shrink-0 text-xs font-semibold', ok ? 'text-up' : optional ? 'text-mute' : 'text-down')}>
        {ok ? 'configurée' : optional ? 'facultative' : 'absente'}
      </span>
    </li>
  );
}
