/**
 * AGY CLI binary resolver.
 *
 * Resolution order:
 *  1. `AGY_BIN_PATH` environment variable
 *  2. `assistants.agy.agyBinaryPath` in config
 *  3. `~/.archon/vendor/agy/<platform-binary>` (user-placed)
 *  4. Autodetect common install paths
 *  5. PATH lookup via `which` / `where`
 *  6. Throw with install / login instructions
 */
import {
  accessSync as _accessSync,
  constants as fsConstants,
  statSync as _statSync,
} from 'node:fs';
import { execFileSync as _execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger, getArchonHome } from '@archon/paths';

const AGY_VENDOR_DIR = 'vendor/agy';
const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'];

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('agy-binary');
  return cachedLog;
}

export function resolveFromPath(): string | undefined {
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const output = _execFileSync(lookupCmd, ['agy'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = output.split(/\r?\n/)[0]?.trim();
    return first || undefined;
  } catch {
    return undefined;
  }
}

export function isExecutableFile(path: string): boolean {
  try {
    const stat = _statSync(path);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    _accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAgyBinaryPath(configBinaryPath?: string): Promise<string> {
  const envPath = process.env.AGY_BIN_PATH;
  if (envPath) {
    return validateExecutable(envPath, 'AGY_BIN_PATH');
  }

  if (configBinaryPath) {
    return validateExecutable(configBinaryPath, 'assistants.agy.agyBinaryPath');
  }

  const vendorBinaryName = getVendorBinaryName();
  if (vendorBinaryName) {
    const vendorBinaryPath = join(getArchonHome(), AGY_VENDOR_DIR, vendorBinaryName);
    if (isExecutableFile(vendorBinaryPath)) {
      getLog().info({ source: 'vendor' }, 'agy.binary_resolved');
      return vendorBinaryPath;
    }
  }

  for (const probePath of getAutodetectPaths()) {
    if (isExecutableFile(probePath)) {
      getLog().info({ source: 'autodetect' }, 'agy.binary_resolved');
      return probePath;
    }
  }

  const fromPath = resolveFromPath();
  if (fromPath && isExecutableFile(fromPath)) {
    getLog().info({ source: 'path' }, 'agy.binary_resolved');
    return fromPath;
  }

  throw new Error(
    'AGY CLI binary not found. The AGY provider requires Google Antigravity CLI.\n\n' +
      'To fix, choose one of:\n' +
      '  1. Install AGY with the official installer, then run `agy` once to sign in.\n' +
      '  2. Set AGY_BIN_PATH=/path/to/agy.\n' +
      '  3. Configure assistants.agy.agyBinaryPath in .archon/config.yaml.\n\n' +
      'Archon does not perform AGY OAuth or token delivery. It reuses the AGY CLI login on this machine.'
  );
}

function validateExecutable(path: string, source: string): string {
  if (!isExecutableFile(path)) {
    throw new Error(
      `${source} is set to "${path}" but it is not an executable file.\n` +
        'Please verify the path points to the AGY CLI executable (chmod +x if needed).'
    );
  }
  getLog().info({ source }, 'agy.binary_resolved');
  return path;
}

function getVendorBinaryName(): string | undefined {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) return undefined;
  if (process.arch !== 'x64' && process.arch !== 'arm64') return undefined;
  return process.platform === 'win32' ? 'agy.exe' : 'agy';
}

function getAutodetectPaths(): string[] {
  const paths: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) paths.push(join(appData, 'npm', 'agy.cmd'));
    paths.push(join(homedir(), '.local', 'bin', 'agy.exe'));
    return paths;
  }

  paths.push(join(homedir(), '.local', 'bin', 'agy'));
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    paths.push('/opt/homebrew/bin/agy');
  }
  paths.push('/usr/local/bin/agy');

  return paths;
}
