/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {untracked} from '../render3/reactivity/untracked';
import {computed} from '../render3/reactivity/computed';
import {signal, signalAsReadonlyFn, WritableSignal} from '../render3/reactivity/signal';
import {Signal, ValueEqualityFn} from '../render3/reactivity/api';
import {effect, EffectRef} from '../render3/reactivity/effect';
import {
  ResourceOptions,
  ResourceStatus,
  WritableResource,
  Resource,
  ResourceRef,
  ResourceStreamItem,
  ResourceLoaderParams,
  ResourceLoader,
  ResourceStreamingLoader,
  StreamingResourceOptions,
} from './api';

export {
  ResourceOptions,
  ResourceStatus,
  WritableResource,
  Resource,
  ResourceRef,
  ResourceStreamItem,
  ResourceLoaderParams,
  ResourceLoader,
  ResourceStreamingLoader,
  StreamingResourceOptions,
};

import {Injector} from '../di/injector';
import {assertInInjectionContext} from '../di/contextual';
import {inject} from '../di/injector_compatibility';
import {PendingTasks} from '../pending_tasks';
import {linkedSignal} from '../render3/reactivity/linked_signal';
import {DestroyRef} from '../linker/destroy_ref';

/**
 * Constructs a `Resource` that projects a reactive request to an asynchronous operation defined by
 * a loader function, which exposes the result of the loading operation via signals.
 *
 * Note that `resource` is intended for _read_ operations, not operations which perform mutations.
 * `resource` will cancel in-progress loads via the `AbortSignal` when destroyed or when a new
 * request object becomes available, which could prematurely abort mutations.
 *
 * @see [Async reactivity with resources](guide/signals/resource)
 *
 * @experimental 19.0
 */
export function resource<T, R>(
  options: ResourceOptions<T, R> & {defaultValue: NoInfer<T>},
): ResourceRef<T>;

/**
 * Constructs a `Resource` that projects a reactive request to an asynchronous operation defined by
 * a loader function, which exposes the result of the loading operation via signals.
 *
 * Note that `resource` is intended for _read_ operations, not operations which perform mutations.
 * `resource` will cancel in-progress loads via the `AbortSignal` when destroyed or when a new
 * request object becomes available, which could prematurely abort mutations.
 *
 * @experimental 19.0
 * @see [Async reactivity with resources](guide/signals/resource)
 */
export function resource<T, R>(options: ResourceOptions<T, R>): ResourceRef<T | undefined>;
export function resource<T, R>(options: ResourceOptions<T, R>): ResourceRef<T | undefined> {
  if (ngDevMode && !options?.injector) {
    assertInInjectionContext(resource);
  }

  const oldNameForParams = (
    options as ResourceOptions<T, R> & {request: ResourceOptions<T, R>['params']}
  ).request;
  const params = (options.params ?? oldNameForParams ?? (() => null)) as () => R;

  return new ResourceImpl<T | undefined, R>(
    params,
    getLoader(options),
    options.defaultValue,
    options.equal ? wrapEqualityFn(options.equal) : undefined,
    options.debugName,
    options.injector ?? inject(Injector),
  );
}

export type ResourceInternalStatus = 'idle' | 'loading' | 'resolved' | 'local';

/**
 * Internal state of a resource.
 */
export interface ResourceProtoState<T, R = unknown> {
  extRequest: WrappedRequest<R>;

  // For simplicity, status is internally tracked as a subset of the public status enum.
  // Reloading and Error statuses are projected from Loading and Resolved based on other state.
  status: ResourceInternalStatus;
}

export interface ResourceState<T, R = unknown> extends ResourceProtoState<T, R> {
  previousStatus: ResourceStatus;
  stream: Signal<ResourceStreamItem<T>> | undefined;
}

export type WrappedRequest<R = unknown> = {request: R; reload: number};

/**
 * Base class which implements `.value` as a `WritableSignal` by delegating `.set` and `.update`.
 */
