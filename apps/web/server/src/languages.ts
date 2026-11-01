// The language content comes from the versioned package `content/languages.v1.json`, written by
// `scripts/export_android_content.py` from the Swift modules. Do not edit the JSON by hand.
import pack from './content/languages.v1.json' with { type: 'json' };

export interface Theme {
  id: string; title: string; subtitle: string; symbol: string; category: string; situation: string; colorIndex: number;
}

export interface LanguageContent {
  id: string; name: string; nativeName: string; variety: string; locale: string; greeting: string; greetingWord: string;
  speechGuidance: string; writingGuidance: string; lemmaGuidance: string; lookupUnavailableReply: string; topicPlaceholder: string;
  introduction: string; conversationGuidance: string; teachingFocus: string[];
  /** Per-language wording of some themes, by theme ID. */
  themeOverrides: Record<string, Theme>;
  /** Fields written for the web only, still waiting for a native speaker's review. */
  pendingNativeReview: string[];
}

export const CONTENT_VERSION: number = pack.version;
const SHARED_THEMES: Theme[] = pack.themes;
export const LANGUAGES: Record<string, LanguageContent> = Object.fromEntries((pack.languages as LanguageContent[]).map(item => [item.id, item]));

/** The 24 conversation themes in one language, in app order. */
export function themesFor(module: LanguageContent): Theme[] {
  return SHARED_THEMES.map(theme => module.themeOverrides[theme.id] ?? theme);
}
