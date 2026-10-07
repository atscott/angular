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
    dependencies: i0.ɵɵgetComponentDepsFactory(ConsumerCmp),
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
  static ɵmod: ConsumerModule = /*@__PURE__*/ i0.ɵɵdefineNgModule({ type: ConsumerModule });
  // @ts-ignore
  static ɵinj: i0.ɵɵInjectorDeclaration<ConsumerModule> = /*@__PURE__*/ i0.ɵɵdefineInjector({
    imports: [ImportedModule, ExternalModule, ConsumerCmp],
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
    dependencies: i0.ɵɵgetComponentDepsFactory(ImportedCmp),
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
  static ɵmod: ImportedModule = /*@__PURE__*/ i0.ɵɵdefineNgModule({ type: ImportedModule });
  // @ts-ignore
  static ɵinj: i0.ɵɵInjectorDeclaration<ImportedModule> = /*@__PURE__*/ i0.ɵɵdefineInjector({
    imports: [ImportedCmp],
  });
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