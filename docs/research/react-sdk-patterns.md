# React SDK research

Research date: 2026-09-25. This note records external evidence for the first React SDK spec. Recommendations are proposals, not implemented behavior or performance results. Sources are upstream documentation, source code, browser vendor documentation, and the Storage Standard.

## Libraries worth borrowing from

GitHub displayed these rounded star counts when checked. They establish broad adoption, not correctness or suitability for OPFS.

| Library                                                                 | Stars | Relevant pattern                                                               |
| ----------------------------------------------------------------------- | ----: | ------------------------------------------------------------------------------ |
| [Zustand](https://github.com/pmndrs/zustand)                            | 58.7k | Pass a stable vanilla store through context, then subscribe to selected state. |
| [TanStack Query](https://github.com/TanStack/query)                     | 50.4k | Separate async reads, mutations, background refresh, and optional Suspense.    |
| [SWR](https://github.com/vercel/swr)                                    | 32.5k | Small hook results with data, loading, and error; keyed subscription sharing.  |
| [Dexie](https://github.com/dexie/Dexie.js)                              | 14.6k | React queries over browser persistence that update after relevant writes.      |
| [react-error-boundary](https://github.com/bvaughn/react-error-boundary) |  8.0k | Application-owned fallback UI, explicit error reporting and reset.             |

### Scope and subscriptions

Zustand recommends passing a vanilla store through React context when instances need dependency injection or initialization from props. Consumers read the store from context and use a selector. This separates instance selection from changing state. [Zustand context example](https://github.com/pmndrs/zustand#react-context)

SWR's subscription implementation scopes subscriptions by cache boundary and serialized key, maintains a reference count, and disposes the source subscription when its last observer leaves. Its callback accepts errors and new data separately. This is a concrete precedent for sharing one folder watch between a hook and a children-function component. The inspected source labels this API experimental, so borrow the mechanism rather than promise API compatibility. [SWR subscription source](https://github.com/vercel/swr/blob/main/src/subscription/index.ts)

Dexie's `useLiveQuery` reruns observed queries after relevant mutations. It documents that direct IndexedDB writes and other wrappers do not trigger observation; mutations through Dexie can propagate across same-origin workers and tabs. Reactive coverage belongs in the public contract. [Dexie live queries](<https://dexie.org/docs/dexie-react-hooks/useLiveQuery()>)

Recommendation: put a stable volume binding in context, with immutable resource snapshots underneath. Share observers by actual volume identity and normalized resource key. A children-function component should call the same hook, so its loading, failure, and unsubscribe behavior cannot drift. Named-volume lookup is an SDK decision; these libraries do not establish the desired lexical lookup rules.

### Read errors, write errors, and retry

TanStack offers separate Suspense hooks with defined data. Its default Suspense error policy throws when no cached data exists, but permits existing data to remain visible after a refresh failure. Error-boundary reset must also reset the failed query. [TanStack Suspense and reset](https://tanstack.com/query/latest/docs/framework/react/guides/suspense)

React error boundaries catch render errors. Ordinary event-handler exceptions and later Promise rejections require explicit handling; `react-error-boundary` offers `useErrorBoundary` for forwarding caught failures. Its fallback API exposes reset, and `onReset` can repair the underlying state. React 19 Actions are a documented exception for errors propagated through `useTransition`. [Error boundary behavior](https://github.com/bvaughn/react-error-boundary#what-errors-are-caught)

Recommendation: make ordinary hooks expose state and typed errors; make mutations return an explicitly documented result or rejecting Promise. Do not assume an enclosing boundary handles a click-triggered write. Keep last successful read data alongside a refresh error, and distinguish clearing an error display from retrying an operation. Never replay a write merely because a component rerendered or a boundary reset.

React's `useActionState` supplies pending state and ordered Action dispatch. Uncaught Action errors reach the nearest error boundary. This supports keeping React SDK mutations as generation-pinned promise-returning operations, with expected save conflicts handled inside the application's Action. Parallel work still needs each outcome handled. [React Actions](https://react.dev/reference/react/useActionState)

## React constraints

`useSyncExternalStore` needs a synchronous snapshot getter. Unchanged state must return the same snapshot identity; mutable internals need cached immutable snapshots. Its subscription returns cleanup. A server snapshot must match initial hydration. React advises against suspending as a consequence of external-store changes because these updates cannot become nonblocking transitions and can replace visible content with a fallback. [React external-store reference](https://react.dev/reference/react/useSyncExternalStore)

The current React documentation explicitly supports reading cached Promises with `use` without a framework. Suspense does not automatically observe work started in Effects or event handlers. A component that suspends before first mount loses that render's state, so a promise stored only in that component's state or memo is not a durable cache. [React Suspense](https://react.dev/reference/react/Suspense)

Promises passed to `use` must retain identity across retries. Even adding `.then()` during render creates a new Promise. React's guide shows a cache outside the suspending component, prefers creating Promises before render when possible, and says rejected Promises propagate to an error boundary. [React promise caching](https://react.dev/reference/react/use#caching-promises-for-client-components)

Recommendation: ship explicit loading/error hooks as the baseline. If Suspense is included, use a separate opt-in read contract with a cached initial read and explicit retry invalidation. Keep resolved snapshots visible during watch-triggered refresh. Place the volume lifecycle owner above the suspending subtree. Do not open workers or acquire filesystem locks as render side effects, and do not confuse retention of a cached read with indefinite retention of decrypted content.

Strict Mode deliberately repeats renders and Effect setup/cleanup in development. A provider must survive these checks without duplicate clients, observers, persistence requests, or premature shared-client closure. [React Strict Mode](https://react.dev/reference/react/StrictMode)

Recommendation: test initial suspension, abandoned render, Strict Mode remount, provider replacement, and final unsubscribe separately. Cache identity and subscription lifetime need not equal worker lifetime. The core's ownership rules must decide when a worker can close safely.

## Persistent storage

`navigator.storage.persist()` is secure-context and Window-only. It requests persistence for the default bucket associated with the storage key, rather than for one application-defined volume. The Promise resolves to a boolean; it can reject when storage cannot be obtained. The standard cautions against concurrent permission questions for one origin. [Storage Standard API](https://storage.spec.whatwg.org/#api)

The SDK cannot promise a visible browser prompt. WebKit documents heuristic granting, including whether the site runs as a Home Screen Web App. Storage estimates do not guarantee that a write of that size will succeed, and quota errors still require handling. [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)

Recommendation: call the feature an automatic persistence request. Default it off, keep a manual action, and deduplicate across providers in the page. Report unavailable, pending, granted, not granted, and failed states without treating a normal `false` result as a volume-open failure. Keep persistence status separate from write durability and backups. Persistence does not stop the user clearing site data.

## Whether to depend on TanStack Query

TanStack's defaults include background refetch on mount, focus, and reconnect, three retries, and five-minute inactive cache retention. Default structural sharing applies to JSON-compatible values, so binary file results need care. [TanStack defaults](https://github.com/TanStack/query/blob/main/docs/framework/react/guides/important-defaults.md)

Recommendation: start with React and the core watch contract. A narrow SDK needs read deduplication, snapshots, generation checks, and subscriber cleanup; it does not yet need a general query framework. Reconsider Query if requirements expand to configurable retries, eviction policies, prefetching, pagination, and complex optimistic updates. If adopted, configure local-storage behavior deliberately. Network reconnect is not proof that an OPFS query became stale. Avoid owning the same resource in two independent caches.

## Whether Effect v4 is a prerequisite

The visible upstream release listing showed `effect@4.0.0-rc.117`, marked prerelease and released September 20. The February beta announcement is historical evidence, not proof that the current release remains beta. Check the selected version again at implementation time. [Effect releases](https://github.com/Effect-TS/effect/releases)

Effect v4 models expected errors in the `Effect` error type, with recovery through `Effect.catch` and `Effect.catchTag`. Unexpected defects are separate and remain in `Cause`, alongside interruptions. This helps internal composition; it does not remove the need for a stable serialized error contract between worker and React. [Effect v4 error model](https://effect.website/docs/v4/error-management/two-error-types)

The Effect team reports a faster rewritten runtime and smaller bundles relative to v3. Its example using Effect, Stream, and Schema falls from roughly 70 kB to 20 kB. These are upstream claims about another baseline, not measurements against this library's existing Promise and worker implementation. [Effect v4 announcement](https://effect.website/blog/releases/effect/40-beta)

Recommendation: define error codes, operation metadata, and worker transport first. Keep a core rewrite out of the React SDK's prerequisites. If lifecycle/error complexity warrants a trial, port one representative orchestration path and compare the same workloads before committing. Include throughput, latency distribution, CPU, allocations, bundle size, worker startup, and recovery behavior; test cold and warm reads, small and large writes, concurrent tabs, and encrypted operations. No evidence gathered here establishes zero performance impact.
