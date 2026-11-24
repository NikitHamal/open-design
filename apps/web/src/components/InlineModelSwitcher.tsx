'use client';
// Composer model + reasoning picker. Two controls in one capsule: a provider/
// model dialog (search, provider rail, model list) and a reasoning dropdown.

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentInfo, ApiProtocol, AppConfig, ExecMode } from '../types';
import {
  EFFORTS,
  PROVIDERS,
  clampEffort,
  findProvider,
  fmtCtx,
  reasoningTiers,
  type Effort,
  type ModelInfo,
} from '../providers/zeus-catalog';

interface Props {
  config: AppConfig;
  agents: AgentInfo[];
  providerModelsCache?: unknown;
  compact?: boolean;
  daemonLive: boolean;
  onModeChange: (mode: ExecMode) => void;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string; serviceTier?: string },
  ) => void;
  onApiProtocolChange: (protocol: ApiProtocol) => void;
  onApiModelChange: (model: string) => void;
  onProviderModelsCacheChange?: Dispatch<SetStateAction<any>>;
  onOpenSettings: (section?: any) => void;
}

const AGENT_ID = 'zeus';
const DEFAULT_SELECTION = 'mercury3/mercury-3';
const EFFORT_SHORT: Record<string, string> = { low: 'Low', medium: 'Med', high: 'High', max: 'Max' };
const LEVEL: Record<string, number> = { low: 1, medium: 2, high: 3, max: 4 };

