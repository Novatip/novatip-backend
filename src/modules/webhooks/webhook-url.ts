import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../../config.js";

export interface WebhookDestination {
  address: string;
  family: number;
}

function rejectUrl(message: string): never {
  throw Object.assign(new Error(message), {
    statusCode: 400,
    code: "WEBHOOK_URL_NOT_PUBLIC",
  });
}

function parseHttpsUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rejectUrl("Webhook URL must be a valid HTTPS URL.");
  }

  if (url.protocol !== "https:") {
    return rejectUrl("Webhook URL must use HTTPS.");
  }
  return url;
}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }

  const bytes = parts.map(Number);
  return bytes.every((part) => part >= 0 && part <= 255) ? bytes : null;
}

function ipv6Bytes(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];

    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (group.includes(".")) {
        const bytes = ipv4Bytes(group);
        if (!bytes) return null;
        groups.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const left = parseGroups(halves[0]!);
  const right = parseGroups(halves[1] ?? "");
  if (!left || !right) return null;

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;

  return [
    ...left,
    ...Array.from({ length: missing }, () => 0),
    ...right,
  ].flatMap((group) => [group >> 8, group & 0xff]);
}

function isUnsafeIpv4(address: string): boolean {
  const bytes = ipv4Bytes(address);
  if (!bytes) return true;
  const [a, b, c] = bytes as [number, number, number, number];

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 &&
      (b === 0 ||
        b === 168 ||
        (b === 88 && c === 99) ||
        (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function isUnsafeWebhookAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isUnsafeIpv4(address);
  if (version !== 6) return true;

  const bytes = ipv6Bytes(address);
  if (!bytes) return true;

  const isIpv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 255 &&
    bytes[11] === 255;
  if (isIpv4Mapped) {
    return isUnsafeIpv4(bytes.slice(12).join("."));
  }

  const allZero = bytes.every((byte) => byte === 0);
  const loopback =
    bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const uniqueLocal = (bytes[0]! & 0xfe) === 0xfc;
  const linkLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80;
  const multicast = bytes[0] === 0xff;
  const globalUnicast = (bytes[0]! & 0xe0) === 0x20;
  const documentation = bytes[0] === 0x20 && bytes[1] === 0x01 &&
    bytes[2] === 0x0d && bytes[3] === 0xb8;

  return (
    allZero ||
    loopback ||
    uniqueLocal ||
    linkLocal ||
    multicast ||
    !globalUnicast ||
    documentation
  );
}

function assertHostnameIsNotLocal(hostname: string): void {
  const host = normalizedHostname(hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "localhost.localdomain"
  ) {
    rejectUrl("Webhook URLs cannot target localhost.");
  }

  if (isIP(host) !== 0 && isUnsafeWebhookAddress(host)) {
    rejectUrl("Webhook URLs cannot target private or reserved IP addresses.");
  }
}

export function assertWebhookUrlForRegistration(rawUrl: string): void {
  const url = parseHttpsUrl(rawUrl);
  if (config.webhooks.allowPrivateHosts) return;
  assertHostnameIsNotLocal(url.hostname);
}

export function assertAddressesArePublic(
  hostname: string,
  addresses: readonly WebhookDestination[],
): void {
  if (addresses.length === 0) {
    throw new Error(`Webhook hostname ${hostname} resolved to no addresses.`);
  }

  const unsafe = addresses.find(({ address }) =>
    isUnsafeWebhookAddress(address),
  );
  if (unsafe) {
    throw new Error(
      `Webhook hostname ${hostname} resolves to a private or reserved address.`,
    );
  }
}

export async function assertWebhookDestinationAllowed(
  rawUrl: string,
  resolveAddresses: (
    hostname: string,
  ) => Promise<readonly WebhookDestination[]> = async (hostname) =>
    lookup(hostname, { all: true, verbatim: true }),
): Promise<WebhookDestination | undefined> {
  const url = parseHttpsUrl(rawUrl);
  if (config.webhooks.allowPrivateHosts) return undefined;

  const hostname = normalizedHostname(url.hostname);
  assertHostnameIsNotLocal(hostname);
  if (isIP(hostname) !== 0) {
    return { address: hostname, family: isIP(hostname) };
  }

  const addresses = await resolveAddresses(hostname);
  assertAddressesArePublic(hostname, addresses);
  const destination = addresses[0];
  if (destination === undefined) {
    throw new Error(`Webhook hostname ${hostname} resolved to no addresses.`);
  }
  return destination;
}
