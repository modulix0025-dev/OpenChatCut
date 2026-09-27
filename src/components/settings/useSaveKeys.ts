import { useState } from 'react';
import { t } from '../../i18n/locale';
import { buildPatch, savedMessage, type KeyStatusResponse, type StagedValues as Values } from './settingsSchema';

/** Save the staged settings. A storage-folder move into a folder that already
 *  holds projects asks the user to replace or use them before resubmitting. */
export function useSaveKeys(values: Values, onSaved: (next: KeyStatusResponse) => void): {
  save: () => Promise<void>; saving: boolean; msg: string | null; error: string | null;
} {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const patch = buildPatch(values);
    if (Object.keys(patch).length === 0) { setMsg(t('没有改动')); return; }
    setSaving(true); setError(null); setMsg(null);
    try {
      type SaveBody = Partial<KeyStatusResponse> & { error?: string; code?: string; newestMtimeMs?: number | null; dataDirWarning?: string };
      const post = async (body: Record<string, unknown>) => {
        const res = await fetch('/api/keys', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        return { res, body: await res.json().catch(() => ({})) as SaveBody };
      };
      let { res, body } = await post(patch);
      // The chosen folder already holds projects: never overwrite or ignore
      // them silently; the user decides.
      if (res.status === 409 && body.code === 'data-dir-has-data') {
        const when = body.newestMtimeMs ? new Date(body.newestMtimeMs).toLocaleString() : t('未知');
        const choice = window.confirm(t('所选文件夹里已经有 OpenChatCut 工程（最后修改：{when}）。\n\n确定：用你当前的工程替换它们（原有数据会保留为备份）。\n取消：不替换，下一步可选择改用该文件夹里已有的工程。', { when }))
          ? 'replace'
          : window.confirm(t('改用该文件夹里已有的工程？当前工程保留在原位置，不会被删除。')) ? 'use-existing' : null;
        if (!choice) { setMsg(t('没有改动')); return; }
        ({ res, body } = await post({ ...patch, OPENCHATCUT_DATA_DIR_EXISTING: choice }));
      }
      if (!res.ok) throw new Error(body.error || t('保存失败 ({n})', { n: res.status }));
      onSaved(body as KeyStatusResponse);
      // A storage-folder move happens on the next launch (so edits made in
      // between are not left behind), so saying "saved" alone would look like
      // nothing happened.
      const saved = body.restartRequired ? t('已保存 · 重启应用后将移动工程并使用新的存储目录') : savedMessage();
      setMsg(body.dataDirWarning ? `${saved} · ${t('注意：该文件夹由云盘同步（OneDrive、Dropbox、iCloud 或 Google Drive），同步程序可能锁定、改写文件或只保留在线副本，建议使用本地文件夹。')}` : saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return { save, saving, msg, error };
}
