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
  const candidates = [
    path.resolve(dir, '../zeus/stdio-runner.js'),
    process.env.OD_DAEMON_CLI_PATH?.trim() || '',
    process.env.OD_BIN?.trim() || '',
    path.resolve(dir, '../daemon-cli.mjs'),
    path.resolve(dir, './daemon-cli.mjs'),
    path.resolve(dir, '../../cli.js'),
    path.resolve(dir, '../zeus/stdio-runner.ts'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return path.resolve(dir, '../daemon-cli.mjs');
}

export const zeusAgentDef = {
  id: 'zeus',
  name: 'Zeus Engine',
  bin: 'zeus-engine',
  versionArgs: ['--version'],
  env: {
    ELECTRON_RUN_AS_NODE: '1',
  },
  fallbackModels: ZEUS_RUNTIME_MODELS,
  fetchModels: async () => ZEUS_RUNTIME_MODELS,
  buildArgs: () => [resolveZeusStdioRunnerPath(), '--zeus-stdio', '--stdio'],
  promptViaStdin: true,
  streamFormat: 'dsh-profile-jsonl',
  resumesSessionViaProfileStdio: true,
  capturesSessionIdFromStream: true,
  supportsCustomModel: true,
  supportsImagePaths: true,
} satisfies RuntimeAgentDef;
