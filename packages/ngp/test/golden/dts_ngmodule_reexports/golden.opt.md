# /out/app.ngtypecheck.ts
```ts
/**
 * TCB for /app.ts
 * @generated
 */

import * as i0 from './app';
import * as i1 from './feature-component';

/*tcb1*/
function _tcb1(this: i0.AppComponent) {
  if (true) {
    var _t1 /*T:DIR:0*/ /*197,229*/ = null! as i1.MyFeatureComponent; /*T:VAE*/
    _t1.myProp /*211,217*/ = 'hello' /*220,227*/ /*210,228*/;
  }
}

```

# /out/app.ts
```ts
import { Component } from '@angular/core';
import { MyFeatureModule } from './feature-module';
// @ts-ignore
import * as i0 from '@angular/core';
// @ts-ignore
import * as i1 from './feature-component';

export class AppComponent {
  …
}
…

```