import {
  useCallback, useEffect, useRef, useState, type RefObject,
} from 'react';
import type {
  ClaudeCodeAgentModel,
  ClaudeCodeAgentStatus,
  ClaudeCodeConnectionTestResult,
  ClaudeCodeLoginStartRequest,
  ClaudeCodeLoginState,
} from '../../../shared/claude-code-agent';
import {
  cancelClaudeCodeLogin,
  fetchClaudeCodeModels,
  fetchClaudeCodeStatus,
  logoutClaudeCode,
  startClaudeCodeLogin,
  submitClaudeCodeLoginCode,
  testClaudeCodeConnection,
} from '../../agent/claude-code/client';
import { applyClaudeCodeAgentStatus } from '../../agent/model-selection';
import { t } from '../../i18n/locale';

interface RemoteStatusState {
  readonly status: ClaudeCodeAgentStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
}

interface RemoteStatusControl {
  readonly state: RemoteStatusState;
  readonly refresh: (silent?: boolean) => Promise<ClaudeCodeAgentStatus | null>;
}

export interface ClaudeCodeSettingsController {
  readonly status: ClaudeCodeAgentStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly modelBusy: boolean;
  readonly modelError: string | null;
  readonly models: readonly ClaudeCodeAgentModel[];
  readonly refresh: () => Promise<ClaudeCodeAgentStatus | null>;
  readonly discoverModels: () => Promise<readonly ClaudeCodeAgentModel[]>;
  /** The in-app sign-in that is running, if any. */
  readonly login: ClaudeCodeLoginState | null;
  readonly actionBusy: 'login' | 'code' | 'cancel' | 'logout' | 'test' | null;
  readonly actionError: string | null;
  readonly testResult: ClaudeCodeConnectionTestResult | null;
  readonly startLogin: (request: ClaudeCodeLoginStartRequest) => Promise<void>;
  readonly submitLoginCode: (code: string) => Promise<void>;
  readonly cancelLogin: () => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly testConnection: (model?: string) => Promise<void>;
}

const LOGIN_POLL_MS = 1_500;
const ACTIVE_LOGIN = new Set<ClaudeCodeLoginState['status']>(['starting', 'waiting', 'code-submitted']);

export function loginIsActive(login: ClaudeCodeLoginState | null | undefined): login is ClaudeCodeLoginState {
  return !!login && ACTIVE_LOGIN.has(login.status);
}

