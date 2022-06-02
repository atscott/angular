/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {createEnvironmentInjector, EnvironmentInjector} from '@angular/core';
import {defer, Observable} from 'rxjs';
import {map, tap} from 'rxjs/operators';

import {LoadedRouterConfig, Route, Routes} from './models';
import {runCanLoadGuards} from './operators/check_guards';
import {RouterConfigLoader} from './router_config_loader';
import {navigationCancelingError, Params, PRIMARY_OUTLET} from './shared';
import {UrlSegment, UrlSegmentGroup, UrlSerializer, UrlTree} from './url_tree';
import {forEach} from './utils/collection';
import {getOutlet, sortByMatchingOutlets} from './utils/config';
import {isImmediateMatch, match, matchWithChecks, noLeftoversInUrl, split} from './utils/config_matching';

class NoMatch {
  public segmentGroup: UrlSegmentGroup|null;

  constructor(segmentGroup?: UrlSegmentGroup) {
    this.segmentGroup = segmentGroup || null;
  }
}
function noMatchError(e: NoMatch): any {
  return new Error(`Cannot match any routes. URL Segment: '${e.segmentGroup}'`);
}

class AbsoluteRedirect {
  constructor(public urlTree: UrlTree) {}
}

/**
 * Returns the `UrlTree` with the redirection applied.
 *
 * Lazy modules are loaded along the way.
 */
export function applyRedirects(
    injector: EnvironmentInjector, configLoader: RouterConfigLoader, urlSerializer: UrlSerializer,
    urlTree: UrlTree, config: Routes): Observable<UrlTree> {
  return defer(
             () =>
                 new ApplyRedirects(injector, configLoader, urlSerializer, urlTree, config).apply())
      .pipe(map(result => {
        if (result instanceof NoMatch) {
          throw noMatchError(result);
        }
        return result;
      }));
}

class ApplyRedirects {
  private allowRedirects: boolean = true;

  constructor(
      private injector: EnvironmentInjector, private configLoader: RouterConfigLoader,
      private urlSerializer: UrlSerializer, private urlTree: UrlTree, private config: Routes) {}

  async apply(): Promise<UrlTree|NoMatch> {
    const splitGroup = split(this.urlTree.root, [], [], this.config).segmentGroup;
    // TODO(atscott): creating a new segment removes the _sourceSegment _segmentIndexShift, which is
    // only necessary to prevent failures in tests which assert exact object matches. The `split` is
    // now shared between `applyRedirects` and `recognize` but only the `recognize` step needs these
    // properties. Before the implementations were merged, the `applyRedirects` would not assign
    // them. We should be able to remove this logic as a "breaking change" but should do some more
    // investigation into the failures first.
    const rootSegmentGroup1 = new UrlSegmentGroup(splitGroup.segments, splitGroup.children);

    try {
      const rootSegmentGroup = await this.expandSegmentGroup(
          this.injector, this.config, rootSegmentGroup1, PRIMARY_OUTLET);
      if (rootSegmentGroup instanceof NoMatch) {
        return rootSegmentGroup;
      }
      return this.createUrlTree(
          squashSegmentGroup(rootSegmentGroup), this.urlTree.queryParams, this.urlTree.fragment);
    } catch (e) {
      if (e instanceof AbsoluteRedirect) {
        // After an absolute redirect we do not apply any more redirects!
        // If this implementation changes, update the documentation note in `redirectTo`.
        this.allowRedirects = false;
        // we need to run matching, so we can fetch all lazy-loaded modules
        return this.match(e.urlTree);
      }

      throw e;
    }
  }

  private async match(tree: UrlTree): Promise<UrlTree|NoMatch> {
    const rootSegmentGroup =
        await this.expandSegmentGroup(this.injector, this.config, tree.root, PRIMARY_OUTLET);
    if (rootSegmentGroup instanceof NoMatch) {
      return rootSegmentGroup;
    }
    return this.createUrlTree(
        squashSegmentGroup(rootSegmentGroup), tree.queryParams, tree.fragment);
  }

  private createUrlTree(rootCandidate: UrlSegmentGroup, queryParams: Params, fragment: string|null):
      UrlTree {
    const root = rootCandidate.segments.length > 0 ?
        new UrlSegmentGroup([], {[PRIMARY_OUTLET]: rootCandidate}) :
        rootCandidate;
    return new UrlTree(root, queryParams, fragment);
  }

