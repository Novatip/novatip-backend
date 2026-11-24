import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:https";
import { Readable } from "node:stream";
import type { WebhookDestination } from "./webhook-url.js";

export function createPinnedLookup(
  destination: WebhookDestination,
): NonNullable<RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [
        { address: destination.address, family: destination.family },
      ]);
    } else {
      callback(null, destination.address, destination.family);
    }
  };
}

/**
 * Send a webhook request using the address already checked by the SSRF guard.
 * The ordinary fetch path is retained only when private destinations are
 * explicitly allowed for local development.
 */
export async function postWebhook(
  url: string,
  init: RequestInit,
  destination?: WebhookDestination,
): Promise<Response> {
  if (destination === undefined) return fetch(url, init);

  const parsedUrl = new URL(url);
  const requestBody = init.body;
  if (typeof requestBody !== "string") {
    throw new TypeError("Webhook request body must be a string.");
  }

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });

  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      parsedUrl,
      {
        method: init.method,
        headers,
        signal: init.signal ?? undefined,
        lookup: createPinnedLookup(destination),
      },
      (response) => {
        const status = response.statusCode ?? 502;
        if (status < 200 || status > 599) {
          response.destroy();
          reject(new Error(`Unsupported webhook response status ${status}.`));
          return;
        }

        const body =
          status === 204 || status === 205 || status === 304
            ? null
            : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status }));
      },
    );
    request.once("error", reject);
    request.end(requestBody);
  });
}
