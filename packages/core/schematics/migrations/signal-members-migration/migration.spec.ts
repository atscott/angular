/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {absoluteFrom} from '@angular/compiler-cli';
import {runTsurgeMigration} from '../../utils/tsurge/testing';
import {SignalMembersMigration} from './migration'; // Changed import
import {initMockFileSystem} from '@angular/compiler-cli/src/ngtsc/file_system/testing';
import {diffText} from '../../utils/tsurge/testing/diff';
// import {dedent} from '../../utils/tsurge/testing/dedent'; // dedent might not be needed if populateComponentWithMember is used
import {setupTsurgeJasmineHelpers} from '../../utils/tsurge/testing/jasmine';
import ts from 'typescript';

interface MemberTestCase {
  id: string;
  beforeMember: string;
  afterMember: string;
  beforeTemplate?: string;
  afterTemplate?: string;
  focus?: boolean;
  options?: ts.CompilerOptions;
  extraImports?: string; // For cases like signal
  afterExtraImports?: string; // For imports added by the migration
}

// Helper to create full component code from member declaration and template
function populateComponentWithMember(
  memberDeclaration: string,
  template: string = '',
  extraImports: string = '',
): string {
  return `
    import { Component ${extraImports} } from '@angular/core';

    @Component({
      selector: 'my-comp',
      template: \`${template}\`
    })
    export class MyTestComponent {
      ${memberDeclaration}
    }
  `;
}


const memberTestCases: MemberTestCase[] = [
  // Primitive Types
  {
    id: 'string member with initializer',
    beforeMember: `myString = 'hello';`,
    afterMember: `myString = signal('hello');`,
    afterExtraImports: ', signal',
  },
  {
    id: 'number member with initializer',
    beforeMember: `myCount = 10;`,
    afterMember: `myCount = signal(10);`,
    afterExtraImports: ', signal',
  },
  {
    id: 'boolean member with initializer',
    beforeMember: `isActive = true;`,
    afterMember: `isActive = signal(true);`,
    afterExtraImports: ', signal',
  },
  {
    id: 'uninitialized string member',
    beforeMember: `myVar: string;`,
    // Depending on strictPropertyInitialization and strictNullChecks,
    // the <string | undefined> might be more accurate.
    // For now, assuming it adds undefined for uninitialized.
    afterMember: `myVar = signal<string | undefined>(undefined);`,
    afterExtraImports: ', signal',
  },
  {
    id: 'uninitialized number member with undefined type',
    beforeMember: `myNum: number | undefined;`,
    afterMember: `myNum = signal<number | undefined>(undefined);`,
    afterExtraImports: ', signal',
  },

  // TypeScript Reads
  {
    id: 'TS read in a method',
    beforeMember: `count = 0;\n  getVal() { return this.count; }`,
    afterMember: `count = signal(0);\n  getVal() { return this.count(); }`,
    afterExtraImports: ', signal',
  },
  {
    id: 'TS read in constructor',
    beforeMember: `message: string = "initial";\n  constructor() { console.log(this.message); }`,
    afterMember: `message = signal("initial");\n  constructor() { console.log(this.message()); }`,
    afterExtraImports: ', signal',
  },
  {
    id: 'TS read in ngOnInit',
    beforeMember: `value = 123;\n  ngOnInit() { if (this.value > 100) {} }`,
    afterMember: `value = signal(123);\n  ngOnInit() { if (this.value() > 100) {} }`,
    afterExtraImports: ', signal',
  },

  // TypeScript Writes (.set)
  {
    id: 'TS write in a method using .set',
    beforeMember: `count = 0;\n  setVal(v: number) { this.count = v; }`,
    afterMember: `count = signal(0);\n  setVal(v: number) { this.count.set(v); }`,
    afterExtraImports: ', signal',
  },
  // TypeScript Writes (.update) - Simple increment
  {
    id: 'TS write in a method using .update for increment',
    beforeMember: `count = 0;\n  increment() { this.count++; }`,
    afterMember: `count = signal(0);\n  increment() { this.count.update(c => c + 1); }`,
    afterExtraImports: ', signal',
  },
  {
    id: 'TS write in a method using .update for decrement',
    beforeMember: `count = 10;\n  decrement() { this.count--; }`,
    afterMember: `count = signal(10);\n  decrement() { this.count.update(c => c - 1); }`,
    afterExtraImports: ', signal',
  },


  // Template Reads
  {
    id: 'Template read interpolation',
    beforeMember: `myVar = 'test';`,
    afterMember: `myVar = signal('test');`,
    beforeTemplate: `{{ myVar }}`,
    afterTemplate: `{{ myVar() }}`,
    afterExtraImports: ', signal',
  },
  {
    id: 'Template read attribute binding',
    beforeMember: `itemId = 'item-1';`,
    afterMember: `itemId = signal('item-1');`,
    beforeTemplate: `<div [id]="itemId"></div>`,
    afterTemplate: `<div [id]="itemId()"></div>`,
    afterExtraImports: ', signal',
  },
  {
    id: 'Template read structural directive',
    beforeMember: `isVisible = true;`,
    afterMember: `isVisible = signal(true);`,
    beforeTemplate: `<div *ngIf="isVisible"></div>`,
    afterTemplate: `<div *ngIf="isVisible()"></div>`,
    afterExtraImports: ', signal',
  },

  // Modifiers and Comments
  {
    id: 'Preserve public modifier and comment',
    beforeMember: `/** My count */\n  public count = 100;`,
    afterMember: `/** My count */\n  public count = signal(100);`,
    afterExtraImports: ', signal',
  },

  // Non-Migration: Complex Types
  {
    id: 'Non-migration for object member',
    beforeMember: `myObj = {a: 1};`,
    afterMember: `myObj = {a: 1};`, // Stays the same
  },
  {
    id: 'Non-migration for array member',
    beforeMember: `myArray = [1, 2, 3];`,
    afterMember: `myArray = [1, 2, 3];`, // Stays the same
  },
  // Non-Migration: Already a signal
  {
    id: 'Non-migration for already a signal',
    beforeMember: `mySig = signal(0);`,
    afterMember: `mySig = signal(0);`, // Stays the same
    extraImports: ', signal', // signal is used in 'before'
  },
  // Non-Migration: Getter/Setter
  {
    id: 'Non-migration for getter',
    beforeMember: `get myVal() { return 0; }`,
    afterMember: `get myVal() { return 0; }`,
  },
  // Non-Migration: Input (handled by another migration)
  {
    id: 'Non-migration for @Input() decorated property',
    beforeMember: `@Input() myInput: string = '';`,
    afterMember: `@Input() myInput: string = '';`,
    extraImports: ', Input', // Input decorator
  }
];