  private async expandSegmentGroup(
      injector: EnvironmentInjector, routes: Route[], segmentGroup: UrlSegmentGroup,
      outlet: string): Promise<UrlSegmentGroup|NoMatch> {
    if (segmentGroup.segments.length === 0 && segmentGroup.hasChildren()) {
      const children = await this.expandChildren(injector, routes, segmentGroup)
      return children instanceof NoMatch ? children : new UrlSegmentGroup([], children);
    }

    return this.expandSegment(injector, segmentGroup, routes, segmentGroup.segments, outlet, true);
  }

  // Recursively expand segment groups for all the child outlets
  private async expandChildren(
      injector: EnvironmentInjector, routes: Route[],
      segmentGroup: UrlSegmentGroup): Promise<{[name: string]: UrlSegmentGroup}|NoMatch> {
    // Expand outlets one at a time, starting with the primary outlet. We need to do it this way
    // because an absolute redirect from the primary outlet takes precedence.
    const childOutlets: string[] = [];
    for (const child of Object.keys(segmentGroup.children)) {
      if (child === 'primary') {
        childOutlets.unshift(child);
      } else {
        childOutlets.push(child);
      }
    }

    const children: {[outlet: string]: UrlSegmentGroup} = {};
    for (const childOutlet of childOutlets) {
      const child = segmentGroup.children[childOutlet];
      // Sort the routes so routes with outlets that match the segment appear
      // first, followed by routes for other outlets, which might match if they have an
      // empty path.
      const sortedRoutes = sortByMatchingOutlets(routes, childOutlet);
      const outletChildren =
          await this.expandSegmentGroup(injector, sortedRoutes, child, childOutlet);
      if (outletChildren instanceof NoMatch) {
        return outletChildren;
      }
      children[childOutlet] = outletChildren;
    }
    return children;
  }

  private async expandSegment(
      injector: EnvironmentInjector, segmentGroup: UrlSegmentGroup, routes: Route[],
      segments: UrlSegment[], outlet: string,
      allowRedirects: boolean): Promise<UrlSegmentGroup|NoMatch> {
    for (const r of routes) {
      if (r.providers && !r._injector) {
        r._injector = createEnvironmentInjector(r.providers, injector, `Route: ${r.path}`);
      }
      // We specifically _do not_ want to include the _loadedInjector here. The loaded injector
      // only applies to the route's children, not the route itself. Note that this distinction
      // only applies here to any tokens we try to retrieve during this phase (CanMatch guards).
      const children = await this.expandSegmentAgainstRoute(
          r._injector ?? injector, segmentGroup, routes, r, segments, outlet, allowRedirects);
      if (!(children instanceof NoMatch)) {
        return children;
      }
    }
    if (noLeftoversInUrl(segmentGroup, segments, outlet)) {
      return new UrlSegmentGroup([], {});
    }
    return new NoMatch(segmentGroup);
  }

  private async expandSegmentAgainstRoute(
      injector: EnvironmentInjector, segmentGroup: UrlSegmentGroup, routes: Route[], route: Route,
      paths: UrlSegment[], outlet: string,
      allowRedirects: boolean): Promise<UrlSegmentGroup|NoMatch> {
    if (!isImmediateMatch(route, segmentGroup, paths, outlet)) {
      return new NoMatch(segmentGroup);
    }

    if (route.redirectTo === undefined) {
      return this.matchSegmentAgainstRoute(injector, segmentGroup, route, paths, outlet);
    }

    if (allowRedirects && this.allowRedirects) {
      return this.expandSegmentAgainstRouteUsingRedirect(
          injector, segmentGroup, routes, route, paths, outlet);
    }

    return new NoMatch(segmentGroup);
  }

  private async expandSegmentAgainstRouteUsingRedirect(
      injector: EnvironmentInjector, segmentGroup: UrlSegmentGroup, routes: Route[], route: Route,
      segments: UrlSegment[], outlet: string): Promise<UrlSegmentGroup|NoMatch> {
    if (route.path === '**') {
      return this.expandWildCardWithParamsAgainstRouteUsingRedirect(
          injector, routes, route, outlet);
    }

    return this.expandRegularSegmentAgainstRouteUsingRedirect(
        injector, segmentGroup, routes, route, segments, outlet);
  }

  private expandWildCardWithParamsAgainstRouteUsingRedirect(
      injector: EnvironmentInjector, routes: Route[], route: Route,
      outlet: string): Promise<UrlSegmentGroup|NoMatch> {
    const newTree = this.applyRedirectCommands([], route.redirectTo!, {});
    if (route.redirectTo!.startsWith('/')) {
      throw new AbsoluteRedirect(newTree);
    }

    const newSegments = this.lineralizeSegments(route, newTree);
    const group = new UrlSegmentGroup(newSegments, {});
    return this.expandSegment(injector, group, routes, newSegments, outlet, false);
  }

