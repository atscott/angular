/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {EnvironmentInjector} from '@angular/core';

import {PartialMatchRouteSnapshot, Route} from '../models';
import {runCanMatchGuards} from '../operators/check_guards';
import {RouterConfigLoader} from '../router_config_loader';
import {ActivatedRouteSnapshot} from '../router_state';
import {defaultUrlMatcher, PRIMARY_OUTLET} from '../shared';
import {UrlSegment, UrlSegmentGroup, UrlSerializer} from '../url_tree';

import {getOrCreateRouteInjectorIfNeeded, getOutlet, isConfigLoaded} from './config';
import {firstValueFrom} from './first_value_from';

export interface MatchResult {
  matched: boolean;
  consumedSegments: UrlSegment[];
  remainingSegments: UrlSegment[];
  parameters: {[k: string]: string};
  positionalParamSegments: {[k: string]: UrlSegment};
}

const noMatch: MatchResult = {
  matched: false,
  consumedSegments: [],
  remainingSegments: [],
  parameters: {},
  positionalParamSegments: {},
};

/**
 * What route matching is being used for.
 *
 * - `navigation`: matching for a navigation. Guards run and a route's configuration is applied
 *   before its children are matched.
 * - `preload`: matching for a preload. The result is discarded, so guards are not run, but the
 *   configurations are still applied in order because the snapshots built from them are used to
 *   run the resolvers and resources.
 * - `preload-warmup`: a first pass over the same routes as `preload` whose only purpose is to get
 *   the lazy loading requests started. It does not wait for a configuration before matching the
 *   children of a route, so the configurations along a URL load together rather than one per
 *   level. Everything it produces is discarded and re-derived by the `preload` pass, which then
 *   needs no requests of its own.
 */
export type RecognizeMode = 'navigation' | 'preload' | 'preload-warmup';

export function createPreMatchRouteSnapshot(
  snapshot: ActivatedRouteSnapshot,
): PartialMatchRouteSnapshot {
  return {
    routeConfig: snapshot.routeConfig,
    url: snapshot.url,
    params: snapshot.params,
    queryParams: snapshot.queryParams,
    fragment: snapshot.fragment,
    data: snapshot.data,
    outlet: snapshot.outlet,
    title: snapshot.title,
    paramMap: snapshot.paramMap,
    queryParamMap: snapshot.queryParamMap,
  };
}

export async function matchWithChecks(
  segmentGroup: UrlSegmentGroup,
  route: Route,
  segments: UrlSegment[],
  injector: EnvironmentInjector,
  urlSerializer: UrlSerializer,
  createSnapshot: (result: MatchResult) => ActivatedRouteSnapshot,
  abortSignal: AbortSignal,
  configLoader: RouterConfigLoader,
  mode: RecognizeMode = 'navigation',
): Promise<MatchResult> {
  const result = match(segmentGroup, route, segments);
  if (!result.matched) {
    return result;
  }

  if (mode === 'navigation') {
    if (route.loadConfig && !isConfigLoaded(route)) {
      await configLoader.loadConfig(route);
      if (abortSignal.aborted) {
        throw new Error(abortSignal.reason);
      }
    }

    const currentSnapshot = createPreMatchRouteSnapshot(createSnapshot(result));
    // Only create the Route's `EnvironmentInjector` if it matches the attempted
    // navigation
    injector = getOrCreateRouteInjectorIfNeeded(route, injector);
    const canMatch = await firstValueFrom(
      runCanMatchGuards(injector, route, segments, urlSerializer, currentSnapshot, abortSignal),
    );
    return canMatch === true ? result : {...noMatch};
  }

  // Preloading is speculative and its results are discarded, so it does not run `canMatch`. That
  // also means it does not need the route's `EnvironmentInjector`, and that it can start loading
  // the component as soon as the path matches instead of waiting for the guards. The component is
  // picked up later by `loadComponents`, which shares the same in-flight request; rejections are
  // ignored here because `loadComponents` reports them for the routes that are part of the tree.
  if (route.loadComponent && !route._loadedComponent) {
    configLoader.loadComponent(route).catch(() => {});
  }

  if (route.loadConfig && !isConfigLoaded(route)) {
    const config = configLoader.loadConfig(route);
    if (mode === 'preload') {
      await config;
      if (abortSignal.aborted) {
        throw new Error(abortSignal.reason);
      }
    } else {
      // Nothing that a configuration contributes is needed to keep matching, so the warm-up pass
      // moves on without it. This is what lets the configurations along the URL load together
      // rather than one per level of the route tree.
      config.catch(() => {});
    }
  }

  return result;
}

