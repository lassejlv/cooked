/**
 * Client stub for server functions. The Vite plugin rewrites `*.server.ts`
 * modules in the client bundle to calls of `serverFnClient`, so server code
 * never ships to the browser.
 */

export const SERVER_FN_ENDPOINT = "/_cooked/fn/";

export function serverFnClient(id: string): (input?: unknown) => Promise<unknown> {
  return async (input?: unknown) => {
    const response = await fetch(SERVER_FN_ENDPOINT + encodeURIComponent(id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: input ?? null }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      result?: unknown;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(data.error ?? `Server function failed (${response.status})`);
    }
    return data.result;
  };
}