  private async expandRegularSegmentAgainstRouteUsingRedirect(
      injector: EnvironmentInjector, segmentGroup: UrlSegmentGroup, routes: Route[], route: Route,
      segments: UrlSegment[], outlet: string): Promise<UrlSegmentGroup|NoMatch> {
    const {matched, consumedSegments, remainingSegments, positionalParamSegments} =
        match(segmentGroup, route, segments);
    if (!matched) return new NoMatch(segmentGroup);

    const newTree =
        this.applyRedirectCommands(consumedSegments, route.redirectTo!, positionalParamSegments);
    if (route.redirectTo!.startsWith('/')) {
      throw new AbsoluteRedirect(newTree);
    }

    const newSegments = this.lineralizeSegments(route, newTree);
    return this.expandSegment(
        injector, segmentGroup, routes, newSegments.concat(remainingSegments), outlet, false);
  }

  private async matchSegmentAgainstRoute(
      injector: EnvironmentInjector, rawSegmentGroup: UrlSegmentGroup, route: Route,
      segments: UrlSegment[], outlet: string): Promise<UrlSegmentGroup|NoMatch> {
    if (route.path === '**') {
      if (route.loadChildren) {
        const cfg = route._loadedRoutes ?
            {routes: route._loadedRoutes, injector: route._loadedInjector} :
            await this.configLoader.loadChildren(injector, route).toPromise();
        route._loadedRoutes = cfg.routes;
        route._loadedInjector = cfg.injector;
        return new UrlSegmentGroup(segments, {});
      }

      return new UrlSegmentGroup(segments, {});
    }

    const result =
        await matchWithChecks(rawSegmentGroup, route, segments, injector, this.urlSerializer)
            .toPromise();
    const {matched, consumedSegments, remainingSegments} = result;
    if (!matched) return new NoMatch(rawSegmentGroup);

    const routerConfig = await this.getChildConfig(injector, route, segments);

    const childInjector = routerConfig.injector ?? injector;
    const childConfig = routerConfig.routes;

    const {segmentGroup: splitSegmentGroup, slicedSegments} =
        split(rawSegmentGroup, consumedSegments, remainingSegments, childConfig);
    // See comment on the other call to `split` about why this is necessary.
    const segmentGroup =
        new UrlSegmentGroup(splitSegmentGroup.segments, splitSegmentGroup.children);

    if (slicedSegments.length === 0 && segmentGroup.hasChildren()) {
      const children = await this.expandChildren(childInjector, childConfig, segmentGroup);
      if (children instanceof NoMatch) {
        return children;
      }
      return new UrlSegmentGroup(consumedSegments, children);
    }

    if (childConfig.length === 0 && slicedSegments.length === 0) {
      return new UrlSegmentGroup(consumedSegments, {});
    }

    const matchedOnOutlet = getOutlet(route) === outlet;
    const cs = await this.expandSegment(
        childInjector, segmentGroup, childConfig, slicedSegments,
        matchedOnOutlet ? PRIMARY_OUTLET : outlet, true);
    if (cs instanceof NoMatch) {
      return cs;
    }
    return new UrlSegmentGroup(consumedSegments.concat(cs.segments), cs.children);
  }

  private async getChildConfig(injector: EnvironmentInjector, route: Route, segments: UrlSegment[]):
      Promise<LoadedRouterConfig> {
    if (route.children) {
      // The children belong to the same module
      return {routes: route.children, injector};
    }

    if (route.loadChildren) {
      // lazy children belong to the loaded module
      if (route._loadedRoutes !== undefined) {
        return {routes: route._loadedRoutes, injector: route._loadedInjector};
      }

      const shouldLoadResult =
          await runCanLoadGuards(injector, route, segments, this.urlSerializer).toPromise();
      if (shouldLoadResult) {
        const cfg = await this.configLoader.loadChildren(injector, route).toPromise();
        route._loadedRoutes = cfg.routes;
        route._loadedInjector = cfg.injector;
        return cfg;
      } else {
        throw navigationCancelingError(
            `Cannot load children because the guard of the route "path: '${
                route.path}'" returned false`);
      }
    }

    return {routes: [], injector};
  }

  private lineralizeSegments(route: Route, urlTree: UrlTree): UrlSegment[] {
    let res: UrlSegment[] = [];
    let c = urlTree.root;
    while (true) {
      res = res.concat(c.segments);
      if (c.numberOfChildren === 0) {
        return res;
      }

      if (c.numberOfChildren > 1 || !c.children[PRIMARY_OUTLET]) {
        throw new Error(
            `Only absolute redirects can have named outlets. redirectTo: '${route.redirectTo}'`)
      }

      c = c.children[PRIMARY_OUTLET];
    }
  }

