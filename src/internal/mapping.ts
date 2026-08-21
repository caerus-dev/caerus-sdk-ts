import { CaerusError, ConflictError } from '../errors.js';
import type {
  Metadata,
  ResourceHolder,
  ResourceHolderPage,
  ResourceHolderStatus,
  Resource,
  ResourcePage,
} from '../types.js';
import {
  ResourceHolderResponse_ResourceHolderStatus as WireStatus,
  type GetResourceHoldersListResponse,
  type GetResourcesByGroupKeyResponse,
  type ResourceHolderResponse,
  type ResourceResponse,
} from '../generated/sre_service.js';

/**
 * The translation layer between protobuf's shapes and the ones this package publishes.
 *
 * Everything awkward about the wire format is dealt with exactly once, right here:
 * metadata as a string, timestamps in seconds, statuses as integers.
 */

/** Objects go out as JSON text, which is what the contract carries. */
export function encodeMetadata(metadata: Metadata | undefined): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  return JSON.stringify(metadata);
}

/**
 * And come back as objects.
 *
 * A blank value means there is none. Anything else has to parse: the alternative is
 * returning undefined for metadata that is really there, which reads as "no metadata"
 * and is the more expensive mistake.
 *
 * Worth knowing: the engine does not check that metadata is JSON, it only checks whether
 * the template allows any. A client other than this SDK can store plain text, and this
 * is where that surfaces.
 */
export function decodeMetadata(raw: string | undefined, context: string): Metadata | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('metadata is not a JSON object');
    }
    return parsed as Metadata;
  } catch (cause) {
    throw new CaerusError(
      `The metadata stored for ${context} is not a JSON object, so it cannot be returned as one. ` +
        `Raw value: ${raw}`,
      'UNKNOWN',
      { cause },
    );
  }
}

/** Epoch seconds on the wire, a Date in the API. */
export function decodeExpiresAt(epochSeconds: number): Date {
  return new Date(epochSeconds * 1000);
}

/**
 * Epoch milliseconds on the wire, a Date in the API, and absent when the engine
 * did not send one: proto3 turns a missing int64 into a zero, and a zero here
 * would otherwise read as January 1970 rather than as "unknown".
 */
export function decodeTimestampMs(epochMs: number | undefined): Date | undefined {
  if (epochMs === undefined || epochMs === 0) return undefined;
  return new Date(epochMs);
}

const STATUS_BY_WIRE: Record<number, ResourceHolderStatus> = {
  [WireStatus.PENDING]: 'PENDING',
  [WireStatus.CONFIRMED]: 'CONFIRMED',
  [WireStatus.RELEASED]: 'RELEASED',
  [WireStatus.QUEUED]: 'QUEUED',
  [WireStatus.EXPIRED]: 'EXPIRED',
};

export function decodeStatus(wire: number, context: string): ResourceHolderStatus {
  const status = STATUS_BY_WIRE[wire];
  if (status === undefined) {
    // A status this version does not know about. Guessing would be worse.
    throw new CaerusError(
      `Caerus reported an unknown status (${wire}) for ${context}. Update @caerus-dev/sdk.`,
    );
  }
  return status;
}

const WIRE_BY_STATUS: Record<ResourceHolderStatus, WireStatus> = {
  PENDING: WireStatus.PENDING,
  CONFIRMED: WireStatus.CONFIRMED,
  RELEASED: WireStatus.RELEASED,
  QUEUED: WireStatus.QUEUED,
  EXPIRED: WireStatus.EXPIRED,
};

/** The other direction, for filtering a query by status. */
export function encodeStatus(status: ResourceHolderStatus): WireStatus {
  return WIRE_BY_STATUS[status];
}

export function toResourceHolder(response: ResourceHolderResponse): ResourceHolder {
  const context = `holder ${response.holderId}`;

  return {
    id: response.holderId,
    resourceId: response.resourceId,
    status: decodeStatus(response.status, context),
    amount: response.amount,
    expiresAt: decodeExpiresAt(response.expiresAt),
    metadata: decodeMetadata(response.metadata, context),
    createdAt: decodeTimestampMs(response.createdAtMs),
  };
}

export function toResource(response: ResourceResponse): Resource {
  return {
    id: response.resourceId,
    key: response.key,
    templateId: response.templateId,
    availableAmount: response.availableAmount,
    pendingCount: response.pendingCount,
    groupKey: response.groupKey === '' ? undefined : response.groupKey,
    metadata: decodeMetadata(response.metadata, `resource ${response.key}`),
    createdAt: decodeTimestampMs(response.createdAtMs),
    updatedAt: decodeTimestampMs(response.updatedAtMs),
  };
}

export function toResourcePage(response: GetResourcesByGroupKeyResponse): ResourcePage {
  return {
    resources: response.resources.map(toResource),
    hasNextPage: response.nextPage,
  };
}

export function toResourceHolderPage(
  response: GetResourceHoldersListResponse,
): ResourceHolderPage {
  return {
    holders: response.resourceHolders.map(toResourceHolder),
    hasNextPage: response.nextPage,
  };
}

/**
 * A holder that came back in a state the operation cannot produce is not one you can
 * use. Handing it over as if the call had worked is the trap this guards: a caller who
 * checks only for a thrown error would carry on believing they hold the seat.
 *
 * Which states count depends on the call, which is why they are passed in: a CONFIRMED
 * holder is the whole point of confirm and a failure coming back from take.
 *
 * The states that surprise people arrive through an idempotency key whose original
 * holder has since finished. The engine is right to replay it — same key, same holder —
 * and the caller is still not holding anything.
 *
 * Queries are exempt: asking what state a holder is in and being told RELEASED is an
 * answer, not a failure.
 */
export function assertUsable(
  holder: ResourceHolder,
  usable: readonly ResourceHolderStatus[],
): ResourceHolder {
  if (usable.includes(holder.status)) return holder;
  throw new ConflictError(
    `Caerus returned holder ${holder.id} as ${holder.status}, which this call cannot use.`,
  );
}
