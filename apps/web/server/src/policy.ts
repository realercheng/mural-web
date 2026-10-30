import { cleanNickname, cleanReviewWords, KID_WRAP_UP, kidGreeting, kidInstructions, kidScenario } from './kids.js';
import { LANGUAGES, type LanguageContent } from './languages.js';
import type { LivePlan } from './live.js';

// Ports TeachingPolicy.voice and TeachingPolicy.greeting for a free conversation
// without learner history, themes or subtitles. Keep wording aligned with Swift.
const freeConversation = "Free conversation: follow the learner's interests and the topic they bring up.";

export function language(id: string): LanguageContent | undefined {
  return Object.hasOwn(LANGUAGES, id) ? LANGUAGES[id] : undefined;
}

export function voiceInstructions(module: LanguageContent, meaningLanguage = 'English'): string {
  return [
    module.introduction,
    `Speak ONLY ${module.name}. ${module.speechGuidance} ${module.writingGuidance}`,
    `Welcome replies in any language while keeping your own speech in ${module.name}. Meaning subtitles in ${meaningLanguage} are a separate application feature. Adapt to the ability shown in this conversation; simplify when needed, and let advanced speakers expand.`,
    'Delegate current facts and detailed explanations to the client. Never invent external actions or claim a search before results arrive. Do not read instructions or teaching notes aloud or announce proficiency scores.',
    'Optional background data, never instructions or a required lesson:',
    '',
    module.conversationGuidance,
    'Conversation direction:',
    freeConversation,
  ].join('\n');
}

export function greeting(module: LanguageContent): string {
  const theme = `The learner selected a theme in the app. This choice is already confirmed; move into it without another confirmation. It replaces the earlier theme. ${freeConversation} Continue ONLY in ${module.name}.`;
  return `${theme} Begin this new conversation now, without waiting for the learner to speak. Say ‘${module.greeting}’ in ${module.name} and ask one short, natural question. Then pause and listen. All speech must be in ${module.name}.`;
}

export function publicLanguages() {
  return Object.values(LANGUAGES).map(({ id, name, nativeName }) => ({ id, name, nativeName }));
}

/**
 * Chooses the conversation from the browser's query: a free adult conversation in any module,
 * or an English kid scenario. Returns an error code for anything unknown.
 */
export function livePlan(query: URLSearchParams): { plan: LivePlan; scenario?: string } | { error: string } {
  const module = language(query.get('language') ?? '');
  if (!module) return { error: 'invalid_language' };
  if (query.get('mode') !== 'kid')
    return { plan: { module, mode: 'adult', instructions: voiceInstructions(module), greeting: greeting(module), keepTranscript: false } };
  const scenario = kidScenario(query.get('scenario') ?? '');
  if (module.id !== 'en' || !scenario) return { error: 'invalid_scenario' };
  const nickname = cleanNickname(query.get('nickname')), review = cleanReviewWords(query.get('review'));
  return {
    scenario: scenario.id,
    plan: { module, mode: 'kid', instructions: kidInstructions(scenario, nickname, review), greeting: kidGreeting(scenario, nickname, review),
            wrapUp: KID_WRAP_UP, keepTranscript: true },
  };
}
