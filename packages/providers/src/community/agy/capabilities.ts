import type { ProviderCapabilities } from '../../types';

/**
 * AGY is a thin CLI bridge around Google Antigravity's own logged-in CLI.
 * Capabilities are intentionally conservative until the CLI exposes stronger
 * contracts for sessions, tools, or structured decoding.
 */
export const AGY_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: 'best-effort',
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: true,
  nativeTools: false,
};
