import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

export const VERSION_INFO = (() => {
  let pkgVersion = '1.2.0';
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    if (pkg.version) pkgVersion = pkg.version;
  } catch {}

  let commit = '';
  let commitMessage = '';
  let commitDate = '';
  let branch = 'unknown';
  if (existsSync(join(REPO_ROOT, '.git'))) {
    try { commit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
    try { commitMessage = execSync('git log -1 --pretty=format:%s', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
    try { commitDate = execSync('git log -1 --pretty=format:%cI', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
    try { branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
  }
  return { version: pkgVersion, commit, commitMessage, commitDate, branch };
})();
