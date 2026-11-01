import { useState } from 'react';
import { createRecord, recordLines, toDate, withMeanings, type KidRecord, type SessionRecord } from './archive';
import type { useAssessor } from './assess';
import { Conversation, Diagnostics, TopBar, Transcript, type Reading } from './common';
import type { History } from './history';
import { RecordView } from './HistoryView';
import { AVATARS, MAX_STARS_PER_TALK, STARS_PER_STICKER, STICKERS, stickers, type Category, type Kids, type LevelInfo, type Profile, type Scenario } from './kids';
import { minutes, REASON_TEXT, type Ended, type Live } from './live';
import { inScope, project, reviewWordsFor } from './learning';
import { LearningView } from './LearningView';
import { ParentArea } from './Parent';

type View = 'profiles' | 'scenarios' | 'talk' | 'stickers' | 'history' | 'parent' | 'words';
interface Result { status: 'writing' | 'ok' | 'none' | 'failed' | 'off'; saved?: SessionRecord; newStickers: number; sessionID?: string }

const avatar = (profile: Profile) => AVATARS[profile.level];
const CATEGORIES: { id: Category; nameZh: string }[] = [{ id: 'daily', nameZh: '日常生活' }, { id: 'explore', nameZh: '校外拓展' }, { id: 'news', nameZh: '新闻话题' }];
const MINIMUM_SECONDS = 30;

