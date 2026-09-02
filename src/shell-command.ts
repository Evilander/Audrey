/**
 * Shell-command classification for Guard and Autopilot capture.
 *
 * "Bash" is one tool name covering everything from `git status` to
 * `rm -rf`. Guard's exact-fingerprint design assumes a failed action is
 * worth not repeating, and Autopilot's failure capture assumes a non-zero
 * exit is a lesson. Both are false for a read-only probe: grep reports
 * "no match" as exit 1, ls reports a missing path as exit 2, test reports
 * false as 1. Recording those as failures filled the episodic store with
 * salience-0.9 log lines and taught Guard to warn on every later command
 * that merely looked similar.
 *
 * Two questions are answered here, both from the command text alone:
 *
 *   - Can this command have side effects at all? Decided fail-closed: a
 *     command is read-only only when every segment is positively recognised
 *     as such. Command substitution, a redirect to anything but /dev/null,
 *     `sudo`, `xargs`, `eval`, an unknown verb, a git subcommand outside the
 *     read-only list — any of these keeps today's behaviour.
 *   - What does it do? A verb signature ("git status", "npm run deploy",
 *     "node -e") lets a remembered failure be compared with a proposed
 *     action by what they run, not by embedding similarity of their text.
 *     Two commands that share a `cd` prefix and a repo path look nearly
 *     identical to a sentence embedder while doing unrelated things.
 */

export interface ShellCommandProfile {
  /** True only when every segment is positively recognised as read-only. */
  readOnly: boolean;
  /** Sorted, de-duplicated verb signatures such as "git status" or "npm run deploy". */
  signatures: string[];
}

interface Word {
  text: string;
  /** Some part of the word was quoted or escaped, so it is never a keyword. */
  quoted: boolean;
  /**
   * An unquoted `$` expansion or glob: the shell may turn this one word into
   * several, so it can carry a flag or a positional the text does not show.
   */
  expands: boolean;
}

type Token =
  | { kind: 'word'; word: Word }
  | { kind: 'sep'; pipe: boolean }
  | { kind: 'redirect'; op: string }
  | { kind: 'subst' };

// Longest operators first so `&&` is not read as `&` twice.
const SEPARATOR_OPS = ['&&', '||', ';;', '|&', ';', '|', '&', '(', ')'];

// An unquoted backslash escapes only these. Before anything else it stays
// literal, so a Windows path like `B:\projects` keeps its shape. Real bash
// would drop that backslash too; the difference can only make a signature
// less readable, never classify a command as safer than it is.
const ESCAPABLE = new Set([...' \t\n"\'$`\\|&;()<>#*?[]~!{}']);

