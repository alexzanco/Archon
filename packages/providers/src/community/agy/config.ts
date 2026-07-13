/**
 * Community provider defaults for AGY (Google Antigravity CLI).
 */
export interface AgyProviderDefaults {
  [key: string]: unknown;
  /** Default AGY model display name, e.g. 'Gemini 3.1 Pro (High)'. */
  model?: string;
  /** Absolute path to the AGY CLI binary. Overrides AGY_BIN_PATH / autodetect. */
  agyBinaryPath?: string;
  /** Value passed to `agy --print-timeout`, e.g. '30s' or '5m0s'. */
  printTimeout?: string;
  /** Additional directories passed as repeated `--add-dir <path>` flags. */
  additionalDirectories?: string[];
  /** Enable AGY's `--sandbox` flag. */
  sandbox?: boolean;
  /** Pass AGY's `--dangerously-skip-permissions` flag. */
  dangerouslySkipPermissions?: boolean;
  /** Best-effort: read AGY's private transcript after print mode and emit tool chunks. */
  transcriptToolEvents?: boolean;
}

/**
 * Parse raw `assistants.agy` config into typed AGY defaults.
 *
 * Invalid field types are ignored so provider discovery is not blocked by a
 * partially edited config file.
 */
export function parseAgyConfig(raw: Record<string, unknown>): AgyProviderDefaults {
  const config: AgyProviderDefaults = {};

  if (typeof raw.model === 'string') {
    config.model = raw.model;
  }

  if (typeof raw.agyBinaryPath === 'string') {
    config.agyBinaryPath = raw.agyBinaryPath;
  }

  if (typeof raw.printTimeout === 'string') {
    config.printTimeout = raw.printTimeout;
  }

  if (Array.isArray(raw.additionalDirectories)) {
    const directories = raw.additionalDirectories.filter(
      (value): value is string => typeof value === 'string'
    );
    if (directories.length > 0) config.additionalDirectories = directories;
  }

  if (typeof raw.sandbox === 'boolean') {
    config.sandbox = raw.sandbox;
  }

  if (typeof raw.dangerouslySkipPermissions === 'boolean') {
    config.dangerouslySkipPermissions = raw.dangerouslySkipPermissions;
  }

  if (typeof raw.transcriptToolEvents === 'boolean') {
    config.transcriptToolEvents = raw.transcriptToolEvents;
  }

  return config;
}
