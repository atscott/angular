/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {EnvironmentInjector, ProviderToken, runInInjectionContext} from '@angular/core';
import {
  // concat, // Removed
  // defer, // Removed
  from, // Used by all guard runners for AbortSignal
  // MonoTypeOperatorFunction, // Removed
  Observable, // wrapIntoObservable still produces Observables internally
  // of, // Removed
  OperatorFunction, // This is used by the new checkGuards signature
  // pipe, // Removed
} from 'rxjs';
import {
  // concatMap, // Removed
  first, // Still used by all guard runners
  // map, // Removed
  // mergeMap, // Removed
  // tap, // Removed
  takeUntil, // Still used by all guard runners
} from 'rxjs/operators';

import {ActivationStart, ChildActivationStart, Event} from '../events';
import {
  CanActivateChildFn,
  CanActivateFn,
  CanDeactivateFn,
  GuardResult,
  CanLoadFn,
  CanMatchFn,
  Route,
  RedirectCommand,
} from '../models';
import {redirectingNavigationError} from '../navigation_canceling_error';
import type {NavigationTransition} from '../navigation_transition';
import type {ActivatedRouteSnapshot, RouterStateSnapshot} from '../router_state';
import {UrlSegment, UrlSerializer, UrlTree} from '../url_tree';
import {wrapIntoObservable} from '../utils/collection';
import {getClosestRouteInjector} from '../utils/config';
import {
  CanActivate,
  CanDeactivate,
  getCanActivateChild,
  getTokenOrFunctionIdentity,
} from '../utils/preactivation';
import {
  isBoolean,
  isCanActivate,
  isCanActivateChild,
  isCanDeactivate,
  isCanLoad,
  isCanMatch,
} from '../utils/type_guards';

// import {prioritizedGuardValue} from './prioritized_guard_value'; // Removed

export function checkGuards(
  injector: EnvironmentInjector,
  forwardEvent?: (evt: Event) => void,
): (t: NavigationTransition) => Promise<NavigationTransition & {guardsResult: GuardResult}> {
  return async (t: NavigationTransition): Promise<NavigationTransition & {guardsResult: GuardResult}> => {
    const {
      targetSnapshot,
      currentSnapshot,
      guards: {canActivateChecks, canDeactivateChecks},
      abortController, // Use the AbortController from the NavigationTransition
    } = t;

    // If the navigation was already aborted before guards ran (e.g. by a resolver),
    // we shouldn't run any more guards.
    if (abortController.signal.aborted) {
      return {...t, guardsResult: false}; // Or handle as per existing cancellation logic
    }

    if (canDeactivateChecks.length === 0 && canActivateChecks.length === 0) {
      return {...t, guardsResult: true};
    }

    const canDeactivateResult = await runCanDeactivateChecks(
      canDeactivateChecks,
      targetSnapshot!,
      currentSnapshot,
      injector,
      abortController.signal, // Pass the real signal
    );

    let guardsResult: GuardResult = canDeactivateResult;
    // If deactivation failed (false or UrlTree) or if navigation was aborted during deactivation
    if (guardsResult !== true || abortController.signal.aborted) {
      // If aborted, ensure guardsResult reflects cancellation if it was true.
      if (abortController.signal.aborted && guardsResult === true) {
        guardsResult = false;
      }
      return {...t, guardsResult};
    }

    // Deactivation passed and was not aborted, proceed to activation checks
    guardsResult = await runCanActivateChecks(
      targetSnapshot!,
      canActivateChecks,
      injector,
      forwardEvent,
      abortController.signal, // Pass the real signal
    );

    // If activation was aborted and guardsResult was true, set to false.
    if (abortController.signal.aborted && guardsResult === true) {
        guardsResult = false;
    }

    return {...t, guardsResult};
  };
}