function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean; expands: boolean }> = [];
  let buffer = '';
  let quoted = false;
  let expands = false;
  let hasWord = false;
  let i = 0;

  function flush(): void {
    if (hasWord) tokens.push({ kind: 'word', word: { text: buffer, quoted, expands } });
    buffer = '';
    quoted = false;
    expands = false;
    hasWord = false;
  }

  function skipBalanced(open: string, close: string): void {
    let depth = 0;
    while (i < command.length) {
      if (command[i] === open) depth++;
      else if (command[i] === close && --depth === 0) {
        i++;
        return;
      }
      i++;
    }
  }

  // Reads one word (a redirect target or heredoc delimiter) honouring quotes.
  // A substitution inside it still runs a command, so it is flagged here too.
  function readWord(): Word | undefined {
    while (i < command.length && (command[i] === ' ' || command[i] === '\t')) i++;
    let text = '';
    let wasQuoted = false;
    let wordExpands = false;
    let found = false;
    while (i < command.length) {
      const ch = command.charAt(i);
      if (ch === "'") {
        const end = command.indexOf("'", i + 1);
        text += command.slice(i + 1, end === -1 ? command.length : end);
        i = end === -1 ? command.length : end + 1;
        wasQuoted = found = true;
        continue;
      }
      if (ch === '"') {
        i++;
        while (i < command.length && command[i] !== '"') {
          const c = command.charAt(i);
          if (c === '\\' && i + 1 < command.length) {
            text += command.charAt(i + 1);
            i += 2;
            continue;
          }
          if (c === '`' || (c === '$' && command[i + 1] === '(')) tokens.push({ kind: 'subst' });
          text += c;
          i++;
        }
        i++;
        wasQuoted = found = true;
        continue;
      }
      if (ch === '\\' && i + 1 < command.length) {
        text += command.charAt(i + 1);
        i += 2;
        wasQuoted = found = true;
        continue;
      }
      if (/[\s;&|<>()]/.test(ch)) break;
      if (ch === '`' || (ch === '$' && command[i + 1] === '(')) tokens.push({ kind: 'subst' });
      if (ch === '$' || ch === '*' || ch === '?' || ch === '[') wordExpands = true;
      text += ch;
      found = true;
      i++;
    }
    return found ? { text, quoted: wasQuoted, expands: wordExpands } : undefined;
  }

  // A heredoc body starts on the line after its operator and ends at a line
  // that is exactly the delimiter. Everything between is data, not commands,
  // except that an unquoted delimiter leaves the body subject to expansion,
  // so a `$(...)` or backtick in it runs.
  function skipHeredocBodies(): void {
    for (const heredoc of pendingHeredocs) {
      while (i < command.length) {
        let end = command.indexOf('\n', i);
        if (end === -1) end = command.length;
        let line = command.slice(i, end).replace(/\r$/, '');
        if (heredoc.stripTabs) line = line.replace(/^\t+/, '');
        i = Math.min(end + 1, command.length);
        if (line === heredoc.delimiter) break;
        if (heredoc.expands && /\$\(|`/.test(line)) tokens.push({ kind: 'subst' });
      }
    }
    pendingHeredocs.length = 0;
  }

  while (i < command.length) {
    const ch = command.charAt(i);
    const next = i + 1 < command.length ? command.charAt(i + 1) : undefined;

    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      buffer += command.slice(i + 1, end === -1 ? command.length : end);
      i = end === -1 ? command.length : end + 1;
      quoted = hasWord = true;
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        const c = command.charAt(i);
        if (c === '\\' && i + 1 < command.length && '$`"\\\n'.includes(command.charAt(i + 1))) {
          buffer += command.charAt(i + 1);
          i += 2;
          continue;
        }
        // Command substitution still expands inside double quotes.
        if (c === '`' || (c === '$' && command[i + 1] === '(')) tokens.push({ kind: 'subst' });
        buffer += c;
        i++;
      }
      i++;
      quoted = hasWord = true;
      continue;
    }

    if (ch === '\\') {
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.has(next)) {
        buffer += next;
        i += 2;
        quoted = hasWord = true;
        continue;
      }
      buffer += ch;
      hasWord = true;
      i++;
      continue;
    }

    if (ch === '\n' || ch === '\r') {
      flush();
      i++;
      if (ch === '\r' && next === '\n') i++;
      if (pendingHeredocs.length > 0) skipHeredocBodies();
      tokens.push({ kind: 'sep', pipe: false });
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      flush();
      i++;
      continue;
    }

    if (ch === '#' && !hasWord) {
      const end = command.indexOf('\n', i);
      i = end === -1 ? command.length : end;
      continue;
    }

    if (ch === '`') {
      flush();
      tokens.push({ kind: 'subst' });
      const end = command.indexOf('`', i + 1);
      i = end === -1 ? command.length : end + 1;
      continue;
    }

    if ((ch === '$' && next === '(') || ((ch === '<' || ch === '>') && next === '(')) {
      flush();
      tokens.push({ kind: 'subst' });
      i++;
      skipBalanced('(', ')');
      continue;
    }

    const fdPrefix = !hasWord && /\d/.test(ch) && (next === '>' || next === '<');
    if (fdPrefix || ch === '<' || ch === '>' || (ch === '&' && next === '>')) {
      flush();
      if (fdPrefix) i++;
      const rest = command.slice(i);
      const heredoc = rest.match(/^<<(-?)(?!<)/);
      if (heredoc) {
        i += heredoc[0].length;
        const delimiter = readWord();
        pendingHeredocs.push({
          delimiter: delimiter?.text ?? '',
          stripTabs: heredoc[1] === '-',
          expands: !delimiter?.quoted,
        });
        continue;
      }
      const op = rest.match(/^(?:<<<|&>>|&>|>>|>\||>&|<&|<>|>|<)/)?.[0] ?? ch;
      i += op.length;
      if (op === '>&' || op === '<&') {
        // Descriptor duplication (`2>&1`, `>&2`) touches no file.
        const dup = command.slice(i).match(/^\s*(?:\d+|-)(?![^\s;&|<>()])/);
        if (dup) {
          i += dup[0].length;
          continue;
        }
      }
      tokens.push({ kind: 'redirect', op: op === '>&' ? '>' : op === '<&' ? '<' : op });
      const target = readWord();
      if (target) tokens.push({ kind: 'word', word: target });
      continue;
    }

    const separator = SEPARATOR_OPS.find(op => command.startsWith(op, i));
    if (separator) {
      flush();
      tokens.push({ kind: 'sep', pipe: separator === '|' || separator === '|&' });
      i += separator.length;
      continue;
    }

    if ((ch === '{' || ch === '}') && !hasWord && (next === undefined || /[\s;&|]/.test(next))) {
      tokens.push({ kind: 'sep', pipe: false });
      i++;
      continue;
    }

    // `$?`, `$$`, `$#` and `$!` expand to exactly one word; anything else
    // the shell may split into several, and a brace inside a word
    // (`f{1,2}.txt`) expands without any glob character at all.
    if (ch === '$' && !/[?$#!]/.test(next ?? '')) expands = true;
    if (ch === '*' || ch === '?' || ch === '[' || ch === '{') expands = true;
    buffer += ch;
    hasWord = true;
    i++;
  }
  flush();
  return tokens;
}

interface Segment {
  words: Word[];
  /** A redirect sends output somewhere other than a discard device. */
  writes: boolean;
  /** The segment reads another segment's output through a pipe. */
  consumer: boolean;
}

const DISCARD_TARGETS = new Set(['/dev/null', 'nul', 'nul:']);

function splitSegments(tokens: Token[]): { segments: Segment[]; substitution: boolean } {
  const result: Segment[] = [];
  let current: Segment = { words: [], writes: false, consumer: false };
  let substitution = false;
  let pendingRedirect: string | undefined;

  function settleRedirect(): void {
    // A redirect that never got a target is treated as a write.
    if (pendingRedirect?.includes('>')) current.writes = true;
    pendingRedirect = undefined;
  }

  for (const token of tokens) {
    if (token.kind === 'subst') {
      substitution = true;
    } else if (token.kind === 'sep') {
      settleRedirect();
      if (current.words.length > 0 || current.writes) result.push(current);
      current = { words: [], writes: false, consumer: token.pipe };
    } else if (token.kind === 'redirect') {
      settleRedirect();
      pendingRedirect = token.op;
    } else if (pendingRedirect) {
      if (pendingRedirect.includes('>') && !DISCARD_TARGETS.has(token.word.text.toLowerCase())) {
        current.writes = true;
      }
      pendingRedirect = undefined;
    } else {
      current.words.push(token.word);
    }
  }
  settleRedirect();
  if (current.words.length > 0 || current.writes) result.push(current);
  return { segments: result, substitution };
}

const KEYWORDS = new Set([
  '!',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'while',
  'until',
  'do',
  'done',
  'esac',
]);

// Wrappers that run another command without side effects of their own.
const TRANSPARENT_PREFIXES = new Set(['time', 'nice', 'nohup', 'builtin', 'command', 'env']);

// Wrappers that run arbitrary or privileged commands: never read-only.
const OPAQUE_PREFIXES = new Set([
  'sudo',
  'doas',
  'runas',
  'exec',
  'eval',
  'xargs',
  'parallel',
  'source',
  '.',
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

// Verbs that say nothing about what a command does.
const TRIVIAL_VERBS = new Set([
  'cd',
  'pushd',
  'popd',
  'echo',
  'printf',
  'true',
  'false',
  ':',
  'pwd',
  'set',
  'shopt',
  'export',
  'unset',
  'local',
  'declare',
  'typeset',
  'readonly',
  'let',
  'sleep',
  'exit',
  'return',
  'break',
  'continue',
  'shift',
  'wait',
  'test',
  '[',
  '[[',
  'clear',
]);

const SIMPLE_READ_ONLY = new Set([
  ...TRIVIAL_VERBS,
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'findstr',
  'ls',
  'dir',
  'tree',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'stat',
  'file',
  'which',
  'where',
  'whereis',
  'type',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'du',
  'df',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'cksum',
  'cut',
  'tr',
  'column',
  'nl',
  'tac',
  'rev',
  'fold',
  'paste',
  'join',
  'comm',
  'strings',
  'hexdump',
  'xxd',
  'od',
  'jq',
  'diff',
  'cmp',
  'seq',
  'expr',
  'bc',
  'uname',
  'whoami',
  'id',
  'groups',
  'printenv',
  'nproc',
  'free',
  'uptime',
  'ps',
  'pgrep',
  'lsof',
  'netstat',
  'ss',
  'tasklist',
  'systeminfo',
  'ver',
  'getconf',
  'locale',
  'tty',
  'dirs',
  'jobs',
  'history',
  'help',
]);

const FIND_WRITE_FLAGS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);

const GIT_READ_ONLY = new Set([
  'status',
  'log',
  'diff',
  'show',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'rev-parse',
  'rev-list',
  'describe',
  'blame',
  'annotate',
  'cat-file',
  'shortlog',
  'name-rev',
  'merge-base',
  'for-each-ref',
  'count-objects',
  'check-ignore',
  'check-attr',
  'check-ref-format',
  'var',
  'version',
  '--version',
  'diff-tree',
  'diff-index',
  'diff-files',
  'show-ref',
  'show-branch',
  'whatchanged',
  'cherry',
  'range-diff',
  'verify-pack',
  'verify-commit',
  'verify-tag',
]);

const GIT_BARE_OPTIONS = new Set([
  '--no-pager',
  '-P',
  '--no-optional-locks',
  '--literal-pathspecs',
]);

const GIT_BRANCH_WRITE_FLAGS = new Set([
  '-d',
  '-D',
  '-m',
  '-M',
  '-c',
  '-C',
  '--delete',
  '--move',
  '--copy',
  '--set-upstream-to',
  '-u',
  '--unset-upstream',
  '--edit-description',
  '-f',
  '--force',
  '--track',
  '--no-track',
]);

const GIT_BRANCH_LIST_FLAGS = new Set([
  '-l',
  '--list',
  '--show-current',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
]);

const GIT_TAG_LIST_FLAGS = new Set(['-l', '--list', '--contains', '--points-at', '-n']);

const GIT_CONFIG_WRITE_FLAGS = new Set([
  '--unset',
  '--unset-all',
  '--add',
  '--replace-all',
  '--edit',
  '-e',
  '--remove-section',
  '--rename-section',
]);

const NPM_READ_ONLY = new Set([
  'ls',
  'list',
  'll',
  'la',
  'view',
  'info',
  'show',
  'v',
  'outdated',
  'explain',
  'why',
  'ping',
  'prefix',
  'root',
  'bin',
  'search',
  's',
  'se',
  'find',
  '--version',
  '-v',
  'whoami',
  'query',
  'sbom',
  'diff',
]);

const NPM_RUN_ALIASES = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_TEST_ALIASES = new Set(['test', 't', 'tst']);
const NPX_BARE_FLAGS = new Set(['-y', '--yes', '--no-install', '--no']);
const NPX_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call']);

const DOCKER_READ_ONLY = new Set([
  'ps',
  'images',
  'inspect',
  'logs',
  'version',
  'info',
  'top',
  'port',
  'diff',
  'history',
  'search',
  '--version',
]);
const DOCKER_GROUPS = new Set([
  'compose',
  'container',
  'image',
  'volume',
  'network',
  'system',
  'context',
  'buildx',
  'manifest',
]);
const DOCKER_COMPOSE_VALUE_OPTIONS = new Set([
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--project-directory',
  '--env-file',
  '--profile',
  '--progress',
  '--ansi',
  '--parallel',
]);
const DOCKER_GROUP_READ_ONLY = new Set([
  'ls',
  'list',
  'inspect',
  'logs',
  'ps',
  'top',
  'port',
  'df',
  'config',
  'version',
  'images',
  'info',
  'show',
]);

const KUBECTL_READ_ONLY = new Set([
  'get',
  'describe',
  'logs',
  'version',
  'explain',
  'api-resources',
  'api-versions',
  'top',
  'cluster-info',
  'diff',
  'events',
]);
const KUBECTL_CONFIG_READ_ONLY = new Set([
  'view',
  'current-context',
  'get-contexts',
  'get-clusters',
  'get-users',
]);

const GH_READ_ONLY = new Set([
  'pr view',
  'pr list',
  'pr status',
  'pr checks',
  'pr diff',
  'issue view',
  'issue list',
  'issue status',
  'repo view',
  'repo list',
  'run view',
  'run list',
  'run watch',
  'release view',
  'release list',
  'auth status',
  'workflow list',
  'workflow view',
  'label list',
  'cache list',
  'gist list',
  'gist view',
  'config get',
  'config list',
  'extension list',
  'secret list',
  'variable list',
  'ssh-key list',
  'gpg-key list',
  'codespace list',
  'search repos',
  'search issues',
  'search prs',
  'search code',
  'search commits',
]);

const PIP_READ_ONLY = new Set([
  'list',
  'show',
  'freeze',
  'check',
  '--version',
  '-V',
  'debug',
  'index',
]);
const CARGO_READ_ONLY = new Set([
  '--version',
  '-V',
  'metadata',
  'tree',
  'search',
  'pkgid',
  'locate-project',
  'read-manifest',
  'verify-project',
]);
const GO_READ_ONLY = new Set(['version', 'env', 'list', 'doc']);
const DOTNET_READ_ONLY = new Set(['--version', '--list-sdks', '--list-runtimes', '--info']);

const INTERPRETERS = new Set([
  'node',
  'nodejs',
  'python',
  'python3',
  'py',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'bash',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'tsx',
  'ts-node',
]);
const INTERPRETER_EVAL_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-c',
  '-C',
  '-r',
  '-Command',
  '-command',
]);

