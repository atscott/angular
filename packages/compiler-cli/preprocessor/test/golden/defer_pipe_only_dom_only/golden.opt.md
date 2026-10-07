# /out/app.component.ngtypecheck.ts
```ts
…

```

# /out/app.component.ts
```ts
…
const AppComponent_Defer_3_DepsFn = () => [MyPipe];
function AppComponent_Defer_1_Template(rf: number, ctx: any) {
  if (rf & 1) {
    i0.ɵɵtext(0);
    i0.ɵɵpipe(1, 'myPipe');
  }
  if (rf & 2) {
    i0.ɵɵtextInterpolate1(' ', i0.ɵɵpipeBind1(1, 1, 'hello'), ' ');
  }
}
…
    template: function AppComponent_Template(rf: number, ctx: any) {
      if (rf & 1) {
        i0.ɵɵdomElementStart(0, 'div');
        i0.ɵɵdomTemplate(1, AppComponent_Defer_1_Template, 2, 3)(
          2,
          AppComponent_DeferPlaceholder_2_Template,
          1,
          0,
        );
        i0.ɵɵdefer(3, 1, AppComponent_Defer_3_DepsFn, null, 2);
        i0.ɵɵdeferOnIdle();
        i0.ɵɵdomElementEnd();
      }
    },
…
```