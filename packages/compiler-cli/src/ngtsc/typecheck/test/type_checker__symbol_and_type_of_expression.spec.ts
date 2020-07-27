/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ASTWithSource, Binary, BindingPipe, Conditional, Interpolation, PropertyRead, TmplAstBoundAttribute, TmplAstBoundText, TmplAstElement, TmplAstNode, TmplAstTemplate} from '@angular/compiler';
import * as ts from 'typescript';

import {absoluteFrom, getSourceFileOrError} from '../../file_system';
import {runInEachFileSystem} from '../../file_system/testing';
import {ClassDeclaration} from '../../reflection';
import {TemplateTypeChecker} from '../api';

import {getClass, ngForDeclaration, ngForDts, setup,} from './test_utils';

runInEachFileSystem(() => {
  describe('TemplateTypeChecker get Symbol and Type of template expression', () => {
    describe('for just a component property used in an input binding', () => {
      let nodes: TmplAstElement[];
      let templateTypeChecker: TemplateTypeChecker;
      let cmp: ClassDeclaration<ts.ClassDeclaration>;
      let program: ts.Program;

      beforeEach(() => {
        const fileName = absoluteFrom('/main.ts');
        const templateString = `<div [inputA]="helloWorld"></div>`;
        const testValues = setup(
            [
              {
                fileName,
                templates: {'Cmp': templateString},
                source: `export class Cmp {helloWorld?: boolean;}`,
              },
            ],
            {inlining: false});
        templateTypeChecker = testValues.templateTypeChecker;
        program = testValues.program;
        const sf = getSourceFileOrError(program, fileName);
        cmp = getClass(sf, 'Cmp');
        nodes = getAstElements(templateTypeChecker, cmp, templateString);
      });

      it('should get a symbol', () => {
        const symbol =
            templateTypeChecker.getSymbolOfTemplateExpression(nodes[0].inputs[0].value, cmp)!;
        expect(symbol.escapedName.toString()).toEqual('helloWorld');
      });

      it('should get a type', () => {
        const type =
            templateTypeChecker.getTypeOfTemplateExpression(nodes[0].inputs[0].value, cmp)!;
        expect(program.getTypeChecker().typeToString(type)).toEqual('false | true | undefined');
      });
    });

    describe('for properties several levels deep', () => {
      let nodes: TmplAstElement[];
      let templateTypeChecker: TemplateTypeChecker;
      let cmp: ClassDeclaration<ts.ClassDeclaration>;
      let program: ts.Program;

      beforeEach(() => {
        const fileName = absoluteFrom('/main.ts');
        const templateString = `<div [inputA]="person.address.street"></div>`;
        const testValues = setup(
            [
              {
                fileName,
                templates: {'Cmp': templateString},
                source: `
              interface Address {
                street: string;
              }

              interface Person {
                address: Address;
              }
              export class Cmp {person?: Person;}
            `,
              },
            ],
            {inlining: false});
        templateTypeChecker = testValues.templateTypeChecker;
        program = testValues.program;
        const sf = getSourceFileOrError(program, fileName);
        cmp = getClass(sf, 'Cmp');
        nodes = getAstElements(templateTypeChecker, cmp, templateString);
      });

      it('should get a symbol', () => {
        const symbol =
            templateTypeChecker.getSymbolOfTemplateExpression(nodes[0].inputs[0].value, cmp)!;
        expect(symbol.escapedName.toString()).toEqual('street');
        expect((symbol.declarations[0] as ts.PropertyDeclaration).parent.name!.getText())
            .toEqual('Address');
      });

      it('should get a type', () => {
        const type =
            templateTypeChecker.getTypeOfTemplateExpression(nodes[0].inputs[0].value, cmp)!;
        expect(program.getTypeChecker().typeToString(type)).toEqual('string');
      });
    });

    describe('for conditionals', () => {
      let nodes: TmplAstElement[];
      let templateTypeChecker: TemplateTypeChecker;
      let cmp: ClassDeclaration<ts.ClassDeclaration>;
      let program: ts.Program;

      beforeEach(() => {
        const fileName = absoluteFrom('/main.ts');
        const templateString = `
        <div [inputA]="person?.address?.street"></div>
        <div [inputA]="person ? person.address : noPersonError"></div>
      `;
        const testValues = setup(
            [
              {
                fileName,
                templates: {'Cmp': templateString},
                source: `
              interface Address {
                street: string;
              }

              interface Person {
                address: Address;
              }
              export class Cmp {person?: Person; noPersonError = 'no person'}
            `,
              },
            ],
            {inlining: false});
        templateTypeChecker = testValues.templateTypeChecker;
        program = testValues.program;
        const sf = getSourceFileOrError(program, fileName);
        cmp = getClass(sf, 'Cmp');
        nodes = getAstElements(templateTypeChecker, cmp, templateString);
      });

      it('should get symbols', () => {
        const safePropertyRead = nodes[0].inputs[0].value as ASTWithSource;
        const symbol = templateTypeChecker.getSymbolOfTemplateExpression(safePropertyRead, cmp)!;
        expect(symbol.escapedName.toString()).toEqual('street');
        expect((symbol.declarations[0] as ts.PropertyDeclaration).parent.name!.getText())
            .toEqual('Address');

        const ternary = (nodes[1].inputs[0].value as ASTWithSource).ast as Conditional;
        expect(templateTypeChecker.getSymbolOfTemplateExpression(ternary, cmp)).toBeNull();

        const addrSymbol = templateTypeChecker.getSymbolOfTemplateExpression(ternary.trueExp, cmp)!;
        expect(addrSymbol.escapedName.toString()).toEqual('address');

        const noPersonSymbol =
            templateTypeChecker.getSymbolOfTemplateExpression(ternary.falseExp, cmp)!;
        expect(noPersonSymbol.escapedName.toString()).toEqual('noPersonError');
      });

      it('should get types', () => {
        const safePropertyRead = nodes[0].inputs[0].value as ASTWithSource;
        const type = templateTypeChecker.getTypeOfTemplateExpression(safePropertyRead, cmp)!;
        expect(program.getTypeChecker().typeToString(type)).toEqual('string | undefined');

        const ternary = (nodes[1].inputs[0].value as ASTWithSource).ast as Conditional;
        const ternaryType = templateTypeChecker.getTypeOfTemplateExpression(ternary, cmp)!;
        expect(program.getTypeChecker().typeToString(ternaryType)).toEqual('string | Address');

        const addrType = templateTypeChecker.getTypeOfTemplateExpression(ternary.trueExp, cmp)!;
        expect(program.getTypeChecker().typeToString(addrType)).toEqual('Address');

        const noPersonType =
            templateTypeChecker.getTypeOfTemplateExpression(ternary.falseExp, cmp)!;
        expect(program.getTypeChecker().typeToString(noPersonType)).toEqual('string');
      });
    });

    describe('for function on a component used in an input binding', () => {
      let nodes: TmplAstElement[];
      let templateTypeChecker: TemplateTypeChecker;
      let cmp: ClassDeclaration<ts.ClassDeclaration>;
      let program: ts.Program;

      beforeEach(() => {
        const fileName = absoluteFrom('/main.ts');
        const templateString = `<div [inputA]="helloWorld"></div>`;
        const testValues = setup(
            [
              {
                fileName,
                templates: {'Cmp': templateString},
                source: `
            export class Cmp {
              helloWorld() { return ''; }
            }`,
              },
            ],
            {inlining: false});
        templateTypeChecker = testValues.templateTypeChecker;
        program = testValues.program;
        const sf = getSourceFileOrError(program, fileName);
        cmp = getClass(sf, 'Cmp');
        nodes = getAstElements(templateTypeChecker, cmp, templateString);
      });

      it('should get a symbol', () => {
        const symbol =
            templateTypeChecker.getSymbolOfTemplateExpression(nodes[0].inputs[0].value, cmp)!;
        expect(symbol.escapedName.toString()).toEqual('helloWorld');
      });

      it('should get a type', () => {
        const type =
            templateTypeChecker.getTypeOfTemplateExpression(nodes[0].inputs[0].value, cmp)!;
        expect(program.getTypeChecker().typeToString(type)).toEqual('() => string');
      });
    });

    describe('for binary a expression', () => {
      let nodes: TmplAstElement[];
      let templateTypeChecker: TemplateTypeChecker;
      let cmp: ClassDeclaration<ts.ClassDeclaration>;
      let program: ts.Program;

      beforeEach(() => {
        const fileName = absoluteFrom('/main.ts');
        const templateString = `<div [inputA]="a + b"></div>`;
        const testValues = setup(
            [
              {
                fileName,
                templates: {'Cmp': templateString},
                source: `
            export class Cmp {
              a!: string;
              b!: number;
            }`,
              },
            ],
            {inlining: false});
        templateTypeChecker = testValues.templateTypeChecker;
        program = testValues.program;
        const sf = getSourceFileOrError(program, fileName);
        cmp = getClass(sf, 'Cmp');
        nodes = getAstElements(templateTypeChecker, cmp, templateString);
      });

      it('should return null when requesting a symbol for an entire binary expression', () => {
        const symbol = templateTypeChecker.getSymbolOfTemplateExpression(
            (nodes[0] as TmplAstElement).inputs[0].value, cmp);
        expect(symbol).toBeNull();
      });

      it('should get a symbol for a component property in a binary expression', () => {
        const valueAssignment = nodes[0].inputs[0].value as ASTWithSource;
        const aSymbol = templateTypeChecker.getSymbolOfTemplateExpression(
            (valueAssignment.ast as Binary).left, cmp)!;
        expect(aSymbol.escapedName.toString()).toBe('a');
        const bSymbol = templateTypeChecker.getSymbolOfTemplateExpression(
            (valueAssignment.ast as Binary).right, cmp)!;
        expect(bSymbol.escapedName.toString()).toBe('b');
      });

      it('should get types', () => {
        const valueAssignment = nodes[0].inputs[0].value as ASTWithSource;

        const wholeExprType =
            templateTypeChecker.getTypeOfTemplateExpression(valueAssignment, cmp)!;
        expect(program.getTypeChecker().typeToString(wholeExprType)).toEqual('string');
        const aType = templateTypeChecker.getTypeOfTemplateExpression(
            (valueAssignment.ast as Binary).left, cmp)!;
        expect(program.getTypeChecker().typeToString(aType)).toEqual('string');
        const bType = templateTypeChecker.getTypeOfTemplateExpression(
            (valueAssignment.ast as Binary).right, cmp)!;
        expect(program.getTypeChecker().typeToString(bType)).toEqual('number');
      });
    });

    describe('for member on directive bound with template var', () => {
      let nodes: TmplAstElement[];
      let templateTypeChecker: TemplateTypeChecker;
      let cmp: ClassDeclaration<ts.ClassDeclaration>;
      let program: ts.Program;

      beforeEach(() => {
        const fileName = absoluteFrom('/main.ts');
        const dirFile = absoluteFrom('/dir.ts');
        const templateString = `
        <div dir #myDir="dir"></div>
        <div [inputA]="myDir.dirValue" [inputB]="myDir"></div>
        `;
        const testValues = setup(
            [
              {
                fileName,
                templates: {'Cmp': templateString},
                declarations: [{
                  name: 'TestDir',
                  selector: '[dir]',
                  file: dirFile,
                  type: 'directive',
                  exportAs: ['dir'],
                }]
              },
              {
                fileName: dirFile,
                source: `export class TestDir { dirValue = 'helloWorld' }`,
                templates: {}
              }
            ],
            {inlining: false});
        templateTypeChecker = testValues.templateTypeChecker;
        program = testValues.program;
        const sf = getSourceFileOrError(program, fileName);
        cmp = getClass(sf, 'Cmp');
        nodes = getAstElements(templateTypeChecker, cmp, templateString);
      });

      it('should get symbols', () => {
        const dirValueSymbol =
            templateTypeChecker.getSymbolOfTemplateExpression(nodes[1].inputs[0].value, cmp)!;
        expect(dirValueSymbol.escapedName.toString()).toBe('dirValue');
        const dirSymbol =
            templateTypeChecker.getSymbolOfTemplateExpression(nodes[1].inputs[1].value, cmp)!;
        expect(dirSymbol.escapedName.toString()).toBe('TestDir');
      });

      it('should get types', () => {
        const dirValueType =
            templateTypeChecker.getTypeOfTemplateExpression(nodes[1].inputs[0].value, cmp)!;
        expect(program.getTypeChecker().typeToString(dirValueType)).toEqual('string');
        const dirType =
            templateTypeChecker.getTypeOfTemplateExpression(nodes[1].inputs[1].value, cmp)!;
        expect(program.getTypeChecker().typeToString(dirType)).toEqual('TestDir');
      });
    });

    describe('templates', () => {
      let templateTypeChecker: TemplateTypeChecker;
      let cmp: ClassDeclaration<ts.ClassDeclaration>;
      let templateNode: TmplAstTemplate;
      let program: ts.Program;

      beforeEach(() => {
        const fileName = absoluteFrom('/main.ts');
        const templateString = `
              <div *ngFor="let user of users; let i = index;">
                {{user.name}} {{user.streetNumber}}
                <div [tabIndex]="i"></div>
              </div>`;
        const testValues = setup(
            [
              {
                fileName,
                templates: {'Cmp': templateString},
                source: `
            export interface User {
              name: string;
              streetNumber: number;
            }
            export class Cmp { users: User[]; }
            `,
                declarations: [ngForDeclaration()],
              },
              ngForDts(),
            ],
            {inlining: false});
        templateTypeChecker = testValues.templateTypeChecker;
        program = testValues.program;
        const sf = getSourceFileOrError(testValues.program, fileName);
        cmp = getClass(sf, 'Cmp');
        templateNode = getAstTemplates(templateTypeChecker, cmp, templateString)[0];
      });

      it('should retrieve a symbol for an expression inside structural binding', () => {
        const ngForOfBinding =
            templateNode.templateAttrs.find(a => a.name === 'ngForOf')! as TmplAstBoundAttribute;
        const symbol =
            templateTypeChecker.getSymbolOfTemplateExpression(ngForOfBinding.value, cmp)!;
        expect(symbol.escapedName.toString()).toEqual('users');
      });

      it('should retrieve a symbol for property reads of implicit variable inside structural binding',
         () => {
           const boundText =
               (templateNode.children[0] as TmplAstElement).children[0] as TmplAstBoundText;
           const interpolation = (boundText.value as ASTWithSource).ast as Interpolation;
           const namePropRead = interpolation.expressions[0] as PropertyRead;
           const streetNumberPropRead = interpolation.expressions[1] as PropertyRead;

           const nameSymbol = templateTypeChecker.getSymbolOfTemplateExpression(namePropRead, cmp)!;
           expect(nameSymbol.escapedName.toString()).toEqual('name');
           const streetSymbol =
               templateTypeChecker.getSymbolOfTemplateExpression(streetNumberPropRead, cmp)!;
           expect(streetSymbol.escapedName.toString()).toEqual('streetNumber');
           const userSymbol =
               templateTypeChecker.getSymbolOfTemplateExpression(namePropRead.receiver, cmp)!;
           expect(userSymbol.escapedName).toContain('$implicit');
           expect(userSymbol.declarations[0].parent!.getText()).toContain('NgForOfContext');
         });

      it('finds symbol when using a template variable', () => {
        const innerElementNodes =
            onlyAstElements((templateNode.children[0] as TmplAstElement).children);
        const indexSymbol = templateTypeChecker.getSymbolOfTemplateExpression(
            innerElementNodes[0].inputs[0].value, cmp)!;
        expect(indexSymbol.escapedName).toContain('index');
        expect(indexSymbol.declarations[0].parent!.getText()).toContain('NgForOfContext');
      });

      it('can retrieve a type for an expression inside structural binding', () => {
        const ngForOfBinding =
            templateNode.templateAttrs.find(a => a.name === 'ngForOf')! as TmplAstBoundAttribute;
        const type = templateTypeChecker.getTypeOfTemplateExpression(ngForOfBinding.value, cmp)!;
        expect(program.getTypeChecker().typeToString(type)).toEqual('Array<User>');
      });

      it('can retrieve a type for an expression inside structural binding', () => {
        const boundText =
            (templateNode.children[0] as TmplAstElement).children[0] as TmplAstBoundText;
        const interpolation = (boundText.value as ASTWithSource).ast as Interpolation;
        const namePropRead = interpolation.expressions[0] as PropertyRead;
        const streetNumberPropertyRead = interpolation.expressions[1] as PropertyRead;

        const nameType = templateTypeChecker.getTypeOfTemplateExpression(namePropRead, cmp)!;
        expect(program.getTypeChecker().typeToString(nameType)).toEqual('string');
        const streetNumType =
            templateTypeChecker.getTypeOfTemplateExpression(streetNumberPropertyRead, cmp)!;
        expect(program.getTypeChecker().typeToString(streetNumType)).toEqual('number');
        const userType =
            templateTypeChecker.getTypeOfTemplateExpression(namePropRead.receiver, cmp)!;
        expect(program.getTypeChecker().typeToString(userType)).toEqual('User');
      });
    });

    describe('pipes', () => {
      let templateTypeChecker: TemplateTypeChecker;
      let cmp: ClassDeclaration<ts.ClassDeclaration>;
      let binding: BindingPipe;
      let program: ts.Program;

      beforeEach(() => {
        const fileName = absoluteFrom('/main.ts');
        const templateString = `<div [inputA]="a | test:b:c"></div>`;
        const testValues = setup(
            [
              {
                fileName,
                templates: {'Cmp': templateString},
                source: `
            export class Cmp { a: string; b: number; c: boolean }
            export class TestPipe {
              transform(value: string, repeat: number, commaSeparate: boolean): string[] {
              }
            }
            `,
                declarations: [{
                  type: 'pipe',
                  name: 'TestPipe',
                  pipeName: 'test',
                }],
              },
            ],
            {inlining: false});
        program = testValues.program;
        templateTypeChecker = testValues.templateTypeChecker;
        const sf = getSourceFileOrError(testValues.program, fileName);
        cmp = getClass(sf, 'Cmp');
        binding = (getAstElements(templateTypeChecker, cmp, templateString)[0].inputs[0].value as
                   ASTWithSource)
                      .ast as BindingPipe;
      });

      it('should get symbol for pipe', () => {
        const pipeSymbol = templateTypeChecker.getSymbolOfTemplateExpression(binding, cmp)!;
        expect(pipeSymbol.escapedName.toString()).toEqual('transform');
        expect((pipeSymbol.declarations[0].parent as ts.ClassDeclaration).name!.getText())
            .toEqual('TestPipe');
      });

      it('should get symbols for pipe expression and args', () => {
        const aSymbol = templateTypeChecker.getSymbolOfTemplateExpression(binding.exp, cmp)!;
        expect(aSymbol.escapedName.toString()).toEqual('a');
        const bSymbol = templateTypeChecker.getSymbolOfTemplateExpression(binding.args[0], cmp)!;
        expect(bSymbol.escapedName.toString()).toEqual('b');
        const cSymbol = templateTypeChecker.getSymbolOfTemplateExpression(binding.args[1], cmp)!;
        expect(cSymbol.escapedName.toString()).toEqual('c');
      });

      it('should get type for pipe', () => {
        const pipeType = templateTypeChecker.getTypeOfTemplateExpression(binding, cmp)!;
        expect(program.getTypeChecker().typeToString(pipeType)).toEqual('Array<string>');
      });

      it('should get types for pipe expression and args', () => {
        const aType = templateTypeChecker.getTypeOfTemplateExpression(binding.exp, cmp)!;
        expect(program.getTypeChecker().typeToString(aType)).toEqual('string');
        const bType = templateTypeChecker.getTypeOfTemplateExpression(binding.args[0], cmp)!;
        expect(program.getTypeChecker().typeToString(bType)).toEqual('number');
        const cType = templateTypeChecker.getTypeOfTemplateExpression(binding.args[1], cmp)!;
        expect(program.getTypeChecker().typeToString(cType)).toEqual('boolean');
      });
    });
  });
});

function onlyAstTemplates(nodes: TmplAstNode[]): TmplAstTemplate[] {
  return nodes.filter((n): n is TmplAstTemplate => n instanceof TmplAstTemplate);
}

function onlyAstElements(nodes: TmplAstNode[]): TmplAstElement[] {
  return nodes.filter((n): n is TmplAstElement => n instanceof TmplAstElement);
}

function getAstElements(
    templateTypeChecker: TemplateTypeChecker, cmp: ts.ClassDeclaration&{name: ts.Identifier},
    templateString: string) {
  return onlyAstElements(templateTypeChecker.overrideComponentTemplate(cmp, templateString).nodes);
}

function getAstTemplates(
    templateTypeChecker: TemplateTypeChecker, cmp: ts.ClassDeclaration&{name: ts.Identifier},
    templateString: string) {
  return onlyAstTemplates(templateTypeChecker.overrideComponentTemplate(cmp, templateString).nodes);
}
