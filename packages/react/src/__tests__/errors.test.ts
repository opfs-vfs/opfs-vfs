import { VfsCommandError } from '@opfs-vfs/opfs-vfs/worker';
import type { RemoteErrorDetails } from '@opfs-vfs/opfs-vfs/worker';
import { describe, expect, it } from 'vitest';
import { classify, toVolumeError, VolumeError } from '../errors';

const details = (code?: string, name?: string, category?: RemoteErrorDetails['category']): RemoteErrorDetails => ({
  message: code ?? name ?? 'failure',
  ...(code ? { code } : {}),
  ...(name ? { name } : {}),
  ...(category ? { category } : {}),
});

describe('errors', () => {
  it('classifies all public code families', () => {
    for (const code of [
      'VFS_SHUTTING_DOWN',
      'VFS_ATTACHMENT_LOST',
      'VFS_PROTOCOL_MISMATCH',
      'VFS_PLUGIN_MISMATCH',
      'VFS_NOT_LEADER',
      'VFS_LEADER_NOT_READY',
      'VFS_WORKER_FAILED',
      'VFS_INITIALIZATION_TIMEOUT',
      'LEADER_RESPONSE_TIMEOUT',
      'VOLUME_IMPORTING',
    ])
      expect(classify(details(code), 'readFileBuffer')).toBe('lifecycle');
    for (const code of ['EVOLUMELOCKED', 'EVAULTCORRUPT', 'EKDF', 'ECRYPTOINTEGRITY', 'ECRYPTSIDECAR'])
      expect(classify(details(code), 'open')).toBe('encryption');
    expect(classify(details('SUBSCRIPTION_CLOSED'), 'sync')).toBe('subscription');
    expect(classify(details(undefined, 'VfsCorruptionError'), 'readFileBuffer')).toBe('corruption');
    expect(classify(details(undefined, 'MetaSnapshotCorruptionError'), 'readFileBuffer')).toBe('corruption');
    expect(classify(details(undefined, 'DataWalCorruptionError'), 'readFileBuffer')).toBe('corruption');
    expect(classify(details(undefined, undefined, 'data-wal'), 'readFileBuffer')).toBe('corruption');
    expect(classify(details('ENOSPC'), 'writeFileBuffer')).toBe('quota');
    expect(classify(details(undefined, 'QuotaExceededError'), 'writeFileBuffer')).toBe('quota');
    expect(classify(details('EEXIST'), 'mkdir')).toBe('conflict');
    expect(classify(details('EBUSY'), 'writeFileBuffer')).toBe('conflict');
    expect(classify(details('EBUSY'), 'unlink')).toBe('filesystem');
    expect(classify(details('ENOENT'), 'readFileBuffer')).toBe('filesystem');
    expect(classify(details('not-a-code'), 'readFileBuffer')).toBe('unknown');
  });

  it('maps command delivery to outcomes and sanitizes ordinary errors', () => {
    const cause = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const input = { operation: 'writeFileBuffer', volume: 'a.bin', path: '/a', mutation: true };
    const refused = toVolumeError(new VfsCommandError(cause, 'refused'), input);
    const sentMutation = toVolumeError(new VfsCommandError(cause, 'sent'), input);
    const sentRead = toVolumeError(new VfsCommandError(cause, 'sent'), { ...input, mutation: false });
    const replied = toVolumeError(new VfsCommandError(cause, 'replied'), input);
    const plain = toVolumeError(new Error('x'.repeat(10_000)), input);
    expect(refused).toMatchObject({ outcome: 'not-applied', kind: 'filesystem', cause: expect.any(VfsCommandError) });
    expect(sentMutation.outcome).toBe('possibly-applied');
    expect(sentRead.outcome).toBe('unknown');
    expect(replied.outcome).toBe('unknown');
    expect(plain).toBeInstanceOf(VolumeError);
    expect(plain.outcome).toBe('unknown');
    expect(plain.details && 'stack' in plain.details).toBe(false);
    expect(plain.details?.message.length).toBeLessThan(2_000);
    expect(plain.cause).toBeInstanceOf(Error);
  });
});
