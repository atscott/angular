# /out/app.component.ngtypecheck.ts
```ts
/**
 * TCB for /app.component.ts
 * @generated
 */

import { Component } from '@angular/core';

interface LocalInterface {
  foo: string;
}

@Component({
  selector: 'app-root',
  template: '<div>{{ prop.foo }}</div>',
  standalone: true,
})
export class AppComponent<T extends LocalInterface> {
  prop!: T;
}

/*tcb1*/
function _tcb1<T extends LocalInterface>(this: AppComponent<T>) {
  if (true) {
    '' + this.prop /*147,151*/ /*147,151*/.foo /*152,155*/ /*147,155*/;
  }
}

```

# /out/app.component.ts
```ts
…

```