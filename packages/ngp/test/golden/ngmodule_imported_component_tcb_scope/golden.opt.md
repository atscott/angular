# /out/consumer_cmp.ngtypecheck.ts
```ts
/**
 * TCB for /consumer_cmp.ts
 * @generated
 */

import * as i0 from './consumer_cmp';

/*tcb1*/
function _tcb1(this: i0.ConsumerCmp) {
  if (true) {
    var _t1 /*103,162*/ = document.createElement('imported-cmp'); /*103,162*/ /*103,162*/
    _t1.addEventListener(/*118,129*/ 'customEvent', ($event /*T:EP*/): any => {
      this.onCustomEvent(/*132,145*/ $event /*146,152*/) /*132,153*/;
    }) /*117,154*/;
    var _t2 /*156,161*/ = _t1; /*155,161*/
    '' + _t2 /*190,195*/.customProp /*196,206*/ /*190,206*/;
  }
}

/* Diagnostics:
 - (103, 162) 'imported-cmp' is not a known element:
1. If 'imported-cmp' is an Angular component, then verify that it is part of this module.
2. If 'imported-cmp' is a Web Component then add 'CUSTOM_ELEMENTS_SCHEMA' to the '@NgModule.schemas' of this component to suppress this message.
*/

```

# /out/consumer_cmp.ts
```ts
import { Component } from '@angular/core';
// @ts-ignore
import * as i0 from '@angular/core';

export class ConsumerCmp {
  onCustomEvent(e: string) {}
  // @ts-ignore
  static ɵfac: i0.ɵɵFactoryDeclaration<ConsumerCmp, never> = function ConsumerCmp_Factory(
    __ngFactoryType__: any,
  ) {
    return new (__ngFactoryType__ || ConsumerCmp)();
  };
  // @ts-ignore
  static ɵcmp: i0.ɵɵComponentDeclaration<
    ConsumerCmp,
    'consumer-cmp',
    never,
    {},
    {},
    never,
    never,
    false,
    never
  > = /*@__PURE__*/ i0.ɵɵdefineComponent({
    type: ConsumerCmp,
    selectors: [['consumer-cmp']],
    standalone: false,
    decls: 4,
    vars: 1,
    consts: [
      ['myRef', ''],
      [3, 'customEvent'],
    ],
    template: function ConsumerCmp_Template(rf: number, ctx: any) {
      if (rf & 1) {
        i0.ɵɵelementStart(0, 'imported-cmp', 1, 0);
        i0.ɵɵlistener(
          'customEvent',
          function ConsumerCmp_Template_imported_cmp_customEvent_0_listener($event: any) {
            return ctx.onCustomEvent($event);
          },
        );
        i0.ɵɵelementEnd();
        i0.ɵɵelementStart(2, 'div');
        i0.ɵɵtext(3);
        i0.ɵɵelementEnd();
      }
      if (rf & 2) {
        const myRef_r1: any = i0.ɵɵreference(1);
        i0.ɵɵadvance(3);
        i0.ɵɵtextInterpolate(myRef_r1.customProp);
      }
    },
    encapsulation: 2,
  });
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        ConsumerCmp,
        [
          {
            type: Component,
            args: [
              {
                selector: 'consumer-cmp',
                template: `
        <imported-cmp (customEvent)="onCustomEvent($event)" #myRef></imported-cmp>
        <div>{{ myRef.customProp }}</div>
      `,
                standalone: false,
              },
            ],
          },
        ],
        null,
        null,
      );
  }
}
(() => {
  (typeof ngDevMode === 'undefined' || ngDevMode) &&
    i0.ɵsetClassDebugInfo(ConsumerCmp, {
      className: 'ConsumerCmp',
      filePath: 'consumer_cmp.ts',
      lineNumber: 11,
    });
})();

```

# /out/consumer_module.ts
```ts
/**
 * `ExternalModule` comes from a module that is not in the program, so it never evaluates to a
 * static reference. ngtsc throws NG1010 there ("Value at position 1 in the NgModule.imports of
 * ConsumerModule is not a reference"), which drops `ConsumerModule` from the compilation
 * entirely — so `getScopeForComponent(ConsumerCmp)` returns null.
 *
 * A null scope is *not* a poisoned one: it reports `isPoisoned: false`, so ngtsc still emits a
 * type-check block, just against an empty scope. This fixture pins that cascade for the
 * element/event/reference cases (`repro_ng0302_pipe_async_not_found` pins it for pipes):
 * `<imported-cmp>` is reported as an unknown element, `$event` widens to the DOM event, and
 * `#myRef` widens to `HTMLElement` — even though `ImportedModule` itself resolved perfectly
 * well. Dropping the resolvable declarations too is the point; it is what ngtsc does.
 */
import { NgModule } from '@angular/core';
import { ConsumerCmp } from './consumer_cmp';
import { ImportedModule } from './imported_cmp';
import { ExternalModule } from '@third-party/external';
// @ts-ignore
import * as i0 from '@angular/core';

