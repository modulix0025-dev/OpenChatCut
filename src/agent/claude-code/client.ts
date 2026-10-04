import type {
  ClaudeCodeAgentModelsResponse,
  ClaudeCodeAgentStatus,
  ClaudeCodeConnectionTestResult,
  ClaudeCodeLoginStartRequest,
  ClaudeCodeLoginState,
} from '../../../shared/claude-code-agent';

async function responseError(response: Response): Promise<Error> {
  let message = '';
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string') message = body.error.trim();
  } catch {
    // The status text below remains useful when an upstream proxy returns HTML.
  }
  return new Error(message || `${response.status} ${response.statusText || 'Request failed'}`);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw await responseError(response);
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`Invalid JSON response from ${path}.`);
  }
}

export function fetchClaudeCodeStatus(): Promise<ClaudeCodeAgentStatus> {
  return requestJson<ClaudeCodeAgentStatus>('/api/claude-code/status');
}

export function fetchClaudeCodeModels(): Promise<ClaudeCodeAgentModelsResponse> {
  return requestJson<ClaudeCodeAgentModelsResponse>('/api/claude-code/models');
}

function postJson(body: unknown = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export function startClaudeCodeLogin(request: ClaudeCodeLoginStartRequest): Promise<ClaudeCodeLoginState> {
  return requestJson<ClaudeCodeLoginState>('/api/claude-code/login/start', postJson(request));
}

export function submitClaudeCodeLoginCode(loginId: string, code: string): Promise<ClaudeCodeLoginState> {
  return requestJson<ClaudeCodeLoginState>('/api/claude-code/login/code', postJson({ loginId, code }));
}

export async function cancelClaudeCodeLogin(loginId?: string): Promise<void> {
  await requestJson<unknown>('/api/claude-code/login/cancel', postJson(loginId ? { loginId } : {}));
}

export async function logoutClaudeCode(): Promise<void> {
  await requestJson<unknown>('/api/claude-code/logout', postJson());
}

export function testClaudeCodeConnection(model?: string): Promise<ClaudeCodeConnectionTestResult> {
  return requestJson<ClaudeCodeConnectionTestResult>('/api/claude-code/test', postJson(model ? { model } : {}));
}
