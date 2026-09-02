import { describe, expect, it } from 'vitest';
import { profileShellCommand, signaturesOverlap } from '../dist/src/shell-command.js';

const isReadOnlyShellCommand = command => profileShellCommand(command).readOnly;
const shellCommandSignatures = command => profileShellCommand(command).signatures;

const READ_ONLY = [
  'git status',
  'git status --short | head -60',
  'git log --oneline -15',
  'git diff --stat | tail -50',
  'git diff CHANGELOG.md .github/workflows/publish.yml',
  'git branch --show-current',
  'git branch -a',
  'git remote -v',
  'git tag -l "v1.*"',
  'git config user.name',
  'git -C B:/projects/claude/audrey rev-parse HEAD',
  'git --no-pager log -1',
  'git stash list',
  'git worktree list',
  'grep -n "export function" src/capsule.ts | head -5',
  'grep -rn "superseded_by" src/recall.ts src/fts.ts | head -20',
  'rg --files | wc -l',
  'ls -la "C:/Users/evela/.audrey/data" | head -20',
  'ls agents/review/ 2>&1',
  'cat README.md',
  'cat "C:/Users/evela/.claude/fable.md"',
  'head -c 400 "$TEMP/pre.err"',
  'tail -30 out.log',
  'wc -l src/*.ts mcp-server/*.ts | sort -n | tail -40',
  'sed -n 1,140p src/preflight.ts',
  "sed -n '/^export/,/^}/p' src/db.ts",
  'find . -iname "*.test.ts" -not -path "*/node_modules/*"',
  'find . -name "*.tmp"',
  'which node && where node',
  'test -f package.json',
  '[ -d dist ]',
  '[[ -f dist/index.js ]] && echo yes',
  'cd B:/projects/claude/audrey && grep -n "zzz" src/capsule.ts',
  'cd "B:/projects/claude/audrey" && (git status; git diff --stat)',
  'echo "---BUILD---"; ls dist | head',
  'pwd',
  'node --version',
  'python --version',
  'npm ls --depth=0',
  'npm view audrey version',
  'npm audit --omit=dev',
  'npm pack --dry-run',
  'npx --version',
  'tsc --noEmit',
  'eslint .',
  'prettier --check "src/**/*.ts"',
  'docker ps -a',
  'docker compose ps',
  'kubectl get pods -n prod',
  'gh pr view 67 --json state',
  'gh pr list --state open',
  'gh api repos/Evilander/Audrey/pulls/67',
  'jq .version package.json',
  "awk -F: '{print $1}' file.txt",
  'sort file.txt | uniq -c',
  'diff a.txt b.txt',
  'du -sh node_modules',
  'df -h',
  'grep foo file > /dev/null 2>&1',
  'grep foo file 2>/dev/null',
  'grep foo file >/dev/null',
  'cat file 2>&1 | grep err',
  'for f in a.md b.md; do echo "=== $f ==="; cat "$f"; echo; done',
  'if grep -q foo file; then echo found; else echo missing; fi',
  'FOO=bar grep "$FOO" file',
  'env | grep PATH',
  'env FOO=bar grep foo file',
  'time grep -r foo src',
  'command -v node',
  'timeout 5 grep -r foo src',
  'ls -la; # list',
  "cat <<'EOF'\nrm -rf /\nEOF",
  'grep "a -> b" file',
  'grep ">" file',
  'echo "$(pwd)"'.replace('$(pwd)', '$HOME'),
  'grep -n "Recommended:\\|Evidence:" src/controller.ts src/autopilot.ts | head -40',
  'ls -la ~/.ssh/ 2>/dev/null; grep -A4 -i "host" ~/.ssh/config 2>/dev/null',
  'tasklist | findstr node',
  '"C:\\Program Files\\Git\\bin\\git.exe" status',
  'git status && echo "---" && git branch --show-current && wc -l src/audrey.ts 2>&1',
];

