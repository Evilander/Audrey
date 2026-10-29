import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const runFile = promisify(execFile);
const PLAN_SCOPES = ['chatgpt.tokens.use.direct', 'resource.invoke'];
const MAX_FILE_BYTES = 1024 * 1024;
// Longer than any legitimate lock hold (a refresh or three revocation attempts).
const STALE_LOCK_MS = 120_000;

interface Tokens {
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  expiresAt: number;
  earliestRefreshAt?: number;
}

interface Account {
  accountId: string;
  clientId: string;
  subject: string;
  email?: string;
  label: string;
  scopes: string[];
  revision: string;
  tokens?: Tokens;
}

interface Credentials {
  version: 1;
  hostId: string;
  activeAccountId?: string;
  accounts: Account[];
}

interface StagedCredentials {
  handle: FileHandle;
  temporary: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

export interface ChatGPTAccountSummary {
  accountId: string;
  clientId: string;
  subject: string;
  email?: string;
  label: string;
  active: boolean;
  signedIn: boolean;
  expiresAt?: number;
  scopes: string[];
  planEnabled: boolean;
}

export interface ChatGPTAuthOptions {
  directory?: string;
  appName?: string;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  now?: () => number;
  requestTimeoutMs?: number;
  loginTimeoutMs?: number;
  refreshLeewayMs?: number;
  lockTimeoutMs?: number;
}

export interface ChatGPTLoginOptions {
  accountId?: string;
  onAuthorizationUrl?: (url: string) => void | Promise<void>;
  openBrowser?: boolean;
  requestConsent?: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 65536): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

function clientId(value: unknown): value is string {
  return text(value, 512) && value !== 'dynamic_agent_client' && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isMissing(error: unknown): boolean {
  return record(error) && error.code === 'ENOENT';
}

function safeEndpoint(value: unknown): value is string {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.origin === ISSUER && !url.username && !url.password && !url.hash && !url.search;
  } catch {
    return false;
  }
}

function validCredentials(value: unknown): value is Credentials {
  if (
    !record(value) ||
    value.version !== 1 ||
    !text(value.hostId, 64) ||
    !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.hostId,
    ) ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 100
  )
    return false;
  const ids = new Set<string>();
  const clients = new Set<string>();
  for (const item of value.accounts) {
    if (
      !record(item) ||
      !text(item.accountId, 64) ||
      !clientId(item.clientId) ||
      !text(item.subject, 512) ||
      !text(item.label, 512) ||
      !text(item.revision, 64) ||
      (item.email !== undefined && !text(item.email, 320)) ||
      !Array.isArray(item.scopes) ||
      !item.scopes.every(scope => text(scope, 128)) ||
      ids.has(item.accountId) ||
      clients.has(item.clientId)
    )
      return false;
    ids.add(item.accountId);
    clients.add(item.clientId);
    if (item.tokens !== undefined) {
      const tokens = item.tokens;
      if (
        !record(tokens) ||
        !text(tokens.accessToken) ||
        !text(tokens.idToken) ||
        (tokens.refreshToken !== undefined && !text(tokens.refreshToken)) ||
        typeof tokens.expiresAt !== 'number' ||
        !Number.isFinite(tokens.expiresAt) ||
        (tokens.earliestRefreshAt !== undefined &&
          (typeof tokens.earliestRefreshAt !== 'number' ||
            !Number.isFinite(tokens.earliestRefreshAt)))
      )
        return false;
    }
  }
  return (
    value.activeAccountId === undefined ||
    (typeof value.activeAccountId === 'string' && ids.has(value.activeAccountId))
  );
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException('ChatGPT authentication was cancelled.', 'AbortError');
}

/**
 * The credential directory and everything inside it must be real files and
 * directories. Ancestors above it may be symbolic links (/tmp on macOS, a
 * relocated home directory); `root` is that directory with those resolved.
 */
async function rejectLinks(path: string, root: string, signal?: AbortSignal): Promise<void> {
  let current = resolve(path);
  for (;;) {
    checkAbort(signal);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('ChatGPT credential paths cannot contain symbolic links.');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(current);
    if (current === root || current === parent) break;
    current = parent;
  }
}

