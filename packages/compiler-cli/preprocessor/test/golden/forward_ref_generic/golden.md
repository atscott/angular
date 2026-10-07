# /out/app.component.ts
```ts
…
    contentQueries: function AppComponent_ContentQueries(rf: number, ctx: any, dirIndex: number) {
      if (rf & 1) {
        i0.ɵɵcontentQuery(dirIndex, GenericComponent, 5);
      }
      if (rf & 2) {
        let _t: any;
        i0.ɵɵqueryRefresh((_t = i0.ɵɵloadQuery())) && (ctx.child = _t.first);
      }
    },
…
```

# /out/generic.component.ts
```ts
…

```