const VERSION_FLAGS = new Set(['--version', '-v', '-V', '-version', '--help', '-h']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell']);
const SHELL_VERSION_FLAGS = new Set(['--version', '-Version', '--help']);

// Verbs that a collapsed newline could hide inside another command's
// argument list. Used only when the caller says the text was flattened.
const HIDDEN_SIDE_EFFECT_VERBS = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'dd',
  'tee',
  'xargs',
  'sudo',
  'git',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'node',
  'python',
  'python3',
  'py',
  'pip',
  'pip3',
  'docker',
  'kubectl',
  'gh',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'chmod',
  'chown',
  'kill',
  'killall',
  'taskkill',
  'mkdir',
  'touch',
  'ln',
  'truncate',
  'install',
  'sed',
  'awk',
  'bash',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'cmd',
  'eval',
  'exec',
  'source',
  'alias',
  'hash',
  'enable',
  'trap',
  'export',
  'declare',
  'typeset',
  'let',
  'readonly',
  'read',
  'mapfile',
  'readarray',
  'printf',
  'env',
]);

export interface ShellProfileOptions {
  /**
   * The text had its newlines collapsed to spaces before it was stored
   * (Autopilot compacts failure records). A verb that began a later line
   * now looks like an argument, so any unquoted argument naming a
   * side-effecting verb disqualifies the command.
   */
  flattened?: boolean;
}

