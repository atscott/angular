/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {EnvironmentInjector, Type, ɵRuntimeError as RuntimeError} from '@angular/core';
import {Observable} from 'rxjs'; // `from` and `of` might not be needed anymore

import {AbsoluteRedirect, ApplyRedirects, NoMatch} from './apply_redirects'; // Removed canLoadFails, noMatch (function)
import {createUrlTreeFromSnapshot} from './create_url_tree';
import {RuntimeErrorCode} from './errors';
import {Data, LoadedRouterConfig, ResolveData, Route, Routes} from './models';
import {runCanLoadGuards} from './operators/check_guards';
import {RouterConfigLoader} from './router_config_loader';
import {
  ActivatedRouteSnapshot,
  getInherited,
  ParamsInheritanceStrategy,
  RouterStateSnapshot,
} from './router_state';
import {PRIMARY_OUTLET} from './shared';
import {UrlSegment, UrlSegmentGroup, UrlSerializer, UrlTree} from './url_tree';
import {getOutlet, sortByMatchingOutlets} from './utils/config';
import {
  emptyPathMatch,
  match,
  matchWithChecks,
  noLeftoversInUrl,
  split,
} from './utils/config_matching';
import {TreeNode} from './utils/tree';
// isEmptyError might not be needed if RxJS is fully removed from this file's logic paths

/**
 * Class used to indicate there were no additional route config matches but that all segments of
 * the URL were consumed during matching so the route was URL matched. When this happens, we still
 * try to match child configs in case there are empty path children.
 */
class NoLeftoversInUrl {}

export function recognize(
  injector: EnvironmentInjector,
  configLoader: RouterConfigLoader,
  rootComponentType: Type<any> | null,
  config: Routes,
  urlTree: UrlTree,
  urlSerializer: UrlSerializer,
  paramsInheritanceStrategy: ParamsInheritanceStrategy = 'emptyOnly',
): Promise<{state: RouterStateSnapshot; tree: UrlTree}> {
  return new Recognizer(
    injector,
    configLoader,
    rootComponentType,
    config,
    urlTree,
    paramsInheritanceStrategy,
    urlSerializer,
  ).recognize();
}

const MAX_ALLOWED_REDIRECTS = 31;

export class Recognizer {
  private applyRedirects: ApplyRedirects;
  private absoluteRedirectCount = 0;
  allowRedirects = true;

  constructor(
    private injector: EnvironmentInjector,
    private configLoader: RouterConfigLoader,
    private rootComponentType: Type<any> | null,
    private config: Routes,
    private urlTree: UrlTree,
    private paramsInheritanceStrategy: ParamsInheritanceStrategy,
    private readonly urlSerializer: UrlSerializer,
  ) {
    this.applyRedirects = new ApplyRedirects(this.urlSerializer, this.urlTree);
  }

  private noMatchError(e: NoMatch): RuntimeError<RuntimeErrorCode.NO_MATCH> {
    return new RuntimeError(
      RuntimeErrorCode.NO_MATCH,
      (typeof ngDevMode === 'undefined' || ngDevMode) &&
        `Cannot match any routes. URL Segment: '${e.segmentGroup}'`,
    );
  }

  async recognize(): Promise<{state: RouterStateSnapshot; tree: UrlTree}> {
    const rootSegmentGroup = split(this.urlTree.root, [], [], this.config).segmentGroup;
    const {children, rootSnapshot} = await this.match(rootSegmentGroup);

    const rootNode = new TreeNode(rootSnapshot, children);
    const routeState = new RouterStateSnapshot('', rootNode);
    const tree = createUrlTreeFromSnapshot(
      rootSnapshot,
      [],
      this.urlTree.queryParams,
      this.urlTree.fragment,
    );
    tree.queryParams = this.urlTree.queryParams;
    routeState.url = this.urlSerializer.serialize(tree);
    return {state: routeState, tree};
  }

  private async match(rootSegmentGroup: UrlSegmentGroup): Promise<{
    children: TreeNode<ActivatedRouteSnapshot>[];
    rootSnapshot: ActivatedRouteSnapshot;
  }> {
    const rootSnapshot = new ActivatedRouteSnapshot(
      [],
      Object.freeze({}),
      Object.freeze({...this.urlTree.queryParams}),
      this.urlTree.fragment,
      Object.freeze({}),
      PRIMARY_OUTLET,
      this.rootComponentType,
      null,
      {},
    );
    try {
      const children = await this.processSegmentGroup(
        this.injector,
        this.config,
        rootSegmentGroup,
        PRIMARY_OUTLET,
        rootSnapshot,
      );
      return {children, rootSnapshot};
    } catch (e: any) {
      if (e instanceof AbsoluteRedirect) {
        this.urlTree = e.urlTree;
        return this.match(e.urlTree.root); // Recursive async call
      }
      if (e instanceof NoMatch) {
        throw this.noMatchError(e);
      }
      throw e;
    }
  }

