# /out/app.component.ngtypecheck.ts
```ts
/**
 * TCB for /app.component.ts
 * @generated
 */

import * as i0 from './app.component';
import * as i1 from './io_array.component';

/*tcb1*/
function _tcb1(this: i0.AppComponent) {
  if (true) {
    var _t1 /*T:DIR:0*/ /*207,370*/ = null! as i1.IoArrayComponent; /*T:VAE*/
    _t1.name /*228,232*/ = 'TestName' /*235,245*/ /*227,246*/;
    _t1.aliasInput /*254,264*/ = 'TestAlias' /*267,278*/ /*253,279*/;
    _t1['emitter'] /*287,294*/
      .subscribe(($event /*T:EP*/): any => {
        this
          .handleEmitter /*297,310*/
          () /*297,312*/;
      }) /*286,313*/;
    _t1['aliasOutput'] /*321,334*/
      .subscribe(($event /*T:EP*/): any => {
        this.handleAliasEmitter(/*337,355*/ $event /*356,362*/) /*337,363*/;
      }) /*320,364*/;
  }
}

```

# /out/app.component.ts
```ts
import { Component } from '@angular/core';
import { IoArrayComponent } from './io_array.component';
// @ts-ignore
import * as i0 from '@angular/core';

export class AppComponent {
  …
}
…

```

# /out/io_array.component.ngtypecheck.ts
```ts
/**
 * TCB for /io_array.component.ts
 * @generated
 */

import * as i0 from './io_array.component';

/*tcb1*/
function _tcb1(this: i0.IoArrayComponent) {
  if (true) {
    '' + this.name /*125,129*/ /*125,129*/;
  }
}

```

# /out/io_array.component.ts
```ts
import { Component, EventEmitter } from '@angular/core';
// @ts-ignore
import * as i0 from '@angular/core';

export class IoArrayComponent {
  …
}
…

```