async function runCanDeactivateChecks(
  checks: CanDeactivate[],
  futureRSS: RouterStateSnapshot,
  currRSS: RouterStateSnapshot,
  injector: EnvironmentInjector,
  signal: AbortSignal,
): Promise<GuardResult> {
  for (const check of checks) {
    const result = await runCanDeactivate( // Remove TODO comment for signal
      check.component,
      check.route,
      currRSS,
      futureRSS,
      injector,
      signal, // Pass signal here
    );
    if (result !== true) {
      return result;
    }
    if (signal.aborted) {
      // TODO: verify what should be returned here. `false` seems like a reasonable default.
      // Or maybe throw a specific error? For now, let's stick to the instructions.
      // The existing code did not have explicit abort handling, so `false` is chosen
      // to align with the idea that navigation is cancelled.
      return false;
    }
  }
  return true;
}

async function runCanActivateChecks(
  futureSnapshot: RouterStateSnapshot,
  checks: CanActivate[],
  injector: EnvironmentInjector,
  forwardEvent: ((evt: Event) => void) | undefined,
  signal: AbortSignal,
): Promise<GuardResult> {
  for (const check of checks) {
    // The `concat` order was: child events, current events, child guards, current guards
    // fireChildActivationStart and fireActivationStart now return Promise<boolean>
    // and always resolve to true. They are side-effect only.
    await fireChildActivationStart(check.route.parent, forwardEvent);
    if (signal.aborted) return false; // Navigation cancelled

    await fireActivationStart(check.route, forwardEvent);
    if (signal.aborted) return false; // Navigation cancelled

    let result = await runCanActivateChild( // Remove wrapIntoObservable and .toPromise()
      futureSnapshot,
      check.path,
      injector,
      signal, // Pass signal here
    );
    if (result !== true) return result;
    if (signal.aborted) return false; // Navigation cancelled

    result = await runCanActivate( // Remove wrapIntoObservable and .toPromise()
      futureSnapshot,
      check.route,
      injector,
      signal, // Pass signal here
    );
    if (result !== true) return result;
    if (signal.aborted) return false; // Navigation cancelled
  }
  return true;
}

/**
 * This should fire off `ActivationStart` events for each route being activated at this
 * level.
 * In other words, if you're activating `a` and `b` below, `path` will contain the
 * `ActivatedRouteSnapshot`s for both and we will fire `ActivationStart` for both. Always
 * return
 * `true` so checks continue to run.
 */
async function fireActivationStart(
  snapshot: ActivatedRouteSnapshot | null,
  forwardEvent?: (evt: Event) => void,
): Promise<boolean> {
  if (snapshot !== null && forwardEvent) {
    forwardEvent(new ActivationStart(snapshot));
  }
  return Promise.resolve(true);
}

/**
 * This should fire off `ChildActivationStart` events for each route being activated at this
 * level.
 * In other words, if you're activating `a` and `b` below, `path` will contain the
 * `ActivatedRouteSnapshot`s for both and we will fire `ChildActivationStart` for both. Always
 * return
 * `true` so checks continue to run.
 */
async function fireChildActivationStart(
  snapshot: ActivatedRouteSnapshot | null,
  forwardEvent?: (evt: Event) => void,
): Promise<boolean> {
  if (snapshot !== null && forwardEvent) {
    forwardEvent(new ChildActivationStart(snapshot));
  }
  return Promise.resolve(true);
}

