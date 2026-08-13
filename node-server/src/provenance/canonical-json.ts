import { createHash } from 'crypto';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

/**
 * Cross-runtime hash profile used by every structured Nebula provenance hash.
 *
 * This value is included in the encoded root, so future profiles cannot share
 * a digest with this one even when their value encodings happen to match.
 */
export const CANONICAL_HASH_PROFILE = 'nebula-canonical-hash-v1' as const;

/**
 * Serialize a JSON value deterministically.
 *
 * Object keys are sorted recursively. Values that regular JSON.stringify
 * silently drops or coerces are rejected: provenance hashes must never depend
 * on an implicit lossy conversion.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new WeakSet<object>(), '$');
}

export function sha256Hex(value: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Convert a JSON-like value to an injective, language-neutral typed tree.
 *
 * - Object keys use Unicode scalar/code-point order rather than JavaScript's
 *   UTF-16 code-unit order.
 * - Safe integral numbers share one integer representation.
 * - Every other finite Number, including -0 and unsafe integral Numbers, is
 *   represented by its exact big-endian IEEE-754 binary64 bits.
 * - Strings containing unpaired UTF-16 surrogates are rejected.
 *
 * The returned tree itself contains only JSON values, and contains no dynamic
 * object keys, so regular JSON serialization is deterministic cross-runtime.
 */
export function canonicalizeForHash(value: unknown): CanonicalJsonValue {
  return [
    CANONICAL_HASH_PROFILE,
    encodeForHash(value, new WeakSet<object>(), '$'),
  ];
}

/** Serialize the typed cross-runtime representation used as SHA-256 input. */
export function hashCanonicalJson(value: unknown): string {
  return canonicalJson(canonicalizeForHash(value));
}

export function sha256Canonical(value: unknown): string {
  return sha256Hex(hashCanonicalJson(value));
}

function encodeForHash(
  value: unknown,
  ancestors: WeakSet<object>,
  location: string,
): CanonicalJsonValue {
  if (value === null) return ['null'];

  switch (typeof value) {
    case 'boolean':
      return ['boolean', value];
    case 'string':
      assertUnicodeScalarString(value, location);
      return ['string', value];
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`Canonical hash requires finite numbers at ${location}`);
      }
      if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
        return ['integer', value];
      }
      return ['float64', float64Hex(value)];
    case 'undefined':
      throw new TypeError(`Canonical hash cannot encode undefined at ${location}`);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`Canonical hash cannot encode ${typeof value} at ${location}`);
    case 'object':
      break;
    default:
      throw new TypeError(`Canonical hash cannot encode value at ${location}`);
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new TypeError(`Canonical hash cannot encode a cyclic value at ${location}`);
  }
  ancestors.add(objectValue);

  try {
    if (Array.isArray(value)) {
      const items: CanonicalJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError(`Canonical hash cannot encode a sparse array at ${location}[${index}]`);
        }
        items.push(encodeForHash(value[index], ancestors, `${location}[${index}]`));
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError(`Canonical hash cannot encode symbol keys at ${location}`);
      }
      return ['array', items];
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Canonical hash requires a plain object at ${location}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Canonical hash cannot encode symbol keys at ${location}`);
    }

    const record = value as Record<string, unknown>;
    const pairs: CanonicalJsonValue[] = [];
    const keys = Object.keys(record);
    for (const key of keys) assertUnicodeScalarString(key, `${location} object key`);
    keys.sort(compareUnicodeCodePoints);
    for (const key of keys) {
      pairs.push([
        key,
        encodeForHash(record[key], ancestors, `${location}.${key}`),
      ]);
    }
    return ['object', pairs];
  } finally {
    ancestors.delete(objectValue);
  }
}

function float64Hex(value: number): string {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(value, 0);
  return bytes.toString('hex');
}

function assertUnicodeScalarString(value: string, location: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        throw new TypeError(`Canonical hash requires Unicode scalar strings at ${location}`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`Canonical hash requires Unicode scalar strings at ${location}`);
    }
  }
}

function compareUnicodeCodePoints(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex)!;
    const rightPoint = right.codePointAt(rightIndex)!;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  return (left.length - leftIndex) - (right.length - rightIndex);
}

function serializeCanonical(value: unknown, ancestors: WeakSet<object>, location: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`Canonical JSON requires finite numbers at ${location}`);
      }
      // JSON.stringify canonicalizes -0 to 0, which is the desired JSON value.
      return JSON.stringify(value);
    case 'undefined':
      throw new TypeError(`Canonical JSON cannot encode undefined at ${location}`);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`Canonical JSON cannot encode ${typeof value} at ${location}`);
    case 'object':
      break;
    default:
      throw new TypeError(`Canonical JSON cannot encode value at ${location}`);
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new TypeError(`Canonical JSON cannot encode a cyclic value at ${location}`);
  }
  ancestors.add(objectValue);

  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError(`Canonical JSON cannot encode a sparse array at ${location}[${index}]`);
        }
        items.push(serializeCanonical(value[index], ancestors, `${location}[${index}]`));
      }
      return `[${items.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Canonical JSON requires a plain object at ${location}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Canonical JSON cannot encode symbol keys at ${location}`);
    }

    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key], ancestors, `${location}.${key}`)}`);
    return `{${properties.join(',')}}`;
  } finally {
    ancestors.delete(objectValue);
  }
}