function splitSelection(value: string): { providerId: string; modelId: string } {
  const at = value.indexOf('/');
  if (at < 0) return { providerId: 'mercury3', modelId: value };
  return { providerId: value.slice(0, at), modelId: value.slice(at + 1) };
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function Bars({ level, total }: { level: number; total: number }) {
  return (
    <span className="zpick-bars" aria-hidden>
      {Array.from({ length: total }, (_, i) => i + 1).map((b) => (
        <i key={b} data-on={b <= level} style={{ height: `${3 + b * 2.2}px` }} />
      ))}
    </span>
  );
}

function ModelRow({
  m,
  providerName,
  active,
  onPick,
}: {
  m: ModelInfo;
  providerName?: string;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button type="button" className="zpick-row" data-active={active} onClick={onPick}>
      <span className="zpick-row__label">{m.label}</span>
      {providerName ? <span className="zpick-row__prov">{providerName}</span> : null}
      {m.vision ? <span className="zpick-tag">Vision</span> : null}
      {m.reasoning ? <span className="zpick-tag">Think</span> : null}
      <span className="zpick-row__ctx">{fmtCtx(m.contextWindow, m.verified)}</span>
    </button>
  );
}

export function InlineModelSwitcher({
  config,
  onModeChange,
  onAgentChange,
  onAgentModelChange,
  onOpenSettings,
}: Props) {
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [railProvider, setRailProvider] = useState<string | null>(null);
  const modelRef = useDismiss(modelOpen, () => setModelOpen(false));
  const effortRef = useDismiss(effortOpen, () => setEffortOpen(false));

  const saved = config.agentModels?.[AGENT_ID];
  const selection = saved?.model && saved.model !== 'default' ? saved.model : DEFAULT_SELECTION;
  const { providerId, modelId } = splitSelection(selection);
  const provider = findProvider(providerId);
  const model = provider.models.find((m) => m.id === modelId);
  const tiers = reasoningTiers(model);
  const effort = clampEffort(((saved?.reasoning as Effort | undefined) ?? 'medium'), tiers);
  const railActive = railProvider ?? provider.id;

  const ensureZeus = () => {
    if (config.mode !== 'daemon') onModeChange('daemon');
    if (config.agentId !== AGENT_ID) onAgentChange(AGENT_ID);
  };

  const pick = (pid: string, m: ModelInfo) => {
    ensureZeus();
    onAgentModelChange(AGENT_ID, {
      model: `${pid}/${m.id}`,
      reasoning: clampEffort(effort, reasoningTiers(m)),
    });
    setModelOpen(false);
    setQuery('');
  };

  const setEffort = (next: Effort) => {
    ensureZeus();
    onAgentModelChange(AGENT_ID, { model: selection, reasoning: next });
    setEffortOpen(false);
  };

  const results = useMemo(() => {
    const t = query.trim().toLowerCase();
    if (!t) return [];
    return PROVIDERS.flatMap((p) =>
      p.models
        .filter((m) => `${m.label} ${m.id} ${p.name}`.toLowerCase().includes(t))
        .map((m) => ({ p, m })),
    ).slice(0, 60);
  }, [query]);

  return (
    <div className="zpick" data-testid="zeus-model-picker">
      <div className="zpick-pop-host" ref={modelRef}>
        <button
          type="button"
          className="zpick-trigger zpick-trigger--model"
          data-solo={tiers.length === 0}
          data-open={modelOpen}
          title="Model"
          onClick={() => setModelOpen((v) => !v)}
        >
          <span className="zpick-trigger__label">{model?.label ?? modelId}</span>
          <span className="zpick-caret" aria-hidden />
        </button>
        {modelOpen ? (
          <div className="zpick-pop zpick-pop--model" role="dialog" aria-label="Model">
            <div className="zpick-search">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models"
              />
              {query ? (
                <button type="button" className="zpick-clear" onClick={() => setQuery('')} aria-label="Clear">
                  Clear
                </button>
              ) : null}
            </div>
            {query ? (
              <div className="zpick-list">
                {results.length === 0 ? <div className="zpick-empty">No models</div> : null}
                {results.map(({ p, m }) => (
                  <ModelRow
                    key={p.id + m.id}
                    m={m}
                    providerName={p.name}
                    active={provider.id === p.id && modelId === m.id}
                    onPick={() => pick(p.id, m)}
                  />
                ))}
              </div>
            ) : (
              <div className="zpick-body">
                <div className="zpick-rail">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="zpick-rail__item"
                      data-active={railActive === p.id}
                      onClick={() => setRailProvider(p.id)}
                    >
                      <span className="zpick-rail__mark" style={{ background: p.color }}>
                        {p.name.slice(0, 1)}
                      </span>
                      <span className="zpick-rail__name">{p.name}</span>
                      <span className="zpick-rail__count">{p.models.length}</span>
                    </button>
                  ))}
                </div>
                <div className="zpick-list">
                  {findProvider(railActive).models.map((m) => (
                    <ModelRow
                      key={m.id}
                      m={m}
                      active={provider.id === railActive && modelId === m.id}
                      onPick={() => pick(railActive, m)}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="zpick-foot">
              <button
                type="button"
                className="zpick-foot__btn"
                onClick={() => {
                  setModelOpen(false);
                  onOpenSettings('execution');
                }}
              >
                Add provider
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {tiers.length > 0 ? (
        <div className="zpick-pop-host" ref={effortRef}>
          <button
            type="button"
            className="zpick-trigger zpick-trigger--effort"
            data-open={effortOpen}
            title="Reasoning"
            onClick={() => setEffortOpen((v) => !v)}
          >
            <Bars level={Math.max(tiers.indexOf(effort), 0) + 1} total={tiers.length} />
            <span>{EFFORT_SHORT[effort]}</span>
          </button>
          {effortOpen ? (
            <div className="zpick-pop zpick-pop--effort" role="menu" aria-label="Reasoning">
              <div className="zpick-pop__title">Reasoning</div>
              {tiers.map((id) => {
                const meta = EFFORTS.find((e) => e.id === id);
                return (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={id === effort}
                    className="zpick-row zpick-row--effort"
                    data-active={id === effort}
                    onClick={() => setEffort(id)}
                  >
                    <Bars level={LEVEL[id] ?? 1} total={4} />
                    <span className="zpick-row__label">{meta?.label ?? id}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
