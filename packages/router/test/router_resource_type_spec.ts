/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

// These tests mainly check the types of router resources, which is generally enforced
// at compile time.

import {Resource, WritableResource} from '@angular/core';
import {routerResource} from '../src/router_resource';

function _typeTests_() {
  // Read-only resources
  {
    const source: Resource<number> = null as any;
    const res = routerResource({source});

    type ValueType = number | undefined;
    let t: ValueType = res.value();
    t = null as unknown as ValueType;

    // @ts-expect-error read-only resources contain no `reload` method
    res.reload();
  }

  // Writable resources
  {
    const source: WritableResource<number> = null as any;
    const res = routerResource({source});

    type ValueType = number | undefined;
    let t: ValueType = res.value();
    t = null as unknown as ValueType;

    // reload is preserved
    res.reload();

    // @ts-expect-error set is omitted from RouterResource API
    res.set(42);
    // @ts-expect-error update is omitted from RouterResource API
    res.update((v) => (v ?? 0) + 1);

    // @ts-expect-error .value is strictly tracked as a Signal, not WritableSignal
    res.value.set(42);
  }

  // Non-blocking read-only resources
  {
    const source: Resource<number> = null as any;
    const res = routerResource.nonBlocking({source});

    type ValueType = number | undefined;
    let t: ValueType = res.value();
    t = null as unknown as ValueType;

    // @ts-expect-error read-only resources contain no `reload` method
    res.reload();
  }

  // Non-blocking writable resources
  {
    const source: WritableResource<number> = null as any;
    const res = routerResource.nonBlocking({source});

    type ValueType = number | undefined;
    let t: ValueType = res.value();
    t = null as unknown as ValueType;

    // reload is preserved
    res.reload();

    // @ts-expect-error set is omitted from RouterResource API
    res.set(42);

    // @ts-expect-error .value is strictly tracked as a Signal, not WritableSignal
    res.value.set(42);
  }
}

describe('routerResource types', () => {
  it('should compile successfully', () => {
    // This file primarily tests types at compile-time via `_typeTests_()` above.
    expect(true).toBe(true);
  });
});
