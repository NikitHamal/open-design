import type {
  DesignSystemSummary,
  PromptTemplateSummary,
  SkillSummary,
} from '../types';
import type { Locale } from './types';

// English-only build: built-in content renders from its source copy.

export function hasLocalizedContent(_locale: Locale): boolean {
  return false;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function localizeSkillName(_locale: Locale, skill: SkillSummary): string {
  return skill.displayName?.en ?? skill.name;
}

export function localizeSkillPrompt(_locale: Locale, skill: SkillSummary): string | undefined {
  return skill.examplePromptI18n?.en ?? (skill.examplePrompt ? normalizeText(skill.examplePrompt) : undefined);
}

export function localizeSkillDescription(_locale: Locale, skill: SkillSummary): string {
  return skill.descriptionI18n?.en ?? normalizeText(skill.description);
}

export function localizeDesignSystemSummary(_locale: Locale, system: DesignSystemSummary): string {
  return system.summary || system.category || '';
}

export function localizeDesignSystemCategory(_locale: Locale, category: string): string {
  return category;
}

export function localizePromptTemplateCategory(_locale: Locale, category: string): string {
  return category;
}

export function localizePromptTemplateSummary(
  _locale: Locale,
  template: PromptTemplateSummary,
): PromptTemplateSummary {
  return template;
}