  async processSegmentGroup(
    injector: EnvironmentInjector,
    config: Route[],
    segmentGroup: UrlSegmentGroup,
    outlet: string,
    parentRoute: ActivatedRouteSnapshot,
  ): Promise<TreeNode<ActivatedRouteSnapshot>[]> {
    if (segmentGroup.segments.length === 0 && segmentGroup.hasChildren()) {
      return await this.processChildren(injector, config, segmentGroup, parentRoute);
    }

    const child = await this.processSegment(
      injector,
      config,
      segmentGroup,
      segmentGroup.segments,
      outlet,
      true,
      parentRoute,
    );
    return child instanceof TreeNode ? [child] : [];
  }

  async processChildren(
    injector: EnvironmentInjector,
    config: Route[],
    segmentGroup: UrlSegmentGroup,
    parentRoute: ActivatedRouteSnapshot,
  ): Promise<TreeNode<ActivatedRouteSnapshot>[]> {
    const childOutlets: string[] = [];
    for (const child of Object.keys(segmentGroup.children)) {
      child === 'primary' ? childOutlets.unshift(child) : childOutlets.push(child);
    }

    const accumulatedChildren: TreeNode<ActivatedRouteSnapshot>[] = [];
    for (const childOutlet of childOutlets) {
      const child = segmentGroup.children[childOutlet];
      const sortedConfig = sortByMatchingOutlets(config, childOutlet);
      const outletChildren = await this.processSegmentGroup(
        injector,
        sortedConfig,
        child,
        childOutlet,
        parentRoute,
      );
      accumulatedChildren.push(...outletChildren);
    }

    if (accumulatedChildren.length === 0 && childOutlets.length > 0) {
      throw new NoMatch(segmentGroup);
    }

    const mergedChildren = mergeEmptyPathMatches(accumulatedChildren);
    if ((typeof ngDevMode === 'undefined' || ngDevMode)) {
      checkOutletNameUniqueness(mergedChildren);
    }
    sortActivatedRouteSnapshots(mergedChildren);
    return mergedChildren; // Already a Promise due to async
  }

  async processSegment(
    injector: EnvironmentInjector,
    routes: Route[],
    segmentGroup: UrlSegmentGroup,
    segments: UrlSegment[],
    outlet: string,
    allowRedirects: boolean,
    parentRoute: ActivatedRouteSnapshot,
  ): Promise<TreeNode<ActivatedRouteSnapshot> | NoLeftoversInUrl> {
    for (const r of routes) {
      try {
        return await this.processSegmentAgainstRoute(
          r._injector ?? injector,
          routes,
          r,
          segmentGroup,
          segments,
          outlet,
          allowRedirects,
          parentRoute,
        );
      } catch (e: any) {
        if (!(e instanceof NoMatch)) throw e;
      }
    }
    if (noLeftoversInUrl(segmentGroup, segments, outlet)) {
      return new NoLeftoversInUrl(); // No need for Promise.resolve due to async
    }
    throw new NoMatch(segmentGroup);
  }

  async processSegmentAgainstRoute(
    injector: EnvironmentInjector,
    routes: Route[],
    route: Route,
    rawSegment: UrlSegmentGroup,
    segments: UrlSegment[],
    outlet: string,
    allowRedirects: boolean,
    parentRoute: ActivatedRouteSnapshot,
  ): Promise<TreeNode<ActivatedRouteSnapshot> | NoLeftoversInUrl> {
    if (
      getOutlet(route) !== outlet &&
      (outlet === PRIMARY_OUTLET || !emptyPathMatch(rawSegment, segments, route))
    ) {
      throw new NoMatch(rawSegment);
    }

    if (route.redirectTo === undefined) {
      return await this.matchSegmentAgainstRoute(
        injector,
        rawSegment,
        route,
        segments,
        outlet,
        parentRoute,
      );
    }

    if (this.allowRedirects && allowRedirects) {
      return await this.expandSegmentAgainstRouteUsingRedirect(
        injector,
        rawSegment,
        routes,
        route,
        segments,
        outlet,
        parentRoute,
      );
    }
    throw new NoMatch(rawSegment);
  }

