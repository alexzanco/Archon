import { describe, expect, test } from 'bun:test';

import { parseAgyConfig } from './config';

describe('parseAgyConfig', () => {
  test('returns empty object for empty input', () => {
    expect(parseAgyConfig({})).toEqual({});
  });

  test('parses supported fields', () => {
    expect(
      parseAgyConfig({
        model: 'Gemini 3.1 Pro (High)',
        agyBinaryPath: '/usr/local/bin/agy',
        printTimeout: '30s',
        additionalDirectories: ['/repo', '/tmp/context'],
        sandbox: true,
        dangerouslySkipPermissions: false,
        transcriptToolEvents: false,
      })
    ).toEqual({
      model: 'Gemini 3.1 Pro (High)',
      agyBinaryPath: '/usr/local/bin/agy',
      printTimeout: '30s',
      additionalDirectories: ['/repo', '/tmp/context'],
      sandbox: true,
      dangerouslySkipPermissions: false,
      transcriptToolEvents: false,
    });
  });

  test('drops malformed fields silently', () => {
    expect(
      parseAgyConfig({
        model: 123,
        agyBinaryPath: false,
        printTimeout: 20,
        additionalDirectories: ['/valid', 42, null],
        sandbox: 'yes',
        dangerouslySkipPermissions: 1,
        transcriptToolEvents: 'yes',
      })
    ).toEqual({ additionalDirectories: ['/valid'] });
  });

  test('ignores unknown keys', () => {
    expect(parseAgyConfig({ model: 'Gemini 3.5 Flash (High)', futureField: true })).toEqual({
      model: 'Gemini 3.5 Flash (High)',
    });
  });
});
