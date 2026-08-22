/**
 * The engine puts a machine-readable code in the trailer, as a google.rpc.Status whose
 * details carry a google.rpc.ErrorInfo. This reads the one field worth reading — the
 * reason — without pulling a protobuf runtime into the error path.
 *
 * Nothing here throws. A trailer that is missing, truncated or shaped differently than
 * expected leaves the error exactly as it was, because failing to enrich an error must
 * never become a second, worse error on top of the first.
 */

const ERROR_INFO_SUFFIX = 'google.rpc.ErrorInfo';

const STATUS_DETAILS = 3;
const ANY_TYPE_URL = 1;
const ANY_VALUE = 2;
const ERROR_INFO_REASON = 1;

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED64 = 1;
const WIRE_FIXED32 = 5;

interface Cursor {
  readonly bytes: Uint8Array;
  offset: number;
}

function readVarint(cursor: Cursor): number | undefined {
  let result = 0;
  let shift = 0;

  while (cursor.offset < cursor.bytes.length) {
    const byte = cursor.bytes[cursor.offset]!;
    cursor.offset += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
    if (shift > 56) return undefined;
  }

  return undefined;
}

function readBytes(cursor: Cursor): Uint8Array | undefined {
  const length = readVarint(cursor);
  if (length === undefined) return undefined;
  const end = cursor.offset + length;
  if (end > cursor.bytes.length) return undefined;
  const slice = cursor.bytes.subarray(cursor.offset, end);
  cursor.offset = end;
  return slice;
}

function skip(cursor: Cursor, wireType: number): boolean {
  switch (wireType) {
    case WIRE_VARINT:
      return readVarint(cursor) !== undefined;
    case WIRE_LENGTH_DELIMITED:
      return readBytes(cursor) !== undefined;
    case WIRE_FIXED64:
      cursor.offset += 8;
      return cursor.offset <= cursor.bytes.length;
    case WIRE_FIXED32:
      cursor.offset += 4;
      return cursor.offset <= cursor.bytes.length;
    default:
      return false;
  }
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function reasonFromErrorInfo(bytes: Uint8Array): string | undefined {
  const cursor: Cursor = { bytes, offset: 0 };

  while (cursor.offset < bytes.length) {
    const tag = readVarint(cursor);
    if (tag === undefined) return undefined;
    const field = tag >>> 3;
    const wireType = tag & 0x07;

    if (field === ERROR_INFO_REASON && wireType === WIRE_LENGTH_DELIMITED) {
      const value = readBytes(cursor);
      return value === undefined ? undefined : decodeText(value);
    }
    if (!skip(cursor, wireType)) return undefined;
  }

  return undefined;
}

function reasonFromAny(bytes: Uint8Array): string | undefined {
  const cursor: Cursor = { bytes, offset: 0 };
  let typeUrl: string | undefined;
  let value: Uint8Array | undefined;

  while (cursor.offset < bytes.length) {
    const tag = readVarint(cursor);
    if (tag === undefined) return undefined;
    const field = tag >>> 3;
    const wireType = tag & 0x07;

    if (field === ANY_TYPE_URL && wireType === WIRE_LENGTH_DELIMITED) {
      const raw = readBytes(cursor);
      if (raw === undefined) return undefined;
      typeUrl = decodeText(raw);
      continue;
    }
    if (field === ANY_VALUE && wireType === WIRE_LENGTH_DELIMITED) {
      const raw = readBytes(cursor);
      if (raw === undefined) return undefined;
      value = raw;
      continue;
    }
    if (!skip(cursor, wireType)) return undefined;
  }

  if (typeUrl === undefined || value === undefined) return undefined;
  if (!typeUrl.endsWith(ERROR_INFO_SUFFIX)) return undefined;
  return reasonFromErrorInfo(value);
}

/** The reason inside a serialised google.rpc.Status, or undefined if there is none. */
export function decodeReason(statusBytes: Uint8Array): string | undefined {
  try {
    const cursor: Cursor = { bytes: statusBytes, offset: 0 };

    while (cursor.offset < statusBytes.length) {
      const tag = readVarint(cursor);
      if (tag === undefined) return undefined;
      const field = tag >>> 3;
      const wireType = tag & 0x07;

      if (field === STATUS_DETAILS && wireType === WIRE_LENGTH_DELIMITED) {
        const detail = readBytes(cursor);
        if (detail === undefined) return undefined;
        const reason = reasonFromAny(detail);
        if (reason !== undefined) return reason;
        continue;
      }
      if (!skip(cursor, wireType)) return undefined;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

interface TrailerCarrier {
  metadata?: { get?: (key: string) => unknown };
}

/** Digs the reason out of a gRPC error's trailing metadata. */
export function reasonOf(error: unknown): string | undefined {
  try {
    const metadata = (error as TrailerCarrier)?.metadata;
    if (typeof metadata?.get !== 'function') return undefined;

    const entries = metadata.get('grpc-status-details-bin');
    if (!Array.isArray(entries) || entries.length === 0) return undefined;

    const first = entries[0];
    if (typeof first === 'string') return undefined;
    if (!(first instanceof Uint8Array)) return undefined;

    return decodeReason(first);
  } catch {
    return undefined;
  }
}
