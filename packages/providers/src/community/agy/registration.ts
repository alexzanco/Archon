import { isRegisteredProvider, registerProvider } from '../../registry';

import { AGY_CAPABILITIES } from './capabilities';
import { AgyProvider } from './provider';

/**
 * Register the Google Antigravity CLI community provider.
 */
export function registerAgyProvider(): void {
  if (isRegisteredProvider('agy')) return;
  registerProvider({
    id: 'agy',
    displayName: 'AGY (Google Antigravity)',
    factory: () => new AgyProvider(),
    capabilities: AGY_CAPABILITIES,
    builtIn: false,
    credentials: { kind: 'dynamic' },
  });
}