export function match(
  segmentGroup: UrlSegmentGroup,
  route: Route,
  segments: UrlSegment[],
): MatchResult {
  if (route.path === '') {
    if (route.pathMatch === 'full' && (segmentGroup.hasChildren() || segments.length > 0)) {
      return {...noMatch};
    }

    return {
      matched: true,
      consumedSegments: [],
      remainingSegments: segments,
      parameters: {},
      positionalParamSegments: {},
    };
  }

  const matcher = route.matcher || defaultUrlMatcher;
  const res = matcher(segments, segmentGroup, route);
  if (!res) return {...noMatch};

  const posParams: {[n: string]: string} = {};
  Object.entries(res.posParams ?? {}).forEach(([k, v]) => {
    posParams[k] = v.path;
  });
  const parameters =
    res.consumed.length > 0
      ? {...posParams, ...res.consumed[res.consumed.length - 1].parameters}
      : posParams;

  return {
    matched: true,
    consumedSegments: res.consumed,
    remainingSegments: segments.slice(res.consumed.length),
    // TODO(atscott): investigate combining parameters and positionalParamSegments
    parameters,
    positionalParamSegments: res.posParams ?? {},
  };
}

export function split(
  segmentGroup: UrlSegmentGroup,
  consumedSegments: UrlSegment[],
  slicedSegments: UrlSegment[],
  config: Route[],
  outlet?: string,
): {
  segmentGroup: UrlSegmentGroup;
  slicedSegments: UrlSegment[];
} {
  if (
    slicedSegments.length > 0 &&
    containsEmptyPathMatchesWithNamedOutlets(segmentGroup, slicedSegments, config, outlet)
  ) {
    const s = new UrlSegmentGroup(
      consumedSegments,
      createChildrenForEmptyPaths(
        config,
        new UrlSegmentGroup(slicedSegments, segmentGroup.children),
      ),
    );
    return {segmentGroup: s, slicedSegments: []};
  }

  if (
    slicedSegments.length === 0 &&
    containsEmptyPathMatches(segmentGroup, slicedSegments, config)
  ) {
    const s = new UrlSegmentGroup(
      segmentGroup.segments,
      addEmptyPathsToChildrenIfNeeded(segmentGroup, slicedSegments, config, segmentGroup.children),
    );
    return {segmentGroup: s, slicedSegments};
  }

  const s = new UrlSegmentGroup(segmentGroup.segments, segmentGroup.children);
  return {segmentGroup: s, slicedSegments};
}

function addEmptyPathsToChildrenIfNeeded(
  segmentGroup: UrlSegmentGroup,
  slicedSegments: UrlSegment[],
  routes: Route[],
  children: {[name: string]: UrlSegmentGroup},
): {[name: string]: UrlSegmentGroup} {
  const res: {[name: string]: UrlSegmentGroup} = {};
  for (const r of routes) {
    if (emptyPathMatch(segmentGroup, slicedSegments, r) && !children[getOutlet(r)]) {
      const s = new UrlSegmentGroup([], {});
      res[getOutlet(r)] = s;
    }
  }
  return {...children, ...res};
}

function createChildrenForEmptyPaths(
  routes: Route[],
  primarySegment: UrlSegmentGroup,
): {[name: string]: UrlSegmentGroup} {
  const res: {[name: string]: UrlSegmentGroup} = {};
  res[PRIMARY_OUTLET] = primarySegment;

  for (const r of routes) {
    if (r.path === '' && getOutlet(r) !== PRIMARY_OUTLET) {
      const s = new UrlSegmentGroup([], {});
      res[getOutlet(r)] = s;
    }
  }
  return res;
}

function containsEmptyPathMatchesWithNamedOutlets(
  segmentGroup: UrlSegmentGroup,
  slicedSegments: UrlSegment[],
  routes: Route[],
  outlet?: string,
): boolean {
  return routes.some((r) => {
    // 1. Can this route match as an empty path?
    const matchesEmpty = emptyPathMatch(segmentGroup, slicedSegments, r);
    if (!matchesEmpty) return false;

    // 2. Is this a named outlet? (We only pull in empty paths if they are named outlets).
    const isNamedOutlet = getOutlet(r) !== PRIMARY_OUTLET;
    if (!isNamedOutlet) return false;

    // 3. Are we already processing this outlet? If so, we ignore it as a pull-in
    // candidate. For example, if we are evaluating the 'secondary' outlet, we shouldn't
    // "pull in" an empty 'secondary' group.  We should let standard
    // segment matching handle it (which looks at the actual characters in the URL).
    const isSelfEvaluating = outlet !== undefined && getOutlet(r) === outlet;
    return !isSelfEvaluating;
  });
}

function containsEmptyPathMatches(
  segmentGroup: UrlSegmentGroup,
  slicedSegments: UrlSegment[],
  routes: Route[],
): boolean {
  return routes.some((r) => emptyPathMatch(segmentGroup, slicedSegments, r));
}

export function emptyPathMatch(
  segmentGroup: UrlSegmentGroup,
  slicedSegments: UrlSegment[],
  r: Route,
): boolean {
  if ((segmentGroup.hasChildren() || slicedSegments.length > 0) && r.pathMatch === 'full') {
    return false;
  }

  return r.path === '';
}

export function noLeftoversInUrl(
  segmentGroup: UrlSegmentGroup,
  segments: UrlSegment[],
  outlet: string,
): boolean {
  return segments.length === 0 && !segmentGroup.children[outlet];
}
