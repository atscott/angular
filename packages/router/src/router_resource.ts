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
} from '@angular/core';
import {Router} from './router';
import {
  NavigationStart,
  NavigationEnd,
  NavigationCancel,
  NavigationError,
  NavigationSkipped,
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

  const sub = router.events.subscribe((e) => {
    if (e instanceof NavigationStart) {
      frozenSnapshot.set(untracked(() => sourceResource.snapshot()));
    } else if (
      e instanceof NavigationEnd ||
      e instanceof NavigationCancel ||
      e instanceof NavigationError ||
      e instanceof NavigationSkipped
    ) {
      frozenSnapshot.set(null);
    }
  });

  injector.get(DestroyRef).onDestroy(() => sub.unsubscribe());

  let previousValue: T | undefined = undefined;

  const res = resourceFromSnapshots(() => {
    let current = sourceResource.snapshot();

    const frozen = frozenSnapshot();
    if (frozen) return frozen;

    // Retain previous value if currently loading (keepPreviousData behavior)
    if (current.status === 'resolved') {
      previousValue = current.value;
    } else if (current.status === 'loading' && current.value === undefined) {
      if (previousValue !== undefined) {
        current = {...current, value: previousValue} as any;
      }
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
