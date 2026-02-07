import {BoundTarget, TmplAstNode} from '@angular/compiler';
import ts from 'typescript';
import {TypeCheckingConfig, TypeCheckId} from '../api';
import {
  TcbComponentMetadata,
  TcbDirectiveMetadata,
  TcbScope,
  TcbPropertySet,
} from '../api/tcb_metadata';
import {DetachedTcbEnvironment} from '../src/detached_tcb_environment';
import {DomSchemaChecker} from '../src/dom';
import {OutOfBandDiagnosticRecorder} from '../src/oob';
import {TcbGenericContextBehavior} from '../src/ops/context';
import {generateTypeCheckBlock} from '../src/type_check_block';
import {Reference} from '../../imports';
import {ClassDeclaration} from '../../reflection';

describe('Detached TCB Generation', () => {
  it('should generate a valid TCB from manually constructed metadata without a live ts.Program', () => {
    // 1. Construct a mock TypeCheckingConfig
    const config: TypeCheckingConfig = {
      applyTemplateContextGuards: true,
      checkQueries: false,
      checkTemplateBodies: true,
      checkTypeOfInputBindings: true,
      strictNullInputBindings: true,
      checkTypeOfAttributes: true,
      checkTypeOfDomBindings: true,
      checkTypeOfOutputEvents: true,
      checkTypeOfAnimationEvents: true,
      checkTypeOfDomEvents: true,
      checkTypeOfDomReferences: true,
      checkTypeOfNonDomReferences: true,
      checkTypeOfPipes: true,
      strictSafeNavigationTypes: true,
      useContextGenericType: true,
      strictLiteralTypes: true,
      enableTemplateTypeChecker: true,
      useInlineTypeConstructors: false,
      suggestionsForSuboptimalTypeInference: false,
      controlFlowPreventingContentProjection: 'warning',
      unusedStandaloneImports: 'warning',
      honorAccessModifiersForInputBindings: false,
      alwaysCheckSchemaInTemplateBodies: false,
      allowSignalsInTwoWayBindings: true,
      allowDomEventAssertion: false,
      checkControlFlowBodies: true,
      checkTwoWayBoundEvents: true,
    };

    // 2. Mock a detached TCB environment
    const env = new DetachedTcbEnvironment(config) as any;

    // 3. Construct a manual component metadata
    const componentDirClass = ts.factory.createClassDeclaration(
      undefined,
      ts.factory.createIdentifier('MyComponent'),
      undefined,
      undefined,
      [],
    );
    const componentDirRef = new Reference(componentDirClass) as Reference<
      ClassDeclaration<ts.ClassDeclaration>
    >;
    (componentDirRef as any).moduleName = '/test/my_component.ts';

    const componentMetadata: TcbDirectiveMetadata = {
      name: 'MyComponent',
      moduleName: '/test/my_component.ts',
      isComponent: true,
      selector: 'my-comp',
      exportAs: null,
      inputs: new TcbPropertySet(new Set(['myInput'])),
      tcbInputs: [
        {
          classPropertyName: 'myInput',
          bindingPropertyName: 'myInput',
          required: false,
          isSignal: false,
          type: undefined,
        },
      ],
      outputs: new TcbPropertySet(new Set()),
      tcbOutputs: [],
      isGeneric: false,
      hasNgTemplateContextGuard: false,
      ngTemplateGuards: [],
      coercedInputFields: new Set(),
      restrictedInputFields: new Set(),
      stringLiteralInputFields: new Set(),
      undeclaredInputFields: new Set(),
      isStandalone: true,
      isSignal: false,
      requiresInlineTcbConstructor: false,
      hasControlValueAccessorMethods: false,
      isExplicitlyDeferred: false,
      typeParameters: undefined,
      ngContentSelectors: null,
      preserveWhitespaces: false,
      animationTriggerNames: null,
      isStructural: false,
    };

    // A fake bound target returning our component directive
    const boundTarget = {
      target: Object.assign({}, componentMetadata, {
        template: (componentMetadata as any).template || [],
      }) as any,
      getUsedDirectives: () => [componentMetadata],
      getUsedPipes: () => [],
      getDirectiveOp: () => null,
      getExpressionTarget: () => null,
      getLazyBindings: () => null,
      getEagerlyUsedPipes: () => [],
    } as unknown as BoundTarget<TcbDirectiveMetadata>;

    (componentMetadata as any).ref = {node: {typeParameters: undefined, name: 'MyComponent'}};
    // The TcbComponentMetadata we feed into the generator
    const tcbMeta: TcbComponentMetadata = {
      id: 'tcb1' as TypeCheckId,
      name: 'MyComponent',
      moduleName: '/test/my_component.ts',
      template: [],
      component: componentMetadata,
      preserveWhitespaces: false,
      scope: {
        directives: [componentMetadata],
        pipes: [],
      },
      boundTarget,
      pipes: new Map(),
      schemas: [],
      isStandalone: true,
    };

    // Mock DomSchemaChecker and OutOfBandDiagnosticRecorder
    const domSchemaChecker = {
      diagnostics: [],
      checkElement: () => {},
      checkProperty: () => {},
    } as unknown as DomSchemaChecker;

    const oobRecorder = {
      diagnostics: [],
      missingReferenceTarget: () => {},
      missingPipe: () => {},
      missingControlFlowDirective: () => {},
      deferredPipeUsedEagerly: () => {},
      deferredComponentUsedEagerly: () => {},
      deferredDirectiveUsedEagerly: () => {},
      illegalWriteToLetDeclaration: () => {},
      incompatibleForOfLetDeclaration: () => {},
      letUsedBeforeDefinition: () => {},
      unknownLetInitializer: () => {},
      unknownElement: () => {},
    } as unknown as OutOfBandDiagnosticRecorder;

    // 4. Run the pure TCB generator!
    const fnName = ts.factory.createIdentifier('_tcb1');
    const tcbFunction = generateTypeCheckBlock(
      env,
      componentDirRef,
      fnName,
      tcbMeta,
      domSchemaChecker,
      oobRecorder,
      TcbGenericContextBehavior.UseEmitter,
    );

    // 5. Verify the output
    const printer = ts.createPrinter();
    const sourceFile = ts.factory.createSourceFile(
      [...env.getPreludeStatements(), tcbFunction],
      ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
      ts.NodeFlags.None,
    );
    const printed = printer.printFile(sourceFile);

    expect(printed).toContain('import * as i1 from "/test/my_component.ts";');
    expect(printed).toContain('function _tcb1(');
    // expect(printed).toContain('let ctx: i1.MyComponent;');
    // Should have basic variable creation
  });
});
