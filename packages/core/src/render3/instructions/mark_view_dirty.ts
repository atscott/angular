/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {isRootView} from '../interfaces/type_checks';
import {FLAGS, LView, LViewFlags} from '../interfaces/view';
import {getLViewParent} from '../util/view_traversal_utils';
import {markViewForRefresh} from '../util/view_utils';

/**
 * Marks current view and all ancestors dirty.
 *
 * Returns the root view because it is found as a byproduct of marking the view tree
 * dirty, and can be used by methods that consume markViewDirty() to easily schedule
 * change detection. Otherwise, such methods would need to traverse up the view tree
 * an additional time to get the root view and schedule a tick on it.
 *
 * @param lView The starting LView to mark dirty
 * @returns the root LView
 */
export function markViewDirty(initialLView: LView): LView|null {
  if (initialLView[FLAGS] & LViewFlags.SignalView) {
    markViewForRefresh(initialLView);
    return null;
  }

  let lView: LView|null = initialLView;
  while (lView) {
    if ((lView[FLAGS] & LViewFlags.SignalView)) {
      // We do not mark ancestor signal views dirty. We should skip over them and keep marking any
      // Zone-based views higher up as Dirty.
      lView = getLViewParent(lView);
    } else {
      lView[FLAGS] |= LViewFlags.Dirty;
      const parent = getLViewParent(lView);
      // Stop traversing up as soon as you find a root view that wasn't attached to any container
      if (isRootView(lView) && !parent) {
        return lView;
      }

      // If the parent of this view is a signal view, we aren't going to be marking it as dirty.
      // That means we need to mark _this_ view with the refresh flag that is capable of 'piercing'
      // non-dirty ancestors
      if (parent && parent[FLAGS] & LViewFlags.SignalView) {
        markViewForRefresh(lView);
      }

      lView = parent;
    }
  }
  return null;
}
