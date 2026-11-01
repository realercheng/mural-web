import { useMemo, useState } from 'react';
import { fromDate } from './archive';
import type { History } from './history';
import { deckDestination, flashcardDeck, inScope, levelLabel, project, wordExplanation, wordLabel, type LearnerScope, type WordState } from './learning';
import { TopBar } from './common';

const dueText = (word: WordState, now: number) => {
  if (word.dueAt < now) return '该复习了';
  const days = Math.ceil((word.dueAt - now) / 86_400);
  return days <= 1 ? '明天复习' : `${days} 天后复习`;
};

/** One to three cells for the memory bars; a new word has none filled. */
function Bars({ word }: { word: WordState }) {
  return (
    <span className="bars" role="img" aria-label={`记忆条 ${word.bars} 格，共 3 格`}>
      {[1, 2, 3].map(cell => <span key={cell} className={cell <= word.bars ? 'bar filled' : 'bar'} />)}
    </span>
  );
}

/**
 * What the learner has shown so far: challenge level, next goal, the words with their memory bars,
 * and a flashcard deck. Everything is computed from the conversations saved on this device.
 */
export function LearningView({ history, scope, title, languages, defaultLanguage, enabled, canHide, onBack }: {
  history: History; scope: LearnerScope; title: string; languages: { id: string; nativeName: string }[]; defaultLanguage: string;
  enabled: boolean; canHide: boolean; onBack: () => void;
}) {
  const [languageID, setLanguageID] = useState(defaultLanguage);
  const [deck, setDeck] = useState<number>();
  const [flipped, setFlipped] = useState(false);
  const hidden = useMemo(() => (Array.isArray(history.preferences.hiddenWords) ? history.preferences.hiddenWords as string[] : []), [history.preferences]);
  const now = fromDate(Date.now());
  const state = useMemo(() => project(history.sessions.filter(item => inScope(item, scope)), languageID, hidden),
                        [history.sessions, scope, languageID, hidden]);
  const cards = useMemo(() => flashcardDeck(state.words, languageID), [state.words, languageID]);
  const hiddenHere = hidden.filter(key => key.startsWith(`${languageID}|`));

  const hide = (word: WordState) => { history.changePreferences(current => ({ ...current, hiddenWords: [...hidden, word.id] })); };
  const restore = () => { history.changePreferences(current => ({ ...current, hiddenWords: hidden.filter(key => !key.startsWith(`${languageID}|`)) })); };

  if (deck !== undefined && cards.length) {
    const index = Math.min(deck, cards.length - 1), card = cards[index]!;
    const go = (direction: number) => { setDeck(deckDestination(cards, index, direction)); setFlipped(false); };
    return (
      <main className="screen">
        <TopBar title="单词卡" onBack={() => { setDeck(undefined); setFlipped(false); }} />
        <p className="muted">{index + 1} / {cards.length} · 只是翻看，不会改变记忆条</p>
        <button className="flashcard" onClick={() => setFlipped(!flipped)} aria-label={flipped ? '看单词' : '看意思'}>
          {flipped ? (
            <>
              <strong>{card.meaning}</strong>
              <span className="muted">“{card.example}”</span>
              <Bars word={card} />
              <span className="small muted">{wordExplanation(card)}</span>
            </>
          ) : (
            <>
              <strong className="big-word">{card.lemma}</strong>
              <span className="muted small">点一下看意思</span>
            </>
          )}
        </button>
        <div className="row center-row">
          <button className="secondary" onClick={() => go(-1)} disabled={index === 0}>‹ 上一张</button>
          <button className="secondary" onClick={() => go(1)} disabled={index === cards.length - 1}>下一张 ›</button>
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <TopBar title={title} onBack={onBack} />
      {languages.length > 1 && scope.kind === 'adult' && (
        <div className="languages" role="radiogroup" aria-label="学习语言">
          {languages.map(item => (
            <button key={item.id} role="radio" aria-checked={item.id === languageID} className={item.id === languageID ? 'chip selected' : 'chip'}
                    onClick={() => setLanguageID(item.id)}>{item.nativeName}</button>
          ))}
        </div>
      )}
      <section className="card summary">
        <strong>{levelLabel(state)}</strong>
        <span className="muted small">挑战等级 {state.challenge} / 5 · 已评估 {state.observationCount} 轮发言</span>
        {state.observationCount > 0 && <span className="small">下一步：{state.nextGoal}</span>}
        {state.capabilities.length > 0 && <span className="small">稳定的能力：{state.capabilities.join('；')}</span>}
      </section>
      <p className="muted small center-text">每轮发言结束后，服务器会让文字模型评估你说了什么，并记录用到的词。同一个词在不同的日子、不同的话题里独立说对，记忆条才会增加。</p>
      {!enabled && <p className="error small">服务器没有开启文字模型，新的对话不会被评估。</p>}
      {cards.length > 0 && <button className="primary" onClick={() => { setDeck(0); setFlipped(false); }}>🃏 单词卡（{cards.length}）</button>}
      {state.words.length === 0 && <p className="muted center-text">还没有单词记录。多聊几轮，Mural 会把用到的词记在这里。</p>}
      <div className="list">
        {state.words.map(word => (
          <div key={word.id} className="list-item word">
            <div className="row between">
              <strong>{word.lemma}</strong>
              <Bars word={word} />
            </div>
            <span>{word.meaning}</span>
            <span className="muted small">“{word.example}” · {wordLabel(word)} · {dueText(word, now)}</span>
            <span className="muted small">{wordExplanation(word)}</span>
            {canHide && <button className="chip" onClick={() => hide(word)}>不再显示</button>}
          </div>
        ))}
      </div>
      {hiddenHere.length > 0 && <button className="secondary" onClick={restore}>恢复已隐藏的 {hiddenHere.length} 个词</button>}
      <p className="muted small center-text">下一次对话开始时，已到期的词会写进语音指令，Mural 会在合适的时候带你复习。</p>
    </main>
  );
}