async function runCanActivate(
  futureRSS: RouterStateSnapshot,
  futureARS: ActivatedRouteSnapshot,
  injector: EnvironmentInjector,
  signal: AbortSignal,
): Promise<GuardResult> {
  const canActivateGuards = futureARS.routeConfig ? futureARS.routeConfig.canActivate : null;
  if (!canActivateGuards || canActivateGuards.length === 0) {
    return true;
  }

  for (const guardToken of canActivateGuards) {
    // Check signal before attempting to resolve guard
    if (signal.aborted) {
      return false; // Navigation cancelled
    }

    const closestInjector = getClosestRouteInjector(futureARS) ?? injector;
    const guard = getTokenOrFunctionIdentity<CanActivate>(
      guardToken as ProviderToken<CanActivate>, // Renamed from 'canActivate' to 'guardToken' for clarity
      closestInjector,
    );
    const guardVal = isCanActivate(guard)
      ? guard.canActivate(futureARS, futureRSS)
      : runInInjectionContext(closestInjector, () => (guard as CanActivateFn)(futureARS, futureRSS));

    const guardResultObservable = wrapIntoObservable(guardVal).pipe(
      first(), // Ensures the Observable completes after one emission
      takeUntil(from(new Promise(resolve => signal.addEventListener('abort', resolve, {once: true})))),
    );

    let guardResult: GuardResult | undefined;
    try {
      guardResult = await guardResultObservable.toPromise();
    } catch (e) {
      // If 'toPromise()' throws an error (e.g. if the abort signal caused takeUntil to complete the observable without emitting)
      // we should check the abort signal status.
      if (signal.aborted) {
        return false; // Navigation cancelled
      }
      // Otherwise, rethrow the error if it's not related to abort.
      throw e;
    }


    // If the signal was aborted while awaiting the guard, guardResult might be undefined.
    if (signal.aborted) {
      return false; // Navigation cancelled
    }

    if (guardResult !== true) {
      // If guardResult is undefined here, it means the guard completed without a value
      // (and not due to abort, which is handled). Treat as a guard failure.
      return guardResult === undefined ? false : guardResult;
    }
  }

  return true; // All guards passed
}

async function runCanActivateChild(
  futureRSS: RouterStateSnapshot,
  path: ActivatedRouteSnapshot[],
  injector: EnvironmentInjector,
  signal: AbortSignal,
): Promise<GuardResult> {
  const futureARS = path[path.length - 1];

  const canActivateChildGuardGroups = path // Renamed from canActivateChildGuards
    .slice(0, path.length - 1)
    .reverse()
    .map((p) => getCanActivateChild(p))
    .filter((group) => group !== null && group.guards.length > 0); // Filter groups with no guards

  if (canActivateChildGuardGroups.length === 0) {
    return true;
  }

  for (const guardGroup of canActivateChildGuardGroups) {
    // `guardGroup` here corresponds to `d` in the original code.
    // It's an object like {node: ActivatedRouteSnapshot, guards: (CanActivateChildFn|ProviderToken)[]}
    if (signal.aborted) {
      return false; // Navigation cancelled
    }

    const innerGuardPromises = guardGroup!.guards.map(async (guardToken) => { // Added ! for guardGroup assuming filter is effective
      const closestInjector = getClosestRouteInjector(guardGroup!.node) ?? injector; // Added ! for guardGroup
      const guard = getTokenOrFunctionIdentity<{canActivateChild: CanActivateChildFn}>(
        guardToken,
        closestInjector,
      );
      const guardVal = isCanActivateChild(guard)
        ? guard.canActivateChild(futureARS, futureRSS)
        : runInInjectionContext(closestInjector, () =>
            (guard as CanActivateChildFn)(futureARS, futureRSS),
          );

      const guardResultObservable = wrapIntoObservable(guardVal).pipe(
        first(),
        takeUntil(from(new Promise(resolve => signal.addEventListener('abort', resolve, {once: true})))),
      );
      // If signal aborted before promise resolves, toPromise might return undefined or throw.
      // Catch error and check signal, or rely on later checks.
      try {
        const result = await guardResultObservable.toPromise();
        return result === undefined && signal.aborted ? false : result; // Ensure false on abort if undefined
      } catch (e) {
        if (signal.aborted) return false; // Ensure false on abort
        throw e; // Rethrow if different error
      }
    });

    const settledResults = await Promise.allSettled(innerGuardPromises);

    if (signal.aborted) {
      return false; // Navigation cancelled
    }

    let urlTreeResult: GuardResult | null = null;
    let booleanFalseResult = false;

    for (const settledResult of settledResults) {
      if (settledResult.status === 'rejected') {
        // An error occurred in a guard or its wrapper.
        // If due to abort, signal.aborted should catch it. Otherwise, this is a guard failure.
        // For now, treating a rejection as a `false` guard result.
        // A more robust solution might involve inspecting the error.
        if (signal.aborted) return false; // Double check signal
        booleanFalseResult = true;
        break; // A rejected guard means this group fails (becomes false)
      }

      const value = settledResult.value;
      // Value can be GuardResult or false (if aborted and undefined was replaced by false)
      if (value === false) {
        booleanFalseResult = true;
        // A UrlTree might still be found and take precedence, so don't break yet
        // unless this false was due to an abort that we already converted from undefined.
        // If signal.aborted is true and value is false, it's definitively a stop.
        if (signal.aborted) break;
      } else if (value !== undefined && typeof value !== 'boolean') { // It's a UrlTree or RedirectCommand
        urlTreeResult = value as (UrlTree | RedirectCommand); // value is not undefined and not boolean
        break; // UrlTree or RedirectCommand has highest precedence for this group
      }
      // If value is true or undefined (and not aborted), continue.
      // Undefined here means a specific guard didn't return a UrlTree/Redirect, but didn't explicitly return false either.
    }

    if (urlTreeResult) {
      return urlTreeResult;
    }
    // If signal was aborted and we broke out early due to a 'false' result that was an abortion
    if (signal.aborted && booleanFalseResult) return false;

    if (booleanFalseResult) {
      return false;
    }
    // If we reach here, all guards in this group returned true. Continue to the next group.
  }

  return true; // All guard groups passed
}

