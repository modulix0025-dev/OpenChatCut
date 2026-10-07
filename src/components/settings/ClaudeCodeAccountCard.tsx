import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ClaudeCodeAgentStatus, ClaudeCodeLoginAccountType } from '../../../shared/claude-code-agent';
import { useT } from '../../i18n/locale';
import { theme, themeAlpha } from '../../theme';
import { Icon } from '../icons';
import { safeClaudeAuthUrl, type ClaudeCodeSettingsController } from './useClaudeCodeSettings';

const COPY_FEEDBACK_MS = 1_600;

type AccountState = 'loading' | 'missing' | 'signed-out' | 'pending' | 'signed-in' | 'error';

function accountState(controller: ClaudeCodeSettingsController): AccountState {
  const { status } = controller;
  if (controller.loading && !status) return 'loading';
  if (controller.login) return 'pending';
  if (!status) return 'error';
  if (!status.installed) return 'missing';
  if (status.account?.loggedIn) return 'signed-in';
  if (status.error || controller.error) return 'error';
  return 'signed-out';
}

export function ClaudeCodeAccountCard({ controller }: {
  controller: ClaudeCodeSettingsController;
}) {
  const t = useT();
  const state = accountState(controller);
  const [switching, setSwitching] = useState(false);
  // Kept here, not in the form, so a failed sign-in does not wipe the choice.
  const formState = useState<LoginFormValues>({ accountType: 'claudeai', email: '', sso: false });
  useEffect(() => { if (state !== 'signed-in') setSwitching(false); }, [state]);
  const canSignIn = !!controller.status?.installed && !controller.status.error?.startsWith('Claude Code CLI ');
  const showForm = canSignIn && (state === 'signed-out' || state === 'error' || (state === 'signed-in' && switching));
  return (
    <section style={card} aria-live="polite">
      <StatusSummary state={state} controller={controller} />
      {(controller.status?.envOverrides?.length ?? 0) > 0 && <EnvOverrideWarning names={controller.status!.envOverrides!} />}
      {(state === 'missing' || (!!controller.status?.installed && !canSignIn)) && (
        <InstallPanel controller={controller} update={state !== 'missing'} />
      )}
      {state === 'pending' && <PendingLogin controller={controller} />}
      {showForm && (
        <LoginForm controller={controller} switching={switching} onCancel={() => setSwitching(false)}
          values={formState[0]} onChange={formState[1]} />
      )}
      {!showForm && state !== 'pending' && (
        <ActionRow state={state} controller={controller}
          onLoadModels={() => { void controller.discoverModels(); }}
          onSwitch={() => setSwitching(true)} />
      )}
      {showForm && state !== 'signed-in' && (
        <div style={actions}>
          <ActionButton disabled={controller.loading} onClick={() => { void controller.refresh(); }}>
            {controller.loading ? t('刷新中…') : t('重新检测')}
          </ActionButton>
        </div>
      )}
      {controller.testResult && <TestResultLine result={controller.testResult} />}
      {controller.actionError && <div role="alert" style={errorText}>{controller.actionError}</div>}
      {state !== 'error' && (controller.error ?? controller.status?.error) && (
        <div role="alert" style={errorText}>{controller.error ?? controller.status?.error}</div>
      )}
      {state === 'signed-in' && controller.modelError && <div role="alert" style={errorText}>{controller.modelError}</div>}
      {canSignIn && state !== 'signed-in' && <TerminalFallback />}
      {controller.status?.path && <div style={pathLine} title={controller.status.path}>{controller.status.path}</div>}
    </section>
  );
}