  private applyRedirectCommands(
      segments: UrlSegment[], redirectTo: string, posParams: {[k: string]: UrlSegment}): UrlTree {
    return this.applyRedirectCreatreUrlTree(
        redirectTo, this.urlSerializer.parse(redirectTo), segments, posParams);
  }

  private applyRedirectCreatreUrlTree(
      redirectTo: string, urlTree: UrlTree, segments: UrlSegment[],
      posParams: {[k: string]: UrlSegment}): UrlTree {
    const newRoot = this.createSegmentGroup(redirectTo, urlTree.root, segments, posParams);
    return new UrlTree(
        newRoot, this.createQueryParams(urlTree.queryParams, this.urlTree.queryParams),
        urlTree.fragment);
  }

  private createQueryParams(redirectToParams: Params, actualParams: Params): Params {
    const res: Params = {};
    forEach(redirectToParams, (v: any, k: string) => {
      const copySourceValue = typeof v === 'string' && v.startsWith(':');
      if (copySourceValue) {
        const sourceName = v.substring(1);
        res[k] = actualParams[sourceName];
      } else {
        res[k] = v;
      }
    });
    return res;
  }

  private createSegmentGroup(
      redirectTo: string, group: UrlSegmentGroup, segments: UrlSegment[],
      posParams: {[k: string]: UrlSegment}): UrlSegmentGroup {
    const updatedSegments = this.createSegments(redirectTo, group.segments, segments, posParams);

    let children: {[n: string]: UrlSegmentGroup} = {};
    forEach(group.children, (child: UrlSegmentGroup, name: string) => {
      children[name] = this.createSegmentGroup(redirectTo, child, segments, posParams);
    });

    return new UrlSegmentGroup(updatedSegments, children);
  }

  private createSegments(
      redirectTo: string, redirectToSegments: UrlSegment[], actualSegments: UrlSegment[],
      posParams: {[k: string]: UrlSegment}): UrlSegment[] {
    return redirectToSegments.map(
        s => s.path.startsWith(':') ? this.findPosParam(redirectTo, s, posParams) :
                                      this.findOrReturn(s, actualSegments));
  }

  private findPosParam(
      redirectTo: string, redirectToUrlSegment: UrlSegment,
      posParams: {[k: string]: UrlSegment}): UrlSegment {
    const pos = posParams[redirectToUrlSegment.path.substring(1)];
    if (!pos)
      throw new Error(
          `Cannot redirect to '${redirectTo}'. Cannot find '${redirectToUrlSegment.path}'.`);
    return pos;
  }

  private findOrReturn(redirectToUrlSegment: UrlSegment, actualSegments: UrlSegment[]): UrlSegment {
    let idx = 0;
    for (const s of actualSegments) {
      if (s.path === redirectToUrlSegment.path) {
        actualSegments.splice(idx);
        return s;
      }
      idx++;
    }
    return redirectToUrlSegment;
  }
}

/**
 * When possible, merges the primary outlet child into the parent `UrlSegmentGroup`.
 *
 * When a segment group has only one child which is a primary outlet, merges that child into the
 * parent. That is, the child segment group's segments are merged into the `s` and the child's
 * children become the children of `s`. Think of this like a 'squash', merging the child segment
 * group into the parent.
 */
function mergeTrivialChildren(s: UrlSegmentGroup): UrlSegmentGroup {
  if (s.numberOfChildren === 1 && s.children[PRIMARY_OUTLET]) {
    const c = s.children[PRIMARY_OUTLET];
    return new UrlSegmentGroup(s.segments.concat(c.segments), c.children);
  }

  return s;
}

/**
 * Recursively merges primary segment children into their parents and also drops empty children
 * (those which have no segments and no children themselves). The latter prevents serializing a
 * group into something like `/a(aux:)`, where `aux` is an empty child segment.
 */
function squashSegmentGroup(segmentGroup: UrlSegmentGroup): UrlSegmentGroup {
  const newChildren = {} as any;
  for (const childOutlet of Object.keys(segmentGroup.children)) {
    const child = segmentGroup.children[childOutlet];
    const childCandidate = squashSegmentGroup(child);
    // don't add empty children
    if (childCandidate.segments.length > 0 || childCandidate.hasChildren()) {
      newChildren[childOutlet] = childCandidate;
    }
  }
  const s = new UrlSegmentGroup(segmentGroup.segments, newChildren);
  return mergeTrivialChildren(s);
}
