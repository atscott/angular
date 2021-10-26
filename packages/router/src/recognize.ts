/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */


import {Data, ResolveData, Route} from './config';
import {ActivatedRouteSnapshot, inheritedParamsDataResolve, ParamsInheritanceStrategy, RouterStateSnapshot} from './router_state';
import {PRIMARY_OUTLET} from './shared';
import {UrlSegmentGroup} from './url_tree';
import {TreeNode} from './utils/tree';

export function sortActivatedRouteSnapshots(nodes: TreeNode<ActivatedRouteSnapshot>[]): void {
  nodes.sort((a, b) => {
    if (a.value.outlet === PRIMARY_OUTLET) return -1;
    if (b.value.outlet === PRIMARY_OUTLET) return 1;
    return a.value.outlet.localeCompare(b.value.outlet);
  });
}

function hasEmptyPathConfig(node: TreeNode<ActivatedRouteSnapshot>) {
  const config = node.value.routeConfig;
  return config && config.path === '' && config.redirectTo === undefined;
}

/**
 * Finds `TreeNode`s with matching empty path route configs and merges them into `TreeNode` with the
 * children from each duplicate. This is necessary because different outlets can match a single
 * empty path route config and the results need to then be merged.
 */
export function mergeEmptyPathMatches(nodes: Array<TreeNode<ActivatedRouteSnapshot>>):
    Array<TreeNode<ActivatedRouteSnapshot>> {
  const result: Array<TreeNode<ActivatedRouteSnapshot>> = [];
  // The set of nodes which contain children that were merged from two duplicate empty path nodes.
  const mergedNodes: Set<TreeNode<ActivatedRouteSnapshot>> = new Set();

  for (const node of nodes) {
    if (!hasEmptyPathConfig(node)) {
      result.push(node);
      continue;
    }

    const duplicateEmptyPathNode =
        result.find(resultNode => node.value.routeConfig === resultNode.value.routeConfig);
    if (duplicateEmptyPathNode !== undefined) {
      duplicateEmptyPathNode.children.push(...node.children);
      mergedNodes.add(duplicateEmptyPathNode);
    } else {
      result.push(node);
    }
  }
  // For each node which has children from multiple sources, we need to recompute a new `TreeNode`
  // by also merging those children. This is necessary when there are multiple empty path configs in
  // a row. Put another way: whenever we combine children of two nodes, we need to also check if any
  // of those children can be combined into a single node as well.
  for (const mergedNode of mergedNodes) {
    const mergedChildren = mergeEmptyPathMatches(mergedNode.children);
    result.push(new TreeNode(mergedNode.value, mergedChildren));
  }
  return result.filter(n => !mergedNodes.has(n));
}

export function checkOutletNameUniqueness(nodes: TreeNode<ActivatedRouteSnapshot>[]): void {
  const names: {[k: string]: ActivatedRouteSnapshot} = {};
  nodes.forEach(n => {
    const routeWithSameOutletName = names[n.value.outlet];
    if (routeWithSameOutletName) {
      const p = routeWithSameOutletName.url.map(s => s.toString()).join('/');
      const c = n.value.url.map(s => s.toString()).join('/');
      throw new Error(`Two segments cannot have the same outlet name: '${p}' and '${c}'.`);
    }
    names[n.value.outlet] = n.value;
  });
}

export function getSourceSegmentGroup(segmentGroup: UrlSegmentGroup): UrlSegmentGroup {
  let s = segmentGroup;
  while (s._sourceSegment) {
    s = s._sourceSegment;
  }
  return s;
}

export function getPathIndexShift(segmentGroup: UrlSegmentGroup): number {
  let s = segmentGroup;
  let res = (s._segmentIndexShift ? s._segmentIndexShift : 0);
  while (s._sourceSegment) {
    s = s._sourceSegment;
    res += (s._segmentIndexShift ? s._segmentIndexShift : 0);
  }
  return res - 1;
}

export function getData(route: Route): Data {
  return route.data || {};
}

export function getResolve(route: Route): ResolveData {
  return route.resolve || {};
}

export function inheritParamsAndData(
    routeNode: TreeNode<ActivatedRouteSnapshot>,
    paramsInheritanceStrategy: ParamsInheritanceStrategy): void {
  const route = routeNode.value;

  const i = inheritedParamsDataResolve(route, paramsInheritanceStrategy);
  route.params = Object.freeze(i.params);
  route.data = Object.freeze(i.data);

  routeNode.children.forEach(n => inheritParamsAndData(n, paramsInheritanceStrategy));
}