const SIDE_EFFECT = [
  'rm -rf dist',
  'git push origin master',
  'git commit -m "x"',
  'git checkout -b feature',
  'git branch -D old',
  'git branch newbranch',
  'git tag v1.0.0',
  'git config user.name Tyler',
  'git stash',
  'git stash pop',
  'git reset --hard',
  'git rebase master',
  'git clean -fd',
  'npm test',
  'npm run build',
  'npm run deploy',
  'npm install',
  'npm publish',
  'npm audit fix',
  'npm version patch',
  'npx vitest run --reporter=dot',
  'yarn',
  'pnpm install',
  'node dist/mcp-server/index.js hook --host claude-code',
  "node -e \"require('fs').writeFileSync('x','y')\"",
  'node --input-type=module -e "import fs from \'node:fs\'"',
  'python -c "print(1)"',
  'python scripts/verify.py',
  'python -m build',
  'bash -c "rm -rf /"',
  'sh setup.sh',
  './deploy.sh',
  'pwsh -Command "Remove-Item x"',
  'sed -i "s/a/b/" file',
  'sed -ni "s/a/b/" file',
  "sed -n 's/a/b/w out.txt' file",
  'sed --in-place=.bak "s/a/b/" file',
  'awk \'{print > "out.txt"}\' file',
  'awk \'{ system("rm x") }\' file',
  'find . -name "*.tmp" -delete',
  'find . -name "*.tmp" -exec rm {} \\;',
  'sort -o sorted.txt file',
  'grep foo file > out.txt',
  'grep foo file >> out.txt',
  'grep foo file 2> err.txt',
  'grep foo file &> all.txt',
  'echo hi | tee log.txt',
  'cat file | xargs rm',
  'grep -l foo *.md | xargs sed -i "s/a/b/"',
  'sudo ls /root',
  'eval "$CMD"',
  'exec node server.js',
  'source ./env.sh',
  '. ./env.sh',
  'ls $(cat dirs)',
  'ls `cat dirs`',
  'echo "$(rm -rf x)"',
  'cat <(rm x)',
  'for f in $(ls); do cat "$f"; done',
  'cp a b',
  'mv a b',
  'mkdir -p x',
  'touch x',
  'chmod +x script.sh',
  'curl -sL -o file https://example.com',
  'curl https://example.com',
  'ssh host ls',
  'docker compose up -d --build',
  'docker run -it ubuntu',
  'docker stats',
  'kubectl apply -f x.yaml',
  'kubectl delete pod x',
  'gh pr merge 67 --merge',
  'gh pr create --title x',
  'gh api -X POST repos/x/y/issues -f title=x',
  'gh api repos/x/y/issues -f title=x',
  'cargo build',
  'cargo check',
  'go build ./...',
  'go vet ./...',
  'pip install requests',
  'tsc',
  'tsc -p tsconfig.json',
  'eslint . --fix',
  'prettier --write "src/**/*.ts"',
  'yq -i ".a = 1" file.yaml',
  'date -s "2026-01-01"',
  'kill -9 1234',
  'taskkill /F /IM node.exe',
  'unknown-tool --flag',
  'cd dist && rm index.js',
  'grep foo file && rm file',
  'ls || rm -rf x',
  'ls; rm x',
  'ls\nrm x',
  'git status; git push',
  '',
  '   ',
  'x'.repeat(30_000),
];

describe('shell command classification', () => {
  it.each(READ_ONLY)('treats %j as read-only', command => {
    expect(isReadOnlyShellCommand(command)).toBe(true);
  });

  it.each(SIDE_EFFECT)('treats %j as side-effecting', command => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });

  it('fails closed on non-string input', () => {
    expect(isReadOnlyShellCommand(undefined)).toBe(false);
    expect(isReadOnlyShellCommand(null)).toBe(false);
    expect(isReadOnlyShellCommand(42)).toBe(false);
  });
});

describe('shell command signatures', () => {
  it.each([
    ['git status', ['git status']],
    ['cd B:/x && git status --short | head -5', ['git status']],
    ['npm run deploy', ['npm run deploy']],
    ['npm run deploy -- --prod', ['npm run deploy']],
    ['npm test -- --runInBand', ['npm test']],
    ['npm t', ['npm test']],
    ['npx vitest run --reporter=dot', ['npx vitest']],
    ['npx --yes audrey@1.2.1 greeting', ['npx audrey']],
    ['node -e "console.log(1)"', ['node -e']],
    ['node --input-type=module -e "1"', ['node -e']],
    ['node dist/mcp-server/index.js hook', ['node index.js']],
    ['"C:\\Program Files\\nodejs\\node.exe" scripts/smoke-cli.js', ['node smoke-cli.js']],
    ['python -m build', ['python -m build']],
    ['python scripts/verify-python-package.py', ['python verify-python-package.py']],
    ['gh pr merge 67 --merge', ['gh pr merge']],
    ['docker compose up -d', ['docker compose up']],
    ['grep -n foo src/x.ts | sed -n 1,5p', ['grep']],
    ['npm test 2>&1 | grep FAIL | tail -20', ['npm test']],
    ['grep -n foo src/x.ts && sed -n 1,5p src/x.ts', ['grep', 'sed']],
    ['echo hi; cd x; export A=1; true', []],
    ['FOO=bar npm run lint', ['npm run lint']],
    ['time npm run build && npm test', ['npm run build', 'npm test']],
    ['sudo rm -rf /', ['sudo']],
    ['git push origin master 2>&1 | tail -3', ['git push']],
    ['cat file | xargs rm', ['cat', 'xargs']],
  ])('%j -> %j', (command, expected) => {
    expect(shellCommandSignatures(command)).toEqual(expected);
  });

  it('reports overlap only on a shared signature', () => {
    expect(signaturesOverlap(['git status', 'head'], ['head', 'sed'])).toBe(true);
    expect(signaturesOverlap(['grep'], ['sed'])).toBe(false);
    expect(signaturesOverlap([], ['sed'])).toBe(false);
    expect(
      signaturesOverlap(
        shellCommandSignatures('cd B:/x && npm run deploy'),
        shellCommandSignatures('npm run deploy -- --dry-run'),
      ),
    ).toBe(true);
    expect(
      signaturesOverlap(
        shellCommandSignatures('cd B:/x && grep -n foo src/a.ts'),
        shellCommandSignatures('cd B:/x && sed -n 1,5p src/a.ts'),
      ),
    ).toBe(false);
  });

  it('keeps heredoc bodies out of the verb set', () => {
    const profile = profileShellCommand("cat <<'EOF' | grep x\nrm -rf /\nEOF\nls");
    expect(profile.readOnly).toBe(true);
    expect(profile.signatures).toEqual(['cat', 'ls']);
  });
});
