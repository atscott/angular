# /out/app.component.ts
```ts
import { Component, ChangeDetectionStrategy } from '@angular/core';
// @ts-ignore
import * as i0 from '@angular/core';

export class OnPushCmp {
  // @ts-ignore
  static ɵfac: i0.ɵɵFactoryDeclaration<OnPushCmp, never> = function OnPushCmp_Factory(
    __ngFactoryType__: any,
  ) {
    return new (__ngFactoryType__ || OnPushCmp)();
  };
  // @ts-ignore
  static ɵcmp: i0.ɵɵComponentDeclaration<
    OnPushCmp,
    'on-push-cmp',
    never,
    {},
    {},
    never,
    never,
    true,
    never
  > = /*@__PURE__*/ i0.ɵɵdefineComponent({
    type: OnPushCmp,
    selectors: [['on-push-cmp']],
    decls: 2,
    vars: 0,
    template: function OnPushCmp_Template(rf: number, ctx: any) {
      if (rf & 1) {
        i0.ɵɵelementStart(0, 'div');
        i0.ɵɵtext(1, 'On Push Component');
        i0.ɵɵelementEnd();
      }
    },
    encapsulation: 2,
    changeDetection: ChangeDetectionStrategy.OnPush,
  });
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        OnPushCmp,
        [
          {
            type: Component,
            args: [
              {
                selector: 'on-push-cmp',
                template: '<div>On Push Component</div>',
                changeDetection: ChangeDetectionStrategy.OnPush,
              },
            ],
          },
        ],
        null,
        null,
      );
  }
}
…

export class DefaultCmp {
  // @ts-ignore
  static ɵfac: i0.ɵɵFactoryDeclaration<DefaultCmp, never> = function DefaultCmp_Factory(
    __ngFactoryType__: any,
  ) {
    return new (__ngFactoryType__ || DefaultCmp)();
  };
  // @ts-ignore
  static ɵcmp: i0.ɵɵComponentDeclaration<
    DefaultCmp,
    'default-cmp',
    never,
    {},
    {},
    never,
    never,
    true,
    never
  > = /*@__PURE__*/ i0.ɵɵdefineComponent({
    type: DefaultCmp,
    selectors: [['default-cmp']],
    decls: 2,
    vars: 0,
    template: function DefaultCmp_Template(rf: number, ctx: any) {
      if (rf & 1) {
        i0.ɵɵelementStart(0, 'div');
        i0.ɵɵtext(1, 'Default Component');
        i0.ɵɵelementEnd();
      }
    },
    encapsulation: 2,
    changeDetection: ChangeDetectionStrategy.Default,
  });
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        DefaultCmp,
        [
          {
            type: Component,
            args: [
              {
                selector: 'default-cmp',
                template: '<div>Default Component</div>',
                changeDetection: ChangeDetectionStrategy.Default,
              },
            ],
          },
        ],
        null,
        null,
      );
  }
}
…

export class EagerCmp {
  // @ts-ignore
  static ɵfac: i0.ɵɵFactoryDeclaration<EagerCmp, never> = function EagerCmp_Factory(
    __ngFactoryType__: any,
  ) {
    return new (__ngFactoryType__ || EagerCmp)();
  };
  // @ts-ignore
  static ɵcmp: i0.ɵɵComponentDeclaration<
    EagerCmp,
    'eager-cmp',
    never,
    {},
    {},
    never,
    never,
    true,
    never
  > = /*@__PURE__*/ i0.ɵɵdefineComponent({
    type: EagerCmp,
    selectors: [['eager-cmp']],
    decls: 2,
    vars: 0,
    template: function EagerCmp_Template(rf: number, ctx: any) {
      if (rf & 1) {
        i0.ɵɵelementStart(0, 'div');
        i0.ɵɵtext(1, 'Eager Component');
        i0.ɵɵelementEnd();
      }
    },
    encapsulation: 2,
    changeDetection: ChangeDetectionStrategy.Eager,
  });
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        EagerCmp,
        [
          {
            type: Component,
            args: [
              {
                selector: 'eager-cmp',
                template: '<div>Eager Component</div>',
                changeDetection: ChangeDetectionStrategy.Eager,
              },
            ],
          },
        ],
        null,
        null,
      );
  }
}
…

```