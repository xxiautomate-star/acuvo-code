import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeVerification } from '../lib/verification-command.mjs';

const yes = (c) => assert.equal(looksLikeVerification(c), true, `should COUNT as verification: ${c}`);
const no = (c) => assert.equal(looksLikeVerification(c), false, `must NOT end a session: ${c}`);

test('⭐⭐⭐ the commands that actually ended sessions early do NOT verify', () => {
  /**
   * These are lifted from the Terminal-Bench transcripts where the loop stopped
   * at `verified` after four rounds. Each exits 0, and each was treated as proof
   * the task was finished. One session closed on the sentence "R is not
   * installed. Let me check what's available and install R."
   */
  no('which R');
  no('ls -la');
  no('cat setup.py');
  no('pip list');
  no('pwd');
  no('echo hello');
  no('grep -r TODO .');
  no('find . -name "*.py"');
  no('mkdir -p build');
  no('git status');
});

test('⭐⭐ a real check still stops the session', () => {
  yes('pytest');
  yes('pytest -q tests/');
  yes('python -m pytest');
  yes('npm test');
  yes('npx vitest run');
  yes('node --test test/foo.test.mjs');
  yes('cargo test');
  yes('go test ./...');
  yes('make');
  yes('tsc --noEmit');
  yes('CI=1 pytest');
});

test('⚠️⚠️ installing is not checking', () => {
  /**
   * The commonest false positive in the transcripts: the agent installs a
   * dependency, it exits 0, and the loop calls the job done before the work
   * starts.
   */
  no('pip install numpy');
  no('npm install');
  no('npm run dev');
  no('go get github.com/x/y');
  no('cargo add serde');
  no('apt-get install -y r-base');
});

test('⚠️⚠️ a CHAIN never verifies — we cannot tell what produced the exit code', () => {
  /**
   * `ls && pytest` exits with pytest's code, but `pytest || echo ok` exits 0
   * whatever happened. Rather than parse shell semantics, only a command that
   * stands alone can close a session.
   */
  no('ls && pytest');
  no('pytest || echo ok');
  no('cd src; pytest');
});

test('⚠️ mentioning a test runner is not running one', () => {
  no('echo "run pytest"');
  no('cat test_stats.py');
  no('grep pytest requirements.txt');
});

test('⚠️ a path-qualified runner still counts', () => {
  yes('./node_modules/.bin/jest');
  yes('/usr/bin/pytest');
});

test('⚠️ garbage is never a verification', () => {
  for (const c of ['', '   ', null, undefined, 42]) no(c);
});

test('⚠️⚠️ UNKNOWN MEANS NOT VERIFIED — the bias is deliberate', () => {
  /**
   * Being wrong this way costs extra rounds, bounded by the round cap and mostly
   * cached. Being wrong the other way hands back a half-finished job that
   * reports success, which is exactly the defect this module exists to end.
   */
  no('./configure');
  no('some-tool-we-have-never-heard-of --run');
});
