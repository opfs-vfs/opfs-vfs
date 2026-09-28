import type {
  ChangeClient,
  ChangeFrame,
  LogicalChangeHost,
  LogicalRecord,
  WireSubscribeOptions,
} from '@opfs-vfs/opfs-vfs/changes';
import { describe, expect, it, vi } from 'vitest';
import { subscriptions } from '../owner';

const base: WireSubscribeOptions = {
  path: '/',
  scope: 'directory',
  recursive: true,
  events: ['create', 'update', 'delete'],
  content: false,
};

const client = (id = 'client', channel = 'channel', route: ChangeClient['route'] = 'local'): ChangeClient => ({
  clientId: id,
  channelId: channel,
  route,
});
const record = (
  path: string,
  sequence: number,
  type: LogicalRecord['type'] = 'create',
  size = 0,
  inodeId = sequence,
): LogicalRecord => ({
  type,
  path,
  kind: 'file',
  cursor: { generation: 'mount', sequence },
  inodeId,
  size,
});

function fixture() {
  const sent: { client: ChangeClient; frame: ChangeFrame }[] = [];
  const validateTarget = vi.fn();
  const host: LogicalChangeHost = {
    generation: 'mount',
    validateTarget,
    send(target, frame) {
      sent.push({ client: target, frame });
    },
  };
  const contribution = subscriptions().logicalChanges;
  if (!contribution) throw new Error('subscriptions must provide logical changes');
  const session = contribution.create(host);
  const register = (target: ChangeClient, id: string, options: Partial<WireSubscribeOptions> = {}) =>
    session.control(target, { type: 'register', subscriptionId: id, options: { ...base, ...options } });
  return { sent, session, register, validateTarget };
}

function codeOf(action: () => unknown): unknown {
  try {
    action();
  } catch (cause) {
    return (cause as { code?: unknown }).code;
  }
  return undefined;
}

