/**
 * Type-safe server functions — `@cookedjs/cooked/fn`.
 *
 * Define in a `*.server.ts` file (never bundled into the client — the Vite
 * plugin replaces those modules with RPC stubs):
 *
 *   export const greet = createServerFn()
 *     .middleware(async ({ request, context }) => ({ user: await auth(request) }))
 *     .validator((input: { name: string }) => {
 *       if (typeof input?.name !== "string") throw new ServerFnError("name required");
 *       return { name: input.name.trim() };
 *     })
 *     .handler(({ input, context }) => ({ message: `Hello ${input.name}` }));
 *
 * Client calls `await greet({ name: "x" })` — a typed POST to the SSR server.
 * Server-side calls (during SSR) execute directly, no HTTP.
 *
 * Security model:
 * - Handlers only see validated input: without a `.validator()`, the raw
 *   client payload is discarded and `input` is `undefined`.
 * - Middleware runs before validation — throw `ServerFnError` (e.g. 401/403)
 *   to reject; returned objects merge into `context`.
 * - Only functions created by `createServerFn` are callable over HTTP (the
 *   server checks the brand), and only from modules the plugin discovered.
 * - Unexpected errors never leak: the client sees a generic 500.
 */

type MaybePromise<T> = T | Promise<T>;

/** Validation/authorization failure with an HTTP status. Message IS sent to the client. */
export class ServerFnError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ServerFnError";
    this.status = status;
  }
}

export interface ServerFnCtx<V> {
  /** Validated input (`undefined` when the fn has no validator). */
  input: V;
  /** The incoming request. Undefined for direct server-side calls. */
  request: Request | undefined;
  /** Accumulated middleware context. */
  context: Record<string, unknown>;
}

export type ServerFnMiddleware = (ctx: {
  request: Request | undefined;
  context: Record<string, unknown>;
}) => MaybePromise<void | Record<string, unknown>>;

export type ServerFn<In, Out> = ([In] extends [undefined]
  ? (input?: In) => Promise<Out>
  : (input: In) => Promise<Out>) & {
  /** @internal brand checked by the SSR server before dispatch */
  __cookedServerFn: true;
  /** @internal full pipeline: middleware -> validator -> handler */
  __run(input: unknown, request?: Request): Promise<unknown>;
};

export interface ServerFnBuilder<In, V> {
  /** Add middleware. Returned objects merge into `context`; throw to reject. */
  middleware(fn: ServerFnMiddleware): ServerFnBuilder<In, V>;
  /** Validate (and type) the client input. `I` is what callers must pass. */
  validator<I, O>(fn: (input: I) => O): ServerFnBuilder<I, O>;
  /** Finish with the handler. Its return value is JSON-serialized to the client. */
  handler<R>(fn: (ctx: ServerFnCtx<V>) => MaybePromise<R>): ServerFn<In, R>;
}

export function createServerFn(): ServerFnBuilder<undefined, undefined> {
  return makeBuilder<undefined, undefined>([], undefined);
}

function makeBuilder<In, V>(
  middlewares: ServerFnMiddleware[],
  validate: ((input: unknown) => unknown) | undefined,
): ServerFnBuilder<In, V> {
  const builder: ServerFnBuilder<In, V> = {
    middleware(fn) {
      return makeBuilder<In, V>([...middlewares, fn], validate);
    },
    validator(fn) {
      return makeBuilder([...middlewares], fn as (input: unknown) => unknown) as never;
    },
    handler(fn) {
      const run = async (rawInput: unknown, request?: Request): Promise<unknown> => {
        let context: Record<string, unknown> = {};
        for (const middleware of middlewares) {
          const extra = await middleware({ request, context });
          if (extra && typeof extra === "object") context = { ...context, ...extra };
        }
        // No validator -> the raw payload is never exposed to the handler.
        const input = validate ? validate(rawInput) : undefined;
        return fn({ input: input as V, request, context });
      };
      const callable = (async (input?: unknown) => run(input)) as ServerFn<In, never>;
      callable.__cookedServerFn = true;
      callable.__run = run;
      return callable as never;
    },
  };
  return builder;
}
