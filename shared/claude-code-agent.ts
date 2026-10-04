export interface ClaudeCodeAccountSummary {
  readonly loggedIn: boolean;
  readonly email: string | null;
  readonly subscriptionType: string | null;
  readonly authMethod: string | null;
  readonly orgName?: string | null;
  readonly apiProvider?: string | null;
}

export type ClaudeCodeLoginAccountType = 'claudeai' | 'console';

/** One in-app `claude auth login` run. Never carries a token. */
export interface ClaudeCodeLoginState {
  readonly id: string;
  readonly status: 'starting' | 'waiting' | 'code-submitted' | 'succeeded' | 'failed' | 'cancelled';
  readonly accountType: ClaudeCodeLoginAccountType;
  readonly email: string | null;
  /** The Claude authorization page, for when the browser did not open by itself. */
  readonly authUrl: string | null;
  /** The CLI asked for a code from the authorization page. */
  readonly codePrompt: boolean;
  readonly error: string | null;
  readonly startedAt: number;
}

export interface ClaudeCodeLoginStartRequest {
  readonly accountType?: ClaudeCodeLoginAccountType;
  readonly email?: string;
  readonly sso?: boolean;
}

export interface ClaudeCodeConnectionTestResult {
  readonly ok: boolean;
  readonly message: string;
  readonly durationMs: number;
  readonly model?: string;
}

export interface ClaudeCodeAgentStatus {
  readonly installed: boolean;
  readonly version: string | null;
  readonly account: ClaudeCodeAccountSummary | null;
  readonly error?: string;
  /** Path of the CLI this app runs, so the user can tell which install is used. */
  readonly path?: string | null;
  /** The running (or last) in-app sign-in. */
  readonly login?: ClaudeCodeLoginState | null;
  /** Names of environment variables that override the browser sign-in. */
  readonly envOverrides?: readonly string[];
}

export interface ClaudeCodeAgentModel {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface ClaudeCodeAgentModelsResponse {
  readonly models: readonly ClaudeCodeAgentModel[];
  readonly error?: string;
}

export interface ClaudeCodeTurnRequest {
  readonly requestId: string;
  readonly system: string;
  readonly prompt: string;
  readonly projectId: string;
  readonly model?: string;
  readonly sessionId?: string;
  /**
   * The composer's auto-apply (YOLO) state for this run. Declared to the
   * turn's own MCP server so begin_edit_session cannot fall back to "manual"
   * when the model omits the argument. Omitted means "leave it to the model",
   * which is the pre-existing behaviour.
   */
  readonly approvalMode?: 'manual' | 'auto';
}

/**
 * Unlike Codex's dynamicTools RPC bridge, Claude Code CLI's own MCP client
 * calls OpenChatCut's MCP server directly and executes tools itself — these
 * events are for chat-UI display only, never for OpenChatCut to act on.
 */
export type ClaudeCodeTurnStreamEvent =
  | { readonly type: 'session'; readonly sessionId: string }
  // `startsMessage` marks the first text/thinking chunk of a NEW CLI assistant
  // message. Each `assistant` line the CLI prints is a complete message rather
  // than a partial delta, so two messages either side of a tool call have to be
  // separated on display; without it they render as one run-on paragraph
  // ("…properly.Now adding…").
  | { readonly type: 'text-delta'; readonly delta: string; readonly startsMessage?: true }
  | { readonly type: 'thinking-delta'; readonly delta: string; readonly startsMessage?: true }
  | {
      readonly type: 'tool-start';
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly type: 'tool-end';
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
      readonly result: unknown;
      readonly success: boolean;
    }
  | {
      readonly type: 'context-usage';
      readonly inputTokens: number;
      readonly contextWindowTokens?: number;
      readonly outputTokens?: number;
      readonly cacheReadTokens?: number;
    }
  | { readonly type: 'error'; readonly message: string }
  // Shown to the user as a chat note, never added to the model's transcript:
  // a denied tool, or a turn that has gone quiet while waiting on something.
  | { readonly type: 'notice'; readonly message: string }
  | { readonly type: 'done' };
