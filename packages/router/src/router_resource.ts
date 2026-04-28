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
  DestroyRef,
  ResourceSnapshot,
  effect,
  computed,
  WritableResource,
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

export const NON_BLOCKING_SYMBOL: unique symbol = Symbol(
  typeof ngDevMode === 'undefined' || ngDevMode ? '__isNonBlocking' : '',
);
export const BLOCKING_SYMBOL: unique symbol = Symbol(
  typeof ngDevMode === 'undefined' || ngDevMode ? '__isBlocking' : '',
);
export const SOURCE_RESOURCE_SYMBOL: unique symbol = Symbol(
  typeof ngDevMode === 'undefined' || ngDevMode ? '__sourceResource' : '',
);

/**
 * @internal
 */
export interface InternalRouterResource<T = unknown> extends Resource<T> {
  [SOURCE_RESOURCE_SYMBOL]: Resource<T>;
  [NON_BLOCKING_SYMBOL]?: boolean;
  [BLOCKING_SYMBOL]?: boolean;
}

/**
 * Marks a resource as non-blocking. The Router will NOT wait for this resource to resolve
 * before completing the navigation.
 * @experimental
 */
export function nonBlocking<T, R extends Resource<T>>(res: R): R {
  (res as unknown as InternalRouterResource<T>)[NON_BLOCKING_SYMBOL] = true;
  return res;
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

export function routerResource<T>(source: Resource<T>): Resource<T> {
  const injector = inject(Injector);
  const router = injector.get(Router);

  const {snapshot: snapshotSignal, frozenSnapshot} = createTransactionalSnapshot(
    source,
    router,
    injector,
  );

  const res = resourceFromSnapshots(snapshotSignal) as unknown as InternalRouterResource<T>;

  res[SOURCE_RESOURCE_SYMBOL] = source;
  if ((source as unknown as InternalRouterResource<T>)[NON_BLOCKING_SYMBOL]) {
    res[NON_BLOCKING_SYMBOL] = true;
  } else {
    res[BLOCKING_SYMBOL] = true;
  }

  const wrapper = Object.create(res);

  wrapper.reload = function (): boolean {
    if (frozenSnapshot() !== null) {
      return false;
    }
    return (source as WritableResource<unknown>).reload?.() ?? false;
  };

  return wrapper as unknown as Resource<T>;
}
