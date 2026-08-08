import { CaerusError, ConflictError } from '../errors.js';
import type {
  Metadata,
  ResourceHolder,
  ResourceHolderStatus,
  Resource,
  ResourcePage,
} from '../types.js';
import {
  ResourceHolderResponse_ResourceHolderStatus as WireStatus,
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

export function toResourceHolder(response: ResourceHolderResponse): ResourceHolder {
  const context = `holder ${response.holderId}`;

  return {
    id: response.holderId,
    resourceId: response.resourceId,
    status: decodeStatus(response.status, context),
    amount: response.amount,
    expiresAt: decodeExpiresAt(response.expiresAt),
    metadata: decodeMetadata(response.metadata, context),
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
  };
}

export function toResourcePage(response: GetResourcesByGroupKeyResponse): ResourcePage {
  return {
    resources: response.resources.map(toResource),
    hasNextPage: response.nextPage,
  };
}

/**
 * A holder that came back EXPIRED is not one you can use. Handing it over as if the
 * call had worked is the trap this guards: a caller who checks only for a thrown error
 * would carry on believing they hold the seat.
 *
 * Queries are exempt — asking what state a holder is in and being told EXPIRED is
 * an answer, not a failure.
 */
export function assertUsable(holder: ResourceHolder): ResourceHolder {
  if (holder.status === 'EXPIRED') {
    throw new ConflictError(`Caerus could not hold ${holder.id}: its status is EXPIRED.`);
  }
  return holder;
}