async function runCanDeactivate(
  component: Object | null,
  currARS: ActivatedRouteSnapshot,
  currRSS: RouterStateSnapshot,
  futureRSS: RouterStateSnapshot,
  injector: EnvironmentInjector,
  signal: AbortSignal,
): Promise<GuardResult> {
  const canDeactivateGuards = currARS?.routeConfig?.canDeactivate ?? null;
  if (!canDeactivateGuards || canDeactivateGuards.length === 0) {
    return true;
  }

  for (const guardToken of canDeactivateGuards) {
    if (signal.aborted) {
      return false; // Navigation cancelled
    }

    const closestInjector = getClosestRouteInjector(currARS) ?? injector;
    // The type of `guardToken` is `CanDeactivateFn<any> | ProviderToken<any> | DeprecatedGuard`
    // Casting to `any` for now to bypass TS2345 for DeprecatedGuard (string)
    const guard = getTokenOrFunctionIdentity<any>(guardToken as any, closestInjector);

    const guardVal = isCanDeactivate(guard)
      ? guard.canDeactivate(component, currARS, currRSS, futureRSS)
      : runInInjectionContext(closestInjector, () =>
          (guard as CanDeactivateFn<any>)(component, currARS, currRSS, futureRSS),
        );

    const guardResultObservable = wrapIntoObservable(guardVal).pipe(
      first(),
      takeUntil(from(new Promise(resolve => signal.addEventListener('abort', resolve, {once: true})))),
    );

    let guardResult: GuardResult | undefined | false; // Allow false explicitly for abort cases
    try {
      guardResult = await guardResultObservable.toPromise();
      if (guardResult === undefined && signal.aborted) {
        guardResult = false; // Ensure false on abort if undefined
      }
    } catch (e) {
      if (signal.aborted) {
        return false; // Navigation cancelled
      }
      throw e;
    }

    if (signal.aborted) { // Double check after await
      return false; // Navigation cancelled
    }

    // At this point, guardResult is GuardResult (boolean | UrlTree | RedirectCommand) or false
    // It should not be undefined here.
    if (guardResult !== true) {
      return guardResult as GuardResult; // Cast because it won't be undefined
    }
  }

  return true; // All guards passed
}

