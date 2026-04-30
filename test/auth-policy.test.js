import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_URL = pathToFileURL(resolve(ROOT, 'src/auth.js')).href;

function runAuthSnippet(source, env = {}) {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEIUM_API_KEY: '',
      CODEIUM_AUTH_TOKEN: '',
      ...env,
    },
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

describe('auth account policy', () => {
  it('treats official Trial plan names as Trial even when local tier is pro', () => {
    const result = runAuthSnippet(`
      const { getAccountPolicy } = await import(${JSON.stringify(AUTH_URL)});
      const policy = getAccountPolicy({ tier: 'pro', planName: 'Trial' });
      console.log(JSON.stringify(policy));
    `, {
      RPM_LIMIT_TRIAL: '3',
      MAX_INFLIGHT_TRIAL: '1',
      MAX_TRIAL_ANTHROPIC_CREDIT: '1',
      RPM_LIMIT_PRO: '30',
      MAX_INFLIGHT_PRO: '4',
    });

    assert.equal(result.isTrial, true);
    assert.equal(result.rpmLimit, 3);
    assert.equal(result.inflightLimit, 1);
  });

  it('uses paid Pro limits only when the official plan is not Trial', () => {
    const result = runAuthSnippet(`
      const { getAccountPolicy } = await import(${JSON.stringify(AUTH_URL)});
      const policy = getAccountPolicy({ tier: 'pro', planName: 'Trial', userStatus: { planName: 'Pro' } });
      console.log(JSON.stringify(policy));
    `, {
      RPM_LIMIT_TRIAL: '3',
      MAX_INFLIGHT_TRIAL: '1',
      MAX_TRIAL_ANTHROPIC_CREDIT: '1',
      RPM_LIMIT_PRO: '30',
      MAX_INFLIGHT_PRO: '4',
    });

    assert.equal(result.isTrial, false);
    assert.equal(result.rpmLimit, 30);
    assert.equal(result.inflightLimit, 4);
  });

  it('does not run real model canaries by default', () => {
    const result = runAuthSnippet(`
      const { getProbeCanaries } = await import(${JSON.stringify(AUTH_URL)});
      console.log(JSON.stringify(getProbeCanaries()));
    `, {
      PROBE_CANARIES: '',
      ENABLE_EXPENSIVE_PROBE: '',
    });

    assert.deepEqual(result, []);
  });

  it('does not route Trial accounts to high-cost Anthropic models by default', () => {
    const result = runAuthSnippet(`
      const { isModelAllowedForAccount } = await import(${JSON.stringify(AUTH_URL)});
      const account = { tier: 'pro', planName: 'Trial' };
      console.log(JSON.stringify({
        haiku: isModelAllowedForAccount(account, 'claude-4.5-haiku'),
        sonnet: isModelAllowedForAccount(account, 'claude-4.5-sonnet'),
        opus: isModelAllowedForAccount(account, 'claude-opus-4.6'),
        gpt: isModelAllowedForAccount(account, 'gpt-4o-mini')
      }));
    `, {
      MAX_TRIAL_ANTHROPIC_CREDIT: '1',
    });

    assert.equal(result.haiku, true);
    assert.equal(result.sonnet, false);
    assert.equal(result.opus, false);
    assert.equal(result.gpt, true);
  });
});