/** The first error line from PowerShell, unwrapped from CLIXML when it uses it. */
function powershellErrorLine(stderr: string): string | undefined {
  const clixml = stderr.match(/<S S="Error">([\s\S]*?)<\/S>/);
  const line = (clixml ? clixml[1]! : stderr)
    .replace(/_x000D_|_x000A_/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim()
    .split('\n')[0];
  return line ? line.slice(0, 300) : undefined;
}

async function protect(path: string, directory: boolean, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  if (process.platform !== 'win32') {
    await chmod(path, directory ? 0o700 : 0o600);
    checkAbort(signal);
    return;
  }
  const encodedPath = Buffer.from(path, 'utf8').toString('base64');
  // Start from the object's current descriptor: a freshly constructed
  // FileSecurity makes Set-Acl write the audit section as well, which needs
  // SeSecurityPrivilege and fails in any shell that is not elevated.
  // Pass paths as encoded data, never interpolate a shell command or account name.
  const script = `$ErrorActionPreference='Stop'; $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $target; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($existing in @($acl.Access)) { [void]$acl.RemoveAccessRule($existing) }; $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',${directory ? "'ContainerInherit,ObjectInherit','None'," : ''}'Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $target -AclObject $acl; $checked=Get-Acl -LiteralPath $target; if (!$checked.AreAccessRulesProtected -or $checked.Owner -ne $sid.Translate([Security.Principal.NTAccount]).Value) { throw 'Credential protection failed' }; foreach($entry in $checked.Access) { if ($entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $entry.AccessControlType -ne 'Allow') { throw 'Credential protection failed' } }`;
  try {
    await runFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, timeout: 10000, signal },
    );
  } catch (error) {
    checkAbort(signal);
    // Surface PowerShell's own first line so the operator can see which
    // ACL step failed; it names the path and the cmdlet, never a token.
    const detail = powershellErrorLine(
      record(error) && typeof error.stderr === 'string' ? error.stderr : '',
    );
    throw new Error(
      `Could not protect ChatGPT credentials with an owner-only Windows ACL.${detail ? ` ${detail}` : ''}`,
      { cause: error },
    );
  }
  checkAbort(signal);
}

async function launchBrowser(url: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      const data = Buffer.from(url, 'utf8').toString('base64');
      const script = `$ErrorActionPreference='Stop'; Start-Process ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')))`;
      await runFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, timeout: 10000 },
      );
    } else {
      await runFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeout: 10000 });
    }
  } catch {
    throw new Error('Could not open the browser. Use the displayed Continue with ChatGPT URL.');
  }
}

/** Public-client OAuth credentials owned by this app; never reads another app's sign-in. */
export class ChatGPTAuth {
  readonly directory: string;
  private canonicalRoot?: string;
  readonly appName: string;
  private readonly request: typeof fetch;
  private readonly browser: (url: string) => Promise<void>;
  private readonly now: () => number;
  private readonly requestTimeout: number;
  private readonly loginTimeout: number;
  private readonly refreshLeeway: number;
  private readonly lockTimeout: number;
  private prepared = false;
  private discovery?: Discovery;
  private keys?: ReturnType<typeof createLocalJWKSet>;

  constructor(options: ChatGPTAuthOptions = {}) {
    this.directory = resolve(options.directory ?? join(homedir(), '.audrey', 'auth'));
    this.appName = options.appName ?? 'Audrey';
    if (!text(this.appName, 128)) throw new Error('ChatGPT app name is invalid.');
    this.request = options.fetch ?? globalThis.fetch;
    this.browser = options.openBrowser ?? launchBrowser;
    this.now = options.now ?? Date.now;
    this.requestTimeout = bounded(options.requestTimeoutMs, 15000, 100, 60000);
    this.loginTimeout = bounded(options.loginTimeoutMs, 300000, 100, 600000);
    this.refreshLeeway = bounded(options.refreshLeewayMs, 60000, 0, 300000);
    this.lockTimeout = bounded(options.lockTimeoutMs, 20000, 100, 60000);
  }

