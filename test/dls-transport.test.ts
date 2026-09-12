import { describe, expect, it } from 'vitest';
import { DlsTransport } from '../src/dls/internal/dls-transport.js';
import { DlsError } from '../src/dls/dls-errors.js';

describe('DlsTransport', () => {
  it('instantiates correctly and provides metadata', () => {
    const transport = new DlsTransport({
      endpoint: 'localhost:9090',
      apiKey: 'secret',
      tls: false,
      timeoutMs: 1000,
      logger: { error: () => {} },
    });

    const meta = transport.buildMetadata();
    expect(meta.get('authorization')).toEqual(['Bearer secret']);
  });

  it('rejects calls when closed', async () => {
    const transport = new DlsTransport({
      endpoint: 'localhost:9090',
      apiKey: 'secret',
      tls: false,
      timeoutMs: 1000,
      logger: { error: () => {} },
    });

    transport.close();

    await expect(
      transport.unary(transport.raw.beginTransaction, {} as any)
    ).rejects.toThrow(DlsError);

    await expect(
      transport.acquireLockStream({} as any)
    ).rejects.toThrow(DlsError);
  });
});
