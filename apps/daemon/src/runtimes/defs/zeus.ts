import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL_OPTION } from './shared.js';
import { PROVIDERS, reasoningTiers } from '../zeus/catalog.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
};

export const ZEUS_RUNTIME_MODELS: RuntimeModelOption[] = [
  DEFAULT_MODEL_OPTION,
  ...PROVIDERS.flatMap((provider) =>
    provider.models.map((model): RuntimeModelOption => {
      const tiers = reasoningTiers(model);
      const id = `${provider.id}/${model.id}`;
      const isDefault = provider.id === 'mercury3' && model.id === 'mercury-3';
      return {
        id,
        label: `${model.label} · ${provider.name}`,
        ...(isDefault ? { default: true } : {}),
        ...(model.contextWindow
          ? {
              metadata: {
                contextWindowTokens: model.contextWindow,
              },
            }
          : {}),
        ...(tiers.length > 0
          ? {
              reasoningOptions: tiers.map((tier) => ({
                id: tier,
                label: EFFORT_LABELS[tier] ?? tier,
                ...(tier === 'medium' ? { default: true } : {}),
              })),
            }
          : {}),
      };
    }),
  ),
];

export function resolveZeusStdioRunnerPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const jsCandidate = path.resolve(dir, '../zeus/stdio-runner.js');
  if (existsSync(jsCandidate)) return jsCandidate;
  const tsCandidate = path.resolve(dir, '../zeus/stdio-runner.ts');
  return tsCandidate;
}

export const zeusAgentDef = {
  id: 'zeus',
  name: 'Zeus Engine',
  bin: 'zeus-engine',
  versionArgs: ['--version'],
  fallbackModels: ZEUS_RUNTIME_MODELS,
  fetchModels: async () => ZEUS_RUNTIME_MODELS,
  buildArgs: () => [resolveZeusStdioRunnerPath(), '--stdio'],
  promptViaStdin: true,
  streamFormat: 'dsh-profile-jsonl',
  resumesSessionViaProfileStdio: true,
  capturesSessionIdFromStream: true,
  supportsCustomModel: true,
  supportsImagePaths: true,
} satisfies RuntimeAgentDef;
