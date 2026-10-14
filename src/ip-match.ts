/**
 * IP/CIDR parsing and matching for the allowlist form of `trustedProxies` (see `client-ip.ts`).
 * Self-contained - no dependency on a validation library - since this package has none otherwise.
 *
 * Known gap: an IPv4-mapped IPv6 address (`::ffff:203.0.113.5`, what a dual-stack socket or a
 * NAT64 gateway can hand back for an IPv4 peer) is unmapped to its 4-byte form before matching, so
 * an IPv4 CIDR entry still matches it. The legacy IPv4-*compatible* form (`::203.0.113.5`, deprecated
 * since 2006) is not - vanishingly unlikely to appear in a forwarding header today.
 */

const IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d|0)$/;

/** Parses a plain (no `/prefix`) IPv4 address into its 4 bytes, or `null` if it isn't one. */
function parseIPv4(ip: string): Uint8Array | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    // reject "01", "001": ambiguous with the old octal-octet convention some parsers still honor
    if (!part || !IPV4_OCTET.test(part) || (part.length > 1 && part.startsWith("0"))) return null;
    bytes[i] = Number(part);
  }
  return bytes;
}

const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

/** Expands a (possibly `::`-compressed) IPv6 address into its 8 hex groups, or `null`. */
function expandIPv6(ip: string): string[] | null {
  // an IPv4-mapped tail ("::ffff:203.0.113.5"): fold the dotted quad into two hex groups first,
  // so the rest of this function only ever deals with plain IPv6 syntax
  const dotted = ip.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let value = ip;
  if (dotted) {
    const v4 = parseIPv4(dotted[2]!);
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    value = `${dotted[1]}${hi}:${lo}`;
  }

  const compressions = value.split("::").length - 1;
  if (compressions > 1) return null; // "::" may appear at most once

  const sides = value.split("::");
  const left = sides[0] ? sides[0].split(":") : [];
  const right = compressions === 1 ? (sides[1] ? sides[1].split(":") : []) : [];
  if (compressions === 0 && left.length !== 8) return null;

  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  if (compressions === 0 && missing !== 0) return null;

  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((g) => !HEX_GROUP.test(g))) return null;
  return groups;
}

/** Parses a plain IPv6 address into its 16 bytes, or `null` if it isn't one. */
function parseIPv6(ip: string): Uint8Array | null {
  const groups = expandIPv6(ip);
  if (!groups) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const value = Number.parseInt(groups[i]!, 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/**
 * An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, `::ffff:0:0/96`) is what a dual-stack socket or a
 * NAT64 gateway can hand back for an IPv4 peer. Unmapped to its 4-byte form so it matches an IPv4
 * CIDR entry directly, the same address either family would otherwise disagree about.
 */
function unmapIPv4(bytes: Uint8Array): Uint8Array {
  const isMapped =
    bytes.length === 16 &&
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  return isMapped ? bytes.slice(12, 16) : bytes;
}

/** Parses a plain IP address (v4 or v6) into its bytes, or `null` if it's neither. */
export function parseIp(ip: string): Uint8Array | null {
  const bytes = ip.includes(":") ? parseIPv6(ip) : parseIPv4(ip);
  return bytes && unmapIPv4(bytes);
}

export type ParsedCidr = { bytes: Uint8Array; prefix: number };

/**
 * Parses `ip` or `ip/prefix` into network bytes and a prefix length, or `null` if it's neither a
 * valid address nor a valid range for its family (prefix must be digits only, and no larger than
 * the address's own bit width - so a malformed entry can never silently become "match everything").
 */
export function parseCidr(value: string): ParsedCidr | null {
  const slash = value.lastIndexOf("/");
  const bytes = parseIp(slash === -1 ? value : value.slice(0, slash));
  if (!bytes) return null;
  const maxBits = bytes.length * 8;
  if (slash === -1) return { bytes, prefix: maxBits };
  const prefixPart = value.slice(slash + 1);
  if (!/^\d+$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  return prefix <= maxBits ? { bytes, prefix } : null;
}

/** Whether `ipBytes` falls inside an already-parsed CIDR range. Different families never match. */
export function matchesCidr(ipBytes: Uint8Array, net: ParsedCidr): boolean {
  if (ipBytes.length !== net.bytes.length) return false;
  let bitsRemaining = net.prefix;
  for (let i = 0; i < ipBytes.length && bitsRemaining > 0; i++) {
    const take = Math.min(8, bitsRemaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if (((ipBytes[i] ?? 0) & mask) !== ((net.bytes[i] ?? 0) & mask)) return false;
    bitsRemaining -= 8;
  }
  return true;
}
