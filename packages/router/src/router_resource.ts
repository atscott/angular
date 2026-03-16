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
  ValueEqualityFn,
  Signal,
  signal,
  untracked,
  DestroyRef,
  ResourceSnapshot,
  effect,
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

export const BLOCKING_SYMBOL = Symbol(
  typeof ngDevMode === 'undefined' || ngDevMode ? '__isBlocking' : '',
);
export const REAL_RESOURCE_SYMBOL = Symbol('REAL_RESOURCE');

/**
 * Creates a transactional resource wrapper around a given source resource.
 * This wrapper ensures that the resource's state only propagates to the UI
 * when the router is NOT in the middle of a pending navigation, or when
 * the navigation successfully commits.
 *
 * @param sourceResource The source `Resource<T>` to wrap.
 * @param router The Angular `Router` instance.
 * @returns A transactional `Resource<T>`.
 * @experimental
 */
export function createTransactionalResource<T>(
  sourceResource: Resource<T>,
  router: Router,
  options?: {injector?: Injector; equal?: ValueEqualityFn<T>},
): Resource<T> {
  const injector = options?.injector ?? inject(Injector);

  const frozenSnapshot = signal<ResourceSnapshot<T> | null>(
    router.getCurrentNavigation() ? untracked(() => sourceResource.snapshot()) : null,
  );

  let recoveringFromAbortion = false;
  let abortedValue: T | undefined = undefined;

  let activeNavigationId: number | null = router.getCurrentNavigation()?.id ?? null;

  const sub = router.events.subscribe((e) => {
    if (e instanceof NavigationStart) {
      activeNavigationId = e.id;

      const snapshot = untracked(() => sourceResource.snapshot());
      if (recoveringFromAbortion && snapshot.status === 'loading') {
        frozenSnapshot.set({...snapshot, status: 'reloading', value: abortedValue} as any);
      } else {
        frozenSnapshot.set(snapshot);
      }

      recoveringFromAbortion = false;
      abortedValue = undefined;
    } else if (e instanceof NavigationEnd || e instanceof NavigationSkipped) {
      if (e.id !== activeNavigationId) return;
      frozenSnapshot.set(null);
      recoveringFromAbortion = false;
      abortedValue = undefined;
    } else if (e instanceof NavigationCancel || e instanceof NavigationError) {
      if (e.id !== activeNavigationId) return;
      const frozen = untracked(frozenSnapshot);
      frozenSnapshot.set(null);

      // Only recover if the parameter state was truly rolled back.
      // E.g. if the navigation was superseded during activation, it's not a rollback,
      // and we shouldn't attempt to recover the pre-navigation state masking the new route parameters.
      const isRollback =
        e instanceof NavigationError ||
        (e as NavigationCancel).code !== NavigationCancellationCode.SupersededByNewNavigation;

      // Because `rollbackState` runs synchronously immediately prior to `NavigationCancel` (for true rollbacks),
      // the underlying resource parameters have already reverted.
      // If those parameters triggered a reload, `isLoading` will synchronously remain true here.
      if (
        isRollback &&
        untracked(sourceResource.isLoading) &&
        (frozen?.status === 'resolved' ||
          frozen?.status === 'local' ||
          frozen?.status === 'reloading')
      ) {
        recoveringFromAbortion = true;
        abortedValue = (frozen as any).value;
      }
    }
  });

  injector.get(DestroyRef).onDestroy(() => sub.unsubscribe());

  // Clear the recovery state once the resource fully settles (resolves or errors).
  // The `isLoading` signal synchronously updates to false upon resolution.
  effect(
    () => {
      if (recoveringFromAbortion && !sourceResource.isLoading()) {
        recoveringFromAbortion = false;
        abortedValue = undefined;
      }
    },
    {injector},
  );

  const res = resourceFromSnapshots(() => {
    const frozen = frozenSnapshot();
    if (frozen) return frozen;

    let current = sourceResource.snapshot();

    if (recoveringFromAbortion && current.status === 'loading') {
      current = {...current, status: 'reloading', value: abortedValue} as any;
    }

    return current;
  });

  (res as any)[REAL_RESOURCE_SYMBOL] = sourceResource;

  return res;
}

/**
 * Marks a resource as blocking. The Router will wait for this resource to resolve
 * before completing the navigation.
 *
 * @param resource The resource to mark as blocking.
 * @returns The same resource instance, marked as blocking.
 * @experimental
 */
export function blocking<T>(resource: Resource<T>): Resource<T> {
  (resource as any)[BLOCKING_SYMBOL] = true;
  return resource;
}
