import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import { InMemoryCaerusClient } from '../src/index.js';
import { Webhooks, CaerusSignatureError, CaerusWebhookExpiredError } from '../src/webhooks/index.js';

describe('Webhooks', () => {
  const webhooks = new Webhooks();
  const secret = 'test_secret_key';
  
  const generateSignatureHeader = (
    payload: string, 
    timestamp: number, 
    customSecret: string = secret
  ): string => {
    const contentToSign = `${timestamp}.${payload}`;
    const signature = crypto
      .createHmac('sha256', customSecret)
      .update(contentToSign, 'utf8')
      .digest('hex');
    return `t=${timestamp},v1=${signature}`;
  };

  it('constructs an event with a valid signature and payload', () => {
    const payload = JSON.stringify({
      id: 'evt_123',
      eventId: 'evt_123',
      eventType: 'resource.taken',
      product: 'SRE',
      objectType: 'RESOURCE_HOLDER',
      objectId: 'h_123',
      environmentId: 'env_abc',
      occurredAt: '2026-08-29T15:00:00Z',
      data: {
        eventId: 'evt_123',
        occurredOn: '2026-08-29T15:00:00Z',
        holderId: 'h_123',
        resourceKey: 'seat_A12',
        amount: 1,
        expiresAt: 1000,
        createdAtMs: 1700000000000,
      }
    });
    
    const timestamp = Math.floor(Date.now() / 1000);
    const header = generateSignatureHeader(payload, timestamp);
    
    const event = webhooks.constructEvent(payload, header, secret);
    
    expect(event.eventType).toBe('resource.taken');
    expect(event.eventId).toBe('evt_123');
    expect(event.product).toBe('SRE');
  });

  it('handles payload as a Buffer', () => {
    const payloadStr = JSON.stringify({ eventType: 'resource.taken' });
    const payloadBuf = Buffer.from(payloadStr, 'utf8');
    
    const timestamp = Math.floor(Date.now() / 1000);
    const header = generateSignatureHeader(payloadStr, timestamp);
    
    const event = webhooks.constructEvent(payloadBuf, header, secret);
    expect(event.eventType).toBe('resource.taken');
  });

  it('throws CaerusSignatureError if header is missing', () => {
    expect(() => {
      webhooks.constructEvent('{}', '', secret);
    }).toThrow(CaerusSignatureError);
  });

  it('throws CaerusSignatureError on invalid signature format', () => {
    expect(() => {
      webhooks.constructEvent('{}', 't=123,v2=invalid', secret);
    }).toThrow(CaerusSignatureError);
  });

  it('throws CaerusWebhookExpiredError if outside tolerance zone', () => {
    const payload = '{}';
    // 6 minutes ago
    const timestamp = Math.floor(Date.now() / 1000) - 360; 
    const header = generateSignatureHeader(payload, timestamp);
    
    expect(() => {
      webhooks.constructEvent(payload, header, secret, 300);
    }).toThrow(CaerusWebhookExpiredError);
  });

  it('accepts event within tolerance zone', () => {
    const payload = '{"eventType":"test"}';
    // 4 minutes ago
    const timestamp = Math.floor(Date.now() / 1000) - 240; 
    const header = generateSignatureHeader(payload, timestamp);
    
    const event = webhooks.constructEvent(payload, header, secret, 300);
    expect(event.eventType).toBe('test');
  });

  it('supports key rollover (multiple signatures)', () => {
    const payload = '{"eventType":"test"}';
    const timestamp = Math.floor(Date.now() / 1000);
    
    const oldHeader = generateSignatureHeader(payload, timestamp, 'old_secret');
    const newHeader = generateSignatureHeader(payload, timestamp, secret);
    
    // Combine both signatures
    const oldSig = oldHeader.split(',')[1];
    const newSig = newHeader.split(',')[1];
    const combinedHeader = `t=${timestamp},${oldSig},${newSig}`;
    
    const event = webhooks.constructEvent(payload, combinedHeader, secret);
    expect(event.eventType).toBe('test');
  });

  it('throws CaerusSignatureError for invalid secret (mismatch)', () => {
    const payload = '{"eventType":"test"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const header = generateSignatureHeader(payload, timestamp, 'wrong_secret');
    
    expect(() => {
      webhooks.constructEvent(payload, header, secret);
    }).toThrow(CaerusSignatureError);
    
    try {
      webhooks.constructEvent(payload, header, secret);
    } catch (err: any) {
      expect(err.message).toBe('No matching signature found.');
    }
  });

  it('prevents timing attacks with signatures of different lengths', () => {
    const payload = '{"eventType":"test"}';
    const timestamp = Math.floor(Date.now() / 1000);
    // Real signature is 64 hex chars (sha256). We test with shorter and longer.
    const headerShort = `t=${timestamp},v1=1234567890abcdef`;
    const headerLong = `t=${timestamp},v1=` + 'a'.repeat(100);
    
    expect(() => {
      webhooks.constructEvent(payload, headerShort, secret);
    }).toThrow(CaerusSignatureError);

    expect(() => {
      webhooks.constructEvent(payload, headerLong, secret);
    }).toThrow(CaerusSignatureError);
  });
});

describe('Client integration', () => {
  it('exposes webhooks on InMemoryCaerusClient', () => {
    const client = new InMemoryCaerusClient();
    expect(client.webhooks).toBeDefined();
    expect(typeof client.webhooks.constructEvent).toBe('function');
  });
});
