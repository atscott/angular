# /out/app.ts
```ts
import {
  Component,
  Directive,
  Injectable,
  Pipe,
  PipeTransform,
  Service,
  NgModule,
} from '@angular/core';
// @ts-ignore
import * as i0 from '@angular/core';

export class MetaComponent {
  …
}
(() => {
  (typeof ngDevMode === 'undefined' || ngDevMode) &&
    i0.ɵsetClassDebugInfo(MetaComponent, {
      className: 'MetaComponent',
      filePath: 'app.ts',
      lineNumber: 8,
    });
})();
…

export class MetaDirective {
  …
}
…

export class MetaService {
  …
}
…

export class MetaPipe implements PipeTransform {
  …
}
…

export class NoArgDecorator {
  …
}
…
(function () {
  (typeof ngJitMode === 'undefined' || ngJitMode) &&
    i0.ɵɵsetNgModuleScope(MetaNgModule, {
      declarations: [MetaDirective],
      exports: [MetaDirective],
    });
})();
i0.ɵɵregisterNgModuleType(MetaNgModule, 'MetaNgModuleId');

```