export abstract class BaseWritableResource<T> implements WritableResource<T> {
  readonly value: WritableSignal<T>;
  abstract readonly status: Signal<ResourceStatus>;
  abstract readonly error: Signal<Error | undefined>;

  abstract reload(): boolean;

  readonly isLoading: Signal<boolean>;

  constructor(value: Signal<T>, debugName: string | undefined) {
    this.value = value as WritableSignal<T>;
    this.value.set = this.set.bind(this);
    this.value.update = this.update.bind(this);
    this.value.asReadonly = signalAsReadonlyFn;

    this.isLoading = computed(
      () => this.status() === 'loading' || this.status() === 'reloading',
      ngDevMode ? createDebugNameObject(debugName, 'isLoading') : undefined,
    );
  }

  abstract set(value: T): void;

  private readonly isError = computed(() => this.status() === 'error');

  update(updateFn: (value: T) => T): void {
    this.set(updateFn(untracked(this.value)));
  }

  // Use a computed here to avoid triggering reactive consumers if the value changes while staying
  // either defined or undefined.
  private readonly isValueDefined = computed(() => {
    // Check if it's in an error state first to prevent the error from bubbling up.
    if (this.isError()) {
      return false;
    }

    return this.value() !== undefined;
  });

  hasValue(): this is ResourceRef<Exclude<T, undefined>> {
    return this.isValueDefined();
  }

  asReadonly(): Resource<T> {
    return this;
  }
}

/**
 * A kernel that handles the loading logic for a resource.
 *
 * It manages the `extRequest` signal, the `loadEffect`, and the `reload` method.
 * It delegates state updates to the provided `delegate`.
 */
export class ResourceKernel<T, R> {
  readonly extRequest: WritableSignal<WrappedRequest<R>>;
  readonly state: WritableSignal<ResourceState<T, R>>;
  private readonly effectRef: EffectRef;
  private pendingController: AbortController | undefined;
  private resolvePendingTask: (() => void) | undefined = undefined;
  private readonly unregisterOnDestroy: () => void;
  destroyed = false;

  constructor(
    request: () => R,
    private readonly loaderFn: ResourceStreamingLoader<T, R>,
    private readonly injector: Injector,
  ) {
    this.extRequest = linkedSignal({
      source: request,
      computation: (req, previous) => {
        // If the request is the same as the previous one, keep the reload count.
        // Otherwise, reset the reload count to 0.
        // Note: We don't use the equality function from the options here because we want to track
        // the actual request object changes for reloading purposes.
        const reload = previous && previous.value.request === req ? previous.value.reload : 0;
        return {request: req, reload};
      },
    });

    this.state = createResourceState(this.extRequest);

    this.effectRef = effect(
      () => {
        const extRequest = this.extRequest();
        // We only want to track the `extRequest` signal. The body of the effect should be untracked
        // to avoid accidental dependencies on other signals accessed during the load.
        untracked(() => this.loadEffect(extRequest));
      },
      {injector, manualCleanup: true},
    );

    this.unregisterOnDestroy = injector.get(DestroyRef).onDestroy(() => this.destroy());
  }

  private async loadEffect(extRequest: WrappedRequest<R>): Promise<void> {
    const previousStatus = this.state().previousStatus;

    // If the request is undefined, we don't load anything.
    if (extRequest.request === undefined) {
      this.abortInProgressLoad();
      return;
    }

    // If the delegate determines we shouldn't load (e.g. because we are in a local state), return.
    if (this.state().status !== 'loading') {
      return;
    }

    // Cancel any pending load.
    this.abortInProgressLoad();

    const {signal: abortSignal} = (this.pendingController = new AbortController());

    // If we have a pending task, resolve it.
    // This shouldn't happen if we correctly cleaned up, but just in case.
    this.resolvePendingTask?.();
    this.resolvePendingTask = undefined;

    // Add a pending task to keep the app stable while loading.
    const pendingTasks = this.injector.get(PendingTasks);
    this.resolvePendingTask = pendingTasks.add();

    try {
      const stream = await untracked(() => {
        return this.loaderFn({
          params: extRequest.request as Exclude<R, undefined>,
          request: extRequest.request as Exclude<R, undefined>,
          abortSignal,
          previous: {
            status: previousStatus,
          },
        } as ResourceLoaderParams<R>);
      });

      if (abortSignal.aborted || untracked(this.extRequest) !== extRequest) {
        return;
      }

      this.state.update((s) => ({
        ...s,
        status: 'resolved',
        stream,
      }));
    } catch (err) {
      if (abortSignal.aborted || untracked(this.extRequest) !== extRequest) {
        return;
      }
      this.state.update((s) => ({
        ...s,
        status: 'resolved',
        stream: signal({error: encapsulateResourceError(err)}),
      }));
    } finally {
      if (!abortSignal.aborted) {
        this.resolvePendingTask?.();
        this.resolvePendingTask = undefined;
        this.pendingController = undefined;
      }
    }
  }