  /** The configured directory with symbolic links above it resolved. */
  private async root(signal?: AbortSignal): Promise<string> {
    if (this.canonicalRoot) return this.canonicalRoot;
    checkAbort(signal);
    let existing = dirname(this.directory);
    const missing = [basename(this.directory)];
    for (;;) {
      try {
        this.canonicalRoot = join(await realpath(existing), ...missing);
        return this.canonicalRoot;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const parent = dirname(existing);
      if (parent === existing) throw new Error('ChatGPT credential directory is unreachable.');
      missing.unshift(basename(existing));
      existing = parent;
    }
  }

  private async prepare(signal?: AbortSignal): Promise<void> {
    checkAbort(signal);
    if (this.prepared) return;
    // Only cache successful protection; cancellation in one call must not poison another.
    const root = await this.root(signal);
    await rejectLinks(root, root, signal);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await protect(root, true, signal);
    this.prepared = true;
  }

  private async read(signal?: AbortSignal): Promise<Credentials | null> {
    const root = await this.root(signal);
    const path = join(root, 'credentials.json');
    await rejectLinks(path, root, signal);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
        throw new Error('Invalid ChatGPT credential file.');
      await this.prepare(signal);
      await protect(path, false, signal);
      const value: unknown = JSON.parse(await readFile(path, { encoding: 'utf8', signal }));
      if (!validCredentials(value)) throw new Error('Invalid ChatGPT credential record.');
      return value;
    } catch (error) {
      if (isMissing(error)) return null;
      // JSON parser errors can contain credential text; do not retain their cause.
      // eslint-disable-next-line preserve-caught-error
      if (error instanceof SyntaxError) throw new Error('Invalid ChatGPT credential record.');
      throw error;
    }
  }