/** A link the card may open: https on a Claude / Anthropic host only. */
export function safeClaudeAuthUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = ['claude.ai', 'claude.com', 'anthropic.com'].some((root) => host === root || host.endsWith(`.${root}`));
    return url.protocol === 'https:' && allowed && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function useClaudeCodeAccountActions(remote: RemoteStatusControl, onAccountChanged: () => void) {
  const mounted = useMountedRef();
  const [login, setLogin] = useState<ClaudeCodeLoginState | null>(null);
  const [busy, setBusy] = useState<ClaudeCodeSettingsController['actionBusy']>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ClaudeCodeConnectionTestResult | null>(null);
  const serverLogin = remote.state.status?.login ?? null;

  // The server is the source of truth for the sign-in: adopt its view on each
  // status read, so a sign-in finished in the browser shows up without a click.
  useEffect(() => {
    if (!serverLogin) return;
    setLogin((current) => {
      if (!current || current.id !== serverLogin.id) return loginIsActive(serverLogin) ? serverLogin : current;
      return serverLogin;
    });
  }, [serverLogin]);

  const refresh = remote.refresh;
  const active = loginIsActive(login);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void refresh(true); }, LOGIN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  // Report how the sign-in ended once, then let the card go back to normal.
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    const key = login ? `${login.id}:${login.status}` : null;
    if (!login || key === lastStatus.current) return;
    lastStatus.current = key;
    if (login.status === 'succeeded') {
      setError(null);
      setTestResult(null);
      onAccountChanged();
    } else if (login.status === 'failed') {
      setError(t('Claude 登录失败：{message}', { message: login.error ?? t('请重试。') }));
    }
  }, [login, onAccountChanged]);

  const run = useCallback(async (kind: NonNullable<ClaudeCodeSettingsController['actionBusy']>, action: () => Promise<void>) => {
    setBusy(kind); setError(null);
    try {
      await action();
    } catch (failure) {
      if (mounted.current) setError(message(failure));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [mounted]);

  const startLogin = useCallback((request: ClaudeCodeLoginStartRequest) => run('login', async () => {
    setTestResult(null);
    try {
      const state = await startClaudeCodeLogin(request);
      if (mounted.current) setLogin(state);
    } catch (failure) {
      throw new Error(t('无法启动 Claude 登录：{message}', { message: message(failure) }));
    }
  }), [mounted, run]);

  const submitLoginCode = useCallback((code: string) => run('code', async () => {
    if (!login) return;
    try {
      const state = await submitClaudeCodeLoginCode(login.id, code);
      if (mounted.current) setLogin(state);
    } catch (failure) {
      throw new Error(t('授权码提交失败：{message}', { message: message(failure) }));
    }
  }), [login, mounted, run]);

  const cancelLogin = useCallback(() => run('cancel', async () => {
    await cancelClaudeCodeLogin(login?.id);
    if (mounted.current) setLogin(null);
    await refresh(true);
  }), [login, mounted, refresh, run]);

  const logout = useCallback(() => run('logout', async () => {
    try {
      await logoutClaudeCode();
    } catch (failure) {
      throw new Error(t('无法退出 Claude 登录：{message}', { message: message(failure) }));
    }
    if (mounted.current) { setLogin(null); setTestResult(null); }
    onAccountChanged();
    await refresh();
  }), [mounted, onAccountChanged, refresh, run]);

  const testConnection = useCallback((model?: string) => run('test', async () => {
    setTestResult(null);
    const result = await testClaudeCodeConnection(model);
    if (mounted.current) setTestResult(result);
  }), [mounted, run]);

  return { login, busy, error, testResult, startLogin, submitLoginCode, cancelLogin, logout, testConnection };
}

function useMountedRef(): RefObject<boolean> {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

function useClaudeCodeStatusControl(): RemoteStatusControl {
  const mounted = useMountedRef();
  const [state, setState] = useState<RemoteStatusState>({ status: null, loading: true, error: null });
  const refresh = useCallback(async (silent = false): Promise<ClaudeCodeAgentStatus | null> => {
    if (!silent) setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const status = await fetchClaudeCodeStatus();
      if (mounted.current) setState({ status, loading: false, error: null });
      return status;
    } catch {
      if (mounted.current) {
        setState((current) => ({
          ...current, loading: false, error: t('无法连接 Claude Code 服务，请确认开发服务正在运行。'),
        }));
      }
      return null;
    }
  }, [mounted]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { state, refresh };
}

function useClaudeCodeModels(autoDiscover: boolean) {
  const mounted = useMountedRef();
  const autoStarted = useRef(false);
  const requestGeneration = useRef(0);
  const [models, setModels] = useState<readonly ClaudeCodeAgentModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = useCallback((): void => {
    requestGeneration.current += 1;
    autoStarted.current = false;
    if (!mounted.current) return;
    setModels([]);
    setBusy(false);
    setError(null);
  }, [mounted]);
  const discoverModels = useCallback(async (): Promise<readonly ClaudeCodeAgentModel[]> => {
    const generation = ++requestGeneration.current;
    setBusy(true); setError(null);
    try {
      const response = await fetchClaudeCodeModels();
      if (generation !== requestGeneration.current) return [];
      if (response.error) {
        if (mounted.current) setError(t('读取模型失败：{message}', { message: response.error }));
        return [];
      }
      if (mounted.current) setModels(response.models);
      return response.models;
    } catch {
      if (generation === requestGeneration.current && mounted.current) {
        setError(t('无法读取 Claude Code 模型，请稍后重试。'));
      }
      return [];
    } finally {
      if (generation === requestGeneration.current && mounted.current) setBusy(false);
    }
  }, [mounted]);
  useEffect(() => {
    if (!autoDiscover) {
      reset();
      return;
    }
    if (autoStarted.current) return;
    autoStarted.current = true;
    void discoverModels();
  }, [autoDiscover, discoverModels, reset]);
  return { models, busy, error, discoverModels, reset };
}

export function useClaudeCodeSettings(savedModel?: string): ClaudeCodeSettingsController {
  const remote = useClaudeCodeStatusControl();
  const models = useClaudeCodeModels(remote.state.status?.account?.loggedIn === true);
  const { reset: resetModels, discoverModels } = models;
  // Another account can have another model list: drop the old one and re-read.
  const accountChanged = useCallback(() => { resetModels(); void discoverModels(); }, [resetModels, discoverModels]);
  const actions = useClaudeCodeAccountActions(remote, accountChanged);
  useEffect(() => {
    if (remote.state.status) {
      applyClaudeCodeAgentStatus(remote.state.status, savedModel, models.models);
    }
  }, [models.models, remote.state.status, savedModel]);
  return {
    status: remote.state.status,
    loading: remote.state.loading,
    error: remote.state.error,
    modelBusy: models.busy,
    modelError: models.error,
    models: models.models,
    refresh: remote.refresh,
    discoverModels: models.discoverModels,
    login: loginIsActive(actions.login) ? actions.login : null,
    actionBusy: actions.busy,
    actionError: actions.error,
    testResult: actions.testResult,
    startLogin: actions.startLogin,
    submitLoginCode: actions.submitLoginCode,
    cancelLogin: actions.cancelLogin,
    logout: actions.logout,
    testConnection: actions.testConnection,
  };
}
