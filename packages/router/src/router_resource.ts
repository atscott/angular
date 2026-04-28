/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  inject,
  Injector,
  Resource,
  resourceFromSnapshots,
  Signal,
  signal,
  untracked,
  DestroyRef,
  ResourceSnapshot,
  effect,
  computed,
} from '@angular/core';
import {Router} from './router';
import {
  NavigationStart,
  NavigationEnd,
  NavigationCancel,
  NavigationError,
  NavigationSkipped,
  NavigationCancellationCode,
} from './events';

export const NON_BLOCKING_SYMBOL = Symbol(
  typeof ngDevMode === 'undefined' || ngDevMode ? '__isNonBlocking' : '',
);
export const SOURCE_RESOURCE_SYMBOL = Symbol();

/**
 * Marks a resource as non-blocking. The Router will NOT wait for this resource to resolve
 * before completing the navigation.
 * @experimental
 */
export function nonBlocking<T, R extends Resource<T>>(res: R): R {
  (res as any)[NON_BLOCKING_SYMBOL] = true;
  return res;
}

/**
 * @experimental
 */
export interface RouterResourceOptions<R extends Resource<unknown>> {
  /**
   * The source `Resource` to wrap.
   */
  source: R;
}

/**
 * Represents the routerResource function block.
 * @experimental
 */
export interface RouterResourceFn {
  /**
   * Creates a transactional resource wrapper around a given source resource.
   * This wrapper ensures that the resource's state only propagates to the UI
   * when the router is NOT in the middle of a pending navigation, or when
   * the navigation successfully commits.
   *
   *
   * @param options Transactional router resource options containing the source resource.
   * @returns A transactional `Resource` preserving the type of the source.
   */
  // Note: This signature intentionally preserves the return type of `source`
  // (e.g., passing a `WritableResource` tightly returns a `WritableResource` to the compiler)
  // for all properties EXCEPT `.value` (which is cast to `Signal`) and mutations like `.set()` and `.update()`.
  // This enables seamless compiler-enforced proxying of methods like `.reload()`,
  // while strictly preventing structural lies about `.value`. A `WritableResource` natively expects
  // `.value` to be a `WritableSignal`, but the transactional wrapper relies on `resourceFromSnapshots`
  // which forces `.value` to be a `ReadonlySignal`.
  // Additionally, `.set()` and `.update()` are omitted to prevent complex state edge cases during navigation.
  <T, R extends Resource<T>>(
    options: RouterResourceOptions<R>,
  ): Omit<R, 'value' | 'set' | 'update'> & {
    value: Signal<(R extends Resource<infer U> ? U : never) | undefined>;
  };

  /**
   * Marks a resource as non-blocking. The Router will NOT wait for this resource to resolve
   * before completing the navigation.
   *
   * @param options Transactional router resource options containing the source resource.
   * @returns The same resource instance, wrapped transactionally and marked as non-blocking.
   */
  nonBlocking: <T, R extends Resource<T>>(
    options: RouterResourceOptions<R>,
  ) => Omit<R, 'value' | 'set' | 'update'> & {
    value: Signal<(R extends Resource<infer U> ? U : never) | undefined>;
  };
}

/**
 * Creates a signal that tracks the resource snapshot and handles transactional behavior
 * (freezing during navigation and rollback recovery).
 */
