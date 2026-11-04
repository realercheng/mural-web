import type { LanguageContent } from './languages.js';

// Mural should speak only the target language. When a long reply of Mural's looks like another
// language, the gateway tells it once to return. TeachingPolicy.shouldRedirectSpeech asks the
// platform's language recognizer; a browser has none, so this uses scripts and common English
// words. It is deliberately cautious: it misses some drift but rarely accuses correct speech.
// Like the apps, it does not judge Tagalog (detectors confuse it with Indonesian).
export const MIN_CHECK_CHARS = 70;

// Only words that mean nothing in the other Latin-script modules (not 'in', 'is', 'for', 'was' ...).
const ENGLISH_WORDS = new Set(['the', 'and', 'you', 'that', 'with', 'this', 'what', 'have', 'your', 'about', 'would', 'they', 'are', 'of', 'not', 'but', 'from']);

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

export function looksOffLanguage(module: LanguageContent, text: string): boolean {
  if (module.id === 'tl' || text.trim().length <= MIN_CHECK_CHARS) return false;
  const letters = count(text, /\p{L}/gu);
  if (letters < 40) return false;
  const share = (script: RegExp) => count(text, script) / letters;
  const han = share(/\p{Script=Han}/gu), cyrillic = share(/\p{Script=Cyrillic}/gu), greek = share(/\p{Script=Greek}/gu), latin = share(/\p{Script=Latin}/gu);
  switch (module.id) {
    case 'zh': return han < 0.3;
    case 'ru': return cyrillic < 0.5;
    case 'el': return greek < 0.5;
    case 'sr': return han > 0.5 || greek > 0.5;
    default: {
      if (han > 0.5 || cyrillic > 0.5 || greek > 0.5) return true;
      if (module.id === 'en' || latin < 0.5) return false;
      const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
      return words.length >= 12 && words.filter(word => ENGLISH_WORDS.has(word)).length / words.length > 0.25;
    }
  }
}
