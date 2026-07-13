import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

import * as resolver from './binary-resolver';

describe('resolveAgyBinaryPath', () => {
  const originalEnv = process.env.AGY_BIN_PATH;
  let isExecutableFileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.AGY_BIN_PATH;
    isExecutableFileSpy?.mockRestore();
    mockLogger.info.mockClear();
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.AGY_BIN_PATH = originalEnv;
    } else {
      delete process.env.AGY_BIN_PATH;
    }
    isExecutableFileSpy?.mockRestore();
  });

  test('uses AGY_BIN_PATH env var when set and executable', async () => {
    process.env.AGY_BIN_PATH = '/usr/local/bin/agy';
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockReturnValue(true);

    await expect(resolver.resolveAgyBinaryPath()).resolves.toBe('/usr/local/bin/agy');
  });

  test('throws when AGY_BIN_PATH is not executable', async () => {
    process.env.AGY_BIN_PATH = '/missing/agy';
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockReturnValue(false);

    await expect(resolver.resolveAgyBinaryPath()).rejects.toThrow('is not an executable file');
  });

  test('uses config binary path when executable', async () => {
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockReturnValue(true);

    await expect(resolver.resolveAgyBinaryPath('/custom/agy')).resolves.toBe('/custom/agy');
  });

  test('env var takes precedence over config path', async () => {
    process.env.AGY_BIN_PATH = '/env/agy';
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockReturnValue(true);

    await expect(resolver.resolveAgyBinaryPath('/config/agy')).resolves.toBe('/env/agy');
  });

  test('checks vendor directory before PATH lookup', async () => {
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockImplementation((path: string) =>
      path.replace(/\\/g, '/').includes('/vendor/agy/')
    );

    const result = await resolver.resolveAgyBinaryPath();
    expect(result.replace(/\\/g, '/')).toContain('/tmp/test-archon-home/vendor/agy/');
  });

  test('falls back to PATH lookup when canonical paths do not match', async () => {
    const pathResult = '/some/bin/agy';
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockImplementation(
      (path: string) => path === pathResult
    );
    const resolveFromPathSpy = spyOn(resolver, 'resolveFromPath').mockReturnValue(pathResult);

    try {
      await expect(resolver.resolveAgyBinaryPath()).resolves.toBe(pathResult);
    } finally {
      resolveFromPathSpy.mockRestore();
    }
  });

  test('throws with install instructions when binary cannot be found', async () => {
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockReturnValue(false);
    const resolveFromPathSpy = spyOn(resolver, 'resolveFromPath').mockReturnValue(undefined);

    try {
      await expect(resolver.resolveAgyBinaryPath()).rejects.toThrow('AGY CLI binary not found');
    } finally {
      resolveFromPathSpy.mockRestore();
    }
  });
});