function InstallPanel({ controller, update }: { controller: ClaudeCodeSettingsController; update: boolean }) {
  const t = useT();
  const busy = controller.actionBusy !== null;
  const installing = controller.actionBusy === 'install';
  const result = controller.installResult;
  return (
    <div style={loginForm}>
      <div style={hint}>
        {t('OpenChatCut 通过官方 Claude Code CLI 连接 Claude。点击下面的按钮运行 Anthropic 官方安装程序（无需管理员权限），完成后会自动重新检测。')}
      </div>
      <code style={{ ...valueCode, ...prominentCode, fontSize: 11, direction: 'ltr', textAlign: 'start' }}>
        {navigator.userAgent.includes('Windows') ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash'}
      </code>
      <div style={actions}>
        <button type="button" disabled={busy} onClick={() => { void controller.installCli(); }}
          style={{ ...button, color: theme.onAccent, background: theme.accent, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}>
          {installing ? t('正在安装 Claude Code…（可能需要几分钟）') : update ? t('更新 Claude Code') : t('安装 Claude Code')}
        </button>
      </div>
      {result && (
        <div role="status" style={{ ...testLine, whiteSpace: 'pre-wrap', color: result.ok ? theme.success : theme.danger }}>
          {result.ok ? t('安装完成。') : t('安装失败：{message}', { message: result.message })}
        </div>
      )}
    </div>
  );
}

function EnvOverrideWarning({ names }: { names: readonly string[] }) {
  const t = useT();
  return (
    <div role="note" style={warningBox}>
      {t('环境变量 {names} 会覆盖浏览器登录的账号。要使用这里登录的账号，请删除该环境变量并重启 OpenChatCut。', { names: names.join(', ') })}
    </div>
  );
}

function TestResultLine({ result }: { result: NonNullable<ClaudeCodeSettingsController['testResult']> }) {
  const t = useT();
  const seconds = (result.durationMs / 1000).toFixed(1);
  return (
    <div role="status" style={{ ...testLine, color: result.ok ? theme.success : theme.danger }}>
      {result.ok
        ? t('连接正常：Claude 已回复（{seconds} 秒{model}）。', { seconds, model: result.model ? ` · ${result.model}` : '' })
        : t('连接失败：{message}', { message: result.message })}
    </div>
  );
}

interface LoginFormValues {
  readonly accountType: ClaudeCodeLoginAccountType;
  readonly email: string;
  readonly sso: boolean;
}

function LoginForm({ controller, switching, onCancel, values, onChange }: {
  controller: ClaudeCodeSettingsController; switching: boolean; onCancel: () => void;
  values: LoginFormValues; onChange: (update: (current: LoginFormValues) => LoginFormValues) => void;
}) {
  const t = useT();
  const { accountType, email, sso } = values;
  const setAccountType = (value: ClaudeCodeLoginAccountType) => onChange((current) => ({ ...current, accountType: value }));
  const setEmail = (value: string) => onChange((current) => ({ ...current, email: value }));
  const setSso = (value: boolean) => onChange((current) => ({ ...current, sso: value }));
  const busy = controller.actionBusy !== null;
  const submit = () => {
    const trimmed = email.trim();
    void controller.startLogin({ accountType, ...(trimmed ? { email: trimmed } : {}), ...(sso ? { sso } : {}) });
  };
  const option = (value: ClaudeCodeLoginAccountType, title: string, detail: string) => (
    <label style={{ ...choice, borderColor: accountType === value ? theme.accent : theme.border }}>
      <input type="radio" name="claude-code-account-type" value={value} checked={accountType === value}
        onChange={() => setAccountType(value)} style={{ margin: '2px 0 0' }} />
      <span style={{ minWidth: 0 }}>
        <span style={choiceTitle}>{title}</span>
        <span style={choiceDetail}>{detail}</span>
      </span>
    </label>
  );
  return (
    <form style={loginForm} onSubmit={(event) => { event.preventDefault(); if (!busy) submit(); }}>
      <div style={formTitle}>{switching ? t('切换到另一个 Claude 账号') : t('选择要连接的账号')}</div>
      <div role="radiogroup" aria-label={t('账号类型')} style={choices}>
        {option('claudeai', t('Claude 订阅账号'), t('Pro / Max / Team / Enterprise，按订阅额度计费。'))}
        {option('console', t('Anthropic Console 账号'), t('按 API 用量计费（console.anthropic.com）。'))}
      </div>
      <label style={fieldLabel}>
        {t('邮箱')}
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com" autoComplete="email" spellCheck={false} dir="ltr" style={input} />
      </label>
      <div style={hint}>{t('可选：填写邮箱后，Claude 登录页会预先选中这个账号。浏览器里已登录其他账号时也可以在授权页切换。')}</div>
      <label style={checkboxLabel}>
        <input type="checkbox" checked={sso} onChange={(event) => setSso(event.target.checked)} />
        {t('使用公司 SSO 登录')}
      </label>
      <div style={actions}>
        <button type="submit" disabled={busy}
          style={{ ...button, color: theme.onAccent, background: theme.accent, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}>
          {controller.actionBusy === 'login' ? t('正在启动…') : t('在浏览器中登录')}
        </button>
        {switching && <ActionButton disabled={busy} onClick={onCancel}>{t('取消')}</ActionButton>}
      </div>
    </form>
  );
}

function PendingLogin({ controller }: { controller: ClaudeCodeSettingsController }) {
  const t = useT();
  const login = controller.login!;
  const [code, setCode] = useState('');
  const url = safeClaudeAuthUrl(login.authUrl);
  const busy = controller.actionBusy !== null;
  return (
    <div style={loginForm}>
      <div style={hint}>
        {url ? t('浏览器应已打开 Claude 授权页面。如果没有打开，请点击下面的链接。') : t('正在等待 Claude Code 打开浏览器…')}
      </div>
      {url && (
        <a href={url} target="_blank" rel="noreferrer" style={authLink} title={url}>{t('打开 Claude 授权页面')}</a>
      )}
      <form style={codeRow} onSubmit={(event) => {
        event.preventDefault();
        if (code.trim() && !busy) void controller.submitLoginCode(code.trim()).then(() => setCode(''));
      }}>
        <input value={code} onChange={(event) => setCode(event.target.value)} aria-label={t('授权码')}
          placeholder={t('如果页面显示授权码，请粘贴到这里')} spellCheck={false} autoComplete="off" dir="ltr"
          style={{ ...input, flex: 1 }} />
        <button type="submit" disabled={busy || !code.trim()}
          style={{ ...button, color: theme.text, background: 'transparent', opacity: busy || !code.trim() ? 0.5 : 1 }}>
          {t('提交')}
        </button>
      </form>
      {login.status === 'code-submitted' && <div style={hint}>{t('授权码已提交，正在完成登录…')}</div>}
      <div style={actions}>
        <ActionButton disabled={controller.actionBusy === 'cancel'} onClick={() => { void controller.cancelLogin(); }}>
          {t('取消登录')}
        </ActionButton>
      </div>
    </div>
  );
}

function TerminalFallback() {
  const t = useT();
  return (
    <details style={terminalDetails}>
      <summary style={terminalSummary}>{t('也可以在终端登录')}</summary>
      <SignInCommands />
    </details>
  );
}

function StatusSummary({ state, controller }: {
  state: AccountState; controller: ClaudeCodeSettingsController;
}) {
  const t = useT();
  const status = controller.status;
  const copy: Record<AccountState, readonly [string, string]> = {
    loading: [t('正在检查 Claude Code CLI…'), t('正在读取本机 Claude Code 运行时状态。')],
    missing: [t('未检测到 Claude Code CLI'), t('请先安装官方 Claude Code CLI，然后刷新状态。')],
    'signed-out': [t('尚未登录 Claude'), t('选择要连接的账号，然后在浏览器中完成 Claude 授权。')],
    pending: [t('等待 Claude 授权'), t('请在浏览器中的 Claude 授权页面点击“Authorize”，完成后会自动刷新。')],
    'signed-in': [t('已登录 Claude'), t('凭据与续期均由 Claude Code CLI 管理。')],
    error: [t('Claude Code 暂时不可用'), controller.error ?? status?.error ?? t('请刷新后重试。')],
  };
  const [title, detail] = copy[state];
  const tone = state === 'signed-in' ? theme.success
    : state === 'error' || state === 'missing' ? theme.danger
      : state === 'pending' ? theme.accent : theme.borderLight;
  return (
    <div style={summaryRow}>
      <span aria-hidden style={{ ...statusDot, background: tone }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={summaryTitle}>{title}</div>
        <div style={summaryDetail}>{detail}</div>
        {state === 'signed-in' && status?.account && <AccountMetadata status={status} />}
      </div>
      {status?.installed && status.version && <span style={versionTag}>{t('Claude Code CLI {version}', { version: status.version })}</span>}
    </div>
  );
}

function AccountMetadata({ status }: { status: ClaudeCodeAgentStatus }) {
  const t = useT();
  const account = status.account;
  if (!account) return null;
  return (
    <div style={metadata}>
      {account.email && <span title={account.email}>{account.email}</span>}
      {account.orgName && <span>{t('组织：{org}', { org: account.orgName })}</span>}
      {account.subscriptionType && <span>{t('套餐：{plan}', { plan: account.subscriptionType })}</span>}
      {account.authMethod && <span>{t('登录方式：{method}', { method: account.authMethod })}</span>}
    </div>
  );
}

function SignInCommands() {
  const t = useT();
  return (
    <div style={loginDetails}>
      <ValueRow label={t('登录')} value="claude auth login" prominent />
      <ValueRow label={t('长期令牌')} value="claude setup-token" prominent />
    </div>
  );
}

function ValueRow({ label, value, prominent = false }: {
  label: string; value: string; prominent?: boolean;
}) {
  return (
    <div style={valueRow}>
      <span style={valueLabel}>{label}</span>
      <code tabIndex={0} style={{ ...valueCode, ...(prominent ? prominentCode : {}) }}>{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

function ActionRow({ state, controller, onLoadModels, onSwitch }: {
  state: AccountState; controller: ClaudeCodeSettingsController; onLoadModels: () => void; onSwitch: () => void;
}) {
  const t = useT();
  const busy = controller.loading || controller.modelBusy || controller.actionBusy !== null;
  if (state === 'signed-in') {
    return (
      <div style={actions}>
        <ActionButton primary disabled={busy} onClick={onLoadModels}>{controller.modelBusy ? t('读取中…') : t('读取模型')}</ActionButton>
        <ActionButton disabled={busy} onClick={() => { void controller.testConnection(); }}>
          {controller.actionBusy === 'test' ? t('正在测试连接…') : t('测试连接')}
        </ActionButton>
        <ActionButton disabled={busy} onClick={() => { void controller.refresh(); }}>{controller.loading ? t('刷新中…') : t('重新检测')}</ActionButton>
        <ActionButton disabled={busy} onClick={onSwitch}>{t('切换账号')}</ActionButton>
        <ActionButton disabled={busy} onClick={() => { void controller.logout(); }}>
          {controller.actionBusy === 'logout' ? t('正在退出…') : t('退出登录')}
        </ActionButton>
      </div>
    );
  }
  return (
    <div style={actions}>
      <ActionButton disabled={busy} onClick={() => { void controller.refresh(); }}>{controller.loading ? t('刷新中…') : t('重新检测')}</ActionButton>
    </div>
  );
}

function ActionButton({ children, onClick, disabled = false, primary = false }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean;
}) {
  const color = primary ? theme.onAccent : theme.text;
  const background = primary ? theme.accent : 'transparent';
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ ...button, color, background, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}>
      {children}
    </button>
  );
}

function CopyButton({ value }: { value: string }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), COPY_FEEDBACK_MS);
  };
  const label = state === 'copied' ? t('已复制') : state === 'failed' ? t('复制失败') : t('复制');
  return (
    <button type="button" onClick={() => { void copy(); }} title={label} aria-label={label} style={copyButton}>
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={11} />
      {label}
    </button>
  );
}

const card: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 10, padding: '11px 13px',
  background: theme.bg, border: `0.5px solid ${theme.border}`, borderRadius: 4,
};
const summaryRow: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 9 };
const statusDot: React.CSSProperties = { width: 8, height: 8, marginTop: 4, borderRadius: '50%', flex: '0 0 auto' };
const summaryTitle: React.CSSProperties = { color: theme.text, fontSize: 12, fontWeight: 600, lineHeight: 1.35 };
const summaryDetail: React.CSSProperties = { marginTop: 2, color: theme.textDim, fontSize: 10.5, lineHeight: 1.45 };
const versionTag: React.CSSProperties = {
  flex: '0 0 auto', padding: '1px 5px', border: `0.5px solid ${theme.border}`,
  borderRadius: 4, color: theme.textDim, fontSize: 9.5,
};
const metadata: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '2px 9px', marginTop: 5, color: theme.textMuted,
  fontSize: 10.5, lineHeight: 1.35, overflowWrap: 'anywhere',
};
const loginDetails: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const valueRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 };
const valueLabel: React.CSSProperties = { width: 52, flex: '0 0 52px', color: theme.textDim, fontSize: 10.5 };
const valueCode: React.CSSProperties = {
  display: 'block', minWidth: 0, overflow: 'hidden', color: 'inherit', fontFamily: 'Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10.5, lineHeight: 1.45, textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'all',
};
const prominentCode: React.CSSProperties = { color: theme.textStrong, fontSize: 13, fontWeight: 700 };
const actions: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 };
const button: React.CSSProperties = {
  minHeight: 28, padding: '4px 9px', border: `0.5px solid ${theme.border}`, borderRadius: 4,
  font: 'inherit', fontSize: 10.5, fontWeight: 500,
};
const copyButton: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto', minHeight: 24,
  padding: '2px 6px', border: `0.5px solid ${theme.border}`, borderRadius: 4,
  background: themeAlpha.ink(0.04), color: theme.textMuted, cursor: 'pointer', fontSize: 10,
};
const pathLine: React.CSSProperties = {
  color: theme.textDim, fontSize: 9.5, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap', direction: 'ltr', textAlign: 'start',
  fontFamily: 'Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
};
const warningBox: React.CSSProperties = {
  padding: '6px 8px', border: `0.5px solid ${theme.border}`, borderRadius: 4,
  background: themeAlpha.ink(0.04), color: theme.text, fontSize: 10.5, lineHeight: 1.45,
};
const testLine: React.CSSProperties = { fontSize: 10.5, lineHeight: 1.45, overflowWrap: 'anywhere' };
const loginForm: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 7 };
const formTitle: React.CSSProperties = { color: theme.text, fontSize: 11, fontWeight: 600 };
const choices: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 };
const choice: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 7, padding: '6px 8px',
  border: `0.5px solid ${theme.border}`, borderRadius: 4, cursor: 'pointer',
};
const choiceTitle: React.CSSProperties = { display: 'block', color: theme.text, fontSize: 11, fontWeight: 500 };
const choiceDetail: React.CSSProperties = { display: 'block', color: theme.textDim, fontSize: 10, lineHeight: 1.4 };
const fieldLabel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, color: theme.textDim, fontSize: 10.5 };
const input: React.CSSProperties = {
  minHeight: 28, padding: '4px 8px', border: `0.5px solid ${theme.border}`, borderRadius: 4,
  background: theme.bg, color: theme.text, font: 'inherit', fontSize: 11, minWidth: 0,
};
const hint: React.CSSProperties = { color: theme.textDim, fontSize: 10, lineHeight: 1.45 };
const checkboxLabel: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, color: theme.text, fontSize: 10.5 };
const authLink: React.CSSProperties = { color: theme.accent, fontSize: 11, fontWeight: 600, alignSelf: 'flex-start' };
const codeRow: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center' };
const terminalDetails: React.CSSProperties = { color: theme.textDim, fontSize: 10.5 };
const terminalSummary: React.CSSProperties = { cursor: 'pointer', marginBottom: 6 };
const errorText: React.CSSProperties = {
  paddingTop: 7, borderTop: `0.5px solid ${theme.border}`, color: theme.danger,
  fontSize: 10.5, lineHeight: 1.45,
};