describe('subscription owner', () => {
  it('normalizes scope paths, deduplicates events, and resets global regex state for each record', () => {
    const { sent, session, register } = fixture();
    const target = client();
    register(target, 'sub', {
      path: 'watched/./',
      recursive: false,
      events: ['create', 'create'],
      match: { source: '.*file$', flags: 'gy' },
    });
    session.control(target, { type: 'activate', subscriptionId: 'sub' });
    session.completed({
      records: [
        record('/watched/file', 1),
        record('/watched/file', 2),
        record('/watched/nested/file', 3),
        record('/watched/file', 4, 'update'),
      ],
      capture() {
        throw new Error('metadata only');
      },
    });
    const events = sent.filter(
      (item): item is { client: ChangeClient; frame: Extract<ChangeFrame, { type: 'event' }> } =>
        item.frame.type === 'event',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.frame.change.cursor.sequence).toBe(1);
    session.control(target, { type: 'ack', subscriptionId: 'sub', deliveryId: 1 });
    expect(
      sent
        .filter((item) => item.frame.type === 'event')
        .map((item) => (item.frame as Extract<ChangeFrame, { type: 'event' }>).change.cursor.sequence),
    ).toEqual([1, 2]);
  });

  it('keeps retiring registrations in the 32-client and 128-mount limits until terminal acknowledgement', () => {
    const { sent, session, register } = fixture();
    const first = client();
    for (let i = 0; i < 32; i++) register(first, `first-${i}`);
    expect(codeOf(() => register(first, 'first-over'))).toBe('ENOSPC');
    session.control(first, { type: 'cancel', subscriptionId: 'first-0' });
    expect(codeOf(() => register(first, 'first-still-retiring'))).toBe('ENOSPC');
    session.control(first, { type: 'terminal-ack', subscriptionId: 'first-0' });
    expect(register(first, 'first-reused')).toMatchObject({ type: 'registered' });

    for (let group = 1; group < 4; group++) {
      const target = client(`client-${group}`);
      for (let i = 0; i < 32; i++) register(target, `group-${group}-${i}`);
    }
    expect(codeOf(() => register(client('overflow'), 'mount-over'))).toBe('ENOSPC');
    expect(sent.filter((item) => item.frame.type === 'closed')).toHaveLength(1);
  });

  it('terminates a 4097th held recipient and applies partial invalidations only to overlapping scopes', () => {
    const { sent, session, register } = fixture();
    const affected = client('affected');
    const unrelated = client('unrelated');
    register(affected, 'affected', { path: '/affected', recursive: true });
    register(unrelated, 'unrelated', { path: '/other', scope: 'file', recursive: false });
    session.completed({
      records: Array.from({ length: 4097 }, (_, index) => record(`/affected/${index}`, index + 1)),
      capture() {
        throw new Error('metadata only');
      },
    });
    expect(sent.find((item) => item.frame.type === 'terminal')?.frame).toMatchObject({
      subscriptionId: 'affected',
      code: 'SUBSCRIPTION_OVERFLOW',
    });
    session.invalidated({ kind: 'paths', paths: [{ path: '/affected', subtree: true }] }, 'partial-mutation');
    expect(
      sent.filter((item) => item.frame.type === 'terminal' && item.frame.subscriptionId === 'unrelated'),
    ).toHaveLength(0);
    session.invalidated({ kind: 'paths', paths: [{ path: '/other', subtree: false }] }, 'record-limit');
    expect(
      sent.find((item) => item.frame.type === 'terminal' && item.frame.subscriptionId === 'unrelated')?.frame,
    ).toMatchObject({ code: 'SUBSCRIPTION_OVERFLOW' });
  });

  it('invalidates overlapping active subscriptions despite event and match filters', () => {
    const { sent, session, register } = fixture();
    const filtered = client('filtered');
    const limited = client('limited');
    const unrelated = client('unrelated');
    const filteredOptions = { events: ['create'] as const, match: { source: '^never$', flags: '' } };
    register(filtered, 'filtered', { path: '/watched', recursive: true, ...filteredOptions });
    register(limited, 'limited', { path: '/limited', recursive: true, ...filteredOptions });
    register(unrelated, 'unrelated', { path: '/other', recursive: true, ...filteredOptions });
    session.control(filtered, { type: 'activate', subscriptionId: 'filtered' });
    session.control(limited, { type: 'activate', subscriptionId: 'limited' });
    session.invalidated({ kind: 'paths', paths: [{ path: '/watched/nested', subtree: true }] }, 'partial-mutation');
    session.invalidated({ kind: 'paths', paths: [{ path: '/limited', subtree: true }] }, 'record-limit');
    expect(
      sent
        .filter(
          (item): item is { client: ChangeClient; frame: Extract<ChangeFrame, { type: 'terminal' }> } =>
            item.frame.type === 'terminal',
        )
        .map((item) => ({ subscriptionId: item.frame.subscriptionId, code: item.frame.code })),
    ).toEqual([
      { subscriptionId: 'filtered', code: 'SUBSCRIPTION_RESYNC_REQUIRED' },
      { subscriptionId: 'limited', code: 'SUBSCRIPTION_OVERFLOW' },
    ]);
  });

  it('uses the aggregate 16384-recipient guard independently of each 4096-recipient guard', () => {
    const { sent, session, register } = fixture();
    const targets = Array.from({ length: 4 }, (_, index) => client(`aggregate-${index}`));
    targets.forEach((target, index) => register(target, `aggregate-${index}`, { path: `/aggregate-${index}` }));
    for (let index = 0; index < 4; index++) {
      session.completed({
        records: Array.from({ length: 4096 }, (_, sequence) =>
          record(`/aggregate-${index}/${sequence}`, index * 4096 + sequence + 1),
        ),
        capture() {
          throw new Error('metadata only');
        },
      });
    }
    expect(sent.filter((item) => item.frame.type === 'terminal')).toHaveLength(0);
    const fifth = client('aggregate-fifth');
    register(fifth, 'fifth', { path: '/fifth' });
    session.completed({
      records: [record('/fifth/overflow', 16_385)],
      capture() {
        throw new Error('metadata only');
      },
    });
    expect(sent.filter((item) => item.frame.type === 'terminal').map((item) => item.frame.subscriptionId)).toEqual([
      'fifth',
    ]);
    session.control(fifth, { type: 'terminal-ack', subscriptionId: 'fifth' });
    session.control(targets[0]!, { type: 'cancel', subscriptionId: 'aggregate-0' });
    session.control(targets[0]!, { type: 'terminal-ack', subscriptionId: 'aggregate-0' });
    expect(register(fifth, 'fifth-fresh', { path: '/fifth' })).toMatchObject({ type: 'registered' });
    session.completed({
      records: [record('/fifth/admitted', 16_386)],
      capture() {
        throw new Error('metadata only');
      },
    });
    expect(sent.filter((item) => item.frame.type === 'terminal').map((item) => item.frame.subscriptionId)).toEqual([
      'fifth',
    ]);
  });

  it('counts the active in-flight event, ignores stale acknowledgements, and preserves active/retiring states', () => {
    const { sent, session, register } = fixture();
    const target = client();
    register(target, 'active', { path: '/active' });
    session.control(target, { type: 'activate', subscriptionId: 'active' });
    session.control(target, { type: 'terminal-ack', subscriptionId: 'active' });
    session.completed({
      records: Array.from({ length: 4096 }, (_, index) => record(`/active/${index}`, index + 1)),
      capture() {
        throw new Error('metadata only');
      },
    });
    expect(sent.filter((item) => item.frame.type === 'event')).toHaveLength(1);
    session.control(target, { type: 'ack', subscriptionId: 'active', deliveryId: 2 });
    expect(sent.filter((item) => item.frame.type === 'event')).toHaveLength(1);
    session.completed({
      records: [record('/active/overflow', 4097)],
      capture() {
        throw new Error('metadata only');
      },
    });
    expect(sent.find((item) => item.frame.type === 'terminal')?.frame).toMatchObject({
      subscriptionId: 'active',
      code: 'SUBSCRIPTION_OVERFLOW',
    });
    const before = sent.length;
    session.completed({
      records: [record('/active/after-retire', 4098)],
      capture() {
        throw new Error('metadata only');
      },
    });
    expect(sent).toHaveLength(before);
  });

  it('does not retain records for a cancelled held subscription', () => {
    const { sent, session, register } = fixture();
    const retired = client('retired');
    register(retired, 'retired', { path: '/retired' });
    session.control(retired, { type: 'cancel', subscriptionId: 'retired' });
    session.completed({
      records: Array.from({ length: 4096 }, (_, index) => record(`/retired/${index}`, index + 1)),
      capture() {
        throw new Error('metadata only');
      },
    });
    const active = Array.from({ length: 4 }, (_, index) => client(`active-${index}`));
    active.forEach((target, index) => register(target, `active-${index}`, { path: `/active-${index}` }));
    for (let index = 0; index < 4; index++) {
      session.completed({
        records: Array.from({ length: 4096 }, (_, sequence) =>
          record(`/active-${index}/${sequence}`, index * 4096 + sequence + 4097),
        ),
        capture() {
          throw new Error('metadata only');
        },
      });
    }
    expect(sent.filter((item) => item.frame.type === 'terminal')).toHaveLength(0);
  });

  it('keeps a retiring in-flight event charged until terminal acknowledgement', () => {
    const { sent, session, register } = fixture();
    const retiring = client('retiring-credit');
    register(retiring, 'retiring-credit', { path: '/retiring-credit' });
    session.control(retiring, { type: 'activate', subscriptionId: 'retiring-credit' });
    session.completed({
      records: [record('/retiring-credit/file', 1)],
      capture() {
        throw new Error('metadata only');
      },
    });
    session.control(retiring, { type: 'cancel', subscriptionId: 'retiring-credit' });
    session.control(retiring, { type: 'ack', subscriptionId: 'retiring-credit', deliveryId: 1 });
    for (let index = 0; index < 4; index++) {
      const target = client(`credit-${index}`);
      register(target, `credit-${index}`, { path: `/credit-${index}` });
      session.completed({
        records: Array.from({ length: 4096 }, (_, sequence) =>
          record(`/credit-${index}/${sequence}`, index * 4096 + sequence + 2),
        ),
        capture() {
          throw new Error('metadata only');
        },
      });
    }
    expect(sent.find((item) => item.frame.type === 'terminal')?.frame).toMatchObject({
      subscriptionId: 'credit-3',
      code: 'SUBSCRIPTION_OVERFLOW',
    });
  });

  it('releases every client-owned ledger entry when its channel closes', () => {
    const { session, register } = fixture();
    const target = client();
    for (let index = 0; index < 32; index++) register(target, `closed-${index}`);
    session.clientClosed(target);
    for (let index = 0; index < 32; index++)
      expect(register(target, `reopened-${index}`)).toMatchObject({ type: 'registered' });
  });

  it('charges UTF-8 event paths by bytes rather than UTF-16 code units', () => {
    const { sent, session, register } = fixture();
    const target = client();
    const path = `/${'é'.repeat(2100)}`;
    register(target, 'utf8', { path: '/', recursive: true });
    session.completed({
      records: Array.from({ length: 4096 }, (_, index) => record(`${path}${index}`, index + 1)),
      capture() {
        throw new Error('metadata only');
      },
    });
    expect(sent.find((item) => item.frame.type === 'terminal')?.frame).toMatchObject({
      subscriptionId: 'utf8',
      code: 'SUBSCRIPTION_OVERFLOW',
    });
  });

  it('releases the 16 MiB metadata ledger only after a retiring registration is acknowledged', () => {
    const { session, register } = fixture();
    const path = `/${'x'.repeat(600_000)}`;
    const registrations: { target: ChangeClient; id: string }[] = [];
    for (let index = 0; index < 32; index++) {
      const target = client(`metadata-${index}`);
      const id = `metadata-${index}`;
      const code = codeOf(() => register(target, id, { path }));
      if (code === 'ENOSPC') break;
      registrations.push({ target, id });
    }
    expect(registrations.length).toBeGreaterThan(0);
    expect(registrations.length).toBeLessThan(32);
    const retired = registrations[0]!;
    session.control(retired.target, { type: 'cancel', subscriptionId: retired.id });
    expect(codeOf(() => register(client('metadata-over'), 'metadata-over', { path }))).toBe('ENOSPC');
    session.control(retired.target, { type: 'terminal-ack', subscriptionId: retired.id });
    expect(register(client('metadata-reused'), 'metadata-reused', { path })).toMatchObject({ type: 'registered' });
  });

  it('applies content omission precedence without capturing metadata-only records', () => {
    const { sent, session, register } = fixture();
    const target = client();
    register(target, 'content', { path: '/', recursive: true, content: { maxBytes: 2 } });
    session.control(target, { type: 'activate', subscriptionId: 'content' });
    let captures = 0;
    const deliver = (item: LogicalRecord) => {
      session.completed({
        records: [item],
        capture() {
          captures++;
          return { status: 'included', bytes: new Uint8Array([1, 2]) };
        },
      });
      const frame = sent.at(-1)!.frame as Extract<ChangeFrame, { type: 'event' }>;
      session.control(target, { type: 'ack', subscriptionId: 'content', deliveryId: frame.deliveryId });
      return frame.change.content;
    };
    expect(deliver(record('/deleted', 1, 'delete', 2))).toEqual({ status: 'omitted', reason: 'deleted' });
    expect(deliver({ ...record('/link', 2, 'create', 2), kind: 'symlink' })).toEqual({
      status: 'omitted',
      reason: 'not-file',
    });
    expect(deliver(record('/large', 3, 'create', 3))).toEqual({ status: 'omitted', reason: 'too-large' });
    expect(deliver(record('/included', 4, 'create', 2))).toMatchObject({ status: 'included' });
    expect(captures).toBe(1);
  });

  it('never calls capture for a metadata-only subscription', () => {
    const { sent, session, register } = fixture();
    const target = client();
    register(target, 'metadata', { path: '/', recursive: true });
    session.control(target, { type: 'activate', subscriptionId: 'metadata' });
    session.completed({
      records: [record('/metadata', 1, 'update', 16)],
      capture() {
        throw new Error('metadata subscriptions must not read');
      },
    });
    expect(sent.at(-1)?.frame).toMatchObject({
      type: 'event',
      subscriptionId: 'metadata',
      change: { content: { status: 'omitted', reason: 'disabled' } },
    });
  });

  it('turns a delivery-copy allocation failure into unavailable and admits a later capture', () => {
    const { sent, session, register } = fixture();
    const target = client();
    register(target, 'content', { path: '/', recursive: true, content: { maxBytes: 16 * 1024 * 1024 } });
    session.control(target, { type: 'activate', subscriptionId: 'content' });
    let captures = 0;
    const slice = vi.spyOn(Uint8Array.prototype, 'slice').mockImplementationOnce(() => {
      throw new Error('allocation failed');
    });
    try {
      session.completed({
        records: [record('/first', 1, 'update', 2, 1)],
        capture() {
          captures++;
          return { status: 'included', bytes: new Uint8Array([1, 2]) };
        },
      });
      expect(sent.at(-1)?.frame).toMatchObject({ type: 'event', change: { content: { reason: 'unavailable' } } });
      const first = sent.at(-1)!.frame as Extract<ChangeFrame, { type: 'event' }>;
      session.control(target, { type: 'ack', subscriptionId: 'content', deliveryId: first.deliveryId });
      session.completed({
        records: [record('/second', 2, 'update', 16 * 1024 * 1024, 2)],
        capture() {
          captures++;
          return { status: 'included', bytes: new Uint8Array(16 * 1024 * 1024) };
        },
      });
      session.completed({
        records: [record('/third', 3, 'update', 16 * 1024 * 1024, 3)],
        capture() {
          captures++;
          return { status: 'included', bytes: new Uint8Array(16 * 1024 * 1024) };
        },
      });
      expect(sent.at(-1)?.frame).toMatchObject({ type: 'event', change: { content: { status: 'included' } } });
      // The failed 2-byte copy must refund before two 16 MiB deliveries reach the 32 MiB recipient ceiling.
      expect(captures).toBe(3);
    } finally {
      slice.mockRestore();
    }
  });

  it('keeps a successful zero-user source through completed for a later authorized recipient', () => {
    const { sent, session, register } = fixture();
    const first = client('first');
    const second = client('second');
    const options = { path: '/', recursive: true, content: { maxBytes: 2 } };
    register(first, 'first', options);
    register(second, 'second', options);
    session.control(first, { type: 'activate', subscriptionId: 'first' });
    session.control(second, { type: 'activate', subscriptionId: 'second' });
    const slice = vi.spyOn(Uint8Array.prototype, 'slice').mockImplementationOnce(() => {
      throw new Error('allocation failed');
    });
    let captures = 0;
    try {
      session.completed({
        records: [record('/file', 1, 'update', 2, 99)],
        capture() {
          captures++;
          return { status: 'included', bytes: new Uint8Array(captures === 1 ? [1, 2] : [9, 9]) };
        },
      });
      const events = sent.filter(
        (item): item is { client: ChangeClient; frame: Extract<ChangeFrame, { type: 'event' }> } =>
          item.frame.type === 'event',
      );
      expect(captures).toBe(2);
      expect(events[0]!.frame.change.content).toMatchObject({ reason: 'unavailable' });
      const included = events[1]!.frame.change.content;
      if (included.status !== 'included') throw new Error('expected included content');
      expect([...included.bytes]).toEqual([1, 2]);
    } finally {
      slice.mockRestore();
    }
  });

  it('rechecks each alias path and never lets unavailable aliases reuse a successful capture', () => {
    for (const paths of [
      ['/denied', '/allowed'],
      ['/allowed', '/denied'],
    ]) {
      const { sent, session, register } = fixture();
      const denied = client('denied');
      const allowed = client('allowed');
      register(denied, 'denied', {
        path: '/denied',
        scope: 'file',
        recursive: false,
        content: { maxBytes: 2 },
      });
      register(allowed, 'allowed', {
        path: '/allowed',
        scope: 'file',
        recursive: false,
        content: { maxBytes: 2 },
      });
      session.control(denied, { type: 'activate', subscriptionId: 'denied' });
      session.control(allowed, { type: 'activate', subscriptionId: 'allowed' });
      const captures: string[] = [];
      session.completed({
        records: paths.map((path, index) => record(path, index + 1, 'update', 2, 7)),
        capture(item) {
          captures.push(item.path);
          return item.path === '/denied'
            ? { status: 'omitted', reason: 'unavailable' }
            : { status: 'included', bytes: new Uint8Array([7, 7]) };
        },
      });
      expect(captures).toEqual(paths);
      expect(
        sent
          .filter(
            (item): item is { client: ChangeClient; frame: Extract<ChangeFrame, { type: 'event' }> } =>
              item.frame.type === 'event',
          )
          .map((item) => item.frame.change.content.status),
      ).toEqual(paths.map((path) => (path === '/denied' ? 'omitted' : 'included')));
    }
  });

  it('captures each authorized path while sharing and isolating its completed inode bytes', () => {
    const { sent, session, register } = fixture();
    const direct = client('direct');
    const follower = client('follower', 'channel', 'follower-relay');
    register(direct, 'direct', { path: '/', recursive: true, content: { maxBytes: 3 } });
    register(follower, 'follower', { path: '/', recursive: true, content: { maxBytes: 3 } });
    session.control(direct, { type: 'activate', subscriptionId: 'direct' });
    session.control(follower, { type: 'activate', subscriptionId: 'follower' });
    let captures = 0;
    session.completed({
      records: [record('/alias', 1, 'create', 3, 77)],
      capture() {
        captures++;
        return { status: 'included', bytes: new Uint8Array(captures === 1 ? [1, 2, 3] : [9, 9, 9]) };
      },
    });
    const frames = sent
      .filter(
        (item): item is { client: ChangeClient; frame: Extract<ChangeFrame, { type: 'event' }> } =>
          item.frame.type === 'event',
      )
      .map((item) => item.frame);
    expect(captures).toBe(2);
    const first = frames[0]!.change.content;
    const second = frames[1]!.change.content;
    expect(first).toMatchObject({ status: 'included' });
    expect(second).toMatchObject({ status: 'included' });
    if (first.status !== 'included' || second.status !== 'included') throw new Error('expected included content');
    first.bytes[0] = 42;
    expect([...second.bytes]).toEqual([1, 2, 3]);
  });

  it('refunds unavailable source reservations before admitting an allowed 192 MiB boundary', () => {
    const { sent, session, register } = fixture();
    const followers = Array.from({ length: 4 }, (_, index) => client(`follower-${index}`, 'channel', 'follower-relay'));
    const denied = client('denied');
    register(denied, 'denied', {
      path: '/denied',
      scope: 'file',
      recursive: false,
      content: { maxBytes: 16 * 1024 * 1024 },
    });
    session.control(denied, { type: 'activate', subscriptionId: 'denied' });
    followers.forEach((target, index) =>
      register(target, `follower-${index}`, {
        path: '/allowed',
        scope: 'file',
        recursive: false,
        content: { maxBytes: 16 * 1024 * 1024 },
      }),
    );
    followers.forEach((target, index) =>
      session.control(target, { type: 'activate', subscriptionId: `follower-${index}` }),
    );
    const bytes = new Uint8Array(16 * 1024 * 1024);
    let captureCalls = 0;
    session.completed({
      records: [
        record('/denied', 1, 'create', bytes.byteLength, 1),
        record('/allowed', 2, 'create', bytes.byteLength, 2),
      ],
      capture(item) {
        captureCalls++;
        return item.path === '/denied' ? { status: 'omitted', reason: 'unavailable' } : { status: 'included', bytes };
      },
    });
    session.completed({
      records: [record('/allowed', 3, 'update', bytes.byteLength, 3)],
      capture() {
        captureCalls++;
        return { status: 'included', bytes: new Uint8Array(bytes) };
      },
    });
    const probe = client('probe');
    register(probe, 'probe', {
      path: '/probe',
      scope: 'file',
      recursive: false,
      content: { maxBytes: bytes.byteLength },
    });
    session.control(probe, { type: 'activate', subscriptionId: 'probe' });
    // The allowed followers retain 160 MiB; this direct delivery peaks at 160 + 16 source + 16 delivery = 192 MiB.
    session.completed({
      records: [record('/probe', 4, 'update', bytes.byteLength, 4)],
      capture() {
        captureCalls++;
        return { status: 'included', bytes };
      },
    });
    const terminals = sent.filter(
      (item): item is { client: ChangeClient; frame: Extract<ChangeFrame, { type: 'terminal' }> } =>
        item.frame.type === 'terminal',
    );
    expect(captureCalls).toBe(7);
    expect(
      sent.find((item) => item.frame.type === 'event' && item.frame.subscriptionId === 'denied')?.frame,
    ).toMatchObject({
      change: { content: { status: 'omitted', reason: 'unavailable' } },
    });
    expect(terminals.map((item) => item.frame.subscriptionId)).toEqual(['follower-1', 'follower-2', 'follower-3']);
    expect(sent.some((item) => item.frame.type === 'terminal' && item.frame.subscriptionId === 'follower-0')).toBe(
      false,
    );
  });

  it('retains two completed 16 MiB versions for two followers and releases them asymmetrically', () => {
    const { sent, session, register } = fixture();
    const first = client('first', 'channel', 'follower-relay');
    const second = client('second', 'channel', 'follower-relay');
    const options = { path: '/', recursive: true, content: { maxBytes: 16 * 1024 * 1024 } };
    register(first, 'first', options);
    register(second, 'second', options);
    session.control(first, { type: 'activate', subscriptionId: 'first' });
    session.control(second, { type: 'activate', subscriptionId: 'second' });
    const size = 16 * 1024 * 1024;
    const a = new Uint8Array(size).fill(1);
    const b = new Uint8Array(size).fill(2);
    session.completed({
      records: [record('/file', 1, 'update', size, 11)],
      capture() {
        return { status: 'included', bytes: a };
      },
    });
    session.completed({
      records: [record('/file', 2, 'update', size, 12)],
      capture() {
        return { status: 'included', bytes: b };
      },
    });
    const aFrames = sent.filter(
      (item): item is { client: ChangeClient; frame: Extract<ChangeFrame, { type: 'event' }> } =>
        item.frame.type === 'event' && item.frame.deliveryId === 1,
    );
    expect(aFrames).toHaveLength(2);
    for (const { frame } of aFrames) {
      if (frame.change.content.status !== 'included') throw new Error('expected A content');
      expect(frame.change.content.bytes[0]).toBe(1);
    }
    session.control(first, { type: 'ack', subscriptionId: 'first', deliveryId: 1 });
    const bFrame = sent.find(
      (item): item is { client: ChangeClient; frame: Extract<ChangeFrame, { type: 'event' }> } =>
        item.frame.type === 'event' && item.frame.subscriptionId === 'first' && item.frame.deliveryId === 2,
    )!.frame;
    if (bFrame.change.content.status !== 'included') throw new Error('expected B content');
    expect(bFrame.change.content.bytes[0]).toBe(2);
    session.control(second, { type: 'cancel', subscriptionId: 'second' });
    session.control(first, { type: 'ack', subscriptionId: 'first', deliveryId: 2 });
    session.control(second, { type: 'terminal-ack', subscriptionId: 'second' });
    session.completed({
      records: [record('/file', 3, 'update', size, 13)],
      capture() {
        return { status: 'included', bytes: new Uint8Array(size).fill(3) };
      },
    });
    expect(sent.some((item) => item.frame.type === 'terminal' && item.frame.subscriptionId === 'first')).toBe(false);
  });

  it("releases a closed follower's delivery reservation before admitting other recipients", () => {
    const { sent, session, register } = fixture();
    const size = 16 * 1024 * 1024;
    const followers = Array.from({ length: 4 }, (_, index) => client(`close-${index}`, 'channel', 'follower-relay'));
    const options = { path: '/', recursive: true, content: { maxBytes: size } };
    followers.forEach((target, index) => {
      register(target, `close-${index}`, options);
      session.control(target, { type: 'activate', subscriptionId: `close-${index}` });
    });
    const bytes = new Uint8Array(size);
    session.completed({
      records: [record('/a', 1, 'update', size, 1)],
      capture() {
        return { status: 'included', bytes };
      },
    });
    session.clientClosed(followers[0]!);
    session.completed({
      records: [record('/b', 2, 'update', size, 2)],
      capture() {
        return { status: 'included', bytes };
      },
    });
    expect(
      sent
        .filter(
          (item): item is { client: ChangeClient; frame: Extract<ChangeFrame, { type: 'terminal' }> } =>
            item.frame.type === 'terminal',
        )
        .map((item) => item.frame.subscriptionId),
    ).toEqual(['close-3']);
  });

  it('holds 128 MiB of two follower versions, charges 32 MiB per follower, and releases on terminal acknowledgement', () => {
    const { sent, session, register } = fixture();
    const size = 16 * 1024 * 1024;
    const add = (id: string, path: string, recursive = false) => {
      const target = client(id, 'channel', 'follower-relay');
      register(target, id, {
        path,
        scope: recursive ? 'directory' : 'file',
        recursive,
        content: { maxBytes: size },
      });
      session.control(target, { type: 'activate', subscriptionId: id });
      return target;
    };
    const first = add('first', '/versions', true);
    const second = add('second', '/versions', true);
    const bytes = new Uint8Array(size);
    session.completed({
      records: [record('/versions/a', 1, 'update', size, 1)],
      capture() {
        return { status: 'included', bytes };
      },
    });
    // One version: 2 followers × (16 MiB × 2 relay delivery) = 64 MiB.
    let bCaptures = 0;
    session.completed({
      records: [record('/versions/b', 2, 'update', size, 2)],
      capture() {
        bCaptures++;
        return { status: 'included', bytes };
      },
    });
    expect(bCaptures).toBe(2);
    // Two versions: 4 deliveries × 32 MiB = 128 MiB; one 16 MiB source per inode is charged only in completed().
    const unrelated = add('unrelated', '/unrelated');
    let unrelatedCaptures = 0;
    session.completed({
      records: [record('/unrelated', 3, 'update', size, 3)],
      capture() {
        unrelatedCaptures++;
        return { status: 'included', bytes };
      },
    });
    // 128 MiB retained + 16 MiB source + 32 MiB relay delivery = 176 MiB.
    expect(unrelatedCaptures).toBe(1);
    session.control(unrelated, { type: 'ack', subscriptionId: 'unrelated', deliveryId: 1 });
    const third = add('third', '/versions/b');
    const fourth = add('fourth', '/versions/b');
    let cCaptures = 0;
    session.completed({
      records: [record('/versions/b', 3, 'update', size, 3)],
      capture() {
        cCaptures++;
        return { status: 'included', bytes };
      },
    });
    // first and second already hold 2 × 16 MiB, so their third version exceeds 32 MiB before capture.
    // Retiring each drops its pending 32 MiB /b delivery but retains its in-flight 32 MiB /a delivery.
    // third and fourth therefore capture: 64 + 16 source + (2 × 32 delivery) = 144 MiB, then source releases.
    expect(cCaptures).toBe(2);
    expect(
      sent
        .filter(
          (item): item is { client: ChangeClient; frame: Extract<ChangeFrame, { type: 'terminal' }> } =>
            item.frame.type === 'terminal',
        )
        .map((item) => item.frame.subscriptionId),
    ).toEqual(['first', 'second']);

    // Terminal acknowledgement releases each retained in-flight /a delivery: 128 MiB → 64 MiB.
    session.control(first, { type: 'terminal-ack', subscriptionId: 'first' });
    session.control(second, { type: 'terminal-ack', subscriptionId: 'second' });
    const admitted = add('admitted', '/c');
    let captures = 0;
    session.completed({
      records: [record('/c', 4, 'update', size, 4)],
      capture() {
        captures++;
        return { status: 'included', bytes };
      },
    });
    expect(captures).toBe(1);
    session.control(third, { type: 'ack', subscriptionId: 'third', deliveryId: 1 });
    session.control(fourth, { type: 'ack', subscriptionId: 'fourth', deliveryId: 1 });
    session.control(admitted, { type: 'ack', subscriptionId: 'admitted', deliveryId: 1 });

    for (let index = 0; index < 5; index++) add(`x-${index}`, '/x');
    add('y', '/y');
    let xyCaptures = 0;
    session.completed({
      records: [record('/x', 5, 'update', size, 5), record('/y', 6, 'update', size, 6)],
      capture() {
        xyCaptures++;
        return { status: 'included', bytes };
      },
    });
    // /x: 16 MiB source + (5 × 32 MiB deliveries) = 176 MiB; /y needs 48 MiB more, so 224 MiB > 192 MiB.
    expect(xyCaptures).toBe(5);
    expect(
      sent
        .filter(
          (item): item is { client: ChangeClient; frame: Extract<ChangeFrame, { type: 'terminal' }> } =>
            item.frame.type === 'terminal',
        )
        .map((item) => item.frame.subscriptionId),
    ).toEqual(['first', 'second', 'y']);
  });

  it('checks matching before capture and enforces the 32 MiB recipient ceiling before a third version', () => {
    const { sent, session, register } = fixture();
    const matched = client('matched');
    register(matched, 'matched', {
      path: '/watched',
      scope: 'file',
      recursive: false,
      content: { maxBytes: 16 * 1024 * 1024 },
    });
    session.control(matched, { type: 'activate', subscriptionId: 'matched' });
    let captures = 0;
    const bytes = new Uint8Array(16 * 1024 * 1024);
    const complete = (path: string, sequence: number) =>
      session.completed({
        records: [record(path, sequence, 'update', bytes.byteLength, sequence)],
        capture() {
          captures++;
          return { status: 'included', bytes };
        },
      });
    complete('/other', 1);
    complete('/watched', 2);
    complete('/watched', 3);
    complete('/watched', 4);
    expect(captures).toBe(2);
    expect(sent.find((item) => item.frame.type === 'terminal')?.frame).toMatchObject({
      subscriptionId: 'matched',
      code: 'SUBSCRIPTION_OVERFLOW',
    });
  });

  it('releases saved delivery size after a worker-style transfer detaches the sent copy', () => {
    const sent: ChangeFrame[] = [];
    const contribution = subscriptions().logicalChanges!;
    const session = contribution.create({
      generation: 'mount',
      validateTarget() {},
      send(_target, frame) {
        sent.push(frame);
        if (frame.type === 'event' && frame.change.content.status === 'included')
          structuredClone(frame.change.content.bytes, { transfer: [frame.change.content.bytes.buffer] });
      },
    });
    const target = client('detached');
    const options = { ...base, content: { maxBytes: 16 * 1024 * 1024 } };
    session.control(target, { type: 'register', subscriptionId: 'detached', options });
    session.control(target, { type: 'activate', subscriptionId: 'detached' });
    const size = 16 * 1024 * 1024;
    for (let sequence = 1; sequence <= 13; sequence++) {
      session.completed({
        records: [record('/file', sequence, 'update', size, sequence)],
        capture() {
          return { status: 'included', bytes: new Uint8Array(size) };
        },
      });
      session.control(target, { type: 'ack', subscriptionId: 'detached', deliveryId: sequence });
    }
    expect(sent.filter((frame) => frame.type === 'terminal')).toHaveLength(0);
  });

  it('keeps a zero-user source charged until completed exits', () => {
    const sent: ChangeFrame[] = [];
    const contribution = subscriptions().logicalChanges!;
    let session!: ReturnType<typeof contribution.create>;
    const zero = client('zero');
    session = contribution.create({
      generation: 'mount',
      validateTarget() {},
      send(target, frame) {
        sent.push(frame);
        if (target.clientId === zero.clientId && frame.type === 'event')
          session.control(zero, { type: 'ack', subscriptionId: 'zero', deliveryId: frame.deliveryId });
      },
    });
    const size = 16 * 1024 * 1024;
    const options = {
      path: '/',
      scope: 'file' as const,
      recursive: false,
      events: ['create', 'update', 'delete'] as const,
      content: { maxBytes: size },
    };
    session.control(zero, { type: 'register', subscriptionId: 'zero', options: { ...options, path: '/zero' } });
    session.control(zero, { type: 'activate', subscriptionId: 'zero' });
    for (const [id, path] of [
      ['b-0', '/b'],
      ['b-1', '/b'],
      ['c-0', '/c'],
      ['c-1', '/c'],
      ['c-2', '/c'],
    ] as const) {
      const target = client(id, 'channel', 'follower-relay');
      session.control(target, { type: 'register', subscriptionId: id, options: { ...options, path } });
      session.control(target, { type: 'activate', subscriptionId: id });
    }
    const bytes = new Uint8Array(size);
    session.completed({
      records: [
        record('/zero', 1, 'update', size, 1),
        record('/b', 2, 'update', size, 2),
        record('/c', 3, 'update', size, 3),
      ],
      capture() {
        return { status: 'included', bytes };
      },
    });
    expect(sent.find((frame) => frame.type === 'terminal')).toMatchObject({
      subscriptionId: 'c-2',
      code: 'SUBSCRIPTION_OVERFLOW',
    });
  });

  it('accepts content registration and rejects malformed owner wires', () => {
    const { session, register, validateTarget } = fixture();
    const target = client();
    expect(register(target, 'content', { content: { maxBytes: 1 } })).toMatchObject({ type: 'registered' });
    expect(validateTarget).toHaveBeenCalledOnce();
    expect(
      codeOf(() =>
        session.control(target, { type: 'register', subscriptionId: 'bad', options: { ...base, events: [] } }),
      ),
    ).toBe('EINVAL');
  });
});