  private async expandSegmentAgainstRouteUsingRedirect(
    injector: EnvironmentInjector,
    segmentGroup: UrlSegmentGroup,
    routes: Route[],
    route: Route,
    segments: UrlSegment[],
    outlet: string,
    parentRoute: ActivatedRouteSnapshot,
  ): Promise<TreeNode<ActivatedRouteSnapshot> | NoLeftoversInUrl> {
    const {matched, parameters, consumedSegments, positionalParamSegments, remainingSegments} =
      match(segmentGroup, route, segments);
    if (!matched) throw new NoMatch(segmentGroup);

    if (typeof route.redirectTo === 'string' && route.redirectTo[0] === '/') {
      this.absoluteRedirectCount++;
      if (this.absoluteRedirectCount > MAX_ALLOWED_REDIRECTS) {
        if (ngDevMode) {
          throw new RuntimeError(
            RuntimeErrorCode.INFINITE_REDIRECT,
            `Detected possible infinite redirect when redirecting from '${this.urlTree}' to '${route.redirectTo}'.\n` +
              `This is currently a dev mode only error but will become a` +
              ` call stack size exceeded error in production in a future major version.`,
          );
        }
        this.allowRedirects = false;
      }
    }
    const currentSnapshot = new ActivatedRouteSnapshot(
      segments,
      parameters,
      Object.freeze({...this.urlTree.queryParams}),
      this.urlTree.fragment,
      getData(route),
      getOutlet(route),
      route.component ?? route._loadedComponent ?? null,
      route,
      getResolve(route),
    );
    const inherited = getInherited(currentSnapshot, parentRoute, this.paramsInheritanceStrategy);
    currentSnapshot.params = Object.freeze(inherited.params);
    currentSnapshot.data = Object.freeze(inherited.data);

    // Assuming applyRedirectCommands still returns Observable
    const newTreeObservable: Observable<UrlTree> = this.applyRedirects.applyRedirectCommands(
      consumedSegments,
      route.redirectTo!,
      positionalParamSegments,
      currentSnapshot,
      injector,
    );
    const newTree = await newTreeObservable.toPromise();
    if (!newTree) {
      throw new RuntimeError(
          RuntimeErrorCode.UNEXPECTED_VALUE_IN_URL, // Placeholder for REDIRECT_GENERATION_FAILED
          (typeof ngDevMode === 'undefined' || ngDevMode) && `Redirect commands did not produce a UrlTree.`);
    }

    // Assuming lineralizeSegments returns Observable
    const linearizedSegmentsObservable = this.applyRedirects.lineralizeSegments(route, newTree);
    const newSegments = await linearizedSegmentsObservable.toPromise();
    if (newSegments === undefined) {
      throw new RuntimeError(
          RuntimeErrorCode.UNEXPECTED_VALUE_IN_URL, // Placeholder for REDIRECT_SEGMENT_LINEARIZATION_FAILED
          (typeof ngDevMode === 'undefined' || ngDevMode) && `Segment linearization failed during redirect.`);
    }

    return await this.processSegment(
      injector,
      routes,
      segmentGroup,
      newSegments.concat(remainingSegments),
      outlet,
      false,
      parentRoute,
    );
  }

  async matchSegmentAgainstRoute(
    injector: EnvironmentInjector,
    rawSegment: UrlSegmentGroup,
    route: Route,
    segments: UrlSegment[],
    outlet: string,
    parentRoute: ActivatedRouteSnapshot,
  ): Promise<TreeNode<ActivatedRouteSnapshot>> {
    const result = await matchWithChecks(rawSegment, route, segments, injector, this.urlSerializer);

    if (!result.matched) {
      throw new NoMatch(rawSegment);
    }

    if (route.path === '**') {
      rawSegment.children = {};
    }

    injector = route._injector ?? injector;
    const {routes: childConfig} = await this.getChildConfig(injector, route, segments);
    const childInjector = route._loadedInjector ?? injector;

    const {parameters, consumedSegments, remainingSegments} = result;
    const snapshot = new ActivatedRouteSnapshot(
      consumedSegments,
      parameters,
      Object.freeze({...this.urlTree.queryParams}),
      this.urlTree.fragment,
      getData(route),
      getOutlet(route),
      route.component ?? route._loadedComponent ?? null,
      route,
      getResolve(route),
    );
    const inherited = getInherited(snapshot, parentRoute, this.paramsInheritanceStrategy);
    snapshot.params = Object.freeze(inherited.params);
    snapshot.data = Object.freeze(inherited.data);

    const {segmentGroup, slicedSegments} = split(
      rawSegment,
      consumedSegments,
      remainingSegments,
      childConfig,
    );

    if (slicedSegments.length === 0 && segmentGroup.hasChildren()) {
      const children = await this.processChildren(childInjector, childConfig, segmentGroup, snapshot);
      return new TreeNode(snapshot, children);
    }

    if (childConfig.length === 0 && slicedSegments.length === 0) {
      return new TreeNode(snapshot, []); // async fn implicitly returns Promise
    }

    const matchedOnOutlet = getOutlet(route) === outlet;
    const child = await this.processSegment(
      childInjector,
      childConfig,
      segmentGroup,
      slicedSegments,
      matchedOnOutlet ? PRIMARY_OUTLET : outlet,
      true,
      snapshot,
    );
    return new TreeNode(snapshot, child instanceof TreeNode ? [child] : []);
  }