export class ConsumerModule {
  // @ts-ignore
  static ɵfac: i0.ɵɵFactoryDeclaration<ConsumerModule, never> = function ConsumerModule_Factory(
    __ngFactoryType__: any,
  ) {
    return new (__ngFactoryType__ || ConsumerModule)();
  };
  // @ts-ignore
  static ɵmod: i0.ɵɵNgModuleDeclaration<
    ConsumerModule,
    [typeof ConsumerCmp],
    [typeof ImportedModule, typeof ExternalModule],
    [typeof ConsumerCmp]
  > = /*@__PURE__*/ i0.ɵɵdefineNgModule({ type: ConsumerModule });
  // @ts-ignore
  static ɵinj: i0.ɵɵInjectorDeclaration<ConsumerModule> = /*@__PURE__*/ i0.ɵɵdefineInjector({
    imports: [ImportedModule, ExternalModule],
  });
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        ConsumerModule,
        [
          {
            type: NgModule,
            args: [
              {
                declarations: [ConsumerCmp],
                imports: [ImportedModule, ExternalModule],
                exports: [ConsumerCmp],
              },
            ],
          },
        ],
        null,
        null,
      );
  }
}
(function () {
  (typeof ngJitMode === 'undefined' || ngJitMode) &&
    i0.ɵɵsetNgModuleScope(ConsumerModule, {
      declarations: [ConsumerCmp],
      imports: [ImportedModule, ExternalModule],
      exports: [ConsumerCmp],
    });
})();

```

# /out/imported_cmp.ngtypecheck.ts
```ts
/**
 * TCB for /imported_cmp.ts
 * @generated
 */

import * as i0 from './imported_cmp';

/*tcb1*/
function _tcb1(this: i0.ImportedCmp) {
  if (true) {
  }
}

```

# /out/imported_cmp.ts
```ts
import { Component, EventEmitter, NgModule, Output } from '@angular/core';
// @ts-ignore
import * as i0 from '@angular/core';

export class ImportedCmp {
  customEvent = new EventEmitter<string>();
  customProp = 'hello';
  // @ts-ignore
  static ɵfac: i0.ɵɵFactoryDeclaration<ImportedCmp, never> = function ImportedCmp_Factory(
    __ngFactoryType__: any,
  ) {
    return new (__ngFactoryType__ || ImportedCmp)();
  };
  // @ts-ignore
  static ɵcmp: i0.ɵɵComponentDeclaration<
    ImportedCmp,
    'imported-cmp',
    never,
    {},
    { 'customEvent': 'customEvent' },
    never,
    never,
    false,
    never
  > = /*@__PURE__*/ i0.ɵɵdefineComponent({
    type: ImportedCmp,
    selectors: [['imported-cmp']],
    outputs: { customEvent: 'customEvent' },
    standalone: false,
    decls: 2,
    vars: 0,
    template: function ImportedCmp_Template(rf: number, ctx: any) {
      if (rf & 1) {
        i0.ɵɵelementStart(0, 'span');
        i0.ɵɵtext(1, 'imported');
        i0.ɵɵelementEnd();
      }
    },
    encapsulation: 2,
  });
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        ImportedCmp,
        [
          {
            type: Component,
            args: [
              {
                selector: 'imported-cmp',
                template: '<span>imported</span>',
                standalone: false,
              },
            ],
          },
        ],
        null,
        { customEvent: [{ type: Output }] },
      );
  }
}
(() => {
  (typeof ngDevMode === 'undefined' || ngDevMode) &&
    i0.ɵsetClassDebugInfo(ImportedCmp, {
      className: 'ImportedCmp',
      filePath: 'imported_cmp.ts',
      lineNumber: 8,
    });
})();

export class ImportedModule {
  // @ts-ignore
  static ɵfac: i0.ɵɵFactoryDeclaration<ImportedModule, never> = function ImportedModule_Factory(
    __ngFactoryType__: any,
  ) {
    return new (__ngFactoryType__ || ImportedModule)();
  };
  // @ts-ignore
  static ɵmod: i0.ɵɵNgModuleDeclaration<
    ImportedModule,
    [typeof ImportedCmp],
    never,
    [typeof ImportedCmp]
  > = /*@__PURE__*/ i0.ɵɵdefineNgModule({ type: ImportedModule });
  // @ts-ignore
  static ɵinj: i0.ɵɵInjectorDeclaration<ImportedModule> = /*@__PURE__*/ i0.ɵɵdefineInjector({});
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        ImportedModule,
        [
          {
            type: NgModule,
            args: [
              {
                declarations: [ImportedCmp],
                exports: [ImportedCmp],
              },
            ],
          },
        ],
        null,
        null,
      );
  }
}
(function () {
  (typeof ngJitMode === 'undefined' || ngJitMode) &&
    i0.ɵɵsetNgModuleScope(ImportedModule, { declarations: [ImportedCmp], exports: [ImportedCmp] });
})();

```

# /tsconfig.ngdiag.json
```json
{
  "tsconfigPath": "/tsconfig.json",
  "diagnostics": [
    {
      "filePath": "/consumer_cmp.ts",
      "category": "error",
      "code": 8001,
      "messageText": "'imported-cmp' is not a known element:\n1. If 'imported-cmp' is an Angular component, then verify that it is part of this module.\n2. If 'imported-cmp' is a Web Component then add 'CUSTOM_ELEMENTS_SCHEMA' to the '@NgModule.schemas' of this component to suppress this message.",
      "span": {
        "start": 103,
        "end": 162
      }
    }
  ]
}

```