function normalizeVerb(word: Word): string {
  const base = word.text.split(/[\\/]/).pop() ?? word.text;
  return base.replace(/\.(?:exe|cmd|bat|com)$/i, '').toLowerCase();
}

function isFlag(arg: string): boolean {
  return arg.startsWith('-');
}

function positional(args: string[]): string[] {
  return args.filter(arg => !isFlag(arg));
}

function scriptName(arg: string): string {
  return (arg.split(/[\\/]/).pop() ?? arg).toLowerCase();
}

// `audrey@1.2.1` -> `audrey`, `@scope/pkg@1.0.0` -> `@scope/pkg`.
function stripPackageVersion(arg: string): string {
  const at = arg.lastIndexOf('@');
  return at > 0 ? arg.slice(0, at) : arg;
}

// Only a directory change and pager/lock suppression are accepted before
// the subcommand. `-c diff.external=./x` or `--exec-path=/x` would make a
// read-only subcommand run a program, so any other leading option fails
// closed.
function gitArgs(args: string[]): string[] | undefined {
  const rest = [...args];
  for (;;) {
    const arg = rest[0];
    if (arg === undefined) break;
    if (arg === '-C') rest.splice(0, 2);
    else if (GIT_BARE_OPTIONS.has(arg)) rest.shift();
    else if (arg.startsWith('-')) return undefined;
    else break;
  }
  return rest;
}

function gitIsReadOnly(sub: string, rest: string[]): boolean {
  // `--output=<path>` makes log, diff, show and their kind write a file.
  if (rest.some(arg => /^--output(?:=|$)/.test(arg))) return false;
  if (GIT_READ_ONLY.has(sub)) return true;
  switch (sub) {
    case 'grep':
      // `-O` opens the matches in a pager or editor.
      return (
        !usesShortFlag(rest, 'O') && !rest.some(arg => arg.startsWith('--open-files-in-pager'))
      );
    case 'fsck':
      // `--lost-found` writes recovered objects under .git/lost-found.
      return !rest.some(arg => arg.startsWith('--lost-found'));
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show';
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show';
    case 'worktree':
      return rest[0] === 'list';
    case 'submodule':
      return rest[0] === 'status' || rest[0] === 'summary';
    case 'notes':
      return rest[0] === 'list' || rest[0] === 'show';
    case 'symbolic-ref':
      return (
        positional(rest).length <= 1 &&
        !usesShortFlag(rest, 'd') &&
        !rest.some(arg => arg.startsWith('--delete'))
      );
    case 'branch':
      if (usesShortFlag(rest, 'dDmMcCuf') || rest.some(arg => GIT_BRANCH_WRITE_FLAGS.has(arg))) {
        return false;
      }
      return positional(rest).length === 0 || rest.some(arg => GIT_BRANCH_LIST_FLAGS.has(arg));
    case 'remote':
      return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url';
    case 'tag':
      if (usesShortFlag(rest, 'df') || rest.some(arg => arg === '--delete' || arg === '--force')) {
        return false;
      }
      return (
        positional(rest).length === 0 ||
        rest.some(arg => GIT_TAG_LIST_FLAGS.has(arg) || /^-n\d*$/.test(arg))
      );
    case 'config':
      if (usesShortFlag(rest, 'e') || rest.some(arg => GIT_CONFIG_WRITE_FLAGS.has(arg))) {
        return false;
      }
      // `git config user.name` reads; `git config user.name Tyler` writes.
      return positional(rest).length <= 1;
    default:
      return false;
  }
}

interface VerbProfile {
  readOnly: boolean;
  signature?: string;
}