function createTransactionalSnapshot<T>(
  source: Resource<T>,
  router: Router,
  injector: Injector,
): {
  snapshot: Signal<ResourceSnapshot<T>>;
  frozenSnapshot: Signal<ResourceSnapshot<T> | null>;
} {
  // Holds a snapshot of the resource to keep the UI masked (frozen) during pending navigations
  // or while recovering from a cancelled navigation.
  const frozenSnapshot = signal<ResourceSnapshot<T> | null>(null);

  // Tracks whether we are in a recovery phase after a cancelled navigation.
  // The intended behavior is that on cancellation, the router reverts to the previous state.
  // This reversion might trigger a new load of the previous state because the signal dependencies
  // changed. If we were to release the frozen resource state immediately, the user would see a loading state
  // for data they were just looking at. To avoid this "loading flash", we retain the frozen
  // value (via frozenSnapshot) during this recovery load/reload until the resource settles.
  const isRollbackRecoveryPending = signal(false);

  let activeNavigationId: number | null = router.currentNavigation()?.id ?? null;

  const sub = router.events.subscribe((e) => {
    if (e instanceof NavigationStart) {
      activeNavigationId = e.id;
      isRollbackRecoveryPending.set(false);

      if (frozenSnapshot() === null) {
        // Freeze the snapshot at the start of navigation to keep the UI stable.
        frozenSnapshot.set(source.snapshot());
      }
    } else if (e instanceof NavigationEnd || e instanceof NavigationSkipped) {
      if (e.id !== activeNavigationId) return;
      // Navigation succeeded or was skipped, so we can unfreeze and use the live state.
      frozenSnapshot.set(null);
      isRollbackRecoveryPending.set(false);
    } else if (e instanceof NavigationCancel || e instanceof NavigationError) {
      if (e.id !== activeNavigationId) return;
      const isRollback =
        e instanceof NavigationError ||
        ((e as NavigationCancel).code !== NavigationCancellationCode.SupersededByNewNavigation &&
          (e as NavigationCancel).code !== NavigationCancellationCode.Redirect);

      if (!isRollback) return;

      const frozen = frozenSnapshot();

      // Because `rollbackState` runs synchronously immediately prior to `NavigationCancel` (for true rollbacks),
      // the underlying resource parameters have already reverted.
      // If those parameters triggered a reload, `isLoading` will synchronously remain true here.
      if (
        frozen?.status === 'resolved' ||
        frozen?.status === 'local' ||
        frozen?.status === 'reloading'
      ) {
        // We were in a valid state, so keep the UI frozen while we wait for the recovery load to complete.
        isRollbackRecoveryPending.set(true);
      } else {
        // We were not in a valid state, so we can't recover. Unfreeze immediately.
        isRollbackRecoveryPending.set(false);
        frozenSnapshot.set(null);
      }
    }
  });

  injector.get(DestroyRef).onDestroy(() => sub.unsubscribe());

  effect(
    () => {
      const loading = source.isLoading();
      const pending = isRollbackRecoveryPending();

      if (pending && !loading) {
        isRollbackRecoveryPending.set(false);
        frozenSnapshot.set(null);
      }
    },
    {injector},
  );

  return {
    snapshot: computed(() => frozenSnapshot() ?? source.snapshot()),
    frozenSnapshot,
  };
}

/**
 * Ensures a resource integrates seamlessly with the Angular router.
 * @experimental
 */
export const routerResource: RouterResourceFn = Object.assign(
  <T, R extends Resource<T>>({
    source,
  }: RouterResourceOptions<R>): Omit<R, 'value'> & {value: Signal<T | undefined>} => {
    const injector = inject(Injector);
    const router = injector.get(Router);

    const {snapshot: snapshotSignal, frozenSnapshot} = createTransactionalSnapshot(
      source,
      router,
      injector,
    );

    const res = resourceFromSnapshots(snapshotSignal) as unknown as R;

    (res as any)[SOURCE_RESOURCE_SYMBOL] = source;
    if ((source as any)[NON_BLOCKING_SYMBOL]) {
      (res as any)[NON_BLOCKING_SYMBOL] = true;
    }

    // Create a wrapper object that inherits from the read-only resource
    // to avoid Proxy issues with property renaming/minification.
    // Using a wrapper also acts as an allowlist for forwarded methods (like `reload`),
    // preventing arbitrary custom mutation methods on custom resources from being exposed.
    const wrapper = Object.create(res);

    wrapper.reload = function (...args: any[]) {
      // If we are in a pending navigation, we ignore reload calls to prevent
      // inconsistent state or redundant loads with different parameters.
      if (frozenSnapshot() !== null) {
        return false;
      }
      // Forward to source if it exists
      return (source as any).reload?.(...args);
    };

    return wrapper as unknown as R;
  },
  {
    nonBlocking: <T, R extends Resource<T>>(
      options: RouterResourceOptions<R>,
    ): Omit<R, 'value' | 'set' | 'update'> & {value: Signal<T | undefined>} => {
      const res = routerResource(options);
      (res as any)[NON_BLOCKING_SYMBOL] = true;
      return res as any;
    },
  },
) as any;
