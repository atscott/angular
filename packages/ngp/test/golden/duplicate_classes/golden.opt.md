# /out/app.ngtypecheck.ts
```ts
/**
 * TCB for /app.ts
 * @generated
 */

import { Component, Directive } from '@angular/core';

export function runTest() {
  @Component({
    selector: 'test-cmp',
    template: `<div>Class 1</div>`,
    standalone: true,
  })
  class TestComponent {
    foo: string = '';
  }

  /*tcb1*/
  function _tcb1(this: TestComponent) {
    if (true) {
    }
  }
}

export function runTest2() {
  @Component({
    selector: 'test-cmp',
    template: `<div>Class 1</div>`,
    standalone: true,
  })
  class TestComponent {
    foo: string = '';
  }

  /*tcb2*/
  function _tcb2(this: TestComponent) {
    if (true) {
    }
  }
}

```

# /out/app.ts
```ts
import { Component, Directive } from '@angular/core';
// @ts-ignore
import * as i0 from '@angular/core';

export function runTest() {
  class TestComponent {
    …
  }
  …
}

export function runTest2() {
  class TestComponent {
    …
  }
  …
}

```