  private async getChildConfig(
    injector: EnvironmentInjector,
    route: Route,
    segments: UrlSegment[],
  ): Promise<LoadedRouterConfig> {
    if (route.children) {
      return {routes: route.children, injector};
    }

    if (route.loadChildren) {
      if (route._loadedRoutes !== undefined) {
        return {routes: route._loadedRoutes, injector: route._loadedInjector!};
      }

      const loadSignal = new AbortController().signal;
      const shouldLoadResult = await runCanLoadGuards(injector, route, segments, this.urlSerializer, loadSignal);

      if (shouldLoadResult) {
        const cfg = await this.configLoader.loadChildren(injector, route).toPromise();
        if (cfg === undefined) {
            throw new RuntimeError(RuntimeErrorCode.UNEXPECTED_VALUE_IN_URL, // Placeholder for module load failure
                (typeof ngDevMode === 'undefined' || ngDevMode) && `Cannot load children because the loader returned undefined for route "path: '${route.path}'"`);
        }
        route._loadedRoutes = cfg.routes;
        route._loadedInjector = cfg.injector;
        return cfg;
      }
      throw new RuntimeError(
          RuntimeErrorCode.NO_MATCH, // Placeholder for CANNOT_LOAD_CHILDREN
          (typeof ngDevMode === 'undefined' || ngDevMode) &&
              `Cannot load children because the guard of the route "path: '${
                  route.path}'" returned false`);
    }
    return {routes: [], injector};
  }
}

function sortActivatedRouteSnapshots(nodes: TreeNode<ActivatedRouteSnapshot>[]): void {
  nodes.sort((a, b) => {
    if (a.value.outlet === PRIMARY_OUTLET) return -1;
    if (b.value.outlet === PRIMARY_OUTLET) return 1;
    return a.value.outlet.localeCompare(b.value.outlet);
  });
}

function hasEmptyPathConfig(node: TreeNode<ActivatedRouteSnapshot>) {
  const config = node.value.routeConfig;
  return config && config.path === '';
}

function mergeEmptyPathMatches(
  nodes: Array<TreeNode<ActivatedRouteSnapshot>>,
): Array<TreeNode<ActivatedRouteSnapshot>> {
  const result: Array<TreeNode<ActivatedRouteSnapshot>> = [];
  const mergedNodes: Set<TreeNode<ActivatedRouteSnapshot>> = new Set();

  for (const node of nodes) {
    if (!hasEmptyPathConfig(node)) {
      result.push(node);
      continue;
    }

    const duplicateEmptyPathNode = result.find(
      (resultNode) => node.value.routeConfig === resultNode.value.routeConfig,
    );
    if (duplicateEmptyPathNode !== undefined) {
      duplicateEmptyPathNode.children.push(...node.children);
      mergedNodes.add(duplicateEmptyPathNode);
    } else {
      result.push(node);
    }
  }
  for (const mergedNode of mergedNodes) {
    const mergedChildren = mergeEmptyPathMatches(mergedNode.children);
    result.push(new TreeNode(mergedNode.value, mergedChildren));
  }
  return result.filter((n) => !mergedNodes.has(n));
}

function checkOutletNameUniqueness(nodes: TreeNode<ActivatedRouteSnapshot>[]): void {
  const names: {[k: string]: ActivatedRouteSnapshot} = {};
  nodes.forEach((n) => {
    const routeWithSameOutletName = names[n.value.outlet];
    if (routeWithSameOutletName) {
      const p = routeWithSameOutletName.url.map((s) => s.toString()).join('/');
      const c = n.value.url.map((s) => s.toString()).join('/');
      throw new RuntimeError(
        RuntimeErrorCode.TWO_SEGMENTS_WITH_SAME_OUTLET,
        (typeof ngDevMode === 'undefined' || ngDevMode) &&
          `Two segments cannot have the same outlet name: '${p}' and '${c}'.`,
      );
    }
    names[n.value.outlet] = n.value;
  });
}

function getData(route: Route): Data {
  return route.data || {};
}

function getResolve(route: Route): ResolveData {
  return route.resolve || {};
}
