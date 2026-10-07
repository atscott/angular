# /out/app.directive.ngtypecheck.ts
```ts
/**
 * TCB for /app.directive.ts
 * @generated
 */

import { Directive } from '@angular/core';

interface LocalInterface {
  foo: string;
}

@Directive({
  selector: '[appRoot]',
  standalone: true,
  host: {
    '[attr.foo]': 'prop.foo',
  },
})
export class AppDirective<T extends LocalInterface> {
  prop!: T;
}

/*tcb1*/
function _tcb1<T extends LocalInterface>(this: AppDirective<T>) {
  if (true) {
  }
  if (true /*hostBindingsBlockGuard*/) {
    this.prop /*176,180*/ /*176,180*/.foo /*181,184*/ /*176,184*/;
  }
}

```

# /out/app.directive.ts
```ts
…

```