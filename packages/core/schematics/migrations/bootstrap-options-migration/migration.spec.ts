/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {absoluteFrom} from '@angular/compiler-cli';
import {initMockFileSystem} from '@angular/compiler-cli/src/ngtsc/file_system/testing';
import {runTsurgeMigration} from '../../utils/tsurge/testing';
import {diffText} from '../../utils/tsurge/testing/diff';
import {BootstrapOptionsMigration} from './migration';

describe('bootstrap options migration', () => {
  beforeEach(() => {
    initMockFileSystem('Native');
  });

  it('should migrate bootstrapApplication with existing options', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { bootstrapApplication } from '@angular/platform-browser';
          import { AppComponent } from './app/app.component';

          bootstrapApplication(AppComponent, {providers: []});
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({
            selector: 'app-root',
            template: '',
            standalone: true,
          })
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/main.ts'));
    const expected = `
          import { provideZoneChangeDetection } from "@angular/core";
          import { bootstrapApplication } from '@angular/platform-browser';
          import { AppComponent } from './app/app.component';

          bootstrapApplication(AppComponent, {providers: [provideZoneChangeDetection(),]});
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));
  });

  it('should migrate bootstrapApplication without existing options', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { bootstrapApplication } from '@angular/platform-browser';
          import { AppComponent } from './app/app.component';

          bootstrapApplication(AppComponent);
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({
            selector: 'app-root',
            template: '',
            standalone: true,
          })
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/main.ts'));
    const expected = `
          import { provideZoneChangeDetection } from "@angular/core";
          import { bootstrapApplication } from '@angular/platform-browser';
          import { AppComponent } from './app/app.component';

          bootstrapApplication(AppComponent, {providers: [provideZoneChangeDetection()]});
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));
  });

  it('should migrate ngZone: "noop"', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule, { ngZone: 'noop' });
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { NgModule, provideZoneChangeDetection, NgZone, ɵNoopNgZone } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [ZoneChangeDetectionModule, BrowserModule],
            bootstrap: [AppComponent]
          })
          export class AppModule {}

          @NgModule({providers: [provideZoneChangeDetection(), {provide: NgZone, useClass: ɵNoopNgZone}]})
          export class ZoneChangeDetectionModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));

    const mainActual = fs.readFile(absoluteFrom('/main.ts'));
    const mainExpected = `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule);
        `;
    expect(mainActual.replace(/\s+/g, ''))
      .withContext(diffText(mainExpected, mainActual))
      .toEqual(mainExpected.replace(/\s+/g, ''));
  });

  it('should migrate ngZoneEventCoalescing', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule, { ngZoneEventCoalescing: true });
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            providers: [],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { NgModule, provideZoneChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [ZoneChangeDetectionModule, BrowserModule],
            providers: [],
            bootstrap: [AppComponent]
          })
          export class AppModule {}

          @NgModule({ providers: [provideZoneChangeDetection({ eventCoalescing: true })] })
          export class ZoneChangeDetectionModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));
  });

  it('should migrate ngZoneRunCoalescing', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule, { ngZoneRunCoalescing: true });
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            providers: [],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { NgModule, provideZoneChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [ZoneChangeDetectionModule, BrowserModule],
            providers: [],
            bootstrap: [AppComponent]
          })
          export class AppModule {}

          @NgModule({providers: [provideZoneChangeDetection({runCoalescing: true})]})
          export class ZoneChangeDetectionModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));
  });

  it('should not add provideZoneChangeDetection if provideZonelessChangeDetection is present', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule, { ngZoneRunCoalescing: true });
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule, provideZonelessChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            providers: [provideZonelessChangeDetection()],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { NgModule, provideZonelessChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            providers: [provideZonelessChangeDetection()],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));
  });

  it('should not add provideZoneChangeDetection if it is already present in an imported module', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule, { ngZoneRunCoalescing: true });
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';
          import { MyOtherModule } from './other.module';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule, MyOtherModule],
            providers: [],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/other.module.ts'),
        contents: `
          import { NgModule, provideZoneChangeDetection } from '@angular/core';

          @NgModule({
            providers: [provideZoneChangeDetection({eventCoalescing: true})],
          })
          export class MyOtherModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { NgModule } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';
          import { MyOtherModule } from './other.module';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule, MyOtherModule],
            providers: [],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));
  });

  it('should migrate ngZone: "zone.js"', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule, { ngZone: 'zone.js' });
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { NgModule, provideZoneChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [ZoneChangeDetectionModule, BrowserModule],
            bootstrap: [AppComponent]
          })
          export class AppModule {}

          @NgModule({providers: [provideZoneChangeDetection() ]})
          export class ZoneChangeDetectionModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));
  });

  it('should migrate ngZone with a custom class', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';
          import { MyZone } from './app/my-zone';

          platformBrowserDynamic().bootstrapModule(AppModule, { ngZone: MyZone });
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
      {
        name: absoluteFrom('/app/my-zone.ts'),
        contents: `
          import { NgZone } from '@angular/core';
          export class MyZone extends NgZone {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { MyZone } from "./my-zone";
          import { NgModule, provideZoneChangeDetection, NgZone } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [ZoneChangeDetectionModule, BrowserModule],
            bootstrap: [AppComponent]
          })
          export class AppModule {}

          @NgModule({
            providers: [
              provideZoneChangeDetection(), 
              {provide: NgZone, useClass: MyZone}
            ]
          })
          export class ZoneChangeDetectionModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));
  });

  it('should remove ignoreChangesOutsideZone', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule, { ignoreChangesOutsideZone: true });
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { NgModule, provideZoneChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [ZoneChangeDetectionModule, BrowserModule],
            bootstrap: [AppComponent]
          })
          export class AppModule {}

            @NgModule({ providers: [provideZoneChangeDetection()] })
    export class ZoneChangeDetectionModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));
  });

  it('should not add provideZoneChangeDetection if it is already present', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule, { ngZoneRunCoalescing: true });
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule, provideZoneChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            providers: [provideZoneChangeDetection({eventCoalescing: true})],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { NgModule, provideZoneChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            providers: [provideZoneChangeDetection({eventCoalescing: true})],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));
  });

  it('should remove bootstrapOptions but not add provideZoneChangeDetection if it is already present', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule, { ngZoneRunCoalescing: true });
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule, provideZoneChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            providers: [provideZoneChangeDetection({eventCoalescing: true})],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { NgModule, provideZoneChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            providers: [provideZoneChangeDetection({eventCoalescing: true})],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));

    const mainActual = fs.readFile(absoluteFrom('/main.ts'));
    const mainExpected = `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule);
        `;
    expect(mainActual.replace(/\s+/g, ''))
      .withContext(diffText(mainExpected, mainActual))
      .toEqual(mainExpected.replace(/\s+/g, ''));
  });

  it('should migrate imports when it is a variable identifier', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule, { ngZoneRunCoalescing: true });
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule, Provider } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          const myImports = [BrowserModule];

          @NgModule({
            declarations: [AppComponent],
            imports: myImports,
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { NgModule, Provider, provideZoneChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          const myImports = [BrowserModule];

          @NgModule({
            declarations: [AppComponent],
            imports: [ZoneChangeDetectionModule, ...myImports],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
          @NgModule({ providers: [provideZoneChangeDetection({ runCoalescing: true })] })
          export class ZoneChangeDetectionModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));
  });

  it('should add provideZoneChangeDetection if no bootstrap options are present', async () => {
    const {fs} = await runTsurgeMigration(new BootstrapOptionsMigration(), [
      {
        name: absoluteFrom('/main.ts'),
        isProgramRootFile: true,
        contents: `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule);
        `,
      },
      {
        name: absoluteFrom('/app/app.module.ts'),
        contents: `
          import { NgModule } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [BrowserModule],
            bootstrap: [AppComponent]
          })
          export class AppModule {}
        `,
      },
      {
        name: absoluteFrom('/app/app.component.ts'),
        contents: `
          import { Component } from '@angular/core';

          @Component({selector: 'app-root', template: ''})
          export class AppComponent {}
        `,
      },
    ]);

    const actual = fs.readFile(absoluteFrom('/app/app.module.ts'));
    const expected = `
          import { NgModule, provideZoneChangeDetection } from '@angular/core';
          import { BrowserModule } from '@angular/platform-browser';
          import { AppComponent } from './app.component';

          @NgModule({
            declarations: [AppComponent],
            imports: [ZoneChangeDetectionModule, BrowserModule],
            bootstrap: [AppComponent]
          })
          export class AppModule {}

          @NgModule({ providers: [provideZoneChangeDetection()] })
          export class ZoneChangeDetectionModule {}
        `;
    expect(actual.replace(/\s+/g, ''))
      .withContext(diffText(expected, actual))
      .toEqual(expected.replace(/\s+/g, ''));

    const mainActual = fs.readFile(absoluteFrom('/main.ts'));
    const mainExpected = `
          import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
          import { AppModule } from './app/app.module';

          platformBrowserDynamic().bootstrapModule(AppModule);
        `;
    expect(mainActual.replace(/\s+/g, ''))
      .withContext(diffText(mainExpected, mainActual))
      .toEqual(mainExpected.replace(/\s+/g, ''));
  });
});
