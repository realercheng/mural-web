import { useEffect, useRef, useState } from 'react';
import { ARCHIVE_MESSAGES, ArchiveError, recordLines, toDate, withMeanings, type SessionRecord } from './archive';
import { SubtitleToggle, TopBar, Transcript, type Reading } from './common';
import type { History } from './history';
import type { Kids } from './kids';
import { minutes } from './live';
import { useMeanings, useSubtitlePreference } from './meaning';

const shortDate = (record: SessionRecord) =>
  toDate(record.startedAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Who and what a record is about, e.g. "孩子 Lucky" or "成人 · English". */
export function recordLabel(record: SessionRecord, kids: Kids, languageName: (id: string) => string) {
  if (record.web?.mode === 'kid') return `孩子 ${kids.profiles.find(p => p.id === record.web?.kid?.profileID)?.nickname ?? '（档案已删除）'}`;
  return `${record.web ? '成人' : '原 App'} · ${languageName(record.languageID)}`;
}

/** All conversations on this device: read, delete, and back up to or restore from a JSON file. */
export function HistoryView({ history, kids, languageName, supported, onBack }: {
  history: History; kids: Kids; languageName: (id: string) => string; supported: string[]; onBack: () => void;
}) {
  const [openID, setOpenID] = useState<string>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const record = history.sessions.find(item => item.id === openID);

  if (record) return <RecordView record={record} history={history} supported={supported} label={recordLabel(record, kids, languageName)}
                                 onBack={() => setOpenID(undefined)} />;

  const exportBackup = () => {
    const blob = history.exportArchive({ kids: { profiles: kids.profiles } });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mural-backup-${new Date().toLocaleDateString('sv')}.json`; // YYYY-MM-DD, local date
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setError(''); setNotice(`已导出 ${history.sessions.length} 次对话和 ${kids.profiles.length} 个孩子档案。文件在浏览器的“下载”里。`);
  };

  const importBackup = async (chosen: File | undefined) => {
    if (!chosen) return;
    setNotice(''); setError('');
    try {
      const result = await history.importArchive(chosen);
      kids.importProfiles(result.profiles);
      setNotice(`导入完成：新增 ${result.added} 次对话${result.skipped ? `，跳过 ${result.skipped} 次已有的对话` : ''}。`);
    } catch (failure) {
      setError(`导入失败，现有记录没有变化。${failure instanceof ArchiveError ? ARCHIVE_MESSAGES[failure.kind] : '无法读取或保存这个文件。'}`);
    } finally { if (file.current) file.current.value = ''; }
  };

  const removeAll = async () => {
    if (!confirm(`删除这台设备上的全部 ${history.sessions.length} 次对话？孩子的星星和贴纸会保留。此操作不能撤销，建议先导出备份。`)) return;
    try { await history.removeAll(); setNotice('已删除全部对话。'); } catch { setError('删除失败，请重试。'); }
  };

  return (
    <main className="screen">
      <TopBar title="对话历史" onBack={onBack} />
      {history.problem && <p className="error">{history.problem}</p>}
      <div className="row">
        <button className="secondary" onClick={exportBackup} disabled={!history.sessions.length}>导出备份</button>
        <button className="secondary" onClick={() => file.current?.click()} disabled={!history.available}>导入备份</button>
        <button className="danger" onClick={removeAll} disabled={!history.sessions.length || !history.available}>全部删除</button>
      </div>
      <input ref={file} type="file" accept="application/json,.json" hidden onChange={event => importBackup(event.target.files?.[0])} />
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {history.sessions.length === 0 && <p className="muted">还没有对话记录。</p>}
      <div className="list">
        {history.sessions.map(item => (
          <button key={item.id} className="list-item" onClick={() => setOpenID(item.id)}>
            <strong>{shortDate(item)} · {item.title}</strong>
            <span className="muted small">{recordLabel(item, kids, languageName)} · {minutes(item.voiceSeconds)} · {item.fragments.length} 句</span>
          </button>
        ))}
      </div>
      <div className="note small muted">
        <p>对话只保存在这台设备的浏览器里，不会上传到服务器。清除浏览器数据会删除它们。</p>
        <p>换设备前请先“导出备份”，在新设备上“导入备份”。备份格式和原 Mural App 相同。</p>
      </div>
    </main>
  );
}

/** One saved conversation, with subtitles, word lookup and deletion. */
export function RecordView({ record, history, supported, label, onBack, allowDelete = true }: {
  record: SessionRecord; history: History; supported: string[]; label: string; onBack: () => void; allowDelete?: boolean;
}) {
  const reading = useRecordReading(record, history, supported);
  return (
    <main className="screen">
      <TopBar title={record.title} onBack={onBack} />
      <p className="muted">{toDate(record.startedAt).toLocaleString('zh-CN', { hour12: false })} · {minutes(record.voiceSeconds)} · {label}</p>
      <div className="row center-row"><SubtitleToggle reading={reading} /></div>
      {!reading.languageID && <p className="small muted">这种语言暂不支持字幕和查词。</p>}
      {reading.languageID && <p className="small muted">点英文单词可以看它在这句话里的意思。</p>}
      <Transcript lines={recordLines(record)} reading={reading} />
      {allowDelete && (
        <button className="danger" onClick={async () => {
          if (!confirm('删除这次对话？此操作不能撤销。')) return;
          await history.remove([record.id]).catch(() => alert('删除失败，请重试。'));
          onBack();
        }}>删除这次对话</button>
      )}
    </main>
  );
}

/** Subtitles for a saved web conversation are fetched once and stored with it. */
export function useRecordReading(record: SessionRecord, history: History, supported: string[]): Reading {
  const languageID = supported.includes(record.languageID) ? record.languageID : undefined;
  const meanings = useMeanings(record.languageID);
  const [subtitles, setSubtitles] = useSubtitlePreference();
  useEffect(() => {
    if (!languageID || !subtitles) return;
    const missing = recordLines(record).filter(line => line.speaker === 'assistant' && !line.meaning);
    if (!missing.length) return;
    let current = true;
    Promise.all(missing.map(line => meanings.request(line.text))).then(results => {
      if (!current || !record.web || !results.some(Boolean)) return;
      const found = new Map(missing.map((line, index) => [line.text, results[index]]));
      history.update(record.id, latest => withMeanings(latest, text => found.get(text)));
    });
    return () => { current = false; };
  }, [record, languageID, subtitles, meanings.request, history.update]);
  return { languageID, meanings, subtitles, onSubtitles: setSubtitles };
}
