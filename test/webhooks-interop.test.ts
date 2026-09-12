import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import {
  Webhooks,
  CaerusSignatureError,
  CaerusWebhookExpiredError,
  CaerusWebhookPayloadError,
} from '../src/webhooks/index.js';
import { CaerusError } from '../src/errors.js';

const JAVA_HEX = '5e3b7a684499bb93c4402adc4c4c6914c9c19be915d55179ba6b881175fe8775';
const TS = 1724425200;
const PAYLOAD = '{"event_id":"123","eventType":"resource.taken"}';
const SECRET = 'whsec_test_secret_key_123456789';
const SIN_VENCIMIENTO = 10 ** 9;

const firmar = (contenido: string, secreto: string) =>
  crypto.createHmac('sha256', secreto).update(contenido, 'utf8').digest('hex');

const atrapar = (fn: () => unknown): unknown => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('Webhooks contra el motor', () => {
  const wh = new Webhooks();

  it('firma exactamente lo mismo que el motor en Java', () => {
    expect(firmar(`${TS}.${PAYLOAD}`, SECRET)).toBe(JAVA_HEX);
  });

  it('acepta una firma generada por el motor', () => {
    const evento = wh.constructEvent(PAYLOAD, `t=${TS},v1=${JAVA_HEX}`, SECRET, SIN_VENCIMIENTO);

    expect(evento).toMatchObject({ event_id: '123' });
  });

  it('rechaza una firma que no corresponde', () => {
    expect(() =>
      wh.constructEvent(PAYLOAD, `t=${TS},v1=${'0'.repeat(64)}`, SECRET, SIN_VENCIMIENTO),
    ).toThrow(CaerusSignatureError);
  });

  it('rechaza un evento viejo con la tolerancia por defecto', () => {
    expect(() => wh.constructEvent(PAYLOAD, `t=${TS},v1=${JAVA_HEX}`, SECRET)).toThrow(
      CaerusWebhookExpiredError,
    );
  });

  it('rechaza un secreto vacio en vez de verificar contra nada', () => {
    const conVacio = firmar(`${TS}.${PAYLOAD}`, '');

    expect(() =>
      wh.constructEvent(PAYLOAD, `t=${TS},v1=${conVacio}`, '', SIN_VENCIMIENTO),
    ).toThrow(CaerusSignatureError);
    expect(() =>
      wh.constructEvent(PAYLOAD, `t=${TS},v1=${conVacio}`, '   ', SIN_VENCIMIENTO),
    ).toThrow(CaerusSignatureError);
  });

  it('un cuerpo firmado que no es JSON da un error del paquete, no un SyntaxError', () => {
    const cuerpo = 'esto no es json';
    const firma = firmar(`${TS}.${cuerpo}`, SECRET);

    const error = atrapar(() =>
      wh.constructEvent(cuerpo, `t=${TS},v1=${firma}`, SECRET, SIN_VENCIMIENTO),
    );

    expect(error).toBeInstanceOf(CaerusWebhookPayloadError);
    expect(error).not.toBeInstanceOf(SyntaxError);
  });

  it('todos los errores de webhooks se atrapan como CaerusError', () => {
    const errores = [
      atrapar(() => wh.constructEvent(PAYLOAD, '', SECRET)),
      atrapar(() => wh.constructEvent(PAYLOAD, 'sin formato', SECRET)),
      atrapar(() => wh.constructEvent(PAYLOAD, `t=${TS},v1=${JAVA_HEX}`, SECRET)),
      atrapar(() => wh.constructEvent(PAYLOAD, `t=${TS},v1=${JAVA_HEX}`, '', SIN_VENCIMIENTO)),
    ];

    for (const error of errores) {
      expect(error).toBeInstanceOf(CaerusError);
    }
  });
});
