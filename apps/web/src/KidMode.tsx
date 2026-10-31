import { useState } from 'react';
import { Conversation, Diagnostics, TopBar } from './common';
import { AVATARS, MAX_STARS_PER_TALK, STARS_PER_STICKER, STICKERS, stickers, type Category, type Kids, type LevelInfo, type Profile, type SavedReport, type Scenario } from './kids';
import { minutes, type Ended, type Live } from './live';
import { ParentArea } from './Parent';

type View = 'profiles' | 'scenarios' | 'talk' | 'stickers' | 'parent';
interface Result { status: 'writing' | 'ok' | 'none' | 'failed' | 'off'; saved?: SavedReport; newStickers: number; sessionID?: string }

const avatar = (profile: Profile) => AVATARS[profile.level];
const CATEGORIES: { id: Category; nameZh: string }[] = [{ id: 'daily', nameZh: '日常生活' }, { id: 'explore', nameZh: '校外拓展' }, { id: 'news', nameZh: '新闻话题' }];
const MINIMUM_SECONDS = 30;

export function KidMode({ live, kids, scenarios, levels, reportsEnabled, serverUsage, onExit }: {
  live: Live; kids: Kids; scenarios: Scenario[]; levels: LevelInfo[]; reportsEnabled: boolean; serverUsage: React.ReactNode; onExit: () => void;
}) {
  const [view, setView] = useState<View>('profiles');
  const [profileID, setProfileID] = useState<string>();
  const [scenario, setScenario] = useState<Scenario>();
  const [result, setResult] = useState<Result>();
  const [category, setCategory] = useState<Category>('daily');
  const levelName = (profile: Profile) => `难度 ${profile.level} ${levels.find(item => item.level === profile.level)?.nameZh ?? ''}`;
  const profile = kids.profiles.find(item => item.id === profileID);

  const writeReport = async (current: Profile, item: Scenario, ended: Ended, recordID: string) => {
    const base: SavedReport = { id: recordID, profileID: current.id, scenarioID: item.id, scenarioTitle: item.titleZh,
                                startedAt: new Date(Date.now() - ended.seconds * 1_000).toISOString(), seconds: ended.seconds, stars: 0, status: 'failed' };
    if (!reportsEnabled || !ended.sessionID) { setResult({ status: 'off', newStickers: 0 }); return; }
    setResult({ status: 'writing', newStickers: 0, sessionID: ended.sessionID });
    try {
      const response = await fetch('/api/kid/report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionID: ended.sessionID }),
      });
      if (response.status === 422) {
        const saved = { ...base, status: 'none' as const };
        kids.addReport(saved); setResult({ status: 'none', saved, newStickers: 0 }); return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const { report } = await response.json();
      const stars = Math.min(MAX_STARS_PER_TALK, report.repeatSuccesses);
      const saved: SavedReport = { ...base, status: 'ok', stars, report };
      kids.addReport(saved);
      setResult({ status: 'ok', saved, newStickers: stickers(current.stars + stars).length - stickers(current.stars).length });
    } catch {
      const saved = base;
      kids.addReport(saved);
      setResult({ status: 'failed', saved, newStickers: 0, sessionID: ended.sessionID });
    }
  };

  const start = () => {
    if (!profile || !scenario) return;
    const seconds = Math.floor(Math.min(kids.remainingToday(profile), scenario.minutes * 60));
    if (seconds < MINIMUM_SECONDS) { live.setMessage('今天的练习时间用完了，明天再来吧！'); return; }
    setResult(undefined);
    const current = profile, item = scenario, recordID = crypto.randomUUID();
    live.start({ language: 'en', mode: 'kid', scenario: item.id, level: String(current.level), nickname: current.nickname,
                 review: kids.lastReviewWords(current.id).join(','), seconds: String(seconds) }, ended => {
      kids.addUsage(current.id, ended.seconds);
      if (ended.seconds > 0) writeReport(current, item, ended, recordID);
    });
  };

  const retry = () => {
    if (!profile || !scenario || !result?.saved || !result.sessionID) return;
    writeReport(profile, scenario, { sessionID: result.sessionID, reason: 'retry', seconds: result.saved.seconds, confirmed: true }, result.saved.id);
  };

  if (view === 'parent') return <ParentArea kids={kids} levels={levels} serverUsage={serverUsage} onBack={() => setView('profiles')} />;

  if (view === 'profiles' || !profile) return (
    <main className="screen">
      <TopBar title="孩子英语口语" onBack={onExit} />
      {kids.profiles.length === 0 && <p className="muted center-text">还没有孩子档案。请家长点下面的“家长设置”创建。</p>}
      <div className="cards">
        {kids.profiles.map(item => (
          <button key={item.id} className="card kid" onClick={() => { setProfileID(item.id); setView('scenarios'); }}>
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

  if (view === 'scenarios' || !scenario) return (
    <main className="screen">
      <TopBar title={`${avatar(profile)} ${profile.nickname}`} onBack={() => setView('profiles')}>
        <button className="chip" onClick={() => setView('stickers')}>⭐ {profile.stars} · 贴纸 {owned.length}</button>
      </TopBar>
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
          <button key={item.id} className="card scenario" onClick={() => { setScenario(item); setResult(undefined); live.setMessage(''); setView('talk'); }}>
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
      {result && !live.busy ? <ResultPanel result={result} profile={profile} onRetry={retry} onAgain={() => setView('scenarios')} /> : (
        <Conversation live={live} idleLabel="开始" stopLabel={stopLabel} onStart={start} onStop={live.wrapping ? live.end : live.wrapUp}
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
  const stars = result.saved?.stars ?? 0;
  return (
    <section className="result">
      {result.status === 'writing' && <p className="muted">正在数星星…</p>}
      {result.status === 'ok' && (
        <>
          <p className="big-stars">{stars > 0 ? '⭐'.repeat(Math.min(stars, MAX_STARS_PER_TALK)) : '💪'}</p>
          <p className="result-title">{stars > 0 ? `太棒了！你得到 ${stars} 颗星！` : '你今天很勇敢地开口了！下次跟读成功就能得星星。'}</p>
          {result.newStickers > 0 && <p className="result-title">解锁新贴纸：{stickers(profile.stars).slice(-result.newStickers).join(' ')}</p>}
          {result.saved?.report?.teachBackWord && <p className="muted">你教会了 Mural：{result.saved.report.teachBackWord}</p>}
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
