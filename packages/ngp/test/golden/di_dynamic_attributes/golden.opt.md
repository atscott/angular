# /out/app.ngtypecheck.ts
```ts
…

```

# /out/app.ts
```ts
import { Attribute, Component } from '@angular/core';
// @ts-ignore
import * as i0 from '@angular/core';

function getAttrName() {
  return 'my-attr';
}

export class TestComponent {
  constructor(
    public literalAttr: string,
    public dynamicAttr: string,
  ) {}
  // @ts-ignore
  static ɵfac: i0.ɵɵFactoryDeclaration<
    TestComponent,
    [{ attribute: 'literal-attr' }, { attribute: unknown }]
  > = function TestComponent_Factory(__ngFactoryType__: any) {
    /* @ts-ignore */
    return new (__ngFactoryType__ || TestComponent)(
      i0.ɵɵinjectAttribute('literal-attr'),
      i0.ɵɵinjectAttribute(getAttrName()),
    );
  };
  …
}
(() => {
  (typeof ngDevMode === 'undefined' || ngDevMode) &&
    i0.ɵsetClassDebugInfo(TestComponent, {
      className: 'TestComponent',
      filePath: 'app.ts',
      lineNumber: 12,
    });
})();
…

```