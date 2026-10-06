# /out/legacy_enabled.ngtypecheck.ts
```ts
/**
 * TCB for /legacy_enabled.ts
 * @generated
 */

import * as i0 from './legacy_enabled';

/*tcb1*/
function _tcb1(this: i0.MyComponent) {
  if (true) {
    '' + 'interpolated' /*240,254*/;
    '' + 'interpolated' /*300,314*/;
  }
}

```

# /out/legacy_enabled.ts
```ts
import { Component, NgModule } from '@angular/core';
// @ts-ignore
import * as i0 from '@angular/core';

export class MyComponent {
  // @ts-ignore
  static ɵfac: i0.ɵɵFactoryDeclaration<MyComponent, never> = function MyComponent_Factory(
    __ngFactoryType__: any,
  ) {
    return new (__ngFactoryType__ || MyComponent)();
  };
  // @ts-ignore
  static ɵcmp: i0.ɵɵComponentDeclaration<
    MyComponent,
    'my-component',
    never,
    {},
    {},
    never,
    never,
    false,
    never
  > = /*@__PURE__*/ i0.ɵɵdefineComponent({
    type: MyComponent,
    selectors: [['my-component']],
    standalone: false,
    decls: 13,
    vars: 2,
    consts: () => {
      let i18n_0;
      if (typeof ngI18nClosureMode !== 'undefined' && ngI18nClosureMode) {
        /**
         * @suppress {msgDescriptions}
         */
        const MSG_EXTERNAL_2908931752694090721$$_LEGACY_ENABLED_TS_0 =
          /* @ts-ignore */
          goog.getMsg('Some & attribute');
        i18n_0 = MSG_EXTERNAL_2908931752694090721$$_LEGACY_ENABLED_TS_0;
      } else {
        /* @ts-ignore */
        i18n_0 = $localize`Some & attribute`;
      }
      let i18n_1;
      if (typeof ngI18nClosureMode !== 'undefined' && ngI18nClosureMode) {
        /**
         * @suppress {msgDescriptions}
         */
        const MSG_EXTERNAL_2720535395337591908$$_LEGACY_ENABLED_TS_1 =
          /* @ts-ignore */
          goog.getMsg('"');
        i18n_1 = MSG_EXTERNAL_2720535395337591908$$_LEGACY_ENABLED_TS_1;
      } else {
        /* @ts-ignore */
        i18n_1 = $localize`"`;
      }
      let i18n_2;
      if (typeof ngI18nClosureMode !== 'undefined' && ngI18nClosureMode) {
        /**
         * @suppress {msgDescriptions}
         */
        const MSG_EXTERNAL_3600934704948217447$$_LEGACY_ENABLED_TS_2 =
          /* @ts-ignore */
          goog.getMsg('""');
        i18n_2 = MSG_EXTERNAL_3600934704948217447$$_LEGACY_ENABLED_TS_2;
      } else {
        /* @ts-ignore */
        i18n_2 = $localize`""`;
      }
      let i18n_3;
      if (typeof ngI18nClosureMode !== 'undefined' && ngI18nClosureMode) {
        /**
         * @suppress {msgDescriptions}
         */
        const MSG_EXTERNAL_2334195497629636162$$_LEGACY_ENABLED_TS_3 =
          /* @ts-ignore */
          goog.getMsg(
            'Some & {$interpolation} attribute',
            { 'interpolation': '�0�' },
            { original_code: { 'interpolation': "{{'interpolated'}}" } },
          );
        i18n_3 = MSG_EXTERNAL_2334195497629636162$$_LEGACY_ENABLED_TS_3;
      } else {
        /* @ts-ignore */
        i18n_3 = $localize`Some & ${'�0�'}:INTERPOLATION: attribute`;
      }
      let i18n_4;
      if (typeof ngI18nClosureMode !== 'undefined' && ngI18nClosureMode) {
        /**
         * @suppress {msgDescriptions}
         */
        const MSG_EXTERNAL_4700340487900776701$$_LEGACY_ENABLED_TS_4 =
          /* @ts-ignore */
          goog.getMsg('Some & message');
        i18n_4 = MSG_EXTERNAL_4700340487900776701$$_LEGACY_ENABLED_TS_4;
      } else {
        /* @ts-ignore */
        i18n_4 = $localize`Some & message`;
      }
      let i18n_5;
      if (typeof ngI18nClosureMode !== 'undefined' && ngI18nClosureMode) {
        /**
         * @suppress {msgDescriptions}
         */
        const MSG_EXTERNAL_3204054277547499090$$_LEGACY_ENABLED_TS_5 =
          /* @ts-ignore */
          goog.getMsg(
            'Some & {$interpolation} message',
            { 'interpolation': '�0�' },
            { original_code: { 'interpolation': "{{'interpolated' }}" } },
          );
        i18n_5 = MSG_EXTERNAL_3204054277547499090$$_LEGACY_ENABLED_TS_5;
      } else {
        /* @ts-ignore */
        i18n_5 = $localize`Some & ${'�0�'}:INTERPOLATION: message`;
      }
      let i18n_6;
      if (typeof ngI18nClosureMode !== 'undefined' && ngI18nClosureMode) {
        /**
         * @suppress {msgDescriptions}
         */
        const MSG_EXTERNAL_2406634758623728945$$_LEGACY_ENABLED_TS_6 =
          /* @ts-ignore */
          goog.getMsg('&');
        i18n_6 = MSG_EXTERNAL_2406634758623728945$$_LEGACY_ENABLED_TS_6;
      } else {
        /* @ts-ignore */
        i18n_6 = $localize`&`;
      }
      let i18n_7;
      if (typeof ngI18nClosureMode !== 'undefined' && ngI18nClosureMode) {
        /**
         * @suppress {msgDescriptions}
         */
        const MSG_EXTERNAL_4156372478368653226$$_LEGACY_ENABLED_TS_7 =
          /* @ts-ignore */
          goog.getMsg('&"');
        i18n_7 = MSG_EXTERNAL_4156372478368653226$$_LEGACY_ENABLED_TS_7;
      } else {
        /* @ts-ignore */
        i18n_7 = $localize`&"`;
      }
      return [
        i18n_4,
        i18n_5,
        i18n_6,
        i18n_7,
        ['title', i18n_3],
        ['title', i18n_0],
        [6, 'title'],
        ['title', i18n_1],
        ['title', i18n_2],
      ];
    },
    template: function MyComponent_Template(rf: number, ctx: any) {
      if (rf & 1) {
        i0.ɵɵelement(0, 'div', 5);
        i0.ɵɵelementStart(1, 'div');
        i0.ɵɵi18n(2, 0);
        i0.ɵɵelementEnd();
        i0.ɵɵelementStart(3, 'div', 6);
        i0.ɵɵi18nAttributes(4, 4);
        i0.ɵɵelementEnd();
        i0.ɵɵelementStart(5, 'div');
        i0.ɵɵi18n(6, 1);
        i0.ɵɵelementEnd();
        i0.ɵɵelementStart(7, 'div');
        i0.ɵɵi18n(8, 2);
        i0.ɵɵelementEnd();
        i0.ɵɵelementStart(9, 'div');
        i0.ɵɵi18n(10, 3);
        i0.ɵɵelementEnd();
        i0.ɵɵelement(11, 'div', 7)(12, 'div', 8);
      }
      if (rf & 2) {
        i0.ɵɵadvance(3);
        i0.ɵɵi18nExp('interpolated');
        i0.ɵɵi18nApply(4);
        i0.ɵɵadvance(3);
        i0.ɵɵi18nExp('interpolated');
        i0.ɵɵi18nApply(6);
      }
    },
    encapsulation: 2,
  });
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        MyComponent,
        [
          {
            type: Component,
            args: [
              {
                selector: 'my-component',
                template: `
      <div i18n-title title="Some &amp; attribute"></div>
      <div i18n>Some &amp; message</div>
      <div i18n-title title="Some &amp; {{'interpolated'}} attribute"></div>
      <div i18n>Some &amp; {{'interpolated' }} message</div>
      <div i18n>&amp;</div>
      <div i18n>&amp;&quot;</div>
      <div i18n-title title="&quot;"></div>
      <div i18n-title title="&quot;&quot;"></div>
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
    i0.ɵsetClassDebugInfo(MyComponent, {
      className: 'MyComponent',
      filePath: 'legacy_enabled.ts',
      lineNumber: 17,
    });
})();

export class MyModule {
  // @ts-ignore
  static ɵfac: i0.ɵɵFactoryDeclaration<MyModule, never> = function MyModule_Factory(
    __ngFactoryType__: any,
  ) {
    return new (__ngFactoryType__ || MyModule)();
  };
  // @ts-ignore
  static ɵmod: i0.ɵɵNgModuleDeclaration<MyModule, [typeof MyComponent], never, never> =
    /*@__PURE__*/ i0.ɵɵdefineNgModule({ type: MyModule });
  // @ts-ignore
  static ɵinj: i0.ɵɵInjectorDeclaration<MyModule> = /*@__PURE__*/ i0.ɵɵdefineInjector({});
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        MyModule,
        [{ type: NgModule, args: [{ declarations: [MyComponent] }] }],
        null,
        null,
      );
  }
}
(function () {
  (typeof ngJitMode === 'undefined' || ngJitMode) &&
    i0.ɵɵsetNgModuleScope(MyModule, { declarations: [MyComponent] });
})();

```