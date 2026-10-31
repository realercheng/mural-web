import { useState } from 'react';
import { TopBar, Transcript } from './common';
import { NICKNAME, type Kids, type Level, type LevelInfo, type Profile, type SavedReport } from './kids';
import { minutes } from './live';

type View = { name: 'list' } | { name: 'edit'; profile?: Profile } | { name: 'reports'; profile: Profile }
  | { name: 'report'; profile: Profile; saved: SavedReport } | { name: 'password' };

/** Parent settings behind a device-local password: profiles, per-child daily minutes and reports. */
export function ParentArea({ kids, levels, serverUsage, onBack }: { kids: Kids; levels: LevelInfo[]; serverUsage: React.ReactNode; onBack: () => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const [view, setView] = useState<View>({ name: 'list' });

  if (!unlocked) return <Lock kids={kids} onUnlock={() => setUnlocked(true)} onBack={onBack} />;
  const toList = () => setView({ name: 'list' });

  if (view.name === 'edit') return <ProfileForm kids={kids} levels={levels} profile={view.profile} onDone={toList} />;
  if (view.name === 'password') return (
    <main className="screen">
      <TopBar title="修改家长密码" onBack={toList} />
      <PasswordForm label="新密码" onSubmit={async password => { await kids.setParentPassword(password); toList(); }} />
    </main>
  );
  if (view.name === 'report') return <ReportDetail saved={view.saved} onBack={() => setView({ name: 'reports', profile: view.profile })} />;
  if (view.name === 'reports') {
    const items = kids.reports.filter(item => item.profileID === view.profile.id);
    return (
      <main className="screen">
        <TopBar title={`${view.profile.nickname} 的报告`} onBack={toList} />
        {items.length === 0 && <p className="muted">还没有练习记录。</p>}
        <div className="list">
          {items.map(item => (
            <button key={item.id} className="list-item" onClick={() => setView({ name: 'report', profile: view.profile, saved: item })}>
              <strong>{new Date(item.startedAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {item.scenarioTitle}</strong>
              <span className="muted small">{minutes(item.seconds)} · ⭐ {item.stars} · {item.status === 'ok' ? item.report?.summary : item.status === 'none' ? '没有识别到孩子说话' : item.status === 'off' ? '未开启报告' : '报告未生成'}</span>
            </button>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <TopBar title="家长设置" onBack={onBack} />
      <div className="list">
        {kids.profiles.map(profile => (
          <div key={profile.id} className="list-item static">
            <strong>{profile.nickname} · 难度 {profile.level} {levels.find(item => item.level === profile.level)?.nameZh}</strong>
            <span className="muted small">每天上限 {profile.dailyMinutes} 分钟，今天已用 {minutes(kids.usedToday(profile.id))}，共 ⭐ {profile.stars}</span>
            <span className="row">
              <button className="secondary" onClick={() => setView({ name: 'reports', profile })}>查看报告</button>
              <button className="secondary" onClick={() => setView({ name: 'edit', profile })}>编辑</button>
            </span>
          </div>
        ))}
      </div>
      <button className="primary" onClick={() => setView({ name: 'edit' })}>添加孩子</button>
      <div className="note small muted">
        <p>{serverUsage}</p>
        <p>话题不和课本绑定。孩子进步后，点“编辑”调高难度即可。</p>
        <p>档案、星星和报告只保存在这台设备的浏览器里。清除浏览器数据会删除它们。</p>
      </div>
      <button className="secondary" onClick={() => setView({ name: 'password' })}>修改家长密码</button>
    </main>
  );
}

function Lock({ kids, onUnlock, onBack }: { kids: Kids; onUnlock: () => void; onBack: () => void }) {
  const [error, setError] = useState('');
  const creating = !kids.hasParentPassword;
  return (
    <main className="screen">
      <TopBar title="家长设置" onBack={onBack} />
      {creating && <p className="muted center-text">第一次使用，请设置家长密码。孩子不知道密码就不能改时长和看报告。</p>}
      <PasswordForm label={creating ? '设置家长密码' : '家长密码'} confirm={creating} onSubmit={async password => {
        if (creating) { await kids.setParentPassword(password); onUnlock(); return; }
        if (await kids.checkParentPassword(password)) onUnlock(); else setError('密码不正确。');
      }} />
      {error && <p className="error">{error}</p>}
      {!creating && <p className="small muted center-text">忘记密码：清除本网站的浏览器数据可以重置，但孩子档案、星星和报告也会一起删除。</p>}
    </main>
  );
}

function PasswordForm({ label, confirm = true, onSubmit }: { label: string; confirm?: boolean; onSubmit: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  return (
    <form className="form" onSubmit={async event => {
      event.preventDefault();
      if (confirm && password.length < 4) { setError('密码至少 4 位。'); return; }
      if (confirm && password !== again) { setError('两次输入的密码不一致。'); return; }
      setError(''); await onSubmit(password); setPassword(''); setAgain('');
    }}>
      <label htmlFor="parent-password">{label}</label>
      <input id="parent-password" type="password" autoComplete={confirm ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} />
      {confirm && <>
        <label htmlFor="parent-password-again">再输入一次</label>
        <input id="parent-password-again" type="password" autoComplete="new-password" value={again} onChange={event => setAgain(event.target.value)} />
      </>}
      <button className="primary" type="submit" disabled={!password}>确定</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function ProfileForm({ kids, levels, profile, onDone }: { kids: Kids; levels: LevelInfo[]; profile?: Profile; onDone: () => void }) {
  const [nickname, setNickname] = useState(profile?.nickname ?? '');
  const [level, setLevel] = useState<Level>(profile?.level ?? 1);
  const [dailyMinutes, setDailyMinutes] = useState(profile?.dailyMinutes ?? 30);
  const valid = NICKNAME.test(nickname.trim());
  return (
    <main className="screen">
      <TopBar title={profile ? '编辑孩子档案' : '添加孩子'} onBack={onDone} />
      <form className="form" onSubmit={event => {
        event.preventDefault();
        if (!valid) return;
        kids.saveProfile({ id: profile?.id ?? crypto.randomUUID(), nickname: nickname.trim(), level, dailyMinutes,
                           stars: profile?.stars ?? 0, createdAt: profile?.createdAt ?? new Date().toISOString() });
        onDone();
      }}>
        <label htmlFor="nickname">昵称（不要填真实姓名）</label>
        <input id="nickname" value={nickname} maxLength={12} onChange={event => setNickname(event.target.value)} placeholder="例如 Lucky、小雨" />
        {nickname && !valid && <p className="error small">昵称只能用文字、字母和数字，最多 12 个字。</p>}
        <span className="label">难度（随时可以改）</span>
        <div className="list" role="radiogroup" aria-label="难度">
          {levels.map(item => (
            <button key={item.level} type="button" role="radio" aria-checked={level === item.level}
                    className={level === item.level ? 'list-item selected' : 'list-item'} onClick={() => setLevel(item.level)}>
              <strong>难度 {item.level} {item.nameZh}</strong>
              <span className="small">{item.hintZh}</span>
            </button>
          ))}
        </div>
        <label htmlFor="daily">每天最多练习 {dailyMinutes} 分钟</label>
        <input id="daily" type="range" min={5} max={60} step={5} value={dailyMinutes} onChange={event => setDailyMinutes(Number(event.target.value))} />
        <p className="small muted">服务器另有全家共用的每日和每月上限，先到者生效。</p>
        <button className="primary" type="submit" disabled={!valid}>保存</button>
      </form>
      {profile && (
        <button className="danger" onClick={() => {
          if (confirm(`删除“${profile.nickname}”的档案、星星和全部报告？此操作不能撤销。`)) { kids.deleteProfile(profile.id); onDone(); }
        }}>删除档案</button>
      )}
    </main>
  );
}

function ReportDetail({ saved, onBack }: { saved: SavedReport; onBack: () => void }) {
  const report = saved.report;
  return (
    <main className="screen">
      <TopBar title={saved.scenarioTitle} onBack={onBack} />
      <p className="muted">{new Date(saved.startedAt).toLocaleString('zh-CN', { hour12: false })} · {minutes(saved.seconds)} · ⭐ {saved.stars}</p>
      {!report && <p className="muted">{saved.status === 'none' ? '这次没有识别到孩子说英语，所以没有报告。' : saved.status === 'off' ? '服务器未开启家长报告。' : '这次的报告没有生成成功。'}</p>}
      {report && (
        <section className="report">
          <p>{report.summary}</p>
          <h2>练习的单词</h2>
          <p>{report.words.join('，') || '—'}</p>
          <h2>练习的句子</h2>
          {report.sentences.length ? <ul>{report.sentences.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p>—</p>}
          <h2>纠正的错误</h2>
          {report.corrections.length ? (
            <ul>{report.corrections.map((item, i) => <li key={i}><s>{item.said}</s> → <strong>{item.correct}</strong><br /><span className="muted small">{item.note}</span></li>)}</ul>
          ) : <p>—</p>}
          <h2>成功跟读</h2>
          <p>{report.repeatSuccesses} 次{report.teachBackWord ? `；孩子教 Mural 的词：${report.teachBackWord}` : ''}</p>
          <h2>下次建议</h2>
          {report.nextSteps.length ? <ul>{report.nextSteps.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p>—</p>}
          {report.reviewWords.length > 0 && <p className="small muted">下次开始时复习：{report.reviewWords.join(', ')}</p>}
          <p className="small muted">报告由文字模型根据语音转写生成，可能有误差。</p>
        </section>
      )}
      {saved.transcript?.length ? <><h2 className="section-title">聊天记录</h2><Transcript lines={saved.transcript} /></> : null}
    </main>
  );
}