function npmProfile(verb: string, args: string[]): VerbProfile {
  const sub = args[0];
  // Bare `npm` prints usage; bare `yarn` and `pnpm` install.
  if (sub === undefined) return { readOnly: verb === 'npm', signature: verb };
  if (NPM_RUN_ALIASES.has(sub)) {
    const script = positional(args.slice(1))[0];
    return { readOnly: false, signature: script ? `${verb} run ${script}` : `${verb} run` };
  }
  if (NPM_TEST_ALIASES.has(sub)) return { readOnly: false, signature: `${verb} test` };
  if (sub === 'config') {
    return {
      readOnly: args[1] === 'get' || args[1] === 'list' || args[1] === 'ls',
      signature: `${verb} config`,
    };
  }
  if (sub === 'audit') return { readOnly: !args.includes('fix'), signature: `${verb} audit` };
  if (sub === 'pack') return { readOnly: args.includes('--dry-run'), signature: `${verb} pack` };
  if (sub === 'version') {
    return { readOnly: positional(args).length === 1, signature: `${verb} version` };
  }
  if (sub === 'dist-tag' || sub === 'owner') {
    return { readOnly: args[1] === 'ls', signature: `${verb} ${sub}` };
  }
  return { readOnly: NPM_READ_ONLY.has(sub), signature: `${verb} ${sub}` };
}

function npxProfile(args: string[]): VerbProfile {
  if (args.length === 1 && VERSION_FLAGS.has(args[0] ?? ''))
    return { readOnly: true, signature: 'npx' };
  const rest = [...args];
  for (;;) {
    const arg = rest[0];
    if (arg === undefined) break;
    if (NPX_VALUE_FLAGS.has(arg)) rest.splice(0, 2);
    else if (NPX_BARE_FLAGS.has(arg)) rest.shift();
    else break;
  }
  const target = positional(rest)[0];
  return {
    readOnly: false,
    signature: target ? `npx ${stripPackageVersion(target).toLowerCase()}` : 'npx',
  };
}

// An interpreter is read-only only when asked for its version or help. A
// syntax-check flag is not enough: `node --check -r ./x.js file` still loads
// x.js, and bun ignores `--check` altogether and runs the file.
function interpreterProfile(verb: string, args: string[]): VerbProfile {
  if (args.length === 0) return { readOnly: false, signature: verb };
  // For a shell, `-v` and `-h` are runtime options, not version queries.
  const versionFlags = SHELLS.has(verb) ? SHELL_VERSION_FLAGS : VERSION_FLAGS;
  if (args.length === 1 && versionFlags.has(args[0] ?? '')) {
    return { readOnly: true, signature: verb };
  }
  const isNode = verb === 'node' || verb === 'nodejs';
  if (args.includes('--check') || (isNode && args.includes('-c'))) {
    return { readOnly: false, signature: `${verb} --check` };
  }
  if (args.some(arg => INTERPRETER_EVAL_FLAGS.has(arg) && !(isNode && arg === '-c'))) {
    return { readOnly: false, signature: `${verb} -e` };
  }
  const moduleIndex = args.indexOf('-m');
  const moduleName = moduleIndex === -1 ? undefined : args[moduleIndex + 1];
  if (moduleName) return { readOnly: false, signature: `${verb} -m ${moduleName.toLowerCase()}` };
  const script = positional(args)[0];
  return { readOnly: false, signature: script ? `${verb} ${scriptName(script)}` : verb };
}

function dockerProfile(args: string[]): VerbProfile {
  const sub = args[0];
  if (!sub) return { readOnly: false, signature: 'docker' };
  if (DOCKER_GROUPS.has(sub)) {
    // `compose` takes its own options before the nested subcommand. Only
    // the options known to take a value are skipped with their value, since
    // `--progress ps down` makes docker read "ps" as the value and run
    // `down`; any option this table does not know fails closed.
    const rest = args.slice(1);
    while (sub === 'compose' && rest[0]?.startsWith('-')) {
      const option = rest[0];
      if (DOCKER_COMPOSE_VALUE_OPTIONS.has(option)) rest.splice(0, 2);
      else if (
        /^--(?:file|project-name|project-directory|env-file|profile|progress|ansi|parallel)=/.test(
          option,
        )
      )
        rest.shift();
      else if (option === '--dry-run' || option === '--compatibility') rest.shift();
      else return { readOnly: false, signature: 'docker compose' };
    }
    const nested = rest[0];
    // `compose config -o <file>` writes the resolved manifest.
    const writesOutput = usesShortFlag(rest, 'o') || rest.some(arg => arg.startsWith('--output'));
    return {
      readOnly: nested !== undefined && DOCKER_GROUP_READ_ONLY.has(nested) && !writesOutput,
      signature: nested ? `docker ${sub} ${nested}` : `docker ${sub}`,
    };
  }
  if (sub === 'stats') return { readOnly: args.includes('--no-stream'), signature: 'docker stats' };
  return { readOnly: DOCKER_READ_ONLY.has(sub), signature: `docker ${sub}` };
}

function kubectlProfile(args: string[]): VerbProfile {
  const sub = args[0];
  if (!sub) return { readOnly: false, signature: 'kubectl' };
  if (sub === 'config') {
    return { readOnly: KUBECTL_CONFIG_READ_ONLY.has(args[1] ?? ''), signature: 'kubectl config' };
  }
  if (sub === 'auth') return { readOnly: args[1] === 'can-i', signature: 'kubectl auth' };
  return { readOnly: KUBECTL_READ_ONLY.has(sub), signature: `kubectl ${sub}` };
}

function ghProfile(args: string[]): VerbProfile {
  const sub = args[0];
  if (!sub) return { readOnly: false, signature: 'gh' };
  if (sub === '--version' || sub === 'status') return { readOnly: true, signature: `gh ${sub}` };
  // `--web` opens a browser; `--hostname` sends the token somewhere else.
  const opensBrowser = usesShortFlag(args, 'w') || args.some(arg => arg.startsWith('--web'));
  if (sub === 'api') {
    // Only a plain GET with no request body: `-X`, `--method`, `-f`, `-F`,
    // `--input` in any spelling, glued or clustered, means a write.
    const readOnly = !args.some(
      arg =>
        /^-[^-]*[XfF]/.test(arg) ||
        arg.startsWith('--method') ||
        arg.startsWith('--field') ||
        arg.startsWith('--raw-field') ||
        arg.startsWith('--input') ||
        arg.startsWith('--hostname'),
    );
    return { readOnly, signature: 'gh api' };
  }
  const pair = `${sub} ${args[1] ?? ''}`.trim();
  return { readOnly: !opensBrowser && GH_READ_ONLY.has(pair), signature: `gh ${pair}` };
}