  private async stage(signal?: AbortSignal): Promise<StagedCredentials> {
    await this.prepare(signal);
    const temporary = join(await this.root(signal), `credentials.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await protect(temporary, false, signal);
      return { handle, temporary };
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async dispose(stage: StagedCredentials): Promise<void> {
    await stage.handle.close().catch(() => {});
    await unlink(stage.temporary).catch(() => {});
  }

  private async save(
    value: Credentials,
    signal?: AbortSignal,
    staged?: StagedCredentials,
  ): Promise<void> {
    if (!validCredentials(value)) throw new Error('Invalid ChatGPT credential record.');
    const root = await this.root(signal);
    const path = join(root, 'credentials.json');
    await rejectLinks(path, root, signal);
    const stage = staged ?? (await this.stage(signal));
    try {
      checkAbort(signal);
      await stage.handle.writeFile(JSON.stringify(value));
      await stage.handle.sync();
      await stage.handle.close();
      checkAbort(signal);
      await rename(stage.temporary, path);
    } finally {
      await this.dispose(stage);
    }
  }

  private async locked<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.prepare(signal);
    const root = await this.root(signal);
    const path = join(root, 'credentials.lock');
    await rejectLinks(path, root, signal);
    const deadline = Date.now() + this.lockTimeout;
    let handle;
    while (!handle) {
      checkAbort(signal);
      try {
        handle = await open(path, 'wx', 0o600);
      } catch (error) {
        if (!record(error) || error.code !== 'EEXIST') throw error;
        if (await this.breakStaleLock(path, signal)) continue;
        if (Date.now() >= deadline)
          throw new Error(
            'ChatGPT credentials are locked by another operation. If its process stopped, remove credentials.lock from the auth directory and retry.',
            { cause: error },
          );
        await delay(50, signal);
      }
    }
    try {
      checkAbort(signal);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      return await operation();
    } finally {
      await handle.close();
      await unlink(path);
    }
  }

  /**
   * A hook process killed at its host deadline leaves the lock file behind.
   * Remove it when the recorded process is gone or the lock is older than any
   * legitimate hold, so later calls do not wait out the timeout and fail.
   */
  private async breakStaleLock(path: string, signal?: AbortSignal): Promise<boolean> {
    checkAbort(signal);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    if (!stat.isFile()) return false;
    let pid: number | undefined;
    let startedAt = stat.mtimeMs;
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (record(raw)) {
        if (typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0) pid = raw.pid;
        if (typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt))
          startedAt = raw.startedAt;
      }
    } catch {
      // Unreadable or still being written: judge it by age alone.
    }
    let stale = Date.now() - startedAt > STALE_LOCK_MS;
    if (!stale && pid !== undefined && pid !== process.pid) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        stale = record(error) && error.code === 'ESRCH';
      }
    }
    if (!stale) return false;
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return true;
  }

  private summary(account: Account, store: Credentials): ChatGPTAccountSummary {
    return {
      accountId: account.accountId,
      clientId: account.clientId,
      subject: account.subject,
      ...(account.email ? { email: account.email } : {}),
      label: account.label,
      active: store.activeAccountId === account.accountId,
      signedIn: !!account.tokens,
      ...(account.tokens ? { expiresAt: account.tokens.expiresAt } : {}),
      scopes: [...account.scopes],
      planEnabled: PLAN_SCOPES.every(scope => account.scopes.includes(scope)),
    };
  }

  async accounts(): Promise<ChatGPTAccountSummary[]> {
    const store = await this.read();
    return store ? store.accounts.map(account => this.summary(account, store)) : [];
  }

  async status(): Promise<ChatGPTAccountSummary | null> {
    return (await this.accounts()).find(account => account.active) ?? null;
  }

  async select(accountId: string): Promise<ChatGPTAccountSummary> {
    return this.locked(async () => {
      const store = await this.read();
      const account = store?.accounts.find(item => item.accountId === accountId);
      if (!store || !account) throw new Error('Saved ChatGPT account was not found.');
      if (!account.tokens)
        throw new Error(
          'That ChatGPT account is signed out. Run audrey auth login for that account.',
        );
      store.activeAccountId = accountId;
      await this.save(store);
      return this.summary(account, store);
    });
  }

  private async response(
    url: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    checkAbort(signal);
    try {
      return await this.request(url, {
        ...init,
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeout)])
          : AbortSignal.timeout(this.requestTimeout),
      });
    } catch {
      checkAbort(signal);
      throw new Error('ChatGPT authentication request failed or timed out.');
    }
  }

  private async json(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
    checkAbort(signal);
    try {
      const body = await response.text();
      checkAbort(signal);
      if (body.length > MAX_FILE_BYTES) throw new Error();
      const value: unknown = JSON.parse(body);
      if (!record(value)) throw new Error();
      return value;
    } catch {
      checkAbort(signal);
      throw new Error('ChatGPT authentication returned an invalid response.');
    }
  }

  private async configuration(signal?: AbortSignal): Promise<Discovery> {
    checkAbort(signal);
    if (this.discovery) return this.discovery;
    const response = await this.response(`${ISSUER}/.well-known/openid-configuration`, {}, signal);
    if (!response.ok) throw new Error(`ChatGPT discovery failed (HTTP ${response.status}).`);
    const body = await this.json(response, signal);
    if (
      body.issuer !== ISSUER ||
      !safeEndpoint(body.authorization_endpoint) ||
      !safeEndpoint(body.token_endpoint) ||
      !safeEndpoint(body.jwks_uri) ||
      (body.revocation_endpoint !== undefined && !safeEndpoint(body.revocation_endpoint))
    ) {
      throw new Error('ChatGPT discovery endpoints could not be verified.');
    }
    this.discovery = body as unknown as Discovery;
    return this.discovery;
  }

  private async signingKeys(signal?: AbortSignal): Promise<void> {
    const configuration = await this.configuration(signal);
    const response = await this.response(configuration.jwks_uri, {}, signal);
    if (!response.ok) throw new Error('ChatGPT signing keys could not be loaded.');
    const body = await this.json(response, signal);
    if (!Array.isArray(body.keys) || body.keys.length > 100)
      throw new Error('ChatGPT signing keys are invalid.');
    this.keys = createLocalJWKSet(body as unknown as JSONWebKeySet);
  }

  private async identity(
    token: string,
    audience: string,
    nonce?: string,
    signal?: AbortSignal,
  ): Promise<JWTPayload> {
    for (let attempt = 0; attempt < 2; attempt++) {
      checkAbort(signal);
      if (!this.keys) await this.signingKeys(signal);
      try {
        const { payload } = await jwtVerify(token, this.keys!, {
          issuer: ISSUER,
          audience,
          requiredClaims: ['sub', 'exp', 'iat'],
          algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
          clockTolerance: 5,
          currentDate: new Date(this.now()),
        });
        checkAbort(signal);
        if (
          !text(payload.sub, 512) ||
          (nonce !== undefined &&
            (typeof payload.nonce !== 'string' || !same(payload.nonce, nonce))) ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== audience)
        ) {
          throw new Error('Invalid identity');
        }
        return payload;
      } catch (error) {
        checkAbort(signal);
        // Key rotation is the only verification failure that merits a network retry.
        if (attempt === 0 && record(error) && error.code === 'ERR_JWKS_NO_MATCHING_KEY') {
          this.keys = undefined;
          continue;
        }
        // JOSE errors can retain JWT payload data; callers only receive this safe message.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(
          'ChatGPT ID token could not be verified (signature, issuer, audience, expiry, or nonce).',
        );
      }
    }
    throw new Error('ChatGPT ID token could not be verified.');
  }

  private async exchange(
    form: URLSearchParams,
    signal?: AbortSignal,
    preserveRotation = false,
  ): Promise<Record<string, unknown>> {
    const configuration = await this.configuration(signal);
    // Fetch ties response-body reads to its request signal. Forward cancellation
    // only until successful refresh headers arrive, then retain the request timeout
    // while receiving the replacement grant and committing it independently.
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    checkAbort(signal);
    if (preserveRotation) signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await this.response(
        configuration.token_endpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        },
        preserveRotation ? cancellation.signal : signal,
      );
      if (preserveRotation && response.ok) signal?.removeEventListener('abort', cancel);
      const body = await this.json(response, preserveRotation && response.ok ? undefined : signal);
      if (!response.ok) {
        if (body.error === 'invalid_grant')
          throw new Error(
            'ChatGPT session expired or was revoked (invalid_grant). Run audrey auth login to sign in again.',
          );
        if (body.error === 'refresh_token_not_ready')
          throw new Error(
            'ChatGPT refresh is not ready yet. Retry after the current access token expires.',
          );
        throw new Error(`ChatGPT token exchange failed (HTTP ${response.status}).`);
      }
      return body;
    } finally {
      if (preserveRotation) signal?.removeEventListener('abort', cancel);
    }
  }

  private tokens(
    body: Record<string, unknown>,
    previous?: Account,
  ): { tokens: Tokens; scopes: string[] } {
    if (
      !text(body.access_token) ||
      body.token_type !== 'Bearer' ||
      typeof body.expires_in !== 'number' ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0 ||
      body.expires_in > 86400 ||
      (body.refresh_token !== undefined && !text(body.refresh_token)) ||
      (body.id_token !== undefined && !text(body.id_token)) ||
      (body.scope !== undefined && typeof body.scope !== 'string')
    ) {
      throw new Error('ChatGPT token response is incomplete.');
    }
    const scopes =
      typeof body.scope === 'string'
        ? [...new Set(body.scope.split(/\s+/).filter(Boolean))]
        : previous
          ? [...previous.scopes]
          : [];
    const idToken = typeof body.id_token === 'string' ? body.id_token : previous?.tokens?.idToken;
    if (!idToken) throw new Error('ChatGPT token response did not include an ID token.');
    if (scopes.includes('offline_access') && !text(body.refresh_token)) {
      throw new Error('ChatGPT token response did not include a replacement refresh token.');
    }
    let earliestRefreshAt: number | undefined;
    if (body.earliest_refresh_at !== undefined) {
      if (
        typeof body.earliest_refresh_at !== 'number' ||
        !Number.isFinite(body.earliest_refresh_at) ||
        body.earliest_refresh_at <= 0
      ) {
        throw new Error('ChatGPT token refresh time is invalid.');
      }
      earliestRefreshAt = body.earliest_refresh_at * 1000;
    }
    return {
      scopes,
      tokens: {
        accessToken: body.access_token,
        idToken,
        ...(text(body.refresh_token) ? { refreshToken: body.refresh_token } : {}),
        expiresAt: this.now() + body.expires_in * 1000,
        ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}),
      },
    };
  }

  async login(options: ChatGPTLoginOptions = {}): Promise<ChatGPTAccountSummary> {
    const pending = await this.locked(async () => {
      let store = await this.read();
      if (!store) {
        store = { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
        await this.save(store);
      }
      const account = options.accountId
        ? store.accounts.find(item => item.accountId === options.accountId)
        : undefined;
      if (options.accountId && !account) throw new Error('Saved ChatGPT account was not found.');
      return { hostId: store.hostId, account };
    });
    const configuration = await this.configuration();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let settled = false;
    let resolveCallback!: (value: URLSearchParams) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<URLSearchParams>((resolvePromise, rejectPromise) => {
      resolveCallback = resolvePromise;
      rejectCallback = rejectPromise;
    });
    // Install the rejection handler before any browser work, which may itself fail.
    void callback.catch(() => {});
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (settled || request.method !== 'GET' || !request.url || request.url.length > 16384) {
        response.writeHead(400).end('Invalid sign-in callback.');
        return;
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/auth/callback') {
        response.writeHead(404).end('Not found.');
        return;
      }
      settled = true;
      const parameters = url.searchParams;
      const unique = ['state', 'code', 'client_id', 'error'].every(
        key => parameters.getAll(key).length <= 1,
      );
      if (!unique || !same(parameters.get('state') ?? '', state)) {
        response.writeHead(400).end('Sign-in could not be verified.');
        rejectCallback(new Error('ChatGPT sign-in state did not match. Start sign-in again.'));
      } else if (parameters.has('error')) {
        response.writeHead(400).end('Sign-in was declined or could not be completed.');
        rejectCallback(new Error('ChatGPT sign-in was declined or could not be completed.'));
      } else {
        response.end('Continue with ChatGPT completed. You can return to the app.');
        resolveCallback(parameters);
      }
    });
    server.headersTimeout = Math.min(this.loginTimeout, 10000);
    server.requestTimeout = Math.min(this.loginTimeout, 10000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', () =>
          rejectListen(new Error('Could not start the ChatGPT loopback callback listener.')),
        );
        server.listen(0, '127.0.0.1', resolveListen);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Could not start the ChatGPT loopback callback listener.');
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const url = new URL(configuration.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: pending.account?.clientId ?? 'dynamic_agent_client',
        ext_agent_host_id: pending.hostId,
        ...(pending.account ? {} : { agent_name_hint: this.appName }),
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        ...(options.requestConsent ? { prompt: 'consent' } : {}),
      }).toString();
      // Hints are optional; omitting them keeps these printable URLs credential-free.
      timer = setTimeout(() => {
        settled = true;
        rejectCallback(new Error('ChatGPT sign-in timed out. Start sign-in again.'));
      }, this.loginTimeout);
      await options.onAuthorizationUrl?.(url.toString());
      if (options.openBrowser !== false) await this.browser(url.toString());
      const parameters = await callback;
      const code = parameters.get('code');
      const issuedClient = parameters.get('client_id') ?? pending.account?.clientId;
      if (
        !text(code, 8192) ||
        !clientId(issuedClient) ||
        (pending.account && issuedClient !== pending.account.clientId)
      ) {
        throw new Error('ChatGPT callback registration or client ID could not be verified.');
      }
      const body = await this.exchange(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: issuedClient,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: RESOURCE,
        }),
      );
      const fresh = this.tokens(body);
      const identity = await this.identity(fresh.tokens.idToken, issuedClient, nonce);
      if (pending.account && identity.sub !== pending.account.subject) {
        throw new Error('ChatGPT account identity did not match the selected registration.');
      }
      return await this.locked(async () => {
        const store = await this.read();
        if (!store || store.hostId !== pending.hostId)
          throw new Error('ChatGPT registration changed during sign-in.');
        const existing = store.accounts.find(item => item.clientId === issuedClient);
        if (
          existing &&
          (existing.subject !== identity.sub ||
            (pending.account && existing.revision !== pending.account.revision))
        ) {
          throw new Error('ChatGPT registration changed during sign-in. Start sign-in again.');
        }
        const account: Account = {
          accountId: existing?.accountId ?? randomUUID(),
          clientId: issuedClient,
          subject: identity.sub!,
          label:
            existing?.label ??
            `${text(identity.email, 320) ? identity.email : 'ChatGPT account'} (${issuedClient.slice(-8)})`,
          ...(text(identity.email, 320) ? { email: identity.email } : {}),
          revision: randomUUID(),
          ...fresh,
        };
        if (existing) store.accounts[store.accounts.indexOf(existing)] = account;
        else store.accounts.push(account);
        store.activeAccountId = account.accountId;
        await this.save(store);
        return this.summary(account, store);
      });
    } finally {
      settled = true;
      if (timer) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  }

  async accessToken(accountId?: string, signal?: AbortSignal): Promise<string> {
    return this.locked(async () => {
      const store = await this.read(signal);
      const account = store?.accounts.find(
        item => item.accountId === (accountId ?? store.activeAccountId),
      );
      if (!store || !account?.tokens)
        throw new Error('Continue with ChatGPT first: run audrey auth login.');
      if (!PLAN_SCOPES.every(scope => account.scopes.includes(scope))) {
        throw new Error(
          'ChatGPT plan usage is not enabled for this account. Run audrey auth login with consent to enable it.',
        );
      }
      if (account.tokens.expiresAt > this.now() + this.refreshLeeway)
        return account.tokens.accessToken;
      if (
        account.tokens.earliestRefreshAt !== undefined &&
        account.tokens.earliestRefreshAt > this.now()
      ) {
        if (account.tokens.expiresAt > this.now()) return account.tokens.accessToken;
        throw new Error(
          'ChatGPT access expired before refresh is allowed. Try again after the refresh time.',
        );
      }
      if (!account.tokens.refreshToken || !account.scopes.includes('offline_access')) {
        if (account.tokens.expiresAt > this.now()) return account.tokens.accessToken;
        throw new Error('ChatGPT session cannot be renewed. Run audrey auth login.');
      }
      let body: Record<string, unknown>;
      // Do expensive permission/key work before the server consumes a rotating grant.
      await this.signingKeys(signal);
      const staged = await this.stage(signal);
      try {
        body = await this.exchange(
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: account.clientId,
            refresh_token: account.tokens.refreshToken,
            resource: RESOURCE,
          }),
          signal,
          true,
        );
      } catch (error) {
        await this.dispose(staged);
        if (error instanceof Error && error.message.includes('(invalid_grant)')) {
          delete account.tokens;
          account.revision = randomUUID();
          await this.save(store, signal);
        }
        throw error;
      }
      try {
        const fresh = this.tokens(body, account);
        // The server has consumed the old refresh token. Persist its
        // replacement before anything that can still fail (identity
        // verification, a cancelled caller, a slow disk), or the account is
        // signed out and needs a manual login.
        account.tokens = fresh.tokens;
        account.scopes = fresh.scopes;
        account.revision = randomUUID();
        await this.save(store, undefined, staged);
        if (typeof body.id_token === 'string') {
          // A key can rotate after the preflight fetch. Allow one bounded JWKS
          // reload without inheriting cancellation of a consumed refresh grant.
          const identity = await this.identity(
            body.id_token,
            account.clientId,
            undefined,
            AbortSignal.timeout(this.requestTimeout),
          );
          if (identity.sub !== account.subject) {
            delete account.tokens;
            account.revision = randomUUID();
            await this.save(store);
            throw new Error('Refreshed ChatGPT identity did not match the registration.');
          }
        }
        checkAbort(signal);
        if (!PLAN_SCOPES.every(scope => account.scopes.includes(scope))) {
          throw new Error(
            'ChatGPT plan usage is no longer enabled. Run audrey auth login with consent.',
          );
        }
        return account.tokens.accessToken;
      } finally {
        await this.dispose(staged);
      }
    }, signal);
  }

  async logout(accountId?: string): Promise<{ revoked: boolean }> {
    return this.locked(async () => {
      const store = await this.read();
      const account = store?.accounts.find(
        item => item.accountId === (accountId ?? store.activeAccountId),
      );
      if (!store || !account) return { revoked: true };
      let revoked = !account.tokens?.refreshToken;
      if (account.tokens?.refreshToken) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const configuration = await this.configuration();
            if (!configuration.revocation_endpoint) break;
            const response = await this.response(configuration.revocation_endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token: account.tokens.refreshToken,
                token_type_hint: 'refresh_token',
                client_id: account.clientId,
              }).toString(),
            });
            if (response.status === 200) {
              revoked = true;
              break;
            }
            if (response.status < 500) break;
          } catch {
            /* Credentials still clear locally after bounded revocation attempts. */
          }
          if (attempt < 2) await delay(100 * 2 ** attempt);
        }
      }
      delete account.tokens;
      account.revision = randomUUID();
      if (store.activeAccountId === account.accountId) delete store.activeAccountId;
      await this.save(store);
      return { revoked };
    });
  }
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error('ChatGPT auth timeout or refresh setting is invalid.');
  return value;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  try {
    await pause(ms, undefined, { signal });
  } catch {
    checkAbort(signal);
    throw new Error('ChatGPT authentication wait failed.');
  }
}
