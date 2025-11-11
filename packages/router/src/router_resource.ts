import {
  computed,
  Injector,
  Signal,
  signal,
  WritableSignal,
  untracked,
  ValueEqualityFn,
  ResourceStreamItem,
  ɵBaseWritableResource as BaseWritableResource,
  effect,
  ɵResourceKernel as ResourceKernel,
  ResourceStatus,
  ResourceStreamingLoader,
  WritableResource,
  ɵResourceState as ResourceState,
  ɵprojectStatusOfState as projectStatusOfState,
  inject,
  ResourceLoaderParams,
  PromiseResourceOptions,
} from '@angular/core';
import {deepEqual} from './utils/collection';

/**
 * @experimental
 * @publicApi
 */
export class RouterResource<T, R> extends BaseWritableResource<T> implements WritableResource<T> {
  private readonly kernel: ResourceKernel<T, R>;

  private readonly stream: Signal<Signal<ResourceStreamItem<T>> | undefined>;
  private readonly pending: Signal<boolean>;
  private get state(): WritableSignal<ResourceState<T, R>> {
    return this.kernel.state;
  }

  /** @internal */
  readonly _pendingStatus: Signal<ResourceStatus>;
  /** @internal */
  readonly _pendingError: Signal<Error | undefined>;

  override readonly status: Signal<ResourceStatus>;
  override readonly error: Signal<Error | undefined>;

  /**
   * A signal that contains the last committed state of the resource.
   * This is used to optimize rollbacks and to freeze the stream during pending navigations.
   */
  private readonly lastCommittedState = signal<ResourceState<T, R> | undefined>(undefined);

  /** @internal */
  readonly init: (pending: Signal<boolean>) => void;

  /** @internal */
  constructor(
    params: () => R,
    loaderFn: ResourceStreamingLoader<T, R>,
    defaultValue: NoInfer<T>,
    equal: ValueEqualityFn<T> = Object.is,
    injector: Injector,
  ) {
    super(
      computed(
        () => {
          const streamSignal = this.stream?.();
          const streamValue = streamSignal?.();
          if (!streamValue) {
            return defaultValue;
          }
          if (!isResolved(streamValue)) {
            throw streamValue.error;
          }
          return streamValue.value as T;
        },
        {equal},
      ),
      undefined,
    );

    const pendingSource = signal<Signal<boolean>>(signal(false));
    const pending = computed(() => pendingSource()());
    this.pending = pending;
    this.init = (pending: Signal<boolean>) => {
      pendingSource.set(pending);
    };

    this.kernel = new ResourceKernel(
      params,
      async (args) => {
        const lastCommittedStream = this.lastCommittedState()?.stream;
        if (lastCommittedStream && this.isRollbackToCommittedStream(args.params)) {
          return lastCommittedStream;
        }
        return loaderFn(args);
      },
      injector,
    );

    // While effect is async and theoretically the Router could create a new navigation
    // before the one we want to commit is finished, in practice this cannot actually affect
    // the committedState in a way that we would worry about because:
    // 1) Blocking resources are also resolved through an effect. If a navigation comes in before
    // that, then the state was never really "committed".
    // 2) The loader itself is controlled by an effect. If another navigation comes in after
    // the old one was committed, but then that navigation gets cancelled quickly, the loader
    // for the non-blocking resource never had a chance to execute anyways so we do need to
    // reload it.
    effect(
      () => {
        const state = this.state();
        const isPending = pending();
        if (!isPending) {
          this.lastCommittedState.set(state);
        }
      },
      {injector},
    );

    this.stream = computed(() => {
      if (pending()) {
        return this.lastCommittedState()?.stream;
      }
      return this.kernel.state().stream;
    });

    this._pendingStatus = computed(() => projectStatusOfState(this.state()));
    this.status = computed(() => {
      if (!pending()) {
        if (this.state().status === 'local') {
          const stream = this.stream();
          return stream && isResolved(stream()) ? 'resolved' : 'error';
        }
        return projectStatusOfState(this.state());
      }
      const stream = this.stream();
      if (stream === undefined) {
        return this.kernel.extRequest().request === undefined ? 'idle' : 'loading';
      }
      return isResolved(stream()) ? 'resolved' : 'error';
    });
    this._pendingError = computed(() => {
      const stream = this.state().stream?.();
      return stream && !isResolved(stream) ? stream.error : undefined;
    });
    this.error = computed(() => {
      const stream = this.stream()?.();
      return stream && !isResolved(stream) ? stream.error : undefined;
    });
  }

  private isRollbackToCommittedStream(params: R) {
    const snapshot = this.lastCommittedState();
    const currentExtRequest = this.kernel.extRequest();
    if (
      currentExtRequest.reload === 0 &&
      snapshot &&
      deepEqual(params, snapshot.extRequest.request)
    ) {
      return true;
    }
    return false;
  }

  override reload(): boolean {
    if (untracked(this.pending)) {
      return false;
    }
    if (this.kernel.extRequest().request === undefined) {
      return false;
    }
    this.kernel.reload();
    return true;
  }

  destroy(): void {
    this.kernel.destroy();
  }

  // TODO(atscott): Consider not supporting this at all for router resource
  // Calling `set` while in the pending state is a problem
  override set(value: T): void {
    if (this.kernel.destroyed) return;
    this.kernel.state.update((s) => ({
      ...s,
      status: 'local',
      stream: signal({value}),
    }));
  }
}

function isResolved<T>(state: ResourceStreamItem<T>): state is {value: T} {
  return (state as {error: unknown}).error === undefined;
}

/**
 * Defines a reactive data resource for a route's `resources` property.
 *
 * @usageNotes
 *
 * ```ts
 * const routes: Route[] = [{
 *   path: 'user/:id',
 *   component: UserCmp,
 *   resources: (ctx: LoaderContext) => ({
 *     user: routerResource({
 *       params: computed(() => ctx.params().id),
 *       loader: ({params: id, abortSignal}) => fetch(`/api/user/${id}`, {signal: abortSignal}).then(res => res.json())
 *     })
 *   })
 * }];
 * ```
 * @publicApi
 * @experimental
 */
export function routerResource<TRequest = any, TValue = any>(
  options: RouterResourceOptions<TRequest, TValue>,
): RouterResource<TValue, TRequest> {
  const injector = inject(Injector);
  const loader = async (args: ResourceLoaderParams<TRequest>) => {
    const value = await options.loader(args);
    return signal({value});
  };
  return new RouterResource<TValue, TRequest>(
    options.params ?? (() => null as TRequest),
    loader,
    options.defaultValue as TValue,
    options.equal,
    injector,
  );
}

export function blocking<TRequest = any, TValue = any>(
  options: RouterResourceOptions<TRequest, TValue>,
): RouterResource<TValue, TRequest> {
  const instance = routerResource(options);
  (instance as any)[BLOCKING_SYMBOL] = true;
  return instance;
}
routerResource.blocking = blocking;

/**
 * @experimental
 * @publicApi
 */
export interface RouterResourceOptions<TRequest, TValue>
  extends Omit<PromiseResourceOptions<TValue, TRequest>, 'injector'> {}

export const BLOCKING_SYMBOL = Symbol(
  typeof ngDevMode === 'undefined' || ngDevMode ? '__isBlocking' : '',
);