// Variables whose assignment cannot change what a later command does. The
// list is short on purpose: PATH, HOME, GIT_EXTERNAL_DIFF, GIT_CONFIG_*,
// NODE_OPTIONS, LD_PRELOAD, LESSOPEN and their kind all make a read-only
// verb run something else, and enumerating them is a losing game.
const HARMLESS_VARIABLES = new Set([
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'TERM',
  'COLUMNS',
  'LINES',
  'NO_COLOR',
  'FORCE_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'CI',
  'MSYS_NO_PATHCONV',
  'MSYS2_ARG_CONV_EXCL',
  'GIT_TERMINAL_PROMPT',
  'GIT_OPTIONAL_LOCKS',
  'NODE_NO_WARNINGS',
  'PYTHONIOENCODING',
  'PYTHONUTF8',
  'PYTHONDONTWRITEBYTECODE',
]);

function assignmentIsHarmless(text: string): boolean {
  const name = text.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
  return name !== undefined && HARMLESS_VARIABLES.has(name);
}

// A verb given by path is only trusted where the operating system keeps its
// own binaries. Anything under a home, temp, or project directory could be a
// file named `grep` that does something else.
const TRUSTED_BIN_DIRS = [
  '/usr/bin/',
  '/bin/',
  '/usr/local/bin/',
  '/usr/sbin/',
  '/sbin/',
  '/opt/homebrew/bin/',
  '/mingw64/bin/',
  '/usr/lib/git-core/',
  // System32 is deliberately absent: its sort.exe, find.exe and tree.exe
  // share names with the GNU tools but take slash-style switches the rules
  // here do not model (`sort.exe in /O out` writes a file).
  'c:/program files/',
  'c:/program files (x86)/',
  '/c/program files/',
  '/c/program files (x86)/',
];

function inTrustedBinDir(text: string): boolean {
  const normalized = text.replace(/\\/g, '/').toLowerCase();
  // `/usr/bin/../../tmp/evil/grep` starts with a trusted prefix and lands
  // anywhere at all: a parent segment or a doubled slash disqualifies it.
  const segments = normalized.split('/');
  if (segments.some((segment, index) => segment === '..' || (segment === '' && index > 0))) {
    return false;
  }
  return TRUSTED_BIN_DIRS.some(dir => normalized.startsWith(dir));
}

// sed is read-only only for scripts built from addresses and printing,
// deleting, holding, substituting and transliterating commands. `w`
// writes a file, `e` runs a command, `r` and `-f` read files the check
// cannot see, and `-i` edits in place; none of those pass.
const SED_FLAGS = new Set([
  '-n',
  '--quiet',
  '--silent',
  '-E',
  '-r',
  '--regexp-extended',
  '-z',
  '--null-data',
  '-u',
  '--unbuffered',
  '-s',
  '--separate',
  '--posix',
  '--debug',
  '--sandbox',
  '--version',
  '--help',
]);
const SED_ADDRESS = String.raw`(?:\d+|\$|\/(?:\\.|[^/\\])*\/)`;
const SED_RANGE = `${SED_ADDRESS}(?:,(?:${SED_ADDRESS}|\\+\\d+|~\\d+))?`;
// Braces group commands (`/x/{p;q}`); a `{` may follow the address and a
// `}` may end a command. Inside a regex address they are ordinary text.
const SED_SIMPLE = new RegExp(
  `^(?:${SED_RANGE})?!?\\s*\\{?\\s*(?:[pPl=DdnNhHgGx]|[qQ]\\d*|l\\s*\\d+)?\\s*\\}?$`,
);
const SED_TRANSFORM = new RegExp(`^(?:${SED_RANGE})?!?\\s*\\{?\\s*([sy])(.)`);

function sedScriptIsReadOnly(script: string): boolean {
  return script.split(/[;\n]/).every(command => {
    const text = command.trim();
    if (SED_SIMPLE.test(text)) return true;
    const transform = text.match(SED_TRANSFORM);
    if (!transform) return false;
    const [prefix, kind, delimiter] = [transform[0], transform[1], transform[2] ?? ''];
    let body = text.slice(prefix.length);
    // Consume the pattern and the replacement, each closed by the delimiter.
    for (let closed = 0; closed < 2;) {
      if (body.length === 0) return false;
      if (body.startsWith('\\')) body = body.slice(2);
      else if (body.startsWith(delimiter)) {
        body = body.slice(1);
        closed++;
      } else body = body.slice(1);
    }
    return kind === 'y' ? /^\s*\}?$/.test(body) : /^[gpImM0-9]*\s*\}?$/.test(body);
  });
}

function sedIsReadOnly(args: string[]): boolean {
  const scripts: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      files.push(...args.slice(i + 1));
      break;
    }
    if (arg === '-e' || arg === '--expression' || /^-[nErzus]*e$/.test(arg)) {
      const script = args[++i];
      if (script === undefined) return false;
      scripts.push(script);
      continue;
    }
    if (arg.startsWith('--expression=')) {
      scripts.push(arg.slice('--expression='.length));
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (SED_FLAGS.has(arg) || /^-[nErzus]+$/.test(arg)) continue;
      if (arg === '-l' || arg.startsWith('--line-length')) {
        if (arg === '-l') i++;
        continue;
      }
      return false;
    }
    files.push(arg);
  }
  if (scripts.length === 0) {
    const first = files.shift();
    if (first === undefined) return args.length > 0;
    scripts.push(first);
  }
  return scripts.every(sedScriptIsReadOnly);
}