/** The words the server accepts for the opening review: plain English words only. */
const REVIEW_WORD = /^[A-Za-z][A-Za-z' -]{0,23}$/;

/**
 * Up to three words for the opening review. They are the child's own vocabulary that is due again
 * (see learning.ts). Until a child has any assessed words, the last report's suggestions are used.
 */
function reviewWords(history: History, profileID: string): string[] {
  const hidden = Array.isArray(history.preferences.hiddenWords) ? history.preferences.hiddenWords as string[] : [];
  const learner = project(history.sessions.filter(item => inScope(item, { kind: 'kid', profileID })), 'en', hidden);
  if (learner.words.length) return reviewWordsFor(learner, undefined, 20).filter(word => REVIEW_WORD.test(word)).slice(0, 3);
  return history.sessions.find(item => item.web?.kid?.profileID === profileID && item.web.kid.report?.reviewWords.length)?.web?.kid?.report?.reviewWords ?? [];
}

export function KidMode({ live, kids, history, assessor, reading, typing, scenarios, levels, reportsEnabled, serverUsage, onExit }: {
  live: Live; kids: Kids; history: History; assessor: ReturnType<typeof useAssessor>; reading: Reading; typing: boolean; scenarios: Scenario[]; levels: LevelInfo[]; reportsEnabled: boolean;
  serverUsage: React.ReactNode; onExit: () => void;
}) {
  const [view, setView] = useState<View>('profiles');
  const [profileID, setProfileID] = useState<string>();
  const [scenario, setScenario] = useState<Scenario>();
  const [result, setResult] = useState<Result>();
  const [category, setCategory] = useState<Category>('daily');
  const [recordID, setRecordID] = useState<string>();
  const levelName = (profile: Profile) => `难度 ${profile.level} ${levels.find(item => item.level === profile.level)?.nameZh ?? ''}`;
  const profile = kids.profiles.find(item => item.id === profileID);

  const writeReport = async (current: Profile, item: Scenario, ended: Ended, recordID: string) => {
    const kid = (status: KidRecord['status'], extra: Partial<KidRecord> = {}): NonNullable<SessionRecord['web']> =>
      ({ mode: 'kid', kid: { profileID: current.id, scenarioID: item.id, level: current.level, stars: 0, status, ...extra } });
    const base = createRecord({ id: recordID, languageID: 'en', title: item.titleZh, themeID: item.id, startedAt: ended.startedAt, seconds: ended.seconds,
                                confirmed: ended.confirmed, endReason: REASON_TEXT(ended.reason), lines: ended.lines, web: kid('failed') });
    const keep = (saved: SessionRecord) => {
      // A retry rebuilds the record: keep what an earlier save already gathered.
      const kept = { ...saved, assessments: history.get(saved.id)?.assessments ?? saved.assessments };
      history.save(kept); addSubtitles(kept); assessor.complete(history, kept.id);
      return kept;
    };
    if (!reportsEnabled || !ended.sessionID) {
      setResult({ status: 'off', saved: keep({ ...base, web: kid('off') }), newStickers: 0 }); return;
    }
    setResult({ status: 'writing', newStickers: 0, sessionID: ended.sessionID });
    try {
      const response = await fetch('/api/kid/report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionID: ended.sessionID }),
      });
      if (response.status === 422) { setResult({ status: 'none', saved: keep({ ...base, web: kid('none') }), newStickers: 0 }); return; }
      if (!response.ok) throw new Error(String(response.status));
      const { report } = await response.json();
      const stars = Math.min(MAX_STARS_PER_TALK, report.repeatSuccesses);
      const saved = keep({ ...base, web: kid('ok', { stars, report }) });
      kids.addStars(current.id, stars);
      setResult({ status: 'ok', saved, newStickers: stickers(current.stars + stars).length - stickers(current.stars).length });
    } catch {
      setResult({ status: 'failed', saved: keep(base), newStickers: 0, sessionID: ended.sessionID });
    }
  };

  /** Stores the subtitles shown during the call with the record, once they have arrived. */
  const addSubtitles = (saved: SessionRecord) => {
    if (!reading.meanings || !reading.subtitles) return;
    const mural = saved.fragments.filter(fragment => fragment.speaker === 'assistant');
    Promise.all(mural.map(fragment => reading.meanings!.request(fragment.text))).then(results => {
      const found = new Map(mural.map((fragment, index) => [fragment.text, results[index]]));
      if (results.some(Boolean)) history.update(saved.id, latest => withMeanings(latest, text => found.get(text)));
    });
  };

  const start = () => {
    if (!profile || !scenario) return;
    const seconds = Math.floor(Math.min(kids.remainingToday(profile), scenario.minutes * 60));
    if (seconds < MINIMUM_SECONDS) { live.setMessage('今天的练习时间用完了，明天再来吧！'); return; }
    setResult(undefined);
    const current = profile, item = scenario, recordID = crypto.randomUUID();
    assessor.begin('en', item.id);
    live.start({ language: 'en', mode: 'kid', scenario: item.id, level: String(current.level), nickname: current.nickname,
                 review: reviewWords(history, current.id).join(','), seconds: String(seconds) }, ended => {
      kids.addUsage(current.id, ended.seconds);
      if (ended.seconds > 0) writeReport(current, item, ended, recordID);
    });
  };

  const retry = () => {
    if (!profile || !scenario || !result?.saved || !result.sessionID) return;
    const saved = result.saved;
    writeReport(profile, scenario, { sessionID: result.sessionID, reason: saved.endReason ?? '', seconds: saved.voiceSeconds, confirmed: saved.usageFinal,
                                     lines: recordLines(saved), startedAt: toDate(saved.startedAt) }, saved.id);
  };

  if (view === 'parent') return <ParentArea kids={kids} history={history} levels={levels} serverUsage={serverUsage} supported={reading.languageID ? ['en'] : []}
                                            onBack={() => setView('profiles')} />;

  if (view === 'profiles' || !profile) return (
    <main className="screen">
      <TopBar title="孩子英语口语" onBack={onExit} />
      {kids.profiles.length === 0 && <p className="muted center-text">还没有孩子档案。请家长点下面的“家长设置”创建。</p>}
      <div className="cards">
        {kids.profiles.map(item => (
          <button key={item.id} className="card kid" onClick={() => { setProfileID(item.id); setResult(undefined); live.clear(); setView('scenarios'); }}>
            <span className="avatar">{avatar(item)}</span>
            <strong>{item.nickname}</strong>
            <span className="muted">{levelName(item)} · ⭐ {item.stars}</span>
            <span className="small muted">今天还可以练 {Math.floor(kids.remainingToday(item) / 60)} 分钟</span>
          </button>
        ))}
      </div>
      <button className="secondary" onClick={() => setView('parent')}>家长设置</button>
    </main>
  );

  const owned = stickers(profile.stars);

  if (view === 'words') return (
    <LearningView history={history} scope={{ kind: 'kid', profileID: profile.id }} title={`${profile.nickname} 的单词`} languages={[{ id: 'en', nativeName: 'English' }]}
                  defaultLanguage="en" enabled={typing} canHide={false} onBack={() => setView('scenarios')} />
  );

  if (view === 'stickers') return (
    <main className="screen">
      <TopBar title={`${profile.nickname} 的贴纸`} onBack={() => setView('scenarios')} />
      <p className="stars-line">⭐ {profile.stars}</p>
      <div className="sticker-book">
        {STICKERS.map((sticker, index) => (
          <span key={index} className={index < owned.length ? 'sticker owned' : 'sticker'}>{index < owned.length ? sticker : '?'}</span>
        ))}
      </div>
      <p className="muted center-text">跟读成功一次得 1 颗星，每 {STARS_PER_STICKER} 颗星解锁一张贴纸。
        还差 {STARS_PER_STICKER - (profile.stars % STARS_PER_STICKER)} 颗星解锁下一张。</p>
    </main>
  );

  if (view === 'history') {
    const items = history.sessions.filter(item => item.web?.kid?.profileID === profile.id && item.fragments.length);
    const record = items.find(item => item.id === recordID);
    if (record) return <RecordView record={record} history={history} supported={reading.languageID ? ['en'] : []} allowDelete={false}
                                   label={`⭐ ${record.web?.kid?.stars ?? 0}`} onBack={() => setRecordID(undefined)} />;
    return (
      <main className="screen">
        <TopBar title="我的聊天记录" onBack={() => setView('scenarios')} />
        {items.length === 0 && <p className="muted">还没有聊天记录。</p>}
        <div className="list">
          {items.map(item => (
            <button key={item.id} className="list-item" onClick={() => setRecordID(item.id)}>
              <strong>{toDate(item.startedAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {item.title}</strong>
              <span className="muted small">{minutes(item.voiceSeconds)} · ⭐ {item.web?.kid?.stars ?? 0} · {item.fragments.length} 句</span>
            </button>
          ))}
        </div>
      </main>
    );
  }

  if (view === 'scenarios' || !scenario) return (
    <main className="screen">
      <TopBar title={`${avatar(profile)} ${profile.nickname}`} onBack={() => setView('profiles')}>
        <button className="chip" onClick={() => setView('stickers')}>⭐ {profile.stars} · 贴纸 {owned.length}</button>
      </TopBar>
      <div className="row center-row">
        <button className="secondary" onClick={() => { setRecordID(undefined); setView('history'); }}>📖 我的聊天记录</button>
        <button className="secondary" onClick={() => setView('words')}>🃏 我的单词</button>
      </div>
      <p className="muted">{levelName(profile)} · 今天还可以练 {minutes(kids.remainingToday(profile))}</p>
      <div className="tabs" role="tablist">
        {CATEGORIES.map(item => (
          <button key={item.id} role="tab" aria-selected={category === item.id} className={category === item.id ? 'chip selected' : 'chip'}
                  onClick={() => setCategory(item.id)}>{item.nameZh}</button>
        ))}
      </div>
      {category === 'news' && <p className="small muted center-text">Mural 不会上网查新闻。请孩子讲自己听到的新闻，Mural 帮孩子用英语说出来。</p>}
      <div className="cards">
        {scenarios.filter(item => item.category === category).map(item => (
          <button key={item.id} className="card scenario" onClick={() => { setScenario(item); setResult(undefined); live.clear(); setView('talk'); }}>
            <strong>{item.titleZh}</strong>
            <span className="muted">{item.titleEn}</span>
            <span className="small">🎲 {item.gameZh} · 约 {item.minutes} 分钟</span>
          </button>
        ))}
      </div>
    </main>
  );

  const stopLabel = live.wrapping ? '结束' : '说再见';
  return (
    <main className="screen">
      <TopBar title={scenario.titleZh} onBack={live.busy ? undefined : () => setView('scenarios')}>
        <span className="muted">⭐ {profile.stars}</span>
      </TopBar>
      <p className="muted">{scenario.titleEn} · 🎲 {scenario.gameZh} · {levelName(profile)}</p>
      {result && !live.busy ? <>
        <ResultPanel result={result} profile={profile} onRetry={retry} onAgain={() => { live.clear(); setView('scenarios'); }} />
        <Transcript lines={live.lines} newestFirst reading={reading} />
      </> : (
        <Conversation live={live} idleLabel="开始" stopLabel={stopLabel} onStart={start} onStop={live.wrapping ? live.end : live.wrapUp}
                      reading={reading} typing={typing}
                      disabled={kids.remainingToday(profile) < MINIMUM_SECONDS}
                      extra={live.phase === 'active' && !live.wrapping ? <button className="secondary" onClick={live.end}>立即结束</button> : undefined} />
      )}
      {!live.busy && !result && kids.remainingToday(profile) < MINIMUM_SECONDS && <p className="error">今天的练习时间用完了，明天再来吧！</p>}
      {!live.busy && !result && <p className="muted small center-text">点“开始”后和 Mural 说英语。想结束时点“说再见”，Mural 会请你教它一个今天学的词。</p>}
      <Diagnostics live={live} />
    </main>
  );
}

function ResultPanel({ result, profile, onRetry, onAgain }: { result: Result; profile: Profile; onRetry: () => void; onAgain: () => void }) {
  const stars = result.saved?.web?.kid?.stars ?? 0;
  return (
    <section className="result">
      {result.status === 'writing' && <p className="muted">正在数星星…</p>}
      {result.status === 'ok' && (
        <>
          <p className="big-stars">{stars > 0 ? '⭐'.repeat(Math.min(stars, MAX_STARS_PER_TALK)) : '💪'}</p>
          <p className="result-title">{stars > 0 ? `太棒了！你得到 ${stars} 颗星！` : '你今天很勇敢地开口了！下次跟读成功就能得星星。'}</p>
          {result.newStickers > 0 && <p className="result-title">解锁新贴纸：{stickers(profile.stars).slice(-result.newStickers).join(' ')}</p>}
          {result.saved?.web?.kid?.report?.teachBackWord && <p className="muted">你教会了 Mural：{result.saved.web.kid.report.teachBackWord}</p>}
        </>
      )}
      {result.status === 'none' && <p className="result-title">这次没有听到你说英语。下次大声说出来，就能得星星！</p>}
      {result.status === 'failed' && (
        <>
          <p className="error">星星和家长报告暂时没有生成。</p>
          <button className="secondary" onClick={onRetry}>重试</button>
        </>
      )}
      {result.status === 'off' && <p className="muted">服务器未开启家长报告，这次不计星星。</p>}
      {result.status !== 'writing' && <button className="primary" onClick={onAgain}>再练一个</button>}
    </section>
  );
}