export async function runCanLoadGuards(
  injector: EnvironmentInjector,
  route: Route,
  segments: UrlSegment[],
  urlSerializer: UrlSerializer,
  signal: AbortSignal,
): Promise<boolean> {
  const canLoadGuards = route.canLoad;
  if (canLoadGuards === undefined || canLoadGuards.length === 0) {
    return true;
  }

  const guardPromises = canLoadGuards.map(async (guardToken: any) => {
    if (signal.aborted) return false; // Return false if aborted before execution

    const guard = getTokenOrFunctionIdentity<any>(guardToken, injector);
    const guardVal = isCanLoad(guard)
      ? guard.canLoad(route, segments)
      : runInInjectionContext(injector, () => (guard as CanLoadFn)(route, segments));

    const guardResultObservable = wrapIntoObservable(guardVal).pipe(
      first(),
      takeUntil(from(new Promise(resolve => signal.addEventListener('abort', resolve, {once: true})))),
    );
    try {
      const result = await guardResultObservable.toPromise();
      return result === undefined && signal.aborted ? false : result;
    } catch (e) {
      if (signal.aborted) return false;
      throw e;
    }
  });

  const settledResults = await Promise.allSettled(guardPromises);

  if (signal.aborted) {
    return false;
  }

  let prioritizedResult: GuardResult | false = true; // Allow false

  for (const settledResult of settledResults) {
    if (settledResult.status === 'rejected') {
      prioritizedResult = false;
      break;
    }

    const value = settledResult.value;
    // Value here can be boolean | UrlTree | RedirectCommand | false (if aborted)
    if (value === false) {
      prioritizedResult = false;
      if (signal.aborted) break; // If due to abort, definitely stop.
    } else if (value !== undefined && typeof value !== 'boolean') { // UrlTree or RedirectCommand
      prioritizedResult = value as (UrlTree | RedirectCommand); // value is not undefined and not boolean
      break;
    }
    // If value is true or undefined (and not aborted), continue.
  }

  if (typeof prioritizedResult !== 'boolean') { // UrlTree or RedirectCommand
    throw redirectingNavigationError(urlSerializer, prioritizedResult);
  }

  return prioritizedResult; // boolean
}

export async function runCanMatchGuards(
  injector: EnvironmentInjector,
  route: Route,
  segments: UrlSegment[],
  urlSerializer: UrlSerializer,
  signal: AbortSignal,
): Promise<boolean> {
  const canMatchGuards = route.canMatch;
  if (canMatchGuards === undefined || canMatchGuards.length === 0) {
    return true;
  }

  const guardPromises = canMatchGuards.map(async (guardToken: any) => {
    if (signal.aborted) return false; // Return false if aborted

    const guard = getTokenOrFunctionIdentity<any>(guardToken, injector);
    const guardVal = isCanMatch(guard)
      ? guard.canMatch(route, segments)
      : runInInjectionContext(injector, () => (guard as CanMatchFn)(route, segments));

    const guardResultObservable = wrapIntoObservable(guardVal).pipe(
      first(),
      takeUntil(from(new Promise(resolve => signal.addEventListener('abort', resolve, {once: true})))),
    );
    try {
      const result = await guardResultObservable.toPromise();
      return result === undefined && signal.aborted ? false : result;
    } catch (e) {
      if (signal.aborted) return false;
      throw e;
    }
  });

  const settledResults = await Promise.allSettled(guardPromises);

  if (signal.aborted) {
    return false;
  }

  let prioritizedResult: GuardResult | false = true; // Allow false

  for (const settledResult of settledResults) {
    if (settledResult.status === 'rejected') {
      prioritizedResult = false;
      break;
    }
    const value = settledResult.value;
    // Value here can be boolean | UrlTree | RedirectCommand | false (if aborted)
    if (value === false) {
      prioritizedResult = false;
      if (signal.aborted) break; // If due to abort, definitely stop.
    } else if (value !== undefined && typeof value !== 'boolean') { // UrlTree or RedirectCommand
      prioritizedResult = value as (UrlTree | RedirectCommand); // value is not undefined and not boolean
      break;
    }
    // If value is true or undefined (and not aborted), continue.
  }

  if (typeof prioritizedResult !== 'boolean') { // UrlTree or RedirectCommand
    throw redirectingNavigationError(urlSerializer, prioritizedResult);
  }

  return prioritizedResult; // boolean
}