// GNU-style short options cluster and glue their values: `-o file`,
// `-ofile` and `-nofile` all set `o`. A single-dash argument containing one
// of the letters anywhere is treated as setting it; over-matching (`-k2o`)
// only fails closed.
function usesShortFlag(args: string[], letters: string): boolean {
  const pattern = new RegExp(`^-[^-]*[${letters}]`);
  return args.some(arg => pattern.test(arg));
}

function subcommandProfile(verb: string, args: string[], readOnlySet: Set<string>): VerbProfile {
  const sub = args[0];
  return {
    readOnly: sub !== undefined && readOnlySet.has(sub),
    signature: sub ? `${verb} ${sub}` : verb,
  };
}

function profileVerb(verb: string, args: string[]): VerbProfile {
  switch (verb) {
    case 'sed':
      return { readOnly: sedIsReadOnly(args), signature: 'sed' };
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk':
      // A program file cannot be inspected; inline programs must not
      // redirect, pipe, or call system().
      return {
        readOnly:
          !usesShortFlag(args, 'fE') &&
          !args.some(
            arg =>
              arg.startsWith('--file') ||
              arg.startsWith('--exec') ||
              arg.includes('>') ||
              arg.includes('|') ||
              arg.includes('system'),
          ),
        signature: 'awk',
      };
    case 'rg':
      // `--pre <command>` runs a preprocessor over every file.
      return { readOnly: !args.some(arg => arg.startsWith('--pre')), signature: 'rg' };
    case 'find':
      return { readOnly: !args.some(arg => FIND_WRITE_FLAGS.has(arg)), signature: 'find' };
    case 'sort':
      return {
        readOnly:
          !usesShortFlag(args, 'o') &&
          !args.some(
            arg =>
              arg.startsWith('--output') ||
              arg.startsWith('--compress-program') ||
              // Windows' own sort.exe spells its output switch /O.
              /^\/[oO]/.test(arg),
          ),
        signature: 'sort',
      };
    case 'file':
      return {
        readOnly: !usesShortFlag(args, 'C') && !args.some(arg => arg.startsWith('--compile')),
        signature: 'file',
      };
    case 'tree':
      return { readOnly: !usesShortFlag(args, 'o'), signature: 'tree' };
    case 'xxd':
      // A second positional is an output file.
      return { readOnly: positional(args).length <= 1, signature: 'xxd' };
    case 'less':
    case 'more':
      // `-o` logs the input to a file; a `+` command can run anything.
      return {
        readOnly:
          !usesShortFlag(args, 'oO') &&
          !args.some(arg => /^--log-file/i.test(arg) || arg.startsWith('+')),
        signature: verb,
      };
    case 'printf':
      // `printf -v PATH ...` assigns a variable later commands resolve through.
      return { readOnly: !usesShortFlag(args, 'v'), signature: undefined };
    case 'history':
      // `-w` and `-a` write the history list to a file.
      return { readOnly: !usesShortFlag(args, 'wa'), signature: undefined };
    case 'jobs':
      // `jobs -x command` runs the command with job ids substituted.
      return { readOnly: !usesShortFlag(args, 'x'), signature: undefined };
    case 'alias':
      // Defining an alias rewrites what a later line's verb means.
      return { readOnly: args.every(arg => arg === '-p'), signature: undefined };
    case 'export':
    case 'declare':
    case 'typeset':
    case 'readonly':
    case 'local':
    case 'let':
      return {
        readOnly: args.every(arg => !ASSIGNMENT.test(arg) || assignmentIsHarmless(arg)),
        signature: undefined,
      };
    case 'uniq':
      return { readOnly: positional(args).length <= 1, signature: 'uniq' };
    case 'yq':
      return {
        readOnly: !usesShortFlag(args, 'i') && !args.some(arg => arg.startsWith('--inplace')),
        signature: 'yq',
      };
    case 'date':
      return {
        readOnly: !usesShortFlag(args, 's') && !args.some(arg => arg.startsWith('--set')),
        signature: 'date',
      };
    case 'hostname':
      return { readOnly: positional(args).length === 0, signature: 'hostname' };
    case 'env':
      return { readOnly: args.every(isFlag), signature: 'env' };
    case 'git': {
      const rest = gitArgs(args);
      const sub = rest?.[0];
      if (!rest || !sub) return { readOnly: false, signature: 'git' };
      return { readOnly: gitIsReadOnly(sub, rest.slice(1)), signature: `git ${sub.toLowerCase()}` };
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return npmProfile(verb, args);
    case 'npx':
      return npxProfile(args);
    case 'tsc':
      return {
        readOnly:
          args.some(arg => arg === '--noEmit' || VERSION_FLAGS.has(arg)) &&
          !usesShortFlag(args, 'b') &&
          !args.some(arg => arg.startsWith('--build')),
        signature: 'tsc',
      };
    case 'docker':
      return dockerProfile(args);
    case 'kubectl':
      return kubectlProfile(args);
    case 'gh':
      return ghProfile(args);
    case 'cargo':
      return subcommandProfile(verb, args, CARGO_READ_ONLY);
    case 'go':
      // `go env -w` writes the user's Go configuration.
      if (args[0] === 'env' && usesShortFlag(args, 'wu')) {
        return { readOnly: false, signature: 'go env' };
      }
      return subcommandProfile(verb, args, GO_READ_ONLY);
    case 'pip':
    case 'pip3':
      return subcommandProfile('pip', args, PIP_READ_ONLY);
    case 'dotnet':
      return subcommandProfile(verb, args, DOTNET_READ_ONLY);
    case 'java':
      return { readOnly: args.length === 1 && VERSION_FLAGS.has(args[0] ?? ''), signature: 'java' };
    case 'vitest':
    case 'jest':
    case 'mocha':
    case 'pytest': {
      const target = positional(args)[0];
      return { readOnly: false, signature: target ? `${verb} ${target.toLowerCase()}` : verb };
    }
    default:
      if (INTERPRETERS.has(verb)) return interpreterProfile(verb, args);
      if (SIMPLE_READ_ONLY.has(verb)) {
        return { readOnly: true, signature: TRIVIAL_VERBS.has(verb) ? undefined : verb };
      }
      return { readOnly: false, signature: verb };
  }
}

function profileSegment(segment: Segment, options: ShellProfileOptions): VerbProfile {
  const words = [...segment.words];
  let readOnly = !segment.writes;
  if (
    options.flattened &&
    words
      .slice(1)
      .some(
        word =>
          !word.quoted &&
          (HIDDEN_SIDE_EFFECT_VERBS.has(normalizeVerb(word)) ||
            (ASSIGNMENT.test(word.text) && !assignmentIsHarmless(word.text))),
      )
  ) {
    readOnly = false;
  }

  // Peel shell keywords, leading assignments, and transparent wrappers until
  // the verb that actually runs is at the front. An assignment is peeled
  // for signature purposes but keeps its verdict: `PATH=/x grep` and
  // `GIT_EXTERNAL_DIFF=./x git diff` both run something other than the verb.
  const peelAssignment = (word: Word): void => {
    if (!assignmentIsHarmless(word.text)) readOnly = false;
    words.shift();
  };
  for (;;) {
    const first = words[0];
    if (!first) return { readOnly };
    if (!first.quoted && KEYWORDS.has(first.text)) {
      words.shift();
      continue;
    }
    // `for f in a b c`, `case $x in`: the remaining words are data.
    if (!first.quoted && ['for', 'case', 'select', 'function'].includes(first.text)) {
      return { readOnly };
    }
    if (!first.quoted && ASSIGNMENT.test(first.text)) {
      peelAssignment(first);
      continue;
    }
    // A word given by path runs whatever sits at that path, whether it is
    // the verb or a wrapper in front of it. Only the system's own binary
    // directories are trusted to hold what the name says.
    if (/[\\/]/.test(first.text) && !inTrustedBinDir(first.text)) readOnly = false;
    const verb = normalizeVerb(first);
    if (OPAQUE_PREFIXES.has(verb)) return { readOnly: false, signature: verb };
    if (verb === 'command' && (words[1]?.text === '-v' || words[1]?.text === '-V')) {
      return { readOnly, signature: 'command -v' };
    }
    if (verb === 'timeout') {
      words.splice(0, 2);
      continue;
    }
    if (TRANSPARENT_PREFIXES.has(verb) && words.length > 1) {
      words.shift();
      while (words[0] && !words[0].quoted && ASSIGNMENT.test(words[0].text)) {
        peelAssignment(words[0]);
      }
      continue;
    }
    break;
  }

  const head = words[0];
  if (!head) return { readOnly };
  const verb = normalizeVerb(head);
  // For a verb whose verdict depends on its flags or how many operands it
  // gets, an argument the shell may expand into several words (`$OPTS`,
  // `*.txt`) could supply the flag or the second operand the text does not
  // show: `sort $OPTS f`, `uniq *.txt`, `git config $ARGS`. Pure readers
  // such as grep, cat and ls keep their globs.
  if (FLAG_SENSITIVE_VERBS.has(verb) && words.slice(1).some(word => word.expands)) {
    readOnly = false;
  }
  const profile = profileVerb(
    verb,
    words.slice(1).map(word => word.text),
  );
  return { readOnly: readOnly && profile.readOnly, signature: profile.signature };
}

const FLAG_SENSITIVE_VERBS = new Set([
  'sort',
  'sed',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'tree',
  'file',
  'less',
  'more',
  'xxd',
  'uniq',
  'find',
  'rg',
  'git',
  'gh',
  'docker',
  'kubectl',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'go',
  'cargo',
  'pip',
  'pip3',
  'dotnet',
  'tsc',
  'date',
  'hostname',
  'yq',
  'printf',
  'alias',
  'export',
  'declare',
  'typeset',
  'readonly',
  'local',
  'let',
]);

// Read-only verbs that, after a pipe, only shape another command's output.
// `npm test | grep FAIL` is about npm test; the grep is not what it does.
const OUTPUT_FILTERS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'findstr',
  'head',
  'tail',
  'sort',
  'uniq',
  'wc',
  'cut',
  'tr',
  'sed',
  'awk',
  'cat',
  'less',
  'more',
  'column',
  'nl',
  'tac',
  'rev',
  'fold',
  'jq',
  'strings',
  'xxd',
  'hexdump',
  'od',
]);

