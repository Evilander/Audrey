import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ChatGPTAuth } from '../dist/src/chatgpt-auth.js';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const grantedScopes =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/api/accounts/authorize`,
  token_endpoint: `${issuer}/api/accounts/oauth/token`,
  jwks_uri: `${issuer}/.well-known/jwks.json`,
  revocation_endpoint: `${issuer}/api/accounts/oauth/revoke`,
};
const realFetch = globalThis.fetch;
const execute = promisify(execFile);
const directories = [];
let privateKey;
let jwks;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', use: 'sig', kid: 'test-key' }],
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'audrey-chatgpt-auth-'));
  directories.push(directory);
  const time = { now: Date.now() };
  const requests = [];
  const urls = [];
  const state = {
    client: 'oaiapp_audrey_test',
    subject: 'subject-one',
    scopes: grantedScopes,
    claims: {},
    callback: {},
    tokenBody: {},
    tokenStatus: 200,
    tokenError: undefined,
    refreshBody: {},
    revocationStatus: 200,
    discovery,
    jwks,
    ...options,
  };
  const fetcher = vi.fn(async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/openid-configuration')) return response(state.discovery);
    if (url.endsWith('/jwks.json')) return response(state.jwks);
    if (url.endsWith('/revoke')) return new Response(null, { status: state.revocationStatus });
    if (url.endsWith('/token')) {
      if (state.tokenError) throw new Error(state.tokenError);
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'refresh_token') {
        return response(
          {
            access_token: 'refreshed-access-secret',
            refresh_token: 'rotated-refresh-secret',
            token_type: 'Bearer',
            expires_in: 3600,
            ...state.refreshBody,
          },
          state.tokenStatus,
        );
      }
      const auth = new URL(urls.at(-1));
      const identity = await new SignJWT({
        nonce: auth.searchParams.get('nonce'),
        email: 'same@example.test',
        ...state.claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject(state.subject)
        .setIssuer(state.claims.iss ?? issuer)
        .setAudience(state.claims.aud ?? form.get('client_id'))
        .setIssuedAt(Math.floor(time.now / 1000))
        .setExpirationTime(state.claims.exp ?? Math.floor(time.now / 1000) + 3600)
        .sign(privateKey);
      return response(
        {
          access_token: 'initial-access-secret',
          refresh_token: 'initial-refresh-secret',
          id_token: identity,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: state.scopes,
          ...state.tokenBody,
        },
        state.tokenStatus,
      );
    }
    throw new Error('Unexpected fixture endpoint');
  });
  const browser = vi.fn(async url => {
    urls.push(url);
    const auth = new URL(url);
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({
      state: auth.searchParams.get('state'),
      code: 'fixture-code',
      client_id: state.client,
      ...state.callback,
    }).toString();
    if (state.callback.client_id === null) callback.searchParams.delete('client_id');
    if (state.duplicateState) callback.searchParams.append('state', auth.searchParams.get('state'));
    if (state.beforeCallback) await state.beforeCallback(auth);
    const result = await realFetch(callback);
    await result.text();
  });
  const auth = new ChatGPTAuth({
    directory,
    fetch: fetcher,
    openBrowser: browser,
    now: () => time.now,
    ...state.authOptions,
  });
  const store = () => readFile(join(directory, 'credentials.json'), 'utf8').then(JSON.parse);
  return { auth, directory, state, requests, urls, fetcher, browser, time, store };
}

describe('ChatGPT public-client sign-in', () => {
  it('uses S256, a live 127.0.0.1 callback, issued client ID and a stable host identity', async () => {
    const f = await fixture();
    const first = await f.auth.login();
    expect(first).toMatchObject({
      active: true,
      signedIn: true,
      planEnabled: true,
      clientId: f.state.client,
      subject: f.state.subject,
    });
    const url = new URL(f.urls[0]);
    expect(url.origin).toBe(issuer);
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(url.searchParams.get('agent_name_hint')).toBe('Audrey');
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect(url.searchParams.get('scope')).toBe(grantedScopes);
    expect(url.searchParams.get('resource')).toBe(resource);
    expect(new URL(url.searchParams.get('redirect_uri')).hostname).toBe('127.0.0.1');
    expect(new URL(url.searchParams.get('redirect_uri')).pathname).toBe('/auth/callback');
    const exchange = new URLSearchParams(
      f.requests.find(item => item.url.endsWith('/token')).init.body,
    );
    expect(exchange.get('client_id')).toBe(f.state.client);
    expect(exchange.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
    expect(exchange.has('client_secret')).toBe(false);
    expect(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(await f.auth.accessToken()).toBe('initial-access-secret');
    f.state.callback.client_id = null;
    await f.auth.login({ accountId: first.accountId });
    const next = new URL(f.urls[1]);
    expect(next.searchParams.get('client_id')).toBe(f.state.client);
    expect(next.searchParams.has('agent_name_hint')).toBe(false);
    expect(next.searchParams.has('id_token_hint')).toBe(false);
    expect(next.searchParams.has('prompt')).toBe(false);
    expect(next.searchParams.get('ext_agent_host_id')).toBe(
      url.searchParams.get('ext_agent_host_id'),
    );
    expect(next.searchParams.get('state')).not.toBe(url.searchParams.get('state'));
    expect(next.searchParams.get('nonce')).not.toBe(url.searchParams.get('nonce'));
    expect(await f.auth.accounts()).toHaveLength(1);
  }, 30000);

  it.each([
    ['mismatched state', { callback: { state: 'spoofed-state' } }],
    ['duplicate state', { duplicateState: true }],
    [
      'denied consent',
      { callback: { error: 'access_denied', error_description: 'access-secret-do-not-log' } },
    ],
    ['missing issued client', { callback: { client_id: null } }],
    ['dynamic entrypoint as client', { client: 'dynamic_agent_client' }],
  ])(
    'rejects %s without exchanging a code or saving a registration',
    async (_label, options) => {
      const f = await fixture(options);
      await expect(f.auth.login()).rejects.toThrow(/ChatGPT/);
      expect(f.requests.some(item => item.url.endsWith('/token'))).toBe(false);
      expect((await f.store()).accounts).toEqual([]);
    },
    30000,
  );

  it.each([
    ['nonce', { claims: { nonce: 'spoofed-nonce' } }],
    ['issuer', { claims: { iss: 'https://attacker.example' } }],
    ['audience', { claims: { aud: 'oaiapp_different_client' } }],
    ['expiry', { claims: { exp: 1 } }],
    ['signature', { tokenBody: { id_token: 'not-a-signed-token' } }],
  ])(
    'rejects invalid ID-token %s before persisting credentials',
    async (_label, options) => {
      const f = await fixture(options);
      await expect(f.auth.login()).rejects.toThrow('ID token could not be verified');
      expect((await f.store()).accounts).toEqual([]);
    },
    30000,
  );

  it('rejects a different callback client and verified subject on returning sign-in', async () => {
    const f = await fixture();
    const account = await f.auth.login();
    const original = await f.store();
    f.state.client = 'oaiapp_swapped';
    const requestCount = f.requests.filter(item => item.url.endsWith('/token')).length;
    await expect(f.auth.login({ accountId: account.accountId })).rejects.toThrow(
      'client ID could not be verified',
    );
    expect(f.requests.filter(item => item.url.endsWith('/token'))).toHaveLength(requestCount);
    f.state.client = account.clientId;
    f.state.subject = 'subject-swapped';
    await expect(f.auth.login({ accountId: account.accountId })).rejects.toThrow(
      'identity did not match',
    );
    expect(await f.store()).toEqual(original);
  }, 30000);

  it('saves identity-only consent but blocks inference, using token-response scopes', async () => {
    const f = await fixture({
      scopes: 'openid profile email',
      callback: { scope: grantedScopes },
      tokenBody: { refresh_token: undefined },
    });
    const account = await f.auth.login();
    expect(account.planEnabled).toBe(false);
    expect(account.signedIn).toBe(true);
    await expect(f.auth.accessToken()).rejects.toThrow('plan usage is not enabled');
    expect(f.browser).toHaveBeenCalledTimes(1);
    f.state.scopes = grantedScopes;
    delete f.state.tokenBody.refresh_token;
    await f.auth.login({ accountId: account.accountId, requestConsent: true });
    expect(new URL(f.urls[1]).searchParams.get('prompt')).toBe('consent');
    expect(await f.auth.accessToken()).toBe('initial-access-secret');
  }, 30000);

  it('keeps separate registrations when account emails match and switches explicitly', async () => {
    const f = await fixture();
    const first = await f.auth.login();
    f.state.client = 'oaiapp_second_account';
    f.state.subject = 'subject-two';
    const second = await f.auth.login();
    expect(second.email).toBe(first.email);
    expect(second.accountId).not.toBe(first.accountId);
    expect((await f.auth.accounts()).map(item => item.active)).toEqual([false, true]);
    expect((await f.auth.select(first.accountId)).active).toBe(true);
    expect((await f.auth.status()).accountId).toBe(first.accountId);
    expect((await f.auth.accounts()).map(item => item.label)[0]).not.toBe(second.label);
  }, 30000);

  it('rejects discovery endpoints outside the issuer before opening a browser', async () => {
    const f = await fixture({
      discovery: { ...discovery, token_endpoint: 'https://attacker.example/token' },
    });
    await expect(f.auth.login()).rejects.toThrow('discovery endpoints could not be verified');
    expect(f.browser).not.toHaveBeenCalled();
  }, 30000);

  it('keeps OAuth and transport error bodies and tokens out of errors and summaries', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const f = await fixture({
      tokenStatus: 400,
      tokenBody: { error: 'evil-secret-access', error_description: 'initial-refresh-secret' },
    });
    let message;
    try {
      await f.auth.login();
    } catch (failure) {
      message = failure.message;
    }
    expect(message).toBe('ChatGPT token exchange failed (HTTP 400).');
    f.state.tokenError = 'https://auth.openai.com/?id_token_hint=private-secret';
    await expect(f.auth.login()).rejects.toThrow('request failed or timed out');
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(
      f.urls.every(
        url => !new URL(url).searchParams.has('id_token_hint') && !url.includes('secret'),
      ),
    ).toBe(true);
  }, 30000);

  it('times out a pending browser flow and closes its callback listener', async () => {
    const f = await fixture({ authOptions: { loginTimeoutMs: 100 } });
    let callback;
    await expect(
      f.auth.login({
        openBrowser: false,
        onAuthorizationUrl: url => {
          callback = new URL(url).searchParams.get('redirect_uri');
        },
      }),
    ).rejects.toThrow('timed out');
    await expect(realFetch(callback)).rejects.toThrow();
  }, 30000);
});

describe('ChatGPT refresh and sign-out', () => {
  it.each([false, true])(
    'verifies a new signing key and preserves rotation (key changes during exchange: %s)',
    async rotateDuringExchange => {
      const f = await fixture({ authOptions: { requestTimeoutMs: 5000 } });
      await f.auth.login();
      f.time.now += 3600000;
      const replacement = await generateKeyPair('RS256');
      const replacementKeys = {
        keys: [
          {
            ...(await exportJWK(replacement.publicKey)),
            alg: 'RS256',
            use: 'sig',
            kid: 'replacement-key',
          },
        ],
      };
      f.state.refreshBody.id_token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'replacement-key' })
        .setIssuer(issuer)
        .setAudience(f.state.client)
        .setSubject(f.state.subject)
        .setIssuedAt(Math.floor(f.time.now / 1000))
        .setExpirationTime(Math.floor(f.time.now / 1000) + 3600)
        .sign(replacement.privateKey);
      const implementation = f.fetcher.getMockImplementation();
      let consumed = false;
      f.fetcher.mockImplementation(async (url, init) => {
        if (
          url.endsWith('/token') &&
          new URLSearchParams(init.body).get('grant_type') === 'refresh_token'
        ) {
          expect(consumed).toBe(false);
          consumed = true;
          if (rotateDuringExchange) f.state.jwks = replacementKeys;
        }
        if (url.endsWith('/jwks.json') && consumed) {
          // Verification may need network I/O after rotation; the 1s local
          // commit deadline must not also be its network deadline.
          await new Promise(resolveDelay => setTimeout(resolveDelay, 1100));
        }
        return implementation(url, init);
      });
      if (!rotateDuringExchange) f.state.jwks = replacementKeys;

      expect(await f.auth.accessToken()).toBe('refreshed-access-secret');
      expect((await f.store()).accounts[0].tokens).toMatchObject({
        refreshToken: 'rotated-refresh-secret',
        idToken: f.state.refreshBody.id_token,
      });
      expect(await f.auth.accessToken()).toBe('refreshed-access-secret');
      expect(f.requests.filter(item => item.url.endsWith('/token'))).toHaveLength(2);
      expect(f.requests.filter(item => item.url.endsWith('/jwks.json'))).toHaveLength(
        rotateDuringExchange ? 3 : 2,
      );
    },
    30000,
  );

  it('commits a successful rotation before reporting cancellation, without returning its token', async () => {
    const f = await fixture();
    await f.auth.login();
    f.time.now += 3600000;
    const implementation = f.fetcher.getMockImplementation();
    const controller = new AbortController();
    f.fetcher.mockImplementation(async (url, init) => {
      const result = await implementation(url, init);
      if (
        url.endsWith('/token') &&
        new URLSearchParams(init.body).get('grant_type') === 'refresh_token'
      )
        controller.abort();
      return result;
    });
    await expect(f.auth.accessToken(undefined, controller.signal)).rejects.toThrow('cancelled');
    expect((await f.store()).accounts[0].tokens.refreshToken).toBe('rotated-refresh-secret');
    await expect(stat(join(f.directory, 'credentials.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    f.fetcher.mockImplementation(implementation);
    expect(await f.auth.accessToken()).toBe('refreshed-access-secret');
    expect(f.requests.filter(item => item.url.endsWith('/token'))).toHaveLength(2);
  }, 30000);

  it('finishes the real Fetch body before reporting cancellation after refresh headers', async () => {
    const f = await fixture({ authOptions: { requestTimeoutMs: 5000 } });
    await f.auth.login();
    f.time.now += 3600000;
    const controller = new AbortController();
    let receivedHeaders;
    const headers = new Promise(resolveHeaders => {
      receivedHeaders = resolveHeaders;
    });
    let reply;
    let refreshes = 0;
    const server = createServer((request, response) => {
      request.resume();
      refreshes++;
      reply = response;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"access_token":');
    });
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const implementation = f.fetcher.getMockImplementation();
    f.fetcher.mockImplementation(async (url, init) => {
      if (
        url.endsWith('/token') &&
        new URLSearchParams(init.body).get('grant_type') === 'refresh_token'
      ) {
        const result = await realFetch(`http://127.0.0.1:${server.address().port}/token`, init);
        receivedHeaders();
        return result;
      }
      return implementation(url, init);
    });
    try {
      const renewal = expect(f.auth.accessToken(undefined, controller.signal)).rejects.toThrow(
        'cancelled',
      );
      await headers;
      await new Promise(resolveTurn => setImmediate(resolveTurn));
      controller.abort();
      reply.end(
        '"refreshed-access-secret","refresh_token":"rotated-refresh-secret","token_type":"Bearer","expires_in":3600}',
      );
      await renewal;
      expect((await f.store()).accounts[0].tokens.refreshToken).toBe('rotated-refresh-secret');
      expect(await f.auth.accessToken()).toBe('refreshed-access-secret');
      expect(refreshes).toBe(1);
      await expect(stat(join(f.directory, 'credentials.lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    }
  }, 30000);

  it('keeps a request timeout while a successful refresh body is stalled', async () => {
    const f = await fixture({ authOptions: { requestTimeoutMs: 150 } });
    await f.auth.login();
    f.time.now += 3600000;
    const original = await f.store();
    const controller = new AbortController();
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"access_token":');
    });
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const implementation = f.fetcher.getMockImplementation();
    f.fetcher.mockImplementation(async (url, init) => {
      if (
        url.endsWith('/token') &&
        new URLSearchParams(init.body).get('grant_type') === 'refresh_token'
      ) {
        const result = await realFetch(`http://127.0.0.1:${server.address().port}/token`, init);
        setImmediate(() => controller.abort());
        return result;
      }
      return implementation(url, init);
    });
    try {
      await expect(f.auth.accessToken(undefined, controller.signal)).rejects.toThrow(
        'invalid response',
      );
      expect(await f.store()).toEqual(original);
      await expect(stat(join(f.directory, 'credentials.lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    }
  }, 30000);

  it('cancels a stalled refresh and releases its credential lock before the hook deadline', async () => {
    const f = await fixture();
    await f.auth.login();
    f.time.now += 3600000;
    const original = await f.store();
    const implementation = f.fetcher.getMockImplementation();
    let reachedRefresh;
    const started = new Promise(resolveStarted => {
      reachedRefresh = resolveStarted;
    });
    f.fetcher.mockImplementation((url, init) => {
      if (
        url.endsWith('/token') &&
        new URLSearchParams(init.body).get('grant_type') === 'refresh_token'
      ) {
        reachedRefresh();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      return implementation(url, init);
    });
    const controller = new AbortController();
    const renewal = f.auth.accessToken(undefined, controller.signal);
    await started;
    const abortedAt = Date.now();
    controller.abort(new Error('Private caller abort reason must not escape'));
    await expect(renewal).rejects.toThrow('ChatGPT authentication was cancelled.');
    expect(Date.now() - abortedAt).toBeLessThan(1000);
    await expect(stat(join(f.directory, 'credentials.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await f.store()).toEqual(original);
    f.fetcher.mockImplementation(implementation);
    expect(await f.auth.accessToken()).toBe('refreshed-access-secret');
  }, 30000);

  it('cancels a competing lock wait without deleting the other process lock', async () => {
    const f = await fixture();
    await f.auth.login();
    f.time.now += 3600000;
    const path = join(f.directory, 'credentials.lock');
    await writeFile(path, 'other-process-lock', { mode: 0o600 });
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = f.auth.accessToken(undefined, controller.signal);
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      await expect(pending).rejects.toThrow('ChatGPT authentication was cancelled.');
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(await readFile(path, 'utf8')).toBe('other-process-lock');
    } finally {
      clearTimeout(timer);
    }
  }, 30000);

  it('rejects a pre-cancelled request without acquiring or leaving a credential lock', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.auth.accessToken(undefined, controller.signal)).rejects.toThrow('cancelled');
    await expect(stat(join(f.directory, 'credentials.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('serializes refresh across independent processes and persists rotating tokens once', async () => {
    const f = await fixture();
    await f.auth.login();
    f.time.now += 3590000;
    const audit = join(f.directory, 'requests.jsonl');
    const fixtureEnv = JSON.stringify({
      module: new URL('../dist/src/chatgpt-auth.js', import.meta.url).href,
      directory: f.directory,
      now: f.time.now,
      discovery,
      jwks,
      audit,
    });
    const source = `
      import { appendFile } from 'node:fs/promises';
      const fixture = JSON.parse(process.env.AUDREY_TEST_FIXTURE);
      const { ChatGPTAuth } = await import(fixture.module);
      const auth = new ChatGPTAuth({directory: fixture.directory, now: () => fixture.now,
        fetch: async (url, init) => {
          if (url.endsWith('/openid-configuration')) return new Response(JSON.stringify(fixture.discovery));
          if (url.endsWith('/jwks.json')) return new Response(JSON.stringify(fixture.jwks));
          if (!url.endsWith('/token')) throw new Error('Unexpected request');
          const form = new URLSearchParams(init.body);
          if (form.get('refresh_token') !== 'initial-refresh-secret' || form.has('scope')) throw new Error('Bad refresh grant');
          await appendFile(fixture.audit, 'refresh\\n');
          await new Promise(resolve => setTimeout(resolve, 150));
          return new Response(JSON.stringify({access_token:'refreshed-access-secret',refresh_token:'rotated-refresh-secret',token_type:'Bearer',expires_in:3600}));
        }});
      if (await auth.accessToken() !== 'refreshed-access-secret') throw new Error('Wrong access token');
      process.stdout.write('ok');
    `;
    const spawnOptions = {
      timeout: 25000,
      windowsHide: true,
      env: { ...process.env, AUDREY_TEST_FIXTURE: fixtureEnv },
    };
    const completed = await Promise.all([
      execute(process.execPath, ['--input-type=module', '-e', source], spawnOptions),
      execute(process.execPath, ['--input-type=module', '-e', source], spawnOptions),
    ]);
    expect(completed.map(item => item.stdout)).toEqual(['ok', 'ok']);
    expect(await readFile(audit, 'utf8')).toBe('refresh\n');
    const saved = await f.store();
    expect(saved.accounts[0].tokens.refreshToken).toBe('rotated-refresh-secret');
    expect(saved.accounts[0].scopes).toEqual(grantedScopes.split(' '));
  }, 60000);

  it('honors earliest_refresh_at instead of prematurely rotating an access token', async () => {
    const f = await fixture({
      tokenBody: { earliest_refresh_at: Math.floor((Date.now() + 3600000) / 1000) },
    });
    await f.auth.login();
    f.time.now += 3550000;
    expect(await f.auth.accessToken()).toBe('initial-access-secret');
    expect(f.requests.filter(item => item.url.endsWith('/token'))).toHaveLength(1);
    f.time.now += 100000;
    expect(await f.auth.accessToken()).toBe('refreshed-access-secret');
  }, 30000);

  it('requires replacement refresh tokens and rejects a swapped refresh identity', async () => {
    const f = await fixture();
    await f.auth.login();
    const original = await f.store();
    f.time.now += 3600000;
    f.state.refreshBody.refresh_token = undefined;
    await expect(f.auth.accessToken()).rejects.toThrow('replacement refresh token');
    expect(await f.store()).toEqual(original);
    f.state.refreshBody.refresh_token = 'rotated-refresh-secret';
    f.state.refreshBody.id_token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(f.state.client)
      .setSubject('swapped-subject')
      .setIssuedAt(Math.floor(f.time.now / 1000))
      .setExpirationTime(Math.floor(f.time.now / 1000) + 3600)
      .sign(privateKey);
    await expect(f.auth.accessToken()).rejects.toThrow('identity did not match');
    // The server consumed the old refresh token, so the account is signed out
    // rather than left holding a dead grant.
    const signedOut = await f.store();
    expect(signedOut.accounts[0].tokens).toBeUndefined();
    expect(signedOut.accounts[0].subject).toBe(original.accounts[0].subject);
  }, 30000);

  it('keeps a rotated refresh token when identity verification fails after the exchange', async () => {
    const f = await fixture();
    await f.auth.login();
    f.time.now += 3600000;
    f.state.refreshBody.refresh_token = 'rotated-refresh-secret';
    f.state.refreshBody.id_token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'rotated-key' })
      .setIssuer(issuer)
      .setAudience(f.state.client)
      .setSubject('subject-one')
      .setIssuedAt(Math.floor(f.time.now / 1000))
      .setExpirationTime(Math.floor(f.time.now / 1000) + 3600)
      .sign(privateKey);
    // The key set reload finds no key for the rotated token: a transient
    // verification failure, not a swapped identity.
    f.state.jwks = { keys: [] };
    await expect(f.auth.accessToken()).rejects.toThrow();
    const saved = await f.store();
    expect(saved.accounts[0].tokens.refreshToken).toBe('rotated-refresh-secret');
  }, 30000);

  it('removes a stale credential lock left behind by a process that is gone', async () => {
    const f = await fixture();
    const account = await f.auth.login();
    const path = join(f.directory, 'credentials.lock');
    await writeFile(path, JSON.stringify({ pid: 2147483646, startedAt: Date.now() }), {
      mode: 0o600,
    });
    expect((await f.auth.select(account.accountId)).active).toBe(true);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 180000 }), {
      mode: 0o600,
    });
    expect((await f.auth.select(account.accountId)).active).toBe(true);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30000);

  it('accepts a credential directory beneath a symbolic-linked parent', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'audrey-chatgpt-parent-'));
    directories.push(parent);
    await mkdir(join(parent, 'home'));
    const linkedParent = join(parent, 'home-link');
    await symlink(
      join(parent, 'home'),
      linkedParent,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const f = await fixture({ authOptions: { directory: join(linkedParent, 'auth') } });
    const account = await f.auth.login();
    expect(account.signedIn).toBe(true);
    expect((await stat(join(parent, 'home', 'auth', 'credentials.json'))).isFile()).toBe(true);
    expect((await f.auth.status()).accountId).toBe(account.accountId);
  }, 30000);

  it('clears an invalid renewable session and requires explicit login', async () => {
    const f = await fixture();
    const account = await f.auth.login();
    f.time.now += 3600000;
    f.state.tokenStatus = 400;
    f.state.refreshBody = { error: 'invalid_grant', error_description: 'private-refresh-secret' };
    await expect(f.auth.accessToken()).rejects.toThrow('invalid_grant');
    expect((await f.store()).accounts[0].tokens).toBeUndefined();
    expect((await f.store()).accounts[0].clientId).toBe(account.clientId);
    await expect(f.auth.accessToken()).rejects.toThrow('run audrey auth login');
    expect(f.browser).toHaveBeenCalledTimes(1);
  }, 30000);

  it('reports unconfirmed revocation, clears secrets and preserves the registration and host', async () => {
    const f = await fixture({ revocationStatus: 503 });
    const account = await f.auth.login();
    const host = (await f.store()).hostId;
    expect(await f.auth.logout()).toEqual({ revoked: false });
    expect(f.requests.filter(item => item.url.endsWith('/revoke'))).toHaveLength(3);
    const saved = await f.store();
    expect(saved.hostId).toBe(host);
    expect(saved.accounts[0]).toMatchObject({
      accountId: account.accountId,
      clientId: account.clientId,
      subject: account.subject,
    });
    expect(saved.accounts[0].tokens).toBeUndefined();
    expect(saved.activeAccountId).toBeUndefined();
    expect(await f.auth.status()).toBeNull();
    expect(JSON.stringify(await f.auth.accounts())).not.toContain('secret');
    await expect(f.auth.select(account.accountId)).rejects.toThrow('signed out');
  }, 30000);

  it('serves a still-valid token without waiting on the credential lock', async () => {
    const f = await fixture();
    await f.auth.login();
    await writeFile(join(f.directory, 'credentials.lock'), 'busy', { mode: 0o600 });
    const startedAt = Date.now();
    expect(await f.auth.accessToken()).toBe('initial-access-secret');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(await readFile(join(f.directory, 'credentials.lock'), 'utf8')).toBe('busy');
  }, 30000);

  it('clears credentials on every documented terminal refresh error and keeps them otherwise', async () => {
    for (const code of [
      'invalid_refresh_token',
      'token_expired',
      'refresh_token_expired',
      'refresh_token_invalidated',
      'refresh_token_reused',
    ]) {
      const f = await fixture();
      await f.auth.login();
      f.time.now += 3600000;
      f.state.tokenStatus = 400;
      f.state.refreshBody = { error: code, error_description: 'private-refresh-secret' };
      await expect(f.auth.accessToken()).rejects.toThrow(code);
      expect((await f.store()).accounts[0].tokens).toBeUndefined();
    }
    const kept = await fixture();
    await kept.auth.login();
    kept.time.now += 3600000;
    kept.state.tokenStatus = 400;
    kept.state.refreshBody = { error: 'temporarily_unavailable' };
    await expect(kept.auth.accessToken()).rejects.toThrow('token exchange failed');
    expect((await kept.store()).accounts[0].tokens.refreshToken).toBe('initial-refresh-secret');
  }, 60000);

  it('answers a malformed callback request with 400 and keeps the sign-in alive', async () => {
    const f = await fixture({
      beforeCallback: async auth => {
        const port = Number(new URL(auth.searchParams.get('redirect_uri')).port);
        await new Promise((resolveProbe, rejectProbe) => {
          const socket = connect(port, '127.0.0.1', () => {
            socket.write('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
          });
          let received = '';
          socket.on('data', chunk => {
            received += chunk;
          });
          socket.on('error', rejectProbe);
          socket.on('close', () => {
            if (received.startsWith('HTTP/1.1 400')) resolveProbe();
            else rejectProbe(new Error(`expected 400, got ${received.split('\r\n')[0]}`));
          });
        });
      },
    });
    const account = await f.auth.login();
    expect(account.signedIn).toBe(true);
  }, 30000);

  it('expands a leading ~ in the credential directory', () => {
    expect(new ChatGPTAuth({ directory: '~/.audrey-tilde-test' }).directory).toBe(
      join(homedir(), '.audrey-tilde-test'),
    );
  });

  it('ignores a refresh time later than the token itself can live', async () => {
    const f = await fixture({
      tokenBody: { earliest_refresh_at: Math.floor(Date.now() / 1000) + 10 * 24 * 3600 },
    });
    await f.auth.login();
    f.time.now += 3600000;
    expect(await f.auth.accessToken()).toBe('refreshed-access-secret');
  }, 30000);

  it('reports revoked:false when an access token cannot be revoked remotely', async () => {
    const f = await fixture({
      scopes: 'openid profile email resource.invoke chatgpt.tokens.use.direct',
      tokenBody: { refresh_token: undefined },
    });
    await f.auth.login();
    expect(await f.auth.logout()).toEqual({ revoked: false });
    expect((await f.store()).accounts[0].tokens).toBeUndefined();
  }, 30000);

  it('times out an existing lock without removing it or refreshing concurrently', async () => {
    const f = await fixture({ authOptions: { lockTimeoutMs: 100 } });
    await f.auth.login();
    f.time.now += 3600000;
    await writeFile(join(f.directory, 'credentials.lock'), 'busy', { mode: 0o600 });
    await expect(f.auth.accessToken()).rejects.toThrow('locked by another operation');
    expect(await readFile(join(f.directory, 'credentials.lock'), 'utf8')).toBe('busy');
  }, 30000);

  it('protects credential files and fails closed on symlinked storage', async () => {
    const f = await fixture();
    await f.auth.login();
    const path = join(f.directory, 'credentials.json');
    if (process.platform === 'win32') {
      const source = `$acl=[IO.File]::GetAccessControl('${path.replaceAll("'", "''")}'); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; if (!$acl.AreAccessRulesProtected) { exit 2 }; foreach ($entry in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if ($entry.IdentityReference.Value -ne $sid.Value) { exit 3 } }; [Console]::Out.Write('protected')`;
      const result = await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(source, 'utf16le').toString('base64'),
        ],
        { windowsHide: true },
      );
      expect(result.stdout.trim()).toBe('protected');
    } else {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    }
    expect(resolve(f.directory)).not.toContain('src');
    const aliasDirectory = await mkdtemp(join(tmpdir(), 'audrey-chatgpt-alias-'));
    directories.push(aliasDirectory);
    const alias = join(aliasDirectory, 'linked');
    await symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new ChatGPTAuth({ directory: alias }).accounts()).rejects.toThrow(
      'symbolic links',
    );
  }, 30000);
});
