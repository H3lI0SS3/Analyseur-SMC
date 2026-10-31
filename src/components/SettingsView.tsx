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
        <Field label="Capital du compte ($)" value={settings.capital} step={100} min={100} onChange={v => set({ capital: v })} />
        <Field label="Risque par trade (%)" value={settings.riskPct} step={0.25} min={0.1} max={2} onChange={v => set({ riskPct: Math.min(2, v) })} hint="Recommandé : 0,5 à 1 %. Plafonné à 2 %." />
        <Field label="Perte max par jour (%)" value={settings.dailyLossPct} step={0.5} min={0.5} max={10} onChange={v => set({ dailyLossPct: v })} hint="Compte les pertes du jour + le risque des trades encore ouverts. Au-delà, plus de nouveau trade au journal." />
      </section>

      <section className="card space-y-4 p-4">
        <div className="label">Coûts de ton broker</div>
        <Field label="Spread EUR/USD (pips)" value={settings.spreadEurPips} step={0.1} min={0} max={10} onChange={v => set({ spreadEurPips: v })} />
        <Field label="Spread or ($)" value={settings.spreadGold} step={0.05} min={0} max={5} onChange={v => set({ spreadGold: v })} />
        <Field label="Commission aller-retour par lot ($)" value={settings.commissionPerLot} step={0.5} min={0} max={50} onChange={v => set({ commissionPerLot: v })} hint="Pris en compte dans le stop, les objectifs, le R:R net et la taille de lot." allowZero />
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
        <p className="text-[11px] leading-relaxed text-mute">
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
          <KeyRow name="TWELVE_DATA_API_KEY" ok={status?.dataSource === 'Twelve Data'} desc="Cotations spot EUR/USD et XAU/USD (gratuit sur twelvedata.com)" optional />
        </ul>
        <p className="text-[11px] leading-relaxed text-mute">
          Sans clé Twelve Data, l’app utilise Yahoo Finance (gratuit) : l’or y est coté via les futures COMEX, avec quelques dollars d’écart possible avec ton broker.
          Les clés se règlent dans AI Studio, panneau « Secrets ». Elles restent côté serveur et ne sont jamais envoyées au navigateur.
        </p>
      </section>
      <section className="card space-y-2 p-4">
        <div className="label">Connecteur Claude (MCP)</div>
        <ul className="space-y-1 text-xs">
          <KeyRow name="MCP_TOKEN" ok={!!status?.mcpEnabled} desc="Secret d’accès au connecteur (16 caractères minimum)" optional />
          <KeyRow name="APP_ACCESS_CODE" ok={!!status?.accessRequired} desc="Code pour ouvrir l’app et protéger tes crédits IA (recommandé)" optional />
        </ul>
        <p className="text-[11px] leading-relaxed text-mute">
          Une fois l’app publiée, ajoute dans Claude un connecteur personnalisé avec l’adresse
          <span className="num text-ink"> {typeof window !== 'undefined' ? window.location.origin : ''}/mcp</span>.
          Claude pourra alors lire les cotations, les bougies et lancer l’analyse. Aucun ordre ne peut être passé.
        </p>
      </section>
    </div>
  );
}

function Field({ label, value, onChange, step, min, max, hint, allowZero }: { label: string; value: number; onChange: (v: number) => void; step: number; min?: number; max?: number; hint?: string; allowZero?: boolean }) {
  return (
    <label className="block">
      <span className="text-sm">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={e => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && (v > 0 || (allowZero && v === 0))) onChange(v);
        }}
        className="num mt-1 w-full rounded-lg border border-line bg-card2 px-3 py-2.5 text-base text-ink focus:border-gold focus:outline-none"
      />
      {hint && <span className="mt-1 block text-[11px] text-mute">{hint}</span>}
    </label>
  );
}

function KeyRow({ name, ok, desc, optional }: { name: string; ok: boolean; desc: string; optional?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md bg-card2 px-2.5 py-1.5">
      <span className="min-w-0">
        <span className="num text-[11px]">{name}</span>
        <span className="block text-[10px] text-mute">{desc}</span>
      </span>
      <span className={cx('shrink-0 text-[11px] font-semibold', ok ? 'text-up' : optional ? 'text-mute' : 'text-down')}>
        {ok ? 'configurée' : optional ? 'facultative' : 'absente'}
      </span>
    </li>
  );
}