describe('SignalMembersMigration', () => { // Changed describe name
  beforeEach(() => {
    setupTsurgeJasmineHelpers();
    initMockFileSystem('Native');
  });

  describe('member migration test cases', () => {
    for (const testCase of memberTestCases) {
      (testCase.focus ? fit : it)(testCase.id, async () => {
        const componentBefore = populateComponentWithMember(
          testCase.beforeMember,
          testCase.beforeTemplate,
          testCase.extraImports,
        );
        const componentAfter = populateComponentWithMember(
          testCase.afterMember,
          testCase.afterTemplate ?? testCase.beforeTemplate, // Use before if afterTemplate not specified
          testCase.afterExtraImports ?? testCase.extraImports,
        );

        const {fs} = await runTsurgeMigration(
          new SignalMembersMigration(), // Changed migration class
          [
            {
              name: absoluteFrom('/app.component.ts'),
              isProgramRootFile: true,
              contents: componentBefore,
            },
          ],
          testCase.options,
        );

        const actual = fs.readFile(absoluteFrom('/app.component.ts'));
        const expected = componentAfter;

        // Basic check, can be improved with more specific diffing if needed
        if (actual !== expected) {
          expect(diffText(expected, actual)).toBe('');
        }
        // Optionally, more specific checks for imports or specific lines
        if (testCase.afterExtraImports?.includes('signal')) {
            expect(actual).toContain('import { Component , signal } from \'@angular/core\';');
        }
      });
    }
  });

  // Add more describe blocks for specific scenarios like external usage if needed
  // For example:
  // describe('external usage (non-migration)', () => { ... });

  it('should correctly compute statistics (basic)', async () => {
    const {getStatistics} = await runTsurgeMigration(
      new SignalMembersMigration(),
      [
        {
          name: absoluteFrom('/app.component.ts'),
          isProgramRootFile: true,
          contents: populateComponentWithMember(
            `
            myString = 'hello'; // eligible
            myNumber = 123;     // eligible
            myObject = {a: 1};  // ineligible (complex type)
            alreadySignal = signal(true); // ineligible (already a signal)
            `,
            '',
            ', signal' // For alreadySignal
          ),
        },
      ],
    );

    const stats = await getStatistics();
    expect(stats['membersCount']).toBe(2); // myString, myNumber
    // Add more specific stats checks as they are implemented in the migration's stats method
    // e.g., expect(stats['incompatibleMembers']).toBe(2);
  });

});