  reload(): boolean {
    this.extRequest.update((s) => ({...s, reload: s.reload + 1}));
    return true;
  }

  abortInProgressLoad(): void {
    untracked(() => this.pendingController?.abort());
    this.pendingController = undefined;
    this.resolvePendingTask?.();
    this.resolvePendingTask = undefined;
  }

  destroy(): void {
    this.destroyed = true;
    this.unregisterOnDestroy();
    this.effectRef.destroy();
    this.abortInProgressLoad();
    this.state.set({
      extRequest: {request: undefined as any, reload: 0},
      status: 'idle',
      previousStatus: 'idle',
      stream: undefined,
    });
  }
}

/**
 * Implementation for `resource()` which uses a `linkedSignal` to manage the resource's state.
 */
export class ResourceImpl<T, R> extends BaseWritableResource<T> implements ResourceRef<T> {
  /**
   * The current state of the resource. Status, value, and error are derived from this.
   */
  /**
   * The current state of the resource. Status, value, and error are derived from this.
   */
  private get state(): WritableSignal<ResourceState<T>> {
    return this.kernel.state;
  }
  private readonly kernel: ResourceKernel<T, R>;
  override readonly status: Signal<ResourceStatus>;
  override readonly error: Signal<Error | undefined>;

  constructor(
    request: () => R,
    loaderFn: ResourceStreamingLoader<T, R>,
    defaultValue: T,
    private readonly equal: ValueEqualityFn<T> | undefined,
    private readonly debugName: string | undefined,
    injector: Injector,
  ) {
    super(
      // Feed a computed signal for the value to `BaseWritableResource`, which will upgrade it to a
      // `WritableSignal` that delegates to `ResourceImpl.set`.
      computed(
        () => {
          const streamValue = this.state().stream?.();

          if (!streamValue) {
            return defaultValue;
          }

          // Prevents `hasValue()` from throwing an error when a reload happened in the error state
          if (this.state().status === 'loading' && this.error()) {
            return defaultValue;
          }

          if (!isResolved(streamValue)) {
            throw new ResourceValueError(this.error()!);
          }

          return streamValue.value;
        },
        {equal, ...(ngDevMode ? createDebugNameObject(debugName, 'value') : undefined)},
      ),
      debugName,
    );

    this.kernel = new ResourceKernel(request, loaderFn, injector);

    this.status = computed(
      () => projectStatusOfState(this.state()),
      ngDevMode ? createDebugNameObject(debugName, 'status') : undefined,
    );

    this.error = computed(
      () => {
        const stream = this.state().stream?.();
        return stream && !isResolved(stream) ? stream.error : undefined;
      },
      ngDevMode ? createDebugNameObject(debugName, 'error') : undefined,
    );
  }

  protected get extRequest(): WritableSignal<WrappedRequest> {
    return this.kernel.extRequest;
  }

