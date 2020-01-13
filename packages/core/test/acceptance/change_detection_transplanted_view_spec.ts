/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {CommonModule} from '@angular/common';
import {ChangeDetectionStrategy, ChangeDetectorRef, Component, DoCheck, Input, TemplateRef, ViewChild} from '@angular/core';
import {AfterViewChecked} from '@angular/core/src/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {expect} from '@angular/platform-browser/testing/src/matchers';

describe('change detection for transplanted views', () => {
  describe('when declaration appears before insertion', () => {

    const insertCompTemplate = `
        InsertComp({{greeting}})
        <div *ngIf="true">
          <!-- Add extra level of embedded view to ensure we can handle nesting -->
          <ng-container
              [ngTemplateOutlet]="template"
              [ngTemplateOutletContext]="{$implicit: greeting}">
          </ng-container>
        </div>
      `;
    @Component({
      selector: 'insert-comp',
      changeDetection: ChangeDetectionStrategy.OnPush,
      template: insertCompTemplate,
    })
    class InsertComp implements DoCheck,
        AfterViewChecked {
      get template(): TemplateRef<any> { return declareComp.myTmpl; }
      greeting: string = 'Hello';
      constructor(public changeDetectorRef: ChangeDetectorRef) {
        if (!(this instanceof InsertForOnPushDeclareComp)) {
          insertComp = this;
        }
      }
      ngDoCheck(): void { logValue = 'Insert'; }
      ngAfterViewChecked(): void { logValue = null; }
    }

    @Component({
      selector: 'insert-for-onpush-declare-comp',
      changeDetection: ChangeDetectionStrategy.OnPush,
      template: insertCompTemplate,
    })
    class InsertForOnPushDeclareComp extends InsertComp {
      constructor(public changeDetectorRef: ChangeDetectorRef) {
        super(changeDetectorRef);
        insertForOnPushDeclareComp = this;
      }
      get template(): TemplateRef<any> { return onPushDeclareComp.myTmpl; }
    }

    @Component({
      selector: `declare-comp`,
      template: `
        DeclareComp({{name}})
        <ng-template #myTmpl let-greeting>
          {{greeting}} {{logName()}}!
        </ng-template>
      `
    })
    class DeclareComp implements DoCheck,
        AfterViewChecked {
      @ViewChild('myTmpl')
      myTmpl !: TemplateRef<any>;
      name: string = 'world';
      constructor(readonly changeDetector: ChangeDetectorRef) {
        if (!(this instanceof OnPushDeclareComp)) {
          declareComp = this;
        }
      }
      ngDoCheck(): void { logValue = 'Declare'; }
      logName() {
        // This will log when the embedded view gets CD. The `logValue` will show if the CD was
        // from `Insert` or from `Declare` component.
        log.push(logValue !);
        return this.name;
      }
      ngAfterViewChecked(): void { logValue = null; }
    }

    @Component({
      selector: `onpush-declare-comp`,
      template: `
        OnPushDeclareComp({{name}})
        <ng-template #myTmpl let-greeting>
          {{greeting}} {{logName()}}!
        </ng-template>
      `,
      changeDetection: ChangeDetectionStrategy.OnPush
    })
    class OnPushDeclareComp extends DeclareComp {
      constructor(readonly changeDetector: ChangeDetectorRef) {
        super(changeDetector);
        onPushDeclareComp = this;
      }
    }


    @Component({
      template: `
      <declare-comp *ngIf="showDeclare"></declare-comp>
      <onpush-declare-comp *ngIf="showOnPushDeclare"></onpush-declare-comp>
      <insert-comp *ngIf="showInsert"></insert-comp>
      <insert-for-onpush-declare-comp *ngIf="showInsertForOnPushDeclare"></insert-for-onpush-declare-comp>
      `
    })
    class AppComp {
      showDeclare: boolean = false;
      showOnPushDeclare: boolean = false;
      showInsert: boolean = false;
      showInsertForOnPushDeclare: boolean = false;
      constructor() { appComp = this; }
    }

    let log !: Array<string|null>;
    let logValue !: string | null;
    let fixture !: ComponentFixture<AppComp>;
    let appComp !: AppComp;
    let insertComp !: InsertComp;
    let insertForOnPushDeclareComp !: InsertForOnPushDeclareComp;
    let declareComp !: DeclareComp;
    let onPushDeclareComp !: OnPushDeclareComp;

    beforeEach(() => {
      TestBed.configureTestingModule({
        declarations:
            [InsertComp, DeclareComp, OnPushDeclareComp, InsertForOnPushDeclareComp, AppComp],
        imports: [CommonModule],
      });
      log = [];
      fixture = TestBed.createComponent(AppComp);
    });

    describe('when declaration component is CheckAlways', () => {
      beforeEach(() => {
        fixture.componentInstance.showDeclare = true;
        fixture.componentInstance.showInsert = true;
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert']);
        log.length = 0;
        expect(trim(fixture.nativeElement.textContent))
            .toEqual('DeclareComp(world) InsertComp(Hello) Hello world!');
      });

      it('should CD with insertion only', () => {
        declareComp.name = 'Angular';
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert']);
        log.length = 0;
        // Expect transplanted LView to be CD because the declaration is CD.
        expect(trim(fixture.nativeElement.textContent))
            .toEqual('DeclareComp(Angular) InsertComp(Hello) Hello Angular!');

        insertComp.greeting = 'Hi';
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert']);
        log.length = 0;
        // expect no change because it is on push.
        expect(trim(fixture.nativeElement.textContent))
            .toEqual('DeclareComp(Angular) InsertComp(Hello) Hello Angular!');

        insertComp.changeDetectorRef.markForCheck();
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert']);
        log.length = 0;
        expect(trim(fixture.nativeElement.textContent))
            .toEqual('DeclareComp(Angular) InsertComp(Hi) Hi Angular!');

        // Destroy insertion should also destroy declaration
        appComp.showInsert = false;
        insertComp.changeDetectorRef.markForCheck();
        fixture.detectChanges(false);
        expect(log).toEqual([]);
        log.length = 0;
        expect(trim(fixture.nativeElement.textContent)).toEqual('DeclareComp(Angular)');

        // Restore both
        appComp.showInsert = true;
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert']);
        log.length = 0;
        expect(trim(fixture.nativeElement.textContent))
            .toEqual('DeclareComp(Angular) InsertComp(Hello) Hello Angular!');

        // Destroy declaration, But we should still be able to see updates in insertion
        appComp.showDeclare = false;
        insertComp.greeting = 'Hello';
        insertComp.changeDetectorRef.markForCheck();
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert']);
        log.length = 0;
        expect(trim(fixture.nativeElement.textContent)).toEqual('InsertComp(Hello) Hello Angular!');
      });

      it('is not checked if detectChanges is called in declaration component', () => {
        declareComp.name = 'Angular';
        declareComp.changeDetector.detectChanges();
        expect(log).toEqual([]);
        log.length = 0;
        expect(trim(fixture.nativeElement.textContent))
            .toEqual('DeclareComp(Angular) InsertComp(Hello) Hello world!');
      });

      it('is checked as part of CheckNoChanges pass', () => {
        fixture.detectChanges(true);
        expect(log).toEqual(['Insert', null /* logName set to null afterViewChecked */]);
        log.length = 0;
        expect(trim(fixture.nativeElement.textContent))
            .toEqual('DeclareComp(world) InsertComp(Hello) Hello world!');
      });
    });

    describe('when declaration component is OnPush', () => {
      beforeEach(() => {
        fixture.componentInstance.showOnPushDeclare = true;
        fixture.componentInstance.showInsertForOnPushDeclare = true;
        fixture.detectChanges(false);
        // Should check as part of initialization
        expect(log).toEqual(['Insert']);
        log.length = 0;
        expect(trim(fixture.nativeElement.textContent))
            .toEqual('OnPushDeclareComp(world) InsertComp(Hello) Hello world!');
      });

      it('should CD with insertion only', () => {
        onPushDeclareComp.name = 'Angular';
        insertForOnPushDeclareComp.greeting = 'Hi';
        // mark declaration point dirty
        onPushDeclareComp.changeDetector.markForCheck();
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert']);
        log.length = 0;
        expect(trim(fixture.nativeElement.textContent))
            .toEqual('OnPushDeclareComp(Angular) InsertComp(Hello) Hello Angular!');

        // mark insertion point dirty
        insertForOnPushDeclareComp.changeDetectorRef.markForCheck();
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert']);
        log.length = 0;
        expect(trim(fixture.nativeElement.textContent))
            .toEqual('OnPushDeclareComp(Angular) InsertComp(Hi) Hi Angular!');

        // mark both insertion and declaration point dirty
        insertForOnPushDeclareComp.changeDetectorRef.markForCheck();
        onPushDeclareComp.changeDetector.markForCheck();
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert']);
        log.length = 0;
      });

      it('is not checked if detectChanges is called in declaration component', () => {
        onPushDeclareComp.name = 'Angular';
        onPushDeclareComp.changeDetector.detectChanges();
        expect(log).toEqual([]);
        log.length = 0;
        expect(trim(fixture.nativeElement.textContent))
            .toEqual('OnPushDeclareComp(Angular) InsertComp(Hello) Hello world!');
      });

      // TODO(atscott): blocked by https://github.com/angular/angular/pull/34443
      xit('is checked as part of CheckNoChanges pass', () => {
        // mark declaration point dirty
        onPushDeclareComp.changeDetector.markForCheck();
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert', null /* logName set to null in afterViewChecked */]);
        log.length = 0;

        // mark insertion point dirty
        insertForOnPushDeclareComp.changeDetectorRef.markForCheck();
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert', null]);
        log.length = 0;

        // mark both insertion and declaration point dirty
        insertForOnPushDeclareComp.changeDetectorRef.markForCheck();
        onPushDeclareComp.changeDetector.markForCheck();
        fixture.detectChanges(false);
        expect(log).toEqual(['Insert', null]);
        log.length = 0;
      });
    });
  });

  // Note that backwards references are not handled in VE or Ivy at the moment.
  describe('backwards references', () => {
    @Component({
      selector: 'insertion',
      template: `
            <div>Insertion({{name}})</div>
            <ng-container [ngTemplateOutlet]="template" [ngTemplateOutletContext]="{$implicit: name}">
            </ng-container>`,
      changeDetection: ChangeDetectionStrategy.OnPush
    })
    class Insertion {
      @Input() template !: TemplateRef<{}>;
      name = 'initial';
      constructor(readonly changeDetectorRef: ChangeDetectorRef) {}
    }

    @Component({
      selector: 'declaration',
      template: `
          <div>Declaration({{name}})</div>
          <ng-template #template let-contextName>
            <div>{{incrementChecks()}}</div>
            <div>TemplateDeclaration({{name}})</div>
            <div>TemplateContext({{contextName}})</div>
          </ng-template>
        `,
      changeDetection: ChangeDetectionStrategy.OnPush
    })
    class Declaration {
      @ViewChild('template') template?: TemplateRef<{}>;
      name = 'initial';
      transplantedViewRefreshCount = 0;
      constructor(readonly changeDetectorRef: ChangeDetectorRef) {}
      incrementChecks() { this.transplantedViewRefreshCount++; }
    }
    let fixture: ComponentFixture<App>;
    let appComponent: App;

    @Component({
      template: `
        <insertion *ngIf="showInsertion" [template]="declaration?.template">
        </insertion>
        <declaration></declaration>
        `
    })
    class App {
      @ViewChild(Declaration) declaration !: Declaration;
      @ViewChild(Insertion) insertion !: Insertion;
      template?: TemplateRef<{}>;
      showInsertion = false;
    }

    beforeEach(() => {
      fixture = TestBed.configureTestingModule({declarations: [App, Declaration, Insertion]})
                    .createComponent(App);
      appComponent = fixture.componentInstance;
      fixture.detectChanges(false);
      appComponent.showInsertion = true;
      fixture.detectChanges(false);
      expect(fixture.nativeElement.textContent)
          .toEqual(
              'Insertion(initial)TemplateDeclaration(initial)TemplateContext(initial)Declaration(initial)');
      expect(appComponent.declaration.transplantedViewRefreshCount).toEqual(1);
      appComponent.declaration.transplantedViewRefreshCount = 0;
    });

    it('when there is a change in the declaration and insertion is marked dirty', () => {
      appComponent.declaration.name = 'new name';
      appComponent.insertion.changeDetectorRef.markForCheck();
      fixture.detectChanges(false);
      // Name should not update in declaration view because only insertion was marked dirty
      expect(fixture.nativeElement.textContent)
          .toEqual(
              'Insertion(initial)TemplateDeclaration(new name)TemplateContext(initial)Declaration(initial)');
      expect(appComponent.declaration.transplantedViewRefreshCount).toEqual(1);
    });

    it('when there is a change to declaration and declaration is marked dirty', () => {
      appComponent.declaration.name = 'new name';
      appComponent.declaration.changeDetectorRef.markForCheck();
      fixture.detectChanges(false);
      const expectedContent =
          'Insertion(initial)TemplateDeclaration(initial)TemplateContext(initial)Declaration(new name)';
      expect(fixture.nativeElement.textContent).toEqual(expectedContent);
      expect(appComponent.declaration.transplantedViewRefreshCount).toEqual(0);
    });

    it('when there is a change to insertion and declaration is marked dirty', () => {
      appComponent.insertion.name = 'new name';
      appComponent.declaration.changeDetectorRef.markForCheck();
      fixture.detectChanges(false);
      // Name should not update in insertion view because only declaration was marked dirty
      // Context name also does not update in the template because the insertion view needs to be
      // checked to update the `ngTemplateOutletContext` input.
      expect(fixture.nativeElement.textContent)
          .toEqual(
              'Insertion(initial)TemplateDeclaration(initial)TemplateContext(initial)Declaration(initial)');
      expect(appComponent.declaration.transplantedViewRefreshCount).toEqual(0);
    });

    it('when there is a change to insertion and insertion marked dirty', () => {
      appComponent.insertion.name = 'new name';
      appComponent.insertion.changeDetectorRef.markForCheck();
      fixture.detectChanges(false);
      expect(fixture.nativeElement.textContent)
          .toEqual(
              'Insertion(new name)TemplateDeclaration(initial)TemplateContext(new name)Declaration(initial)');
      expect(appComponent.declaration.transplantedViewRefreshCount).toEqual(1);
    });

    it('when nothing is dirty', () => {
      fixture.detectChanges(false);
      expect(appComponent.declaration.transplantedViewRefreshCount).toEqual(0);
    });

    it('when both declaration and insertion are marked dirty', () => {
      appComponent.declaration.changeDetectorRef.markForCheck();
      appComponent.insertion.changeDetectorRef.markForCheck();
      fixture.detectChanges(false);
      // Only refreshed when insertion component is refreshed
      expect(appComponent.declaration.transplantedViewRefreshCount).toEqual(1);
    });
  });

  it('shielded CheckAlways transplanted views', () => {
    @Component({
      selector: 'check-always-insertion',
      template: `<ng-container [ngTemplateOutlet]="template"></ng-container>`
    })
    class CheckAlwaysInsertion {
      @Input() template !: TemplateRef<{}>;
    }

    @Component({
      selector: 'on-push-insertion-host',
      template: `<check-always-insertion [template]="template"></check-always-insertion>`,
      changeDetection: ChangeDetectionStrategy.OnPush
    })
    class OnPushInsertionHost {
      @Input() template !: TemplateRef<{}>;
    }

    @Component({
      template: `
      <ng-template #template>{{value}}</ng-template>
      <on-push-insertion-host [template]="template"></on-push-insertion-host>
      `
    })
    class CheckAlwaysDeclaration {
      value = 'initial';
    }

    const fixture =
        TestBed
            .configureTestingModule(
                {declarations: [CheckAlwaysDeclaration, CheckAlwaysInsertion, OnPushInsertionHost]})
            .createComponent(CheckAlwaysDeclaration);
    fixture.detectChanges();
    fixture.componentInstance.value = 'new';
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toEqual('new');
  });
});

function trim(text: string | null): string {
  return text ? text.replace(/[\s\n]+/gm, ' ').trim() : '';
}