const MAX_COMMAND_CHARS = 20_000;

/**
 * Classifies a shell command. Empty or over-long input counts as an unknown,
 * side-effecting command.
 */
export function profileShellCommand(
  command: string,
  options: ShellProfileOptions = {},
): ShellCommandProfile {
  if (
    typeof command !== 'string' ||
    command.trim().length === 0 ||
    command.length > MAX_COMMAND_CHARS
  ) {
    return { readOnly: false, signatures: [] };
  }
  // Bash removes a backslash-newline before it reads anything else, so `$\`
  // followed by a newline and `(` is a substitution. Do the same first.
  const parsed = splitSegments(tokenize(command.replace(/\\\r?\n/g, '')));
  let readOnly = !parsed.substitution && parsed.segments.length > 0;
  const signatures = new Set<string>();
  for (const segment of parsed.segments) {
    const profile = profileSegment(segment, options);
    if (!profile.readOnly) readOnly = false;
    if (!profile.signature) continue;
    if (segment.consumer && OUTPUT_FILTERS.has(profile.signature)) continue;
    signatures.add(profile.signature);
  }
  return { readOnly, signatures: [...signatures].sort() };
}

/**
 * Recovers the command from one of Autopilot's failure records, whose
 * content reads "Tool failure: Bash failed while attempting: input_chars=N
 * command=<command>. Error: <summary>". Undefined when the record is not
 * shaped that way (a non-shell tool, or a hand-written memory).
 */
export function commandFromFailureRecord(content: string): string | undefined {
  return content.match(/\bcommand=([\s\S]*?)(?:\. Error: |$)/)?.[1];
}

export function signaturesOverlap(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = new Set(a);
  for (const signature of b) if (left.has(signature)) return true;
  return false;
}