  /**
   * Called either directly via `WritableResource.set` or via `.value.set()`.
   */
  override set(value: T): void {
    if (this.kernel.destroyed) {
      return;
    }
    const error = untracked(this.error);
    const state = untracked(this.state);

    if (!error) {
      const current = untracked(this.value);
      if (
        state.status === 'local' &&
        (this.equal ? this.equal(current, value) : current === value)
      ) {
        return;
      }
    }

    // Enter Local state with the user-defined value.
    this.state.set({
      extRequest: state.extRequest,
      status: 'local',
      previousStatus: 'local',
      stream: signal(
        {value},
        ngDevMode ? createDebugNameObject(this.debugName, 'stream') : undefined,
      ),
    });

    // We're departing from whatever state the resource was in previously, so cancel any in-progress
    // loading operations.
    this.kernel.abortInProgressLoad();
  }

  override reload(): boolean {
    // We don't want to restart in-progress loads.
    const {status} = untracked(this.state);
    if (status === 'idle' || status === 'loading') {
      return false;
    }

    return this.kernel.reload();
  }

  destroy(): void {
    this.kernel.destroy();
  }
}

/**
 * Wraps an equality function to handle either value being `undefined`.
 */
function wrapEqualityFn<T>(equal: ValueEqualityFn<T>): ValueEqualityFn<T | undefined> {
  return (a, b) => (a === undefined || b === undefined ? a === b : equal(a, b));
}

export function getLoader<T, R>(options: ResourceOptions<T, R>): ResourceStreamingLoader<T, R> {
  if (isStreamingResourceOptions(options)) {
    return options.stream;
  }

  return async (params) => {
    try {
      return signal(
        {value: await options.loader(params)},
        ngDevMode ? createDebugNameObject(options.debugName, 'stream') : undefined,
      );
    } catch (err) {
      return signal(
        {error: encapsulateResourceError(err)},
        ngDevMode ? createDebugNameObject(options.debugName, 'stream') : undefined,
      );
    }
  };
}

function isStreamingResourceOptions<T, R>(
  options: ResourceOptions<T, R>,
): options is StreamingResourceOptions<T, R> {
  return !!(options as StreamingResourceOptions<T, R>).stream;
}

/**
 * Project from a state with `ResourceInternalStatus` to the user-facing `ResourceStatus`
 */
export function projectStatusOfState(state: ResourceState<unknown>): ResourceStatus {
  switch (state.status) {
    case 'loading':
      return state.extRequest.reload === 0 ? 'loading' : 'reloading';
    case 'resolved':
      return isResolved(state.stream!()) ? 'resolved' : 'error';
    default:
      return state.status;
  }
}

function isResolved<T>(state: ResourceStreamItem<T>): state is {value: T} {
  return (state as {error: unknown}).error === undefined;
}

/**
 * Creates a debug name object for an internal signal.
 */
function createDebugNameObject(
  resourceDebugName: string | undefined,
  internalSignalDebugName: string,
): {debugName?: string} {
  return {
    debugName: `Resource${resourceDebugName ? '#' + resourceDebugName : ''}.${internalSignalDebugName}`,
  };
}

export function encapsulateResourceError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new ResourceWrappedError(error);
}

class ResourceValueError extends Error {
  constructor(error: Error) {
    super(
      ngDevMode
        ? `Resource is currently in an error state (see Error.cause for details): ${error.message}`
        : error.message,
      {cause: error},
    );
  }
}

class ResourceWrappedError extends Error {
  constructor(error: unknown) {
    super(
      ngDevMode
        ? `Resource returned an error that's not an Error instance: ${String(error)}. Check this error's .cause for the actual error.`
        : String(error),
      {cause: error},
    );
  }
}

export function createResourceState<T, R>(
  source: Signal<WrappedRequest<R>>,
): WritableSignal<ResourceState<T, R>> {
  return linkedSignal<WrappedRequest<R>, ResourceState<T, R>>({
    source,
    computation: (extRequest, previous) => {
      const status = extRequest.request === undefined ? 'idle' : 'loading';
      if (!previous) {
        return {
          extRequest,
          status,
          previousStatus: 'idle',
          stream: undefined,
        };
      }
      return {
        extRequest,
        status,
        previousStatus: projectStatusOfState(previous.value),
        stream:
          previous.value.extRequest.request === extRequest.request
            ? previous.value.stream
            : undefined,
      };
    },
